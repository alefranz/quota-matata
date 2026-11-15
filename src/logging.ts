/**
 * Privacy-safe, bounded JSONL diagnostics.
 *
 * Reusable logging module for the quota-matata core. It is deliberately NOT
 * wired to any OpenCode hook yet (adapter slice). Design rules:
 *
 * - Best effort: `log()` never throws into the caller (request path). Sink
 *   failures disable the sink after one safe `plugin.error` report attempt.
 * - Privacy first: provider free-text (message/body) is withheld unless
 *   `captureErrorDetails` is enabled; by default unknown provider payloads
 *   are reduced to a small allowlist of vetted structural fields. Everything
 *   that is logged is redacted and bounded — values AND object keys. Request
 *   prompts/conversation/request bodies are excluded recursively at every
 *   depth, for every event type, regardless of the capture flag. Response
 *   bodies are classified after BOM/whitespace normalization: structured
 *   input (JSON object/array/string prefix) is allowlist-reduced or fails
 *   closed (arrays, oversized, truncated/malformed) — never excerpted raw.
 *   Host wire wrappers are reduced through the host allowlist wherever they
 *   appear (including inside plugin/unknown errors). Plugin error payloads
 *   keep structural diagnostics only: arbitrary Error message/stack text is
 *   never dumped (the plugin's explicit top-level `message` field is the
 *   bounded diagnostic channel).
 *   The bounded queue holds only sanitized, serialized lines — never raw
 *   caller objects.
 * - Bounded memory/disk: fixed queue capacity (drop + report on overflow),
 *   per-event byte cap, per-instance rotation by maxSizeBytes/maxFiles.
 * - No shared write targets: each logger instance owns one file named with
 *   PID + instance counter + random suffix, so concurrent instances/processes
 *   cannot interleave or rotate each other's files. Old files from dead
 *   processes are never scanned or deleted (documented retention limit).
 * - No timers, services, databases or runtime dependencies; Node builtins only.
 *
 * See specs/logging.md for the event schema, bounds and threat model.
 */
// The build config uses `types: []`; this explicit reference makes the Node
// builtin module declarations available without changing the accepted config.
/// <reference types="node" />
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, rename, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { env, pid, platform } from "node:process"
import { parseBody } from "./classify.js"
import type { ResolvedLogging } from "./types.js"

/** Keep in sync with package.json "version". */
export const PLUGIN_VERSION = "0.1.0"

/** Hard cap for one serialized event line (bytes, UTF-8, excluding newline). */
export const MAX_EVENT_BYTES = 16_384
/** Maximum sanitized lines waiting for the serial sink; overflow is dropped. */
export const MAX_QUEUE_EVENTS = 256
/** Cap for any single sanitized string value (characters). */
export const MAX_STRING_CHARS = 2048

const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 32
const MAX_OBJECT_KEYS = 32
/** Total object/array nodes visited per sanitize call (DAG/explosion guard). */
const MAX_NODES = 2000
/** Strings longer than this are pre-truncated before redaction (CPU bound). */
const MAX_REDACT_CHARS = 65_536
/** Response bodies larger than this are never JSON-parsed (fail closed/text). */
const MAX_BODY_PARSE_CHARS = 65_536
const MAX_BODY_TEXT_CHARS = 1024
/**
 * Leading whitespace/BOM, normalized before classifying or parsing a body:
 * JSON.parse rejects a BOM, and leading noise must not hide a structured
 * prefix. Anchored — only the leading run is scanned, never the whole body.
 */
const BODY_LEAD_RE = /^[\s\uFEFF]*/
/** Cap for the sanitized opt-in body envelope (bytes). */
const MAX_PAYLOAD_BYTES = 8192
const MAX_CONTEXT_STRING_CHARS = 256
const MAX_DATE_MS = 8.64e15

const WITHHELD_MARKER = "[withheld: captureErrorDetails is disabled]"
/** Last-resort line; only reachable if even the minimal stub cannot serialize. */
const STATIC_FALLBACK =
  '{"type":"plugin.error","level":"error","message":"quota-matata: event serialization failed","truncated":true}'

export type LogLevel = ResolvedLogging["level"]
export type DiagnosticEventType = "provider.error" | "retry.decision" | "plugin.error"

/**
 * Optional correlation context. Nothing here is required: events without any
 * context are valid. `source` and `correlationId` exist so the later adapter
 * can deduplicate the same failure seen through different host surfaces
 * (e.g. the session.retry hook vs. an event-stream notification).
 */
export interface LoggerContext {
  readonly sessionID?: string
  readonly agent?: string
  readonly provider?: string
  readonly model?: string
  readonly attempt?: number
  /** OpenCode host version, supplied by the adapter when known. */
  readonly hostVersion?: string
  /** Origin surface, e.g. "session.retry" or "event.session.execution.failed". */
  readonly source?: string
  /** Caller-chosen key grouping events about the same failure. */
  readonly correlationId?: string
}

/**
 * Event input. Only `type` is meaningful; every other field is optional and
 * defensively validated/sanitized. Unknown error shapes are logged too.
 */
