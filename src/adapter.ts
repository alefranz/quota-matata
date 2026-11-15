/**
 * Quota Matata — OpenCode v2 plugin adapter (supported Promise API).
 *
 * Wires the accepted pure core (`evaluateQuota`) and the accepted privacy-safe
 * JSONL logger to the host's supported hooks:
 *
 * - `ctx.session.hook("retry", …)` — classify/evaluate every provider failure
 *   the host consults plugins for, and apply only validated overrides to the
 *   mutable `decision`. The host skips this hook entirely once its native
 *   retry schedule is exhausted; the plugin cannot extend that cap.
 * - `ctx.session.hook("http.response", …)` — metadata-only observation of
 *   HTTP >= 400 responses (status, Retry-After header, request kind). Never
 *   reads the request, URLs, or response bodies (one-shot streams).
 * - `ctx.event.subscribe({ types, signal })` — terminal `session.execution.failed`
 *   observations (provider.error even when no retry hook ran). Events arrive in
 *   the wire envelope `{ type, data: … }`. A terminal event is an INDEPENDENT
 *   observation source: the host supplies only `{ sessionID, error }` on it (no
 *   agent/model/attempt and no execution identity), and the event bus delivers
 *   it asynchronously relative to the direct retry/HTTP hooks. The adapter
 *   therefore logs exactly the fields the host provides and never infers which
 *   retry attempt or execution a terminal failure belongs to; it links to the
 *   direct-hook records by sessionID only (see specs/integration.md).
 *
 * Safety model (see specs/integration.md):
 * - Callbacks never throw: the host wraps them in `Effect.promise`, so a
 *   rejection would defect the session execution. Any internal failure leaves
 *   the host's native decision untouched ("fail native") and is reported as a
 *   sanitized `plugin.error` log event.
 * - No timers, schedulers, or counters: waits are the host's cancellable
 *   `Effect.sleep`. The adapter keeps no cross-surface correlation state, so
 *   asynchronous event delivery can never mislabel a terminal observation.
 * - `enabled: false` is fully inert: no hooks, no subscription, no logger, no
 *   files. Invalid options throw `ConfigError` from setup (never silent).
 * - Cleanup disposes registrations, aborts the event subscription, awaits the
 *   loop's exit, and flushes/closes the logger. No background work survives.
 */
import type { Plugin } from "@opencode/plugin"
import type { SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session"
import type { OpenCodeEvent } from "@opencode/client"
import { ConfigError, MAX_DELAY_MS, resolveConfig } from "./config.js"
import { classifyError, normalizeError } from "./classify.js"
import { evaluateQuota } from "./core.js"
import { createLogger, PLUGIN_VERSION } from "./logging.js"
import type { DiagnosticLogger, LoggerContext } from "./logging.js"
import type { HostError, QuotaMatataConfig, ResolvedConfig } from "./types.js"

/** Plugin id registered with the host (`Plugin.define`). */
export const PLUGIN_ID = "quota-matata"

/**
 * The only event type this adapter consumes. Terminal `session.execution.failed`
 * is an independent observation source (see the header and specs/integration.md):
 * the host supplies no agent/model/attempt or execution identity on it, and the
 * bus delivers it asynchronously relative to the direct hooks, so no lifecycle
 * event is needed (or safe) to scope a cross-surface correlation cache. The
 * adapter keeps no such cache.
 */
const EVENT_TYPES = ["session.execution.failed"] as const

type TerminalFailed = Extract<OpenCodeEvent, { type: "session.execution.failed" }>

interface DecisionSnapshot {
  readonly retry: boolean
  readonly delay?: number
}

/** Read a property without trusting hostile getters; undefined on any failure. */
function tryRead<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into finite ms >= 0. */
function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000
    return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_DELAY_MS) : undefined
  }
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  const ms = at - now
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_DELAY_MS) : undefined
}

/**
 * Plugin setup for the supported OpenCode v2 Promise API. Exported separately
 * so tests and embedders can drive it with the real `Plugin.Context` type.
 * Invalid options reject with `ConfigError`; `enabled: false` returns without
 * registering anything.
 */