export interface DiagnosticEventInput {
  readonly type: DiagnosticEventType
  /** Defaults: provider.error=warn, retry.decision=info, plugin.error=error. */
  readonly level?: LogLevel
  readonly context?: LoggerContext
  /** HostError, Error, or any unknown value. Sanitized; never dumped as-is. */
  readonly error?: unknown
  /** plugin.error only: plugin-owned diagnostic text (sanitized, bounded). */
  readonly message?: string
  readonly category?: string
  /** Classifier rule id, e.g. "alibaba.quota_weekly". */
  readonly rule?: string
  /** Canonical provider whose rules matched, when provider-specific. */
  readonly matched?: string
  /** Native decision before the plugin: {retry, delay?}. */
  readonly original?: unknown
  /** Decision after the plugin: {retry, delay?}. */
  readonly final?: unknown
  /** Whether the plugin changed the native decision (computed when omitted). */
  readonly override?: boolean
  /** Policy path from the decision, e.g. "categories.quota_weekly". */
  readonly policy?: string
  /** Final retry delay in ms. */
  readonly delay?: number
  readonly reason?: string
}

export interface LoggerState {
  readonly enabled: boolean
  readonly closed: boolean
  readonly failed: boolean
  readonly written: number
  readonly dropped: number
  readonly filePath?: string
  readonly lastError?: string
}

export interface DiagnosticLogger {
  /** Enqueue one event. Never throws; drops silently when disabled/failed/full. */
  log(event: DiagnosticEventInput): void
  /** Resolves once all pending lines are written (or the sink has failed). */
  flush(): Promise<void>
  /** Flush, then ignore future events. Idempotent; deterministic cleanup. */
  close(): Promise<void>
  readonly state: LoggerState
}

// ---------------------------------------------------------------------------
// Redaction and bounded sanitization
// ---------------------------------------------------------------------------

const URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s"'<>\\]+)/gi
const BEARER_RE = /\b(bearer|basic)(\s+)[A-Za-z0-9\-._~+/]+=*/gi
const COOKIE_HEADER_RE = /\b(set-cookie|cookie)(\s*:\s*)[^\r\n]*/gi
// Credential key spellings for serialized text. Separator-terminated header
// prefixes are allowed so standard forms like "x-api-key", "set-cookie" and
// "x-amz-security-token" match, mirroring the structured-key normalization.
const SECRET_KEY =
  "(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|api[_-]?secret|client[_-]?secret|" +
  "access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|password|passwd|" +
  "authorization|credential|credentials|cookie)"
// Quoted values may be unterminated: truncation can cut a closing quote, and
// the redacted result must never reveal the secret prefix (match to end).
const SECRET_JSON_RE = new RegExp(`("${SECRET_KEY}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*(?:"|$)`, "gi")
const SECRET_KV_RE = new RegExp(`\\b(${SECRET_KEY})(\\s*[:=]\\s*)("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\\s"',;&}\\]]+)`, "gi")
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g
/** Normalized (lowercase, alphanumeric-only) object key credential match. */
const CREDENTIAL_KEY_RE =
  /apikey|accesstoken|refreshtoken|idtoken|authtoken|token|secret|password|passwd|authorization|cookie|credential|privatekey|accesskey|apisecret|clientsecret/i
/**
 * Request-data keys: stripped recursively at every depth, for every event
 * type and capture mode (the no-request-data invariant). Deliberately small
 * and structural — unknown payloads are handled by the allowlists, not by
 * enumerating prose. Normalized with `normalizeKey` before comparison.
 */
const REQUEST_DATA_KEYS = new Set([
  "prompt",
  "prompts",
  "messages",
  "conversation",
  "conversations",
  "history",
  "chathistory",
  "input",
  "inputs",
  "request",
  "requests",
  "requestbody",
  "requestdata",
])
/** Vetted structural string: short enum-like token, no whitespace/prose. */
const STRUCTURAL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** Cap for sanitized output object keys (plus a short collision suffix). */
const MAX_KEY_CHARS = 256
/** Maximum recursion depth for opt-in response-body envelope reduction. */
const MAX_ENVELOPE_DEPTH = 4

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Accept a string only as vetted structural evidence (code/type/request id):
 * enum-like shape, bounded, and stable under redaction (a credential-shaped
 * token is not a code). Anything else — free text, prose, secrets — is
 * withheld, never truncated into the log.
 */
function structuralToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !STRUCTURAL_TOKEN_RE.test(value)) return undefined
  return redactText(value) === value ? value : undefined
}

function validStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function validRetryAfterMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...[truncated]`
}

/**
 * Best-effort credential redaction for free text: URLs (userinfo, query,
 * fragment), bearer/basic tokens, cookie headers, key=value and JSON
 * "key": "value" secret forms (including header-prefixed spellings such as
 * x-api-key/set-cookie), and common key formats (sk-, AKIA, JWT). Quoted
 * secret forms also match unterminated values, so truncation can never leak
 * a secret prefix. Redaction is defense-in-depth, not a guarantee — unknown
 * secret formats may survive, which is why free text is withheld by default
 * and bounded.
 */
function redactText(input: string): string {
  let text = input
  if (text.length > MAX_REDACT_CHARS) {
    // CPU bound. Cut at the last whitespace inside the window so a partially
    // cut key=value token cannot survive; a quoted value cut mid-way is still
    // redacted by the unterminated-quote forms below.
    const head = text.slice(0, MAX_REDACT_CHARS)
    const partial = /\s\S*$/.exec(head)
    if (partial !== null) {
      text = head.slice(0, partial.index)
    } else {
      // No whitespace at all: hard cut. A delimiter that triggers redaction
      // (URL @, JWT dots, key-length minimums) may lie beyond the window, so
      // conservatively redact trailing partial URL/key fragments — a cut
      // secret prefix must never survive truncation.
      text = head
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\@]*$/i, "[redacted-url]")
        .replace(/\b(?:sk-[A-Za-z0-9_-]*|AKIA[0-9A-Z]*|eyJ[A-Za-z0-9_-]*)$/, "[redacted-key]")
    }
  }
  // URLs: strip userinfo, redact query values and fragments entirely.
  text = text.replace(URL_RE, (_match, scheme: string, rest: string) => {
    let out = rest
    const pathStart = out.search(/[/?#]/)
    const at = out.lastIndexOf("@")
    if (at !== -1 && (pathStart === -1 || at < pathStart)) out = `[redacted]@${out.slice(at + 1)}`
    out = out.replace(/\?[^#]*/, "?[redacted]").replace(/#.*/, "#[redacted]")
    return scheme + out
  })
  text = text.replace(BEARER_RE, (_match, scheme: string, space: string) => `${scheme}${space}[redacted]`)
  text = text.replace(COOKIE_HEADER_RE, (_match, name: string, sep: string) => `${name}${sep}[redacted]`)
  text = text.replace(SECRET_JSON_RE, (_match, prefix: string) => `${prefix}"[redacted]"`)
  text = text.replace(SECRET_KV_RE, (match, key: string, sep: string, value: string) =>
    value.startsWith("[redacted]") ? match : `${key}${sep}[redacted]`,
  )
  text = text.replace(SK_KEY_RE, "[redacted-key]").replace(AWS_KEY_RE, "[redacted-key]").replace(JWT_RE, "[redacted-jwt]")
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? truncate(redactText(value), max) : undefined
}

interface WalkBudget {
  nodes: number
}

/**
 * Convert an arbitrary unknown value into a bounded, redacted, JSON-safe
 * plain value. Total: cycles, hostile getters, proxies, exotic types and
 * explosive DAGs all degrade to markers instead of throwing or hanging.
 * Request-data keys are excluded at every depth regardless of capture, and
 * output keys are redacted/bounded like values (keys can carry secrets too).
 *
 * `optIn` selects the free-text policy:
 * - true  — the provider `captureErrorDetails` walker: Error message/stack
 *           are emitted redacted/bounded, and host wire wrappers keep
 *           sanitized opt-in body details.
 * - false — the plugin-owned walker: stable structural diagnostics only.
 *           Error message/stack are arbitrary text that may embed request
 *           payloads, so only the class name is kept; host wire wrappers
 *           reduce to structural fields. Explicit plugin diagnostic text
 *           belongs in the event's top-level `message` field instead.
 * Host wire wrappers (a `response` record) are never walked raw in either
 * mode: `response.body` may echo prompt/conversation/request data.
 */
function sanitizeValue(
  value: unknown,
  optIn: boolean,
  depth = 0,
  path = new Set<object>(),
  budget: WalkBudget = { nodes: 0 },
): unknown {
  if (value === null) return null
  const kind = typeof value
  if (kind === "string") return truncate(redactText(value as string), MAX_STRING_CHARS)
  if (kind === "number") return Number.isFinite(value as number) ? value : String(value)
  if (kind === "boolean") return value
  if (kind === "bigint") return String(value)
  if (kind !== "object") return undefined // undefined, function, symbol: omitted
  const obj = value as object
  if (path.has(obj)) return "[circular]"
  if (depth >= MAX_DEPTH) return "[max-depth]"
  if (budget.nodes >= MAX_NODES) return "[truncated]"
  budget.nodes++
  path.add(obj)
  try {
    if (Array.isArray(obj)) {
      const out: unknown[] = []
      const len = Math.min(obj.length, MAX_ARRAY_ITEMS)
      for (let i = 0; i < len; i++) {
        const item = sanitizeValue(obj[i], optIn, depth + 1, path, budget)
        out.push(item === undefined ? null : item)
      }
      if (obj.length > MAX_ARRAY_ITEMS) out.push(`...[+${obj.length - MAX_ARRAY_ITEMS} more]`)
      return out
    }
    // Host wire wrappers are reduced through the host allowlist, never walked
    // raw: response.body may echo prompt/conversation/request data (R11-01).
    let hostWrapper = false
    try {
      hostWrapper = isRecord((obj as Record<string, unknown>).response)
    } catch {
      return "[unreadable]"
    }
    if (hostWrapper) {
      try {
        return reduceHostError(obj as Record<string, unknown>, optIn)
      } catch {
        return "[unreadable]"
      }
    }
    // Null-prototype output: JSON-origin keys like __proto__ are plain own
    // properties, never prototype traps. Keys are redacted/bounded and
    // collision-suffixed; sensitivity is detected against the ORIGINAL key.
    const out: Record<string, unknown> = Object.create(null)
    const usedKeys = new Set<string>()
    const emit = (key: string, cleaned: unknown): void => {
      if (cleaned === undefined) return
      let safe = truncate(redactText(key), MAX_KEY_CHARS)
      if (safe === "") safe = "[empty-key]"
      let candidate = safe
      for (let n = 2; usedKeys.has(candidate); n++) candidate = `${safe}~${n}`
      usedKeys.add(candidate)
      out[candidate] = cleaned
    }
    // Error.name lives on the prototype and message/stack are non-enumerable
    // own properties; capture them explicitly (cross-realm errors are
    // duck-typed). The class name is structural and always kept; message/stack
    // are arbitrary free text that may embed request payloads, so they are
    // emitted only by the provider opt-in walker (redacted/bounded), never by
    // the plugin-owned walker. Request-data exclusions still apply below.
    let errorLike = false
    try {
      const rec = obj as Record<string, unknown>
      errorLike = obj instanceof Error || (typeof rec.name === "string" && typeof rec.message === "string")
      if (errorLike) {
        if (typeof rec.name === "string") emit("name", truncate(redactText(rec.name), 128))
        if (optIn) {
          if (typeof rec.message === "string") emit("message", truncate(redactText(rec.message), MAX_STRING_CHARS))
          if (typeof rec.stack === "string") emit("stack", truncate(redactText(rec.stack), MAX_STRING_CHARS))
        }
      }
    } catch {
      /* fall through to generic key walk */
    }
    let keys: string[]
    try {
      keys = Object.keys(obj)
    } catch {
      return "[unreadable]"
    }
    const limit = Math.min(keys.length, MAX_OBJECT_KEYS)
    for (let i = 0; i < limit; i++) {
      const key = keys[i]
      if (key === undefined) continue
      if (errorLike && (key === "name" || key === "message" || key === "stack")) continue
      const normalized = normalizeKey(key)
      if (REQUEST_DATA_KEYS.has(normalized)) continue
      if (CREDENTIAL_KEY_RE.test(normalized)) {
        emit(key, "[redacted]")
        continue
      }
      let raw: unknown
      try {
        raw = (obj as Record<string, unknown>)[key]
      } catch {
        emit(key, "[unreadable]")
        continue
      }
      emit(key, sanitizeValue(raw, optIn, depth + 1, path, budget))
    }
    if (keys.length > MAX_OBJECT_KEYS) emit("[truncated]", `${keys.length - MAX_OBJECT_KEYS} more keys`)
    return out
  } catch {
    return "[unreadable]"
  } finally {
    path.delete(obj)
  }
}

/**
 * Default (capture-off) reduction of unknown provider error shapes: a small
 * allowlist of vetted structural fields only — code/type/requestId as
 * enum-like tokens, status, retryAfterMs, and recognized `error` envelopes
 * reduced recursively with the same allowlist. Unknown keys are withheld
 * without being read (hostile-getter safe); free text never enters the log.
 */
function structuralSummary(
  obj: object,
  depth = 0,
  path = new Set<object>(),
  budget: WalkBudget = { nodes: 0 },
): Record<string, unknown> | string {
  if (path.has(obj)) return "[circular]"
  if (depth >= MAX_DEPTH) return "[max-depth]"
  if (budget.nodes >= MAX_NODES) return "[truncated]"
  budget.nodes++
  path.add(obj)
  try {
    const rec = obj as Record<string, unknown>
    const out: Record<string, unknown> = Object.create(null)
    // Error class names are structural; message/stack are free text (withheld).
    try {
      if (obj instanceof Error || (typeof rec.name === "string" && typeof rec.message === "string")) {
        const name = structuralToken(rec.name)
        if (name !== undefined) out.name = name
      }
    } catch {
      /* hostile name/message getters: fall through to the key walk */
    }
    let keys: string[]
    try {
      keys = Object.keys(obj)
    } catch {
      return "[unreadable]"
    }
    const limit = Math.min(keys.length, MAX_OBJECT_KEYS)
    for (let i = 0; i < limit; i++) {
      const key = keys[i]
      if (key === undefined) continue
      const normalized = normalizeKey(key)
      if (REQUEST_DATA_KEYS.has(normalized)) continue
      if (
        normalized !== "code" &&
        normalized !== "type" &&
        normalized !== "status" &&
        normalized !== "retryafterms" &&
        normalized !== "requestid" &&
        normalized !== "error"
      ) {
        continue
      }
      let raw: unknown
      try {
        raw = rec[key]
      } catch {
        continue
      }
      if (normalized === "status") {
        const status = validStatus(raw)
        if (status !== undefined && out.status === undefined) out.status = status
      } else if (normalized === "retryafterms") {
        const retryAfterMs = validRetryAfterMs(raw)
        if (retryAfterMs !== undefined && out.retryAfterMs === undefined) out.retryAfterMs = retryAfterMs
      } else if (normalized === "error") {
        if (isRecord(raw) && out.error === undefined) out.error = structuralSummary(raw, depth + 1, path, budget)
      } else {
        const canonical = normalized === "requestid" ? "requestId" : normalized
        const token = structuralToken(raw)
        if (token !== undefined && out[canonical] === undefined) out[canonical] = token
      }
    }
    return out
  } catch {
    return "[unreadable]"
  } finally {
    path.delete(obj)
  }
}

/**
 * Index of the first significant body character after leading whitespace/BOM.
 * A BOM must not hide a structured prefix, and `JSON.parse` rejects a BOM, so
 * classification and bounded parsing both operate on the normalized body.
 */
function bodyContentStart(body: string): number {
  const lead = BODY_LEAD_RE.exec(body)
  return lead === null ? 0 : lead[0].length
}

/**
 * Sanitized opt-in response-body details, classified BEFORE any excerpting.
 * After BOM/whitespace normalization, a body whose first significant character
 * opens a JSON object, array, or string (`{`, `[`, `"`) is STRUCTURED input:
 * it is reduced through the envelope allowlist (parsed record), kept as
 * bounded redacted free text (a cleanly parsed JSON string scalar), or FAILS
 * CLOSED (array, oversized, or truncated/malformed so it cannot be parsed).
 * Structured input is never stringified-then-redacted as a raw excerpt, because
 * a truncated or BOM-prefixed envelope could echo prompt/conversation/request
 * data (R15, remaining R11-01). Everything else is plain diagnostic text and
 * keeps a bounded redacted excerpt. Bodies beyond the parse bound are never
 * JSON-parsed. Only called with captureErrorDetails enabled.
 */
function bodyDetails(body: string): unknown {
  const start = bodyContentStart(body)
  const first = start < body.length ? body[start] : ""
  const structured = first === "{" || first === "[" || first === '"'
  if (body.length > MAX_BODY_PARSE_CHARS) {
    // Oversized: never parse (R11-04). Structured input fails closed; only
    // plain free text keeps a bounded redacted excerpt. Redact BEFORE
    // truncating so a cut quoted credential can never leak its prefix.
    if (structured) return { withheld: true, note: "oversized response body exceeds the parse bound" }
    return { text: truncate(redactText(body), MAX_BODY_TEXT_CHARS) }
  }
  if (structured) {
    // Normalize the BOM/lead so valid prefixed JSON parses; a parse failure
    // (truncated/malformed) fails closed rather than excerpting request data.
    let parsed: unknown
    try {
      parsed = JSON.parse(start === 0 ? body : body.slice(start))
    } catch {
      return { withheld: true, note: "structured response body could not be parsed safely" }
    }
    if (isRecord(parsed)) {
      try {
        const cleaned = reduceBodyEnvelope(parsed, 0)
        const json = safeStringify(cleaned)
        if (json !== undefined && Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES) return cleaned
        return { truncated: true, note: `error details exceed ${MAX_PAYLOAD_BYTES} bytes` }
      } catch {
        return { truncated: true, note: "error details could not be sanitized" }
      }
    }
    if (typeof parsed === "string") {
      // A cleanly parsed JSON string scalar is free text (the supported opt-in
      // text channel), not a nested envelope that could carry request fields.
      return { text: truncate(redactText(body), MAX_BODY_TEXT_CHARS) }
    }
    // Arrays are not a supported error-envelope shape: fail closed instead
    // of excerpting raw JSON that may contain request data (R11-01).
    return { withheld: true, note: "array response bodies are not supported" }
  }
  // Plain diagnostic text (not structured JSON): bounded, redacted free text.
  return { text: truncate(redactText(body), MAX_BODY_TEXT_CHARS) }
}

/**
 * Recursive allowlist reduction of recognized provider error envelopes
 * (DashScope/OpenAI style). code/type/request ids must be vetted structural
 * tokens; message is opt-in free text (redacted, bounded); nested `error`
 * records recurse with the same allowlist. Every other field — prompt,
 * messages, request, choices, arbitrary prose — is dropped, never walked.
 */
function reduceBodyEnvelope(rec: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const key of ["code", "message", "type", "status", "error", "request_id", "requestId"]) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) continue
    const value = rec[key]
    if (key === "status") {
      const status = validStatus(value)
      if (status !== undefined) out.status = status
    } else if (key === "message") {
      if (typeof value === "string") out.message = truncate(redactText(value), MAX_STRING_CHARS)
    } else if (key === "error") {
      if (isRecord(value) && depth + 1 < MAX_ENVELOPE_DEPTH) out.error = reduceBodyEnvelope(value, depth + 1)
      else if (typeof value === "string") out.error = truncate(redactText(value), MAX_STRING_CHARS)
    } else {
      const token = structuralToken(value)
      if (token !== undefined) out[key] = token
    }
  }
  return out
}