export async function setupQuotaMatata(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
  // Throws ConfigError listing every issue (dotted paths) — never silent.
  const config: ResolvedConfig = resolveConfig(ctx.options as QuotaMatataConfig)
  if (!config.enabled) return

  const logger: DiagnosticLogger = createLogger(config.logging, { pluginVersion: PLUGIN_VERSION })
  const hostVersion = asString(tryRead(() => ctx.app.version))
  const registrations: Array<{ readonly dispose: () => Promise<void> }> = []
  const controller = new AbortController()
  let loop: Promise<void> | undefined
  let closed = false

  const pluginError = (message: string, cause: unknown, sessionID?: string): void => {
    try {
      logger.log({
        type: "plugin.error",
        message,
        error: cause,
        context: { sessionID, hostVersion, source: "plugin.adapter" },
      })
    } catch {
      // Logging must never break the host, even if the logger itself misbehaves.
    }
  }

  const onRetry = (input: SessionRetry): void => {
    // The host wraps this callback in Effect.promise, so ANY throw defects
    // the session execution. The entire body — reads, validation, metadata
    // formatting, evaluation, logging and decision application — stays
    // inside one no-throw boundary. On any failure the host keeps its native
    // decision object exactly as received (fail native).
    let sessionID = ""
    let context: LoggerContext | undefined
    try {
      // Snapshot before anything else.
      const original: DecisionSnapshot | undefined = tryRead(() =>
        input.decision.retry ? { retry: true, delay: input.decision.delay } : { retry: false },
      )
      sessionID = asString(tryRead(() => input.sessionID)) ?? ""
      const agent = asString(tryRead(() => input.agent))
      const provider = asString(tryRead(() => input.model.providerID)) ?? ""
      const model = asString(tryRead(() => input.model.id)) ?? ""
      const attempt = tryRead(() => input.attempt)
      // Validate BEFORE any coercion: a malformed/hostile non-number (e.g. a
      // throwing Symbol.toPrimitive/toString installed by another hook) must
      // never reach String()/template formatting. Only a finite number is
      // ever coerced below.
      const numericAttempt = typeof attempt === "number" && Number.isFinite(attempt) ? attempt : undefined
      const correlationId = numericAttempt === undefined ? `${sessionID}:retry` : `${sessionID}:${numericAttempt}`
      context = {
        sessionID,
        agent,
        provider,
        model,
        attempt: numericAttempt,
        hostVersion,
        source: "session.retry",
        correlationId,
      }
      // Unreadable native decision/attempt: fail native rather than
      // fabricate inputs for the engine.
      if (original === undefined) throw new TypeError("retry hook: native decision unreadable")
      if (numericAttempt === undefined) throw new TypeError("retry hook: attempt unreadable")
      const error = input.error
      const result = evaluateQuota(
        { provider, model, error, attempt: numericAttempt, decision: original, now: Date.now() },
        config,
      )
      const final: DecisionSnapshot =
        result.action === "retry"
          ? { retry: true, delay: result.delayMs }
          : result.action === "stop"
            ? { retry: false }
            : original
      // Every observed error is logged, including unknown categories. Both
      // records carry the classifier's stable rule identity and — only when a
      // provider-specific rule actually matched — the canonical matched
      // provider (R27-01). Generic/fallback rules leave `matched` unset; no
      // provider identity is fabricated. The logger sanitizes/bounds these
      // fields through its accepted path like any other string.
      const { ruleId, provider: matchedProvider } = result.classification
      logger.log({ type: "provider.error", context, error, category: result.category, rule: ruleId, matched: matchedProvider })
      logger.log({
        type: "retry.decision",
        context,
        category: result.category,
        rule: ruleId,
        matched: matchedProvider,
        original,
        final,
        policy: result.policy,
        delay: result.action === "retry" ? result.delayMs : undefined,
        reason: result.reason,
      })
      // Apply only validated overrides; no_override leaves the host object untouched.
      if (result.action === "retry") {
        if (Number.isInteger(result.delayMs) && result.delayMs >= 0 && result.delayMs <= MAX_DELAY_MS) {
          input.decision = { retry: true, delay: result.delayMs }
        } else {
          pluginError("engine returned an invalid delay; native decision preserved", undefined, sessionID)
        }
      } else if (result.action === "stop") {
        input.decision = { retry: false }
      }
      // No cross-surface correlation state is stored: the direct-hook record
      // above (provider.error + retry.decision) already carries the accurate
      // session/agent/model/attempt under correlationId `sessionID:attempt`.
      // Terminal events are logged independently (see handleEvent).
    } catch (cause) {
      // Classification/evaluation/logging failure: fail native, report safely.
      // The logger reduces plugin.error payloads to structural diagnostics;
      // raw Error message/stack never leak. The fallback context reuses only
      // values already read through guarded accessors — the hostile input is
      // never coerced again.
      try {
        logger.log({
          type: "provider.error",
          context: context ?? { sessionID, hostVersion, source: "session.retry", correlationId: `${sessionID}:retry` },
          error: tryRead(() => input.error),
        })
      } catch {
        // best effort only
      }
      pluginError("retry hook evaluation failed; native decision preserved", cause, sessionID)
    }
  }

  const onHttpResponse = (input: SessionHttpResponse): void => {
    try {
      const status = tryRead(() => input.response.status)
      if (typeof status !== "number" || !Number.isFinite(status) || status < 400) return
      const sessionID = asString(tryRead(() => input.sessionID)) ?? ""
      const agent = asString(tryRead(() => input.agent))
      const provider = asString(tryRead(() => input.model.providerID)) ?? ""
      const model = asString(tryRead(() => input.model.id)) ?? ""
      const kind = asString(tryRead(() => input.kind)) ?? "unknown"
      // Metadata only: status + Retry-After header. Never touch request, URLs,
      // headers beyond Retry-After, or the one-shot response body stream.
      const retryAfterMs = parseRetryAfter(
        asString(tryRead(() => input.response.headers.get("retry-after"))),
        Date.now(),
      )
      const correlationId = `${sessionID}:http:${kind}`
      logger.log({
        type: "provider.error",
        context: {
          sessionID,
          agent,
          provider,
          model,
          hostVersion,
          source: "session.http.response",
          correlationId,
        },
        error: { type: "http.error", status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
        reason: `metadata-only HTTP ${status} observation (kind ${kind}); no URL/request/response body is read; the same failure may also appear via session.retry or session.execution.failed (linked by sessionID)`,
      })
    } catch (cause) {
      pluginError("http.response observation failed; request unaffected", cause)
    }
  }

  const handleEvent = (event: OpenCodeEvent): void => {
    switch (event.type) {
      case "session.execution.failed": {
        const failed = event as TerminalFailed
        const sessionID = asString(tryRead(() => failed.data.sessionID)) ?? ""
        const error = tryRead(() => failed.data.error)
        // Context-free classification of the observed error (R27-01): the
        // terminal supplies no provider/model identity, so only generic rules
        // can match. The emitted rule id is the classifier's actual output for
        // THIS error — never a provider-specific rule or `matched` provider
        // borrowed from a retry/HTTP record. Pure and per-event: no
        // cross-surface state exists. normalizeError/classifyError are total,
        // but a hostile error shape may still throw on property reads; the
        // guard keeps the observation itself (logged without classification)
        // rather than losing it.
        const classification = tryRead(() => classifyError(normalizeError("", "", error as HostError), config))
        // A terminal event is an INDEPENDENT observation source. The host
        // supplies only { sessionID, error } here — no agent/model/attempt and
        // no execution identity — and the bus delivers it asynchronously
        // relative to the direct retry/HTTP hooks (publish order does not order
        // this subscriber against those hooks). There is no supported way to
        // prove which retry attempt or which execution a terminal failure
        // belongs to, so none is inferred: log exactly the fields the host
        // provides and link to the direct-hook records by sessionID only.
        // This is deliberately safe under arbitrary delivery order/backlog,
        // including a delayed old failure arriving after a newer execution's
        // retry hook. See specs/integration.md (correlation visibility).
        logger.log({
          type: "provider.error",
          context: {
            sessionID,
            hostVersion,
            source: "event.session.execution.failed",
            correlationId: `${sessionID}:terminal`,
          },
          error,
          ...(classification === undefined ? {} : { category: classification.category, rule: classification.ruleId }),
          reason:
            "terminal execution failure observed independently via session.execution.failed; the host supplies no agent/model/attempt or execution identity on terminal events, so none is inferred. Correlate with session.retry / session.http.response records by sessionID — those direct-hook records carry the accurate per-attempt context." +
            (classification === undefined
              ? ""
              : " Terminal classification is context-free: no provider identity is supplied, so only generic rules apply and no matched provider is attributed."),
        })
        break
      }
      default:
        // Only session.execution.failed is subscribed. Anything else (including
        // server.connected or lifecycle events if a host ever delivers them) is
        // ignored: success/start/interruption/deletion are not provider errors
        // and there is no correlation state to release.
        break
    }
  }

  const runEventLoop = (): Promise<void> =>
    (async () => {
      try {
        const stream = ctx.event.subscribe({ types: EVENT_TYPES, signal: controller.signal })
        for await (const event of stream) {
          if (closed) break
          try {
            handleEvent(event)
          } catch (cause) {
            pluginError("terminal event handling failed", cause)
          }
        }
      } catch (cause) {
        if (!closed) pluginError("event subscription failed; terminal observations may be missed", cause)
      }
    })()

  const cleanup: Plugin.Cleanup = async () => {
    if (closed) return
    closed = true
    controller.abort()
    for (const registration of registrations.splice(0)) {
      try {
        await registration.dispose()
      } catch (cause) {
        pluginError("hook dispose failed", cause)
      }
    }
    try {
      await loop
    } catch {
      // Loop failures are already reported; cleanup must not throw.
    }
    await logger.close()
  }

  try {
    registrations.push(await ctx.session.hook("retry", onRetry))
    registrations.push(await ctx.session.hook("http.response", onHttpResponse))
    loop = runEventLoop()
  } catch (cause) {
    // Partial setup failure: release everything acquired, then surface the error.
    await cleanup()
    throw cause
  }
  return cleanup
}