/**
 * Allowlist reduction of a host wire error (`type`/`response` markers).
 * Structural fields (vetted type token, status, retryAfterMs, and the provider
 * code parsed from the body within the parse bound) are always kept; the
 * opt-in free-text message and sanitized body details only when `capture` is
 * true. The response body itself is NEVER copied raw: it goes through
 * `bodyDetails`, which fails closed on unsupported structured shapes. Shared
 * by the top-level provider path and by wrapped host errors found inside
 * unknown/plugin payloads (R11-01). Property reads may throw on hostile
 * getters; callers catch and degrade to `[unreadable]`.
 */
function reduceHostError(rec: Record<string, unknown>, capture: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  const type = typeof rec.type === "string" ? rec.type : undefined
  const typeToken = structuralToken(type)
  if (typeToken !== undefined) out.type = typeToken
  const status = validStatus(rec.status)
  if (status !== undefined) out.status = status
  const retryAfterMs = validRetryAfterMs(rec.retryAfterMs)
  if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs
  const response = rec.response
  let body: string | undefined
  if (isRecord(response) && typeof response.body === "string" && response.body !== "") body = response.body
  // The parse bound applies BEFORE any JSON work, including capture-off
  // code extraction; oversized bodies keep only the host structural fields.
  // Normalize the BOM/lead so a BOM-prefixed envelope still yields its vetted
  // code (JSON.parse rejects a BOM); this never widens the bound.
  if (body !== undefined && body.length <= MAX_BODY_PARSE_CHARS) {
    const start = bodyContentStart(body)
    const code = structuralToken(parseBody(start === 0 ? body : body.slice(start)).code)
    if (code !== undefined) out.code = code
  }
  if (capture) {
    const message = typeof rec.message === "string" ? rec.message : undefined
    if (message !== undefined) out.message = truncate(redactText(message), MAX_STRING_CHARS)
    if (body !== undefined) out.details = bodyDetails(body)
  }
  return out
}

/**
 * Provider error summary. Structural host fields (type/status/retryAfterMs
 * and the short provider code parsed from the body) are always kept; the
 * original provider free-text payload (message/body) only when capture is
 * enabled — sanitized and bounded. Unknown shapes degrade to the structural
 * allowlist by default; request data is excluded on every path.
 */
function providerErrorField(error: unknown, capture: boolean): unknown {
  try {
    if (typeof error === "string") return capture ? truncate(redactText(error), MAX_STRING_CHARS) : WITHHELD_MARKER
    if (error === null || typeof error !== "object") return sanitizeValue(error, true)
    if (Array.isArray(error)) return capture ? sanitizeValue(error, true) : WITHHELD_MARKER
    const rec = error as Record<string, unknown>
    const type = typeof rec.type === "string" ? rec.type : undefined
    const hasResponse = isRecord(rec.response)
    // Only the host wire shape (type/response markers) gets structured
    // extraction. Error instances and unknown objects use the structural
    // allowlist by default, or the bounded opt-in walker (request-data
    // exclusion and host-wrapper reduction apply in both modes).
    if (type === undefined && !hasResponse) {
      return capture ? sanitizeValue(error, true) : structuralSummary(error)
    }
    return reduceHostError(rec, capture)
  } catch {
    return "[unreadable]"
  }
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function safeErrorText(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return truncate(redactText(message), 512)
  } catch {
    return "unknown error"
  }
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }
const DEFAULT_LEVEL: Readonly<Record<DiagnosticEventType, LogLevel>> = {
  "provider.error": "warn",
  "retry.decision": "info",
  "plugin.error": "error",
}

interface BuildOptions {
  readonly level: LogLevel
  readonly capture: boolean
  readonly pluginVersion: string
}

function nativeDecision(value: unknown): { retry: boolean; delay?: number } | undefined {
  if (!isRecord(value) || typeof value.retry !== "boolean") return undefined
  const delay = value.delay
  return typeof delay === "number" && Number.isFinite(delay) && delay >= 0
    ? { retry: value.retry, delay }
    : { retry: value.retry }
}

/** Fields dropped, in order, when an event exceeds MAX_EVENT_BYTES. */
const DROP_PATHS: readonly (readonly string[])[] = [
  ["error", "details"],
  ["error", "message"],
  ["error"],
  ["reason"],
  ["message"],
  ["context"],
]

function dropField(event: Record<string, unknown>, path: readonly string[]): void {
  let current: unknown = event
  for (let i = 0; i < path.length - 1; i++) {
    if (!isRecord(current)) return
    current = current[path[i] as string]
  }
  const last = path[path.length - 1]
  if (last !== undefined && isRecord(current)) delete current[last]
}

/** Serialize within MAX_EVENT_BYTES, dropping optional fields progressively. */
function fitEvent(event: Record<string, unknown>): string {
  let json = safeStringify(event)
  if (json !== undefined && Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json
  for (const path of DROP_PATHS) {
    dropField(event, path)
    event.truncated = true
    json = safeStringify(event)
    if (json !== undefined && Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json
  }
  const stub = {
    id: event.id,
    ts: event.ts,
    type: event.type,
    level: event.level,
    pluginVersion: event.pluginVersion,
    truncated: true,
  }
  return safeStringify(stub) ?? STATIC_FALLBACK
}

/**
 * Build one sanitized JSONL line (without trailing newline), or null when the
 * event is below the configured level. Total: any input, including null or
 * hostile objects, produces a line or a safe fallback — never a throw.
 */
function buildEventLine(input: unknown, opts: BuildOptions): string | null {
  try {
    const rec = isRecord(input) ? input : {}
    const rawType = rec.type
    const type: DiagnosticEventType =
      rawType === "provider.error" || rawType === "retry.decision" || rawType === "plugin.error"
        ? rawType
        : "plugin.error"
    const rawLevel = rec.level
    const level: LogLevel =
      typeof rawLevel === "string" && rawLevel in LEVEL_ORDER ? (rawLevel as LogLevel) : DEFAULT_LEVEL[type]
    if (LEVEL_ORDER[level] < LEVEL_ORDER[opts.level]) return null

    const now = Date.now()
    const event: Record<string, unknown> = Object.create(null)
    event.id = randomUUID()
    event.ts = new Date(now).toISOString()
    event.type = type
    event.level = level
    event.pluginVersion = opts.pluginVersion

    const ctx = isRecord(rec.context) ? rec.context : undefined
    if (ctx !== undefined) {
      const context: Record<string, unknown> = Object.create(null)
      for (const key of ["sessionID", "agent", "provider", "model"]) {
        const value = boundedString(ctx[key], MAX_CONTEXT_STRING_CHARS)
        if (value !== undefined) context[key] = value
      }
      if (typeof ctx.attempt === "number" && Number.isFinite(ctx.attempt) && ctx.attempt >= 0) {
        context.attempt = Math.floor(ctx.attempt)
      }
      if (Object.keys(context).length > 0) event.context = context
      const hostVersion = boundedString(ctx.hostVersion, 64)
      if (hostVersion !== undefined) event.hostVersion = hostVersion
      const source = boundedString(ctx.source, 128)
      if (source !== undefined) event.source = source
      const correlationId = boundedString(ctx.correlationId, MAX_CONTEXT_STRING_CHARS)
      if (correlationId !== undefined) event.correlationId = correlationId
    }

    if (rec.error !== undefined) {
      // plugin.error carries plugin-owned failures: the bounded walker in
      // structural mode (never gated by capture) — Error message/stack are
      // withheld, host wire wrappers reduce to structural fields, and
      // request-data exclusion applies recursively. Explicit plugin
      // diagnostic text belongs in the top-level `message` field below.
      // Provider payloads are gated by captureErrorDetails.
      event.error = type === "plugin.error" ? sanitizeValue(rec.error, false) : providerErrorField(rec.error, opts.capture)
    }
    for (const key of ["category", "rule", "matched", "policy"]) {
      const value = boundedString(rec[key], MAX_CONTEXT_STRING_CHARS)
      if (value !== undefined) event[key] = value
    }
    const reason = boundedString(rec.reason, MAX_STRING_CHARS)
    if (reason !== undefined) event.reason = reason
    if (type === "plugin.error") {
      const message = boundedString(rec.message, MAX_STRING_CHARS)
      if (message !== undefined) event.message = message
    }

    const original = nativeDecision(rec.original)
    if (original !== undefined) event.original = original
    const final = nativeDecision(rec.final)
    if (final !== undefined) event.final = final
    if (typeof rec.override === "boolean") event.override = rec.override
    else if (original !== undefined && final !== undefined) {
      event.override = original.retry !== final.retry || original.delay !== final.delay
    }
    let delay: number | undefined
    if (typeof rec.delay === "number" && Number.isFinite(rec.delay) && rec.delay >= 0) {
      delay = rec.delay
      event.delay = delay
    } else if (final !== undefined && final.retry && final.delay !== undefined) {
      delay = final.delay
    }
    if (final !== undefined && final.retry && delay !== undefined) {
      const at = now + delay
      if (Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS) event.nextRetryAt = new Date(at).toISOString()
    }
    return fitEvent(event)
  } catch {
    return STATIC_FALLBACK
  }
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * User-data default: $XDG_DATA_HOME when set, otherwise the platform's normal
 * per-user data location, then `quota-matata/logs`. Pure and injectable for
 * tests; no filesystem access.
 */
export function defaultLogDirectory(
  envOverride: Readonly<Record<string, string | undefined>> = env,
  platformOverride: string = platform,
  homeOverride: string = homedir(),
): string {
  const xdg = envOverride.XDG_DATA_HOME
  let base: string
  if (typeof xdg === "string" && xdg.trim() !== "") base = xdg
  else if (platformOverride === "darwin") base = join(homeOverride, "Library", "Application Support")
  else if (platformOverride === "win32") {
    base = envOverride.LOCALAPPDATA ?? envOverride.APPDATA ?? join(homeOverride, "AppData", "Local")
  } else base = join(homeOverride, ".local", "share")
  return join(base, "quota-matata", "logs")
}

/** Expand a leading `~` and resolve to an absolute path. */
function resolveDirectory(dir: string | undefined): string {
  if (dir === undefined) return defaultLogDirectory()
  if (dir === "~") return homedir()
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return resolve(homedir(), dir.slice(2))
  return resolve(dir)
}

// ---------------------------------------------------------------------------
// Sink: serial bounded append queue, per-instance rotation
// ---------------------------------------------------------------------------

async function unlinkMaybe(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
  }
}

async function renameMaybe(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error
  }
}

class JsonlSink implements DiagnosticLogger {
  private readonly queue: string[] = []
  private draining: Promise<void> | null = null
  private closed = false
  private failed = false
  private dirReady = false
  private currentBytes = 0
  private written = 0
  private dropped = 0
  private lastError: string | undefined

  constructor(
    private readonly filePath: string,
    private readonly directory: string,
    private readonly maxSizeBytes: number,
    private readonly maxFiles: number,
    private readonly buildLine: (input: unknown) => string | null,
  ) {}

  log(event: DiagnosticEventInput): void {
    try {
      if (this.closed || this.failed) return
      // Sanitize + serialize synchronously: the queue only ever holds bounded
      // sanitized strings, never references to caller objects (no retention
      // of prompts/bodies, bounded memory: MAX_QUEUE_EVENTS × MAX_EVENT_BYTES).
      const line = this.buildLine(event)
      if (line === null) return
      if (this.queue.length >= MAX_QUEUE_EVENTS) {
        this.dropped++
        return
      }
      this.queue.push(line)
      if (this.draining === null) this.draining = this.drain()
    } catch {
      this.dropped++
    }
  }

  async flush(): Promise<void> {
    while (this.draining !== null) await this.draining
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  get state(): LoggerState {
    return {
      enabled: true,
      closed: this.closed,
      failed: this.failed,
      written: this.written,
      dropped: this.dropped,
      filePath: this.filePath,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        if (this.dropped > 0) {
          const count = this.dropped
          this.dropped = 0
          const line = this.buildLine({
            type: "plugin.error",
            message: `logging queue overflow: ${count} event(s) dropped`,
          })
          if (line !== null) await this.writeLine(line)
        }
        if (this.queue.length === 0) break
        const line = this.queue.shift()
        if (line === undefined) break
        await this.writeLine(line)
      }
    } catch (error) {
      await this.fail(error)
    } finally {
      this.draining = null
    }
  }

  /**
   * Permanent failure isolation: record the error, discard pending lines, and
   * attempt exactly one plugin.error report (no recursive logging, no retry
   * loops). Never throws.
   */
  private async fail(error: unknown): Promise<void> {
    if (this.failed) return
    this.failed = true
    this.lastError = safeErrorText(error)
    this.dropped += this.queue.length
    this.queue.length = 0
    try {
      const line = this.buildLine({ type: "plugin.error", message: `logging sink failed: ${this.lastError}` })
      if (line !== null) await this.writeLine(line)
    } catch {
      /* report not feasible; state.lastError still exposes the failure */
    }
  }

  private async writeLine(line: string): Promise<void> {
    await this.ensureDirectory()
    await this.checkFile()
    const bytes = Buffer.byteLength(line) + 1
    if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxSizeBytes) await this.rotate()
    await appendFile(this.filePath, `${line}\n`, { flag: "a", mode: 0o600 })
    this.currentBytes += bytes
    this.written++
  }

  private async ensureDirectory(): Promise<void> {
    if (this.dirReady) return
    // Mode applies to directories we create only; existing directories are
    // never chmod'ed. Refuse symlinked log directories (lstat does not follow).
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const st = await lstat(this.directory)
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error("log directory is not a real directory (symlink refused)")
    }
    try {
      const fst = await stat(this.filePath)
      if (fst.isFile()) this.currentBytes = fst.size
    } catch {
      /* file does not exist yet */
    }
    this.dirReady = true
  }

  /** Refuse pre-planted symlinks/non-regular files at our own path. */
  private async checkFile(): Promise<void> {
    try {
      const st = await lstat(this.filePath)
      if (!st.isFile()) throw new Error("log file path is not a regular file (symlink refused)")
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error
    }
  }

  /**
   * Rotate only this instance's own exact file names. Total files per
   * instance ≤ maxFiles; a single event may exceed maxSizeBytes (rotation
   * happens before the next append), so the per-file bound is
   * maxSizeBytes + one event.
   */
  private async rotate(): Promise<void> {
    if (this.maxFiles <= 1) {
      await unlinkMaybe(this.filePath)
      this.currentBytes = 0
      return
    }
    await unlinkMaybe(`${this.filePath}.${this.maxFiles - 1}`)
    for (let k = this.maxFiles - 2; k >= 1; k--) {
      await renameMaybe(`${this.filePath}.${k}`, `${this.filePath}.${k + 1}`)
    }
    await rename(this.filePath, `${this.filePath}.1`)
    this.currentBytes = 0
  }
}

function disabledLogger(): DiagnosticLogger {
  const noop = async (): Promise<void> => {}
  return {
    log: () => {},
    flush: noop,
    close: noop,
    get state(): LoggerState {
      return { enabled: false, closed: false, failed: false, written: 0, dropped: 0 }
    },
  }
}

let instanceCounter = 0

/**
 * Create a diagnostics logger from the resolved core logging config.
 * `enabled: false` (the default) returns an inert logger: no directory is
 * created and nothing touches the disk. Creation itself performs no I/O;
 * the directory is created lazily on the first write (0700, files 0600 where
 * the platform supports modes). Never throws.
 */
export function createLogger(logging: ResolvedLogging, options?: { readonly pluginVersion?: string }): DiagnosticLogger {
  try {
    const pluginVersion = boundedString(options?.pluginVersion, 64) ?? PLUGIN_VERSION
    if (!isRecord(logging) || logging.enabled !== true) return disabledLogger()
    const level: LogLevel = logging.level in LEVEL_ORDER ? logging.level : "info"
    const capture = logging.captureErrorDetails === true
    const directory = resolveDirectory(
      typeof logging.directory === "string" && logging.directory.trim() !== "" ? logging.directory : undefined,
    )
    const rotation: Record<string, unknown> = isRecord(logging.rotation) ? logging.rotation : {}
    const maxSizeBytes =
      typeof rotation.maxSizeBytes === "number" && Number.isInteger(rotation.maxSizeBytes) && rotation.maxSizeBytes >= 1
        ? rotation.maxSizeBytes
        : 1_048_576
    const maxFiles =
      typeof rotation.maxFiles === "number" && Number.isInteger(rotation.maxFiles) && rotation.maxFiles >= 1
        ? rotation.maxFiles
        : 5
    // Per-instance file: PID + process-local counter + random suffix. Live
    // instances/processes never share a write target; dead processes' files
    // are left alone (retention scope is per instance, see specs/logging.md).
    const fileName = `quota-matata-${pid}-${instanceCounter++}-${randomUUID().slice(0, 8)}.jsonl`
    const filePath = join(directory, fileName)
    const buildLine = (input: unknown): string | null => buildEventLine(input, { level, capture, pluginVersion })
    return new JsonlSink(filePath, directory, maxSizeBytes, maxFiles, buildLine)
  } catch {
    return disabledLogger()
  }
}
