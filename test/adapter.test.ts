/**
 * Adapter boundary tests against the REAL published @opencode/plugin@2.3.0
 * types. The fake host below implements the actual SDK signatures
 * (ModelHooks<SessionHooks>, EventDomain.subscribe with AbortSignal semantics,
 * wire-envelope OpenCodeEvent shapes); no hook API is hand-invented.
 *
 * Logging assertions read real JSONL files written by the accepted logger.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import type { Plugin } from "@opencode/plugin"
import type { ModelHooks, ModelHookOptions, Registration } from "@opencode/plugin/promise/registration"
import type { SessionHooks, SessionHttpResponse, SessionRetry } from "@opencode/plugin/promise/session"
import type { EventDomain } from "@opencode/plugin/promise/event"
import type { OpenCodeEvent } from "@opencode/client"
import { ConfigError } from "../src/config.js"
import { setupQuotaMatata } from "../src/adapter.js"
import { nextWeeklyResetUtc8Ms } from "../src/policy.js"

// ---------------------------------------------------------------------------
// Fixtures typed with the real SDK shapes
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.UTC(2026, 10, 18, 4, 30, 0, 0) // a Wednesday, UTC+8 mid-week
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-adapter-"))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort cleanup
    }
  }
})

function withFixedNow<T>(fn: () => T): T {
  const real = Date.now
  Date.now = () => FIXED_NOW
  try {
    return fn()
  } finally {
    Date.now = real
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

const WEEKLY_BODY = '{"error":{"message":"week allocated quota exceeded","code":"Throttling.AllocationQuota"}}'

function weeklyError(): SessionRetry["error"] {
  return {
    type: "provider.quota",
    message: "429 Too Many Requests",
    status: 429,
    response: { body: WEEKLY_BODY },
  }
}

function makeRetry(overrides: {
  sessionID?: string
  agent?: string
  providerID?: string
  modelID?: string
  error?: SessionRetry["error"]
  attempt?: number
  decision?: SessionRetry["decision"]
}): SessionRetry {
  return {
    sessionID: overrides.sessionID ?? "ses_1",
    agent: overrides.agent ?? "build",
    model: { providerID: overrides.providerID ?? "alibaba", id: overrides.modelID ?? "qwen3-max" },
    error: overrides.error ?? weeklyError(),
    attempt: overrides.attempt ?? 2,
    decision: overrides.decision ?? { retry: false },
  } as SessionRetry
}

type FailedEvent = Extract<OpenCodeEvent, { type: "session.execution.failed" }>
type InterruptedEvent = Extract<OpenCodeEvent, { type: "session.execution.interrupted" }>
type DeletedEvent = Extract<OpenCodeEvent, { type: "session.deleted" }>
type StartedEvent = Extract<OpenCodeEvent, { type: "session.execution.started" }>
type SucceededEvent = Extract<OpenCodeEvent, { type: "session.execution.succeeded" }>

function failedEvent(sessionID: string, error: SessionRetry["error"]): FailedEvent {
  return {
    id: "evt_failed",
    created: FIXED_NOW,
    type: "session.execution.failed",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, error },
  } as FailedEvent
}

function interruptedEvent(sessionID: string, reason: InterruptedEvent["data"]["reason"]): InterruptedEvent {
  return {
    id: "evt_interrupted",
    created: FIXED_NOW,
    type: "session.execution.interrupted",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID, reason },
  } as InterruptedEvent
}

function deletedEvent(sessionID: string): DeletedEvent {
  return {
    id: "evt_deleted",
    created: FIXED_NOW,
    type: "session.deleted",
    durable: { aggregateID: sessionID, seq: 3, version: 2 },
    data: { sessionID },
  } as DeletedEvent
}

function startedEvent(sessionID: string): StartedEvent {
  return {
    id: "evt_started",
    created: FIXED_NOW,
    type: "session.execution.started",
    durable: { aggregateID: sessionID, seq: 4, version: 1 },
    data: { sessionID },
  } as StartedEvent
}

function succeededEvent(sessionID: string): SucceededEvent {
  return {
    id: "evt_succeeded",
    created: FIXED_NOW,
    type: "session.execution.succeeded",
    durable: { aggregateID: sessionID, seq: 5, version: 1 },
    data: { sessionID },
  } as SucceededEvent
}

// ---------------------------------------------------------------------------
// Fake host: real SDK signatures, real abort/iterator semantics
// ---------------------------------------------------------------------------

/**
 * Fake of the in-process Promise-plugin event route (plugin
 * `promise/adapter.ts` makeStreams → core `plugin/host.ts` → `bus.ts`
 * unbounded PubSub): types filter, abort closes the iterator and resolves
 * any pending next() with done, iterator.return() finishes, stream errors
 * reject pending next(). No capacity bound exists on this route.
 */
class FakeEventBus {
  readonly subscribeCalls: Array<{ types?: readonly string[]; signal?: AbortSignal }> = []
  activeIterators = 0
  private readonly subscribers = new Set<{
    push: (event: OpenCodeEvent) => void
    fail: (error: unknown) => void
  }>()

  push(event: OpenCodeEvent): void {
    for (const subscriber of [...this.subscribers]) subscriber.push(event)
  }

  failAll(error: unknown): void {
    for (const subscriber of [...this.subscribers]) subscriber.fail(error)
  }

  readonly subscribe: EventDomain["subscribe"] = ((options?: {
    types?: readonly string[]
    signal?: AbortSignal
  }) => {
    this.subscribeCalls.push({ types: options?.types, signal: options?.signal })
    const types = options?.types?.length ? new Set<string>(options.types) : undefined
    const signal = options?.signal
    const bus = this
    return {
      [Symbol.asyncIterator]() {
        bus.activeIterators++
        const queued: OpenCodeEvent[] = []
        let pending: ((result: IteratorResult<OpenCodeEvent>) => void) | undefined
        let pendingReject: ((error: unknown) => void) | undefined
        let failure: unknown
        let hasFailure = false
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          bus.activeIterators--
          bus.subscribers.delete(subscriber)
          signal?.removeEventListener("abort", onAbort)
          queued.length = 0
          if (pending) {
            const resolve = pending
            pending = undefined
            pendingReject = undefined
            resolve({ done: true, value: undefined })
          }
        }
        const onAbort = () => finish()
        const subscriber = {
          push(event: OpenCodeEvent) {
            if (finished) return
            if (types && !types.has(event.type)) return
            if (pending) {
              const resolve = pending
              pending = undefined
              pendingReject = undefined
              resolve({ done: false, value: event })
            } else {
              queued.push(event)
            }
          },
          fail(error: unknown) {
            if (finished) return
            if (pendingReject) {
              const reject = pendingReject
              pending = undefined
              pendingReject = undefined
              finished = true
              bus.activeIterators--
              bus.subscribers.delete(subscriber)
              signal?.removeEventListener("abort", onAbort)
              reject(error)
            } else {
              failure = error
              hasFailure = true
            }
          },
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) finish()
        else bus.subscribers.add(subscriber)
        return {
          next(): Promise<IteratorResult<OpenCodeEvent>> {
            const value = queued.shift()
            if (value !== undefined) return Promise.resolve({ done: false, value })
            if (hasFailure) return Promise.reject(failure)
            if (finished) return Promise.resolve({ done: true, value: undefined })
            return new Promise((resolve, reject) => {
              pending = resolve
              pendingReject = reject
            })
          },
          return(): Promise<IteratorResult<OpenCodeEvent>> {
            finish()
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    }
  }) as unknown as EventDomain["subscribe"]
}

interface FakeHooks {
  readonly hook: ModelHooks<SessionHooks>
  readonly calls: Array<{ name: keyof SessionHooks; options?: ModelHookOptions }>
  readonly retryCallbacks: Array<(input: SessionRetry) => Promise<void> | void>
  readonly httpCallbacks: Array<(input: SessionHttpResponse) => Promise<void> | void>
  readonly registrations: Array<Registration & { disposed: boolean }>
  failHttpRegistration: boolean
}

function makeHooks(): FakeHooks {
  const calls: FakeHooks["calls"] = []
  const retryCallbacks: FakeHooks["retryCallbacks"] = []
  const httpCallbacks: FakeHooks["httpCallbacks"] = []
  const registrations: FakeHooks["registrations"] = []
  const state = { failHttpRegistration: false }
  const hook = (async <Name extends keyof SessionHooks>(
    name: Name,
    callback: (input: SessionHooks[Name]) => Promise<void> | void,
    options?: ModelHookOptions,
  ): Promise<Registration> => {
    calls.push({ name, options })
    if (name === "http.response" && state.failHttpRegistration) {
      throw new Error("fake http.response registration failure")
    }
    const registration = {
      disposed: false,
      dispose: async () => {
        registration.disposed = true
      },
    }
    registrations.push(registration)
    if (name === "retry") retryCallbacks.push(callback as (input: SessionRetry) => Promise<void> | void)
    if (name === "http.response") httpCallbacks.push(callback as (input: SessionHttpResponse) => Promise<void> | void)
    return registration
  }) as ModelHooks<SessionHooks>
  return {
    hook,
    calls,
    retryCallbacks,
    httpCallbacks,
    registrations,
    get failHttpRegistration() {
      return state.failHttpRegistration
    },
    set failHttpRegistration(value: boolean) {
      state.failHttpRegistration = value
    },
  }
}

interface Harness {
  readonly ctx: Plugin.Context
  readonly hooks: FakeHooks
  readonly bus: FakeEventBus
}

function makeHarness(options: Record<string, unknown> = {}): Harness {
  const hooks = makeHooks()
  const bus = new FakeEventBus()
  const ctx = {
    app: { name: "opencode", version: "2.3.0", channel: "stable" },
    options,
    session: { hook: hooks.hook },
    event: { subscribe: bus.subscribe },
  } as unknown as Plugin.Context
  return { ctx, hooks, bus }
}

function loggingOptions(dir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { logging: { enabled: true, directory: dir, ...extra } }
}

function readEvents(dir: string): Array<Record<string, unknown>> {
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
  const events: Array<Record<string, unknown>> = []
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return events
}

function makeHttpResponse(overrides: {
  sessionID?: string
  status?: number
  retryAfter?: string | null
  kind?: SessionHttpResponse["kind"]
}): SessionHttpResponse {
  const retryAfter = overrides.retryAfter === undefined ? null : overrides.retryAfter
  return {
    sessionID: overrides.sessionID ?? "ses_1",
    agent: "build",
    model: { providerID: "alibaba", id: "qwen3-max" },
    kind: overrides.kind ?? "primary",
    // Hostile accessors prove the adapter never reads request URLs or bodies.
    request: {
      get url(): string {
        throw new Error("request.url must not be read")
      },
    },
    response: {
      status: overrides.status ?? 429,
      headers: {
        get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter : null),
      },
      get body(): never {
        throw new Error("response.body must not be read")
      },
    },
  } as unknown as SessionHttpResponse
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("adapter setup and options", () => {
  it("registers retry + http.response hooks unscoped and subscribes to terminal events", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    assert.equal(typeof cleanup, "function")
    assert.deepEqual(
      harness.hooks.calls.map((call) => call.name),
      ["retry", "http.response"],
    )
    // Server-wide: no provider scoping, so every provider/primary/subagent is covered.
    for (const call of harness.hooks.calls) assert.equal(call.options, undefined)
    assert.equal(harness.bus.subscribeCalls.length, 1)
    // Only the terminal failure is consumed: it is an independent observation
    // source. Lifecycle events are not needed (no cross-surface correlation
    // cache exists), so they are not subscribed.
    assert.deepEqual(harness.bus.subscribeCalls[0]?.types, ["session.execution.failed"])
    assert.ok(harness.bus.subscribeCalls[0]?.signal instanceof AbortSignal)
    await cleanup?.()
  })

  it("enabled:false is fully inert: no hooks, no subscription, no files", async () => {
    const dir = tempDir()
    const harness = makeHarness({ enabled: false, ...loggingOptions(dir) })
    const cleanup = await setupQuotaMatata(harness.ctx)
    assert.equal(cleanup, undefined)
    assert.equal(harness.hooks.calls.length, 0)
    assert.equal(harness.bus.subscribeCalls.length, 0)
    assert.deepEqual(readdirSync(dir), [])
  })

  it("invalid options reject with ConfigError listing issues; nothing registered", async () => {
    const harness = makeHarness({ maxWaitMs: -5, categories: { quota_weekly: { marginMs: "soon" } } })
    await assert.rejects(
      () => setupQuotaMatata(harness.ctx),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.ok(error.issues.some((issue) => issue.startsWith("config.maxWaitMs:")))
        assert.ok(error.issues.some((issue) => issue.startsWith("config.categories.quota_weekly.marginMs:")))
        return true
      },
    )
    assert.equal(harness.hooks.calls.length, 0)
    assert.equal(harness.bus.subscribeCalls.length, 0)
  })

  it("unknown option keys are rejected (no silent bad config)", async () => {
    const harness = makeHarness({ bogusKey: 1 })
    await assert.rejects(
      () => setupQuotaMatata(harness.ctx),
      (error: unknown) => error instanceof ConfigError && error.issues.some((i) => i.includes('unknown key "bogusKey"')),
    )
  })

  it("partial setup failure disposes acquired registrations and surfaces the error", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    harness.hooks.failHttpRegistration = true
    await assert.rejects(() => setupQuotaMatata(harness.ctx), /fake http\.response registration failure/)
    assert.equal(harness.hooks.registrations.length, 1)
    assert.equal(harness.hooks.registrations[0]?.disposed, true)
    assert.equal(harness.bus.subscribeCalls.length, 0)
    assert.equal(harness.bus.activeIterators, 0)
    assert.deepEqual(readdirSync(dir), [])
  })
})

describe("retry hook decisions", () => {
  it("forces a weekly retry over native false and logs the full decision", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({ decision: { retry: false } })
    const nativeDecision = input.decision
    const result = withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.equal(result, undefined) // synchronous callback
    const expectedDelay = nextWeeklyResetUtc8Ms(FIXED_NOW) - FIXED_NOW + 60_000
    assert.deepEqual(input.decision, { retry: true, delay: expectedDelay })
    // The original native object is never mutated.
    assert.deepEqual(nativeDecision, { retry: false })
    await cleanup?.()
    const events = readEvents(dir)
    const providerError = events.find((event) => event.type === "provider.error")
    const decision = events.find((event) => event.type === "retry.decision")
    assert.ok(providerError)
    assert.ok(decision)
    assert.equal(decision.category, "quota_weekly")
    assert.equal(decision.override, true)
    assert.deepEqual(decision.original, { retry: false })
    assert.deepEqual(decision.final, { retry: true, delay: expectedDelay })
    assert.equal(decision.delay, expectedDelay)
    assert.equal(typeof decision.policy, "string")
    assert.equal(typeof decision.reason, "string")
    assert.equal(decision.nextRetryAt, new Date(FIXED_NOW + expectedDelay).toISOString())
    for (const event of [providerError, decision]) {
      const context = event.context as Record<string, unknown>
      assert.equal(context.sessionID, "ses_1")
      assert.equal(context.agent, "build")
      assert.equal(context.provider, "alibaba")
      assert.equal(context.model, "qwen3-max")
      assert.equal(context.attempt, 2)
      // The accepted logger hoists hostVersion/source/correlationId from the
      // context input to top-level event fields (specs/logging.md).
      assert.equal(event.hostVersion, "2.3.0")
      assert.equal(event.source, "session.retry")
      assert.equal(event.correlationId, "ses_1:2")
      assert.equal(event.pluginVersion, "0.1.0")
    }
    // Default privacy: no free-text body/message content in the log.
    const raw = JSON.stringify(events)
    assert.ok(!raw.includes("week allocated quota exceeded"))
  })

  it("rate_limit keeps the native decision object untouched (no_override)", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({
      error: { type: "provider.rate-limit", message: "429 Too Many Requests", status: 429 },
      decision: { retry: true, delay: 4000 },
    })
    const nativeDecision = input.decision
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.strictEqual(input.decision, nativeDecision) // same object, not rewritten
    assert.deepEqual(input.decision, { retry: true, delay: 4000 })
    await cleanup?.()
    const decision = readEvents(dir).find((event) => event.type === "retry.decision")
    assert.ok(decision)
    assert.equal(decision.category, "rate_limit")
    assert.equal(decision.override, false)
    assert.deepEqual(decision.original, { retry: true, delay: 4000 })
    assert.deepEqual(decision.final, { retry: true, delay: 4000 })
  })

  it("permanent auth/billing failures stop even when native proposed retry", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    for (const error of [
      { type: "provider.auth", message: "InvalidApiKey", status: 401 },
      { type: "provider.budget-limit", message: "BudgetLimitExceeded", status: 402 },
    ] satisfies Array<SessionRetry["error"]>) {
      const input = makeRetry({ error, decision: { retry: true, delay: 2000 } })
      withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
      assert.deepEqual(input.decision, { retry: false })
    }
    await cleanup?.()
    const decisions = readEvents(dir).filter((event) => event.type === "retry.decision")
    assert.equal(decisions.length, 2)
    assert.deepEqual(decisions.map((event) => event.category), ["authentication", "billing"])
    for (const decision of decisions) assert.equal(decision.override, true)
  })

  it("respects error.retryAfterMs as a minimum cooldown (metadata merge)", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({
      error: {
        type: "provider.quota",
        message: "usage allocated quota exceeded",
        status: 429,
        retryAfterMs: 120_000,
      },
      decision: { retry: false },
    })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.deepEqual(input.decision, { retry: true, delay: 120_000 })
    await cleanup?.()
    const decision = readEvents(dir).find((event) => event.type === "retry.decision")
    assert.equal(decision?.category, "quota_temporary")
    assert.equal(decision?.delay, 120_000)
  })

  it("stops instead of clamping when the weekly wait exceeds maxWaitMs", async () => {
    const harness = makeHarness({ maxWaitMs: 60_000 })
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({ decision: { retry: false } })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.deepEqual(input.decision, { retry: false })
    await cleanup?.()
  })

  it("unknown errors are logged and left to the native decision", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({
      error: { type: "unknown", message: "something odd happened" },
      decision: { retry: true, delay: 2000 },
    })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.deepEqual(input.decision, { retry: true, delay: 2000 })
    await cleanup?.()
    const events = readEvents(dir)
    assert.ok(events.some((event) => event.type === "provider.error"))
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.category, "other")
    assert.equal(decision?.override, false)
  })
})

describe("fail-native safety", () => {
  it("hostile error getters never throw into the host; native decision preserved", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const hostile = {
      type: "provider.quota",
      get message(): string {
        throw new Error("boom secret payload text")
      },
    }
    const input = makeRetry({ error: hostile as SessionRetry["error"], decision: { retry: false } })
    const nativeDecision = input.decision
    assert.doesNotThrow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.strictEqual(input.decision, nativeDecision)
    await cleanup?.()
    const events = readEvents(dir)
    const pluginError = events.find((event) => event.type === "plugin.error")
    assert.ok(pluginError)
    assert.equal(pluginError.message, "retry hook evaluation failed; native decision preserved")
    // Raw Error text must not leak; provider.error is still attempted.
    const raw = JSON.stringify(events)
    assert.ok(!raw.includes("boom secret payload text"))
    assert.ok(events.some((event) => event.type === "provider.error"))
  })

  it("a throwing clock fails native without touching the decision", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({ decision: { retry: false } })
    const realNow = Date.now
    Date.now = () => {
      throw new Error("clock unavailable")
    }
    try {
      assert.doesNotThrow(() => harness.hooks.retryCallbacks[0]?.(input))
    } finally {
      Date.now = realNow
    }
    assert.deepEqual(input.decision, { retry: false })
    await cleanup?.()
    assert.ok(readEvents(dir).some((event) => event.type === "plugin.error"))
  })

  it("a failed log sink never affects decisions", async () => {
    const dir = tempDir()
    const blocker = join(dir, "not-a-directory")
    writeFileSync(blocker, "occupied")
    const harness = makeHarness(loggingOptions(blocker))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({ decision: { retry: false } })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    const expectedDelay = nextWeeklyResetUtc8Ms(FIXED_NOW) - FIXED_NOW + 60_000
    assert.deepEqual(input.decision, { retry: true, delay: expectedDelay })
    await cleanup?.()
    // The blocker file is untouched; no log directory was created through it.
    assert.equal(readFileSync(blocker, "utf8"), "occupied")
  })
})

describe("malformed/hostile attempt values (R21-01)", () => {
  // The host wraps the callback in Effect.promise: a throw here defects the
  // session execution. Every non-number must fail native BEFORE any coercion.
  function withAttempt(value: unknown): SessionRetry {
    const input = makeRetry({ decision: { retry: false } })
    ;(input as { attempt: unknown }).attempt = value
    return input
  }

  const hostileAttempts: Array<{ name: string; value: unknown }> = [
    {
      name: "throwing Symbol.toPrimitive",
      value: {
        [Symbol.toPrimitive]() {
          throw new Error("attempt toPrimitive SECRET")
        },
      },
    },
    {
      name: "throwing toString",
      value: {
        toString() {
          throw new Error("attempt toString SECRET")
        },
      },
    },
    { name: "symbol", value: Symbol("attempt") },
    { name: "nonnumeric string", value: "2" },
    { name: "NaN", value: Number.NaN },
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
    { name: "plain object", value: {} },
  ]

  for (const { name, value } of hostileAttempts) {
    it(`fails native without throwing for ${name}`, async () => {
      const dir = tempDir()
      const harness = makeHarness(loggingOptions(dir))
      const cleanup = await setupQuotaMatata(harness.ctx)
      const input = withAttempt(value)
      const nativeDecision = input.decision
      assert.doesNotThrow(() => harness.hooks.retryCallbacks[0]?.(input))
      assert.strictEqual(input.decision, nativeDecision) // same reference, untouched
      await cleanup?.()
      const events = readEvents(dir)
      const pluginError = events.find((event) => event.type === "plugin.error")
      assert.ok(pluginError, "failure is reported safely")
      assert.equal(pluginError.message, "retry hook evaluation failed; native decision preserved")
      // provider.error is still attempted with a safe fallback context.
      const providerError = events.find((event) => event.type === "provider.error")
      assert.ok(providerError)
      assert.equal(providerError.correlationId, "ses_1:retry")
      assert.equal((providerError.context as Record<string, unknown>).attempt, undefined)
      assert.ok(!events.some((event) => event.type === "retry.decision"))
      // Raw conversion-failure text must never leak.
      assert.ok(!JSON.stringify(events).includes("SECRET"))
    })
  }

  it("a throwing attempt getter fails native without escaping", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({ decision: { retry: false } })
    Object.defineProperty(input, "attempt", {
      get() {
        throw new Error("attempt getter SECRET")
      },
    })
    const nativeDecision = input.decision
    assert.doesNotThrow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.strictEqual(input.decision, nativeDecision)
    await cleanup?.()
    const events = readEvents(dir)
    assert.ok(events.some((event) => event.type === "plugin.error"))
    assert.ok(!JSON.stringify(events).includes("SECRET"))
  })

  it("a hostile attempt with a failed log sink still never throws", async () => {
    const dir = tempDir()
    const blocker = join(dir, "not-a-directory")
    writeFileSync(blocker, "occupied")
    const harness = makeHarness(loggingOptions(blocker))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = withAttempt({
      [Symbol.toPrimitive]() {
        throw new Error("attempt conversion failure")
      },
    })
    const nativeDecision = input.decision
    assert.doesNotThrow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.strictEqual(input.decision, nativeDecision)
    await cleanup?.()
    assert.equal(readFileSync(blocker, "utf8"), "occupied")
  })

  it("the callback stays usable for valid attempts after hostile ones", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    assert.doesNotThrow(() =>
      harness.hooks.retryCallbacks[0]?.(
        withAttempt({
          [Symbol.toPrimitive]() {
            throw new Error("attempt conversion failure")
          },
        }),
      ),
    )
    const input = makeRetry({ decision: { retry: false } })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    const expectedDelay = nextWeeklyResetUtc8Ms(FIXED_NOW) - FIXED_NOW + 60_000
    assert.deepEqual(input.decision, { retry: true, delay: expectedDelay })
    // The valid invocation's direct-hook record keeps its accurate context; the
    // terminal event is an independent observation (no inferred attempt).
    harness.bus.push(failedEvent("ses_1", weeklyError()))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const decision = events.find(
      (event) => event.type === "retry.decision" && (event.context as Record<string, unknown>).sessionID === "ses_1",
    )
    assert.equal(decision?.correlationId, "ses_1:2")
    assert.equal((decision?.context as Record<string, unknown>).attempt, 2)
    const terminal = events.find((event) => event.source === "event.session.execution.failed")
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    assert.equal((terminal?.context as Record<string, unknown>).attempt, undefined)
  })
})

describe("HTTP metadata-only observation", () => {
  it("logs status/Retry-After/kind for >=400 without reading request or body", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    assert.doesNotThrow(() =>
      harness.hooks.httpCallbacks[0]?.(makeHttpResponse({ status: 429, retryAfter: "120", kind: "primary" })),
    )
    await cleanup?.()
    const events = readEvents(dir)
    assert.equal(events.length, 1)
    const event = events[0]
    assert.equal(event?.type, "provider.error")
    const context = event?.context as Record<string, unknown>
    assert.equal(event?.source, "session.http.response")
    assert.equal(event?.correlationId, "ses_1:http:primary")
    assert.equal(context.sessionID, "ses_1")
    assert.equal(context.agent, "build")
    assert.equal(context.provider, "alibaba")
    assert.equal(context.model, "qwen3-max")
    assert.deepEqual(event?.error, { type: "http.error", status: 429, retryAfterMs: 120_000 })
    assert.ok(String(event?.reason).includes("metadata-only"))
    assert.ok(String(event?.reason).includes("kind primary"))
    // The hostile getters throw if read; their text must never surface, and
    // the error payload stays exactly the metadata allowlist.
    const raw = JSON.stringify(events)
    assert.ok(!raw.includes("must not be read"))
    assert.deepEqual(Object.keys(event?.error as Record<string, unknown>).sort(), ["retryAfterMs", "status", "type"])
  })

  it("ignores successful responses and invalid Retry-After values", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    harness.hooks.httpCallbacks[0]?.(makeHttpResponse({ status: 200 }))
    harness.hooks.httpCallbacks[0]?.(makeHttpResponse({ status: 503, retryAfter: "not-a-date" }))
    await cleanup?.()
    const events = readEvents(dir)
    assert.equal(events.length, 1)
    assert.deepEqual(events[0]?.error, { type: "http.error", status: 503 })
  })

  it("parses HTTP-date Retry-After relative to now", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    withFixedNow(() =>
      harness.hooks.httpCallbacks[0]?.(
        makeHttpResponse({ status: 429, retryAfter: new Date(FIXED_NOW + 60_000).toUTCString() }),
      ),
    )
    await cleanup?.()
    const events = readEvents(dir)
    assert.deepEqual(events[0]?.error, { type: "http.error", status: 429, retryAfterMs: 60_000 })
  })
})

describe("terminal events are independent observations (R21-02)", () => {
  it("terminal failure is logged independently; the retry record keeps accurate context", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ error, decision: { retry: false } })))
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    // A second terminal observation is likewise independent (no consumed entry).
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 2)
    for (const terminal of terminals) {
      assert.equal(terminal.correlationId, "ses_1:terminal")
      const context = terminal.context as Record<string, unknown>
      assert.equal(context.sessionID, "ses_1")
      // Terminal events carry no agent/model/attempt; none is inferred.
      assert.equal(context.attempt, undefined)
      assert.equal(context.agent, undefined)
      assert.equal(context.provider, undefined)
      assert.equal(context.model, undefined)
      assert.ok(String(terminal.reason).includes("independently"))
      assert.ok(String(terminal.reason).includes("sessionID"))
      assert.ok(!String(terminal.reason).includes("terminal confirmation"))
    }
    // The direct retry record retains its accurate context and correlation id.
    const decision = events.find((event) => event.type === "retry.decision")
    assert.ok(decision)
    assert.equal(decision.correlationId, "ses_1:2")
    assert.equal((decision.context as Record<string, unknown>).attempt, 2)
    assert.equal((decision.context as Record<string, unknown>).agent, "build")
    assert.equal((decision.context as Record<string, unknown>).model, "qwen3-max")
  })

  it("terminal provider.error is captured even for an unknown error with no prior observation", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    harness.bus.push(failedEvent("ses_9", { type: "unknown", message: "mystery failure" }))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    assert.equal(events.length, 1)
    const event = events[0]
    assert.equal(event?.type, "provider.error")
    const context = event?.context as Record<string, unknown>
    assert.equal(event?.source, "event.session.execution.failed")
    assert.equal(context.sessionID, "ses_9")
    assert.equal(event?.correlationId, "ses_9:terminal")
    assert.equal(context.agent, undefined)
    assert.equal(context.provider, undefined)
    assert.equal(context.model, undefined)
    assert.equal(context.attempt, undefined)
    assert.ok(String(event?.reason).includes("no agent/model/attempt"))
    assert.deepEqual(event?.error, { type: "unknown" })
  })

  it("a differing terminal error inherits no provider/model from a prior retry", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ decision: { retry: false } })))
    harness.bus.push(failedEvent("ses_1", { type: "provider.auth", message: "InvalidApiKey", status: 401 }))
    await tick()
    await cleanup?.()
    const terminal = readEvents(dir).find((event) => event.source === "event.session.execution.failed")
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    const context = terminal?.context as Record<string, unknown>
    assert.equal(context.provider, undefined)
    assert.equal(context.model, undefined)
    assert.ok(String(terminal?.reason).includes("independently"))
  })

  it("terminal never inherits agent/model from an HTTP observation", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    harness.hooks.httpCallbacks[0]?.(makeHttpResponse({ status: 401 }))
    harness.bus.push(failedEvent("ses_1", { type: "provider.auth", message: "InvalidApiKey", status: 401 }))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const terminal = events.find((event) => event.source === "event.session.execution.failed")
    const context = terminal?.context as Record<string, unknown>
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    assert.equal(context.agent, undefined)
    assert.equal(context.provider, undefined)
    assert.equal(context.model, undefined)
    assert.equal(context.attempt, undefined)
    // The HTTP record itself keeps its accurate direct-hook context.
    const http = events.find((event) => event.source === "session.http.response")
    assert.ok(http)
    assert.equal(http.correlationId, "ses_1:http:primary")
    assert.equal((http.context as Record<string, unknown>).agent, "build")
    assert.equal((http.context as Record<string, unknown>).model, "qwen3-max")
  })

  it("interruption is not logged as an error; the terminal stays independent", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ error, decision: { retry: false } })))
    harness.bus.push(interruptedEvent("ses_1", "user"))
    await tick()
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    // provider.error + retry.decision from the hook, then one independent terminal.
    assert.equal(events.length, 3)
    const terminal = events[2]
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    assert.ok(!events.some((event) => String(event?.reason ?? "").includes("interrupted")))
  })

  it("session.deleted is not logged; the terminal stays independent", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ error, decision: { retry: false } })))
    harness.bus.push(deletedEvent("ses_1"))
    await tick()
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    await cleanup?.()
    const terminal = readEvents(dir).find((event) => event.source === "event.session.execution.failed")
    assert.equal(terminal?.correlationId, "ses_1:terminal")
  })

  it("keeps per-session isolation across primary/subagent/multi-session traffic", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const sessions = [
      { sessionID: "ses_primary", agent: "build", providerID: "alibaba" },
      { sessionID: "ses_sub", agent: "general", providerID: "alibaba" },
      { sessionID: "ses_other", agent: "build", providerID: "openai" },
    ]
    withFixedNow(() => {
      for (const session of sessions) {
        harness.hooks.retryCallbacks[0]?.(
          makeRetry({ ...session, decision: { retry: false }, attempt: 3 }),
        )
      }
    })
    // alibaba sessions forced; openai weekly phrase cannot match Alibaba rules.
    harness.bus.push(failedEvent("ses_sub", weeklyError()))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const decisions = events.filter((event) => event.type === "retry.decision")
    assert.equal(decisions.length, 3)
    const bySession = new Map(
      decisions.map((event) => [(event.context as Record<string, unknown>).sessionID, event]),
    )
    assert.equal(bySession.get("ses_primary")?.override, true)
    assert.equal(bySession.get("ses_sub")?.override, true)
    assert.equal(bySession.get("ses_other")?.override, false) // isolation: no Alibaba phrases for openai
    // Generic order: a bare 429 is rate_limit before the provider.quota type
    // could map to quota_unknown (accepted core; never quota_weekly here).
    assert.equal(bySession.get("ses_other")?.category, "rate_limit")
    const terminal = events.find((event) => event.source === "event.session.execution.failed")
    const context = terminal?.context as Record<string, unknown>
    assert.equal(context.sessionID, "ses_sub")
    assert.equal(terminal?.correlationId, "ses_sub:terminal")
    assert.equal(context.agent, undefined)
    assert.equal(context.attempt, undefined)
  })

  it("captures every terminal independently across many sessions (no shared state)", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error: SessionRetry["error"] = { type: "unknown", message: "volume probe" }
    withFixedNow(() => {
      for (let i = 0; i < 257; i++) {
        harness.hooks.retryCallbacks[0]?.(
          makeRetry({ sessionID: `ses_${i}`, error, decision: { retry: true, delay: 1000 }, attempt: 2 }),
        )
      }
    })
    // The synchronous burst overflows the logger's accepted bounded queue
    // (256 lines + one overflow report). Let the serial drain settle before the
    // terminal observations so this test exercises independence, not drops.
    const deadline = Date.now() + 5000
    while (readEvents(dir).length < 257) {
      if (Date.now() > deadline) throw new Error("logger drain did not settle")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    harness.bus.push(failedEvent("ses_0", error))
    harness.bus.push(failedEvent("ses_256", error))
    await tick()
    await cleanup?.()
    const terminals = readEvents(dir).filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 2)
    // No per-session cache exists, so there is nothing to evict: every terminal
    // is independent regardless of volume or order.
    assert.equal(terminals[0]?.correlationId, "ses_0:terminal")
    assert.equal(terminals[1]?.correlationId, "ses_256:terminal")
    for (const terminal of terminals) {
      assert.equal((terminal.context as Record<string, unknown>).attempt, undefined)
    }
  })

  it("reports a broken event stream once and keeps the retry hook working", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    harness.bus.failAll(new Error("stream broke"))
    await tick()
    const input = makeRetry({ decision: { retry: false } })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    assert.equal(input.decision.retry, true)
    await cleanup?.()
    const events = readEvents(dir)
    const failures = events.filter((event) => event.type === "plugin.error")
    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.message, "event subscription failed; terminal observations may be missed")
  })
})

describe("terminal independence under lifecycle and ordering (R21-02)", () => {
  it("a new execution after success: terminal inherits nothing old", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    // Execution 1: retry observation (attempt 2, model qwen3-max), then success.
    withFixedNow(() =>
      harness.hooks.retryCallbacks[0]?.(makeRetry({ sessionID: "ses_stale", error, decision: { retry: false } })),
    )
    harness.bus.push(succeededEvent("ses_stale"))
    await tick()
    // Execution 2: starts and fails with the SAME error, no retry hook ran.
    harness.bus.push(startedEvent("ses_stale"))
    await tick()
    harness.bus.push(failedEvent("ses_stale", error))
    await tick()
    await cleanup?.()
    const terminal = readEvents(dir).find((event) => event.source === "event.session.execution.failed")
    assert.ok(terminal)
    assert.equal(terminal.correlationId, "ses_stale:terminal")
    const context = terminal.context as Record<string, unknown>
    assert.equal(context.attempt, undefined)
    assert.equal(context.agent, undefined)
    assert.equal(context.provider, undefined)
    assert.equal(context.model, undefined)
    assert.ok(String(terminal.reason).includes("independently"))
    assert.ok(!String(terminal.reason).includes("terminal confirmation"))
  })

  it("terminal after success is independent even without a started event", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ error, decision: { retry: false } })))
    harness.bus.push(succeededEvent("ses_1"))
    await tick()
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    await cleanup?.()
    const terminal = readEvents(dir).find((event) => event.source === "event.session.execution.failed")
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    assert.equal((terminal?.context as Record<string, unknown>).attempt, undefined)
  })

  it("terminal is independent when a prior terminal was missed", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ error, decision: { retry: false } })))
    // No terminal event for execution 1 arrives; execution 2 starts anyway.
    harness.bus.push(startedEvent("ses_1"))
    await tick()
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    await cleanup?.()
    const terminal = readEvents(dir).find((event) => event.source === "event.session.execution.failed")
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    assert.ok(String(terminal?.reason).includes("independently"))
  })

  it("same-execution terminal is independent; the retry record keeps accurate context", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    // Host order: started precedes the execution's first retry hook.
    harness.bus.push(startedEvent("ses_1"))
    await tick()
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ error, decision: { retry: false } })))
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const terminal = events.find((event) => event.source === "event.session.execution.failed")
    // The terminal is an independent observation: no attempt/model is inferred,
    // even within the same execution (the host provides no execution identity).
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    assert.equal((terminal?.context as Record<string, unknown>).attempt, undefined)
    assert.ok(!String(terminal?.reason).includes("terminal confirmation"))
    // The direct retry record still carries the accurate same-execution context.
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.correlationId, "ses_1:2")
    assert.equal((decision?.context as Record<string, unknown>).attempt, 2)
  })

  it("consecutive executions each log an independent terminal", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    // Execution 1: attempt 2 on qwen3-max.
    harness.bus.push(startedEvent("ses_1"))
    await tick()
    withFixedNow(() =>
      harness.hooks.retryCallbacks[0]?.(makeRetry({ error, attempt: 2, decision: { retry: false } })),
    )
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    // Execution 2: attempt 3 on a different model, same error fingerprint.
    harness.bus.push(startedEvent("ses_1"))
    await tick()
    withFixedNow(() =>
      harness.hooks.retryCallbacks[0]?.(
        makeRetry({ error, attempt: 3, modelID: "qwen-plus", decision: { retry: false } }),
      ),
    )
    harness.bus.push(failedEvent("ses_1", error))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 2)
    // Neither terminal inherits the other execution's attempt/model.
    for (const terminal of terminals) {
      assert.equal(terminal.correlationId, "ses_1:terminal")
      const context = terminal.context as Record<string, unknown>
      assert.equal(context.attempt, undefined)
      assert.equal(context.model, undefined)
    }
    // Each direct retry record keeps its own accurate attempt/model.
    const decisions = events.filter((event) => event.type === "retry.decision")
    assert.equal(decisions.length, 2)
    assert.equal(decisions[0]?.correlationId, "ses_1:2")
    assert.equal((decisions[0]?.context as Record<string, unknown>).model, "qwen3-max")
    assert.equal(decisions[1]?.correlationId, "ses_1:3")
    assert.equal((decisions[1]?.context as Record<string, unknown>).model, "qwen-plus")
  })

  it("a mismatching error after success inherits no old provider/model", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ decision: { retry: false } })))
    harness.bus.push(succeededEvent("ses_1"))
    await tick()
    harness.bus.push(startedEvent("ses_1"))
    await tick()
    harness.bus.push(failedEvent("ses_1", { type: "provider.auth", message: "InvalidApiKey", status: 401 }))
    await tick()
    await cleanup?.()
    const terminal = readEvents(dir).find((event) => event.source === "event.session.execution.failed")
    assert.equal(terminal?.correlationId, "ses_1:terminal")
    const context = terminal?.context as Record<string, unknown>
    assert.equal(context.provider, undefined)
    assert.equal(context.model, undefined)
    assert.ok(String(terminal?.reason).includes("independently"))
  })

  it("succeeded and started are lifecycle signals, never logged as errors", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ decision: { retry: false } })))
    // Let the logger's serial drain flush the hook's two events first.
    const deadline = Date.now() + 5000
    while (readEvents(dir).length < 2) {
      if (Date.now() > deadline) throw new Error("logger drain did not settle")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    harness.bus.push(succeededEvent("ses_1"))
    harness.bus.push(startedEvent("ses_1"))
    await tick()
    await cleanup?.()
    assert.equal(readEvents(dir).length, 2) // only the hook's two events
  })

  it("one session's lifecycle never affects another session's terminal", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const error = weeklyError()
    withFixedNow(() => {
      harness.hooks.retryCallbacks[0]?.(
        makeRetry({ sessionID: "ses_a", error, attempt: 2, decision: { retry: false } }),
      )
      harness.hooks.retryCallbacks[0]?.(
        makeRetry({ sessionID: "ses_b", error, attempt: 3, decision: { retry: false } }),
      )
    })
    // ses_a succeeds and restarts; ses_b is still in its first execution.
    harness.bus.push(succeededEvent("ses_a"))
    harness.bus.push(startedEvent("ses_a"))
    await tick()
    harness.bus.push(failedEvent("ses_b", error))
    await tick()
    harness.bus.push(failedEvent("ses_a", error))
    await tick()
    await cleanup?.()
    const terminals = readEvents(dir).filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 2)
    const bySession = new Map(
      terminals.map((event) => [(event.context as Record<string, unknown>).sessionID, event]),
    )
    // Both terminals are independent; neither carries a retry attempt/model.
    assert.equal(bySession.get("ses_b")?.correlationId, "ses_b:terminal")
    assert.equal((bySession.get("ses_b")?.context as Record<string, unknown>).attempt, undefined)
    assert.equal(bySession.get("ses_a")?.correlationId, "ses_a:terminal")
    assert.equal((bySession.get("ses_a")?.context as Record<string, unknown>).attempt, undefined)
  })
})

describe("cleanup", () => {
  it("disposes registrations, aborts the subscription, exits the loop, flushes the logger", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    assert.equal(harness.bus.activeIterators, 1)
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ decision: { retry: false } })))
    await cleanup?.()
    assert.equal(harness.hooks.registrations.length, 2)
    for (const registration of harness.hooks.registrations) assert.equal(registration.disposed, true)
    assert.equal(harness.bus.subscribeCalls[0]?.signal?.aborted, true)
    assert.equal(harness.bus.activeIterators, 0)
    // Logger flushed and closed: later observations write nothing.
    const before = readEvents(dir)
    assert.ok(before.some((event) => event.type === "retry.decision"))
    harness.bus.push(failedEvent("ses_1", weeklyError()))
    await tick()
    assert.deepEqual(readEvents(dir), before)
    // Idempotent.
    await cleanup?.()
    assert.equal(harness.bus.activeIterators, 0)
  })

  it("cleanup with a pending iterator does not leak a waiting next()", async () => {
    const harness = makeHarness()
    const cleanup = await setupQuotaMatata(harness.ctx)
    // The loop is blocked in next() with no events queued.
    await cleanup?.()
    assert.equal(harness.bus.activeIterators, 0)
    assert.equal(harness.bus.subscribeCalls[0]?.signal?.aborted, true)
  })
})

// ---------------------------------------------------------------------------
// R27-01: the actual matched classifier rule identity must reach the real
// JSONL files (provider.error + retry.decision), not just the engine result.
// Assertions read the files the accepted logger actually wrote.
// ---------------------------------------------------------------------------
describe("R27-01: classifier provenance in real JSONL", () => {
  const planCases = [
    ["hour allocated quota exceeded", "quota_five_hour", "alibaba.quota_five_hour"],
    ["week allocated quota exceeded", "quota_weekly", "alibaba.quota_weekly"],
    ["month allocated quota exceeded", "quota_monthly", "alibaba.quota_monthly"],
    ["usage allocated quota exceeded", "quota_temporary", "alibaba.quota_temporary"],
    ["concurrency allocated quota exceeded", "concurrency_limit", "alibaba.quota_concurrency"],
  ] as const

  for (const capture of [false, true]) {
    it(`all five Alibaba plan rules carry rule/matched in both records (captureErrorDetails=${capture})`, async () => {
      const dir = tempDir()
      const harness = makeHarness(loggingOptions(dir, { captureErrorDetails: capture }))
      const cleanup = await setupQuotaMatata(harness.ctx)
      withFixedNow(() => {
        for (const [i, [phrase]] of planCases.entries()) {
          harness.hooks.retryCallbacks[0]?.(
            makeRetry({
              sessionID: `ses_rule_${i}`,
              // R27 reproduction shape: generic host message, phrase inside a
              // structured OpenAI-style body envelope.
              error: {
                type: "provider.quota",
                message: "429 Too Many Requests",
                status: 429,
                response: { body: JSON.stringify({ error: { message: phrase, type: "insufficient_quota", code: null } }) },
              },
              decision: { retry: false },
            }),
          )
        }
      })
      await cleanup?.()
      const events = readEvents(dir)
      for (const [i, [, category, ruleId]] of planCases.entries()) {
        const correlationId = `ses_rule_${i}:2`
        const providerError = events.find((event) => event.type === "provider.error" && event.correlationId === correlationId)
        const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === correlationId)
        assert.ok(providerError, `provider.error for ${ruleId}`)
        assert.ok(decision, `retry.decision for ${ruleId}`)
        for (const event of [providerError, decision]) {
          assert.equal(event.rule, ruleId)
          assert.equal(event.matched, "alibaba")
          assert.equal(event.category, category)
        }
      }
      // Privacy is unchanged: with capture off the phrase never reaches disk.
      if (!capture) assert.ok(!JSON.stringify(events).includes("allocated quota exceeded"))
    })
  }

  it("plain-message phrases carry the same rule identity", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    withFixedNow(() =>
      harness.hooks.retryCallbacks[0]?.(
        makeRetry({ error: { type: "provider.quota", message: "week allocated quota exceeded", status: 429 }, decision: { retry: false } }),
      ),
    )
    await cleanup?.()
    const events = readEvents(dir)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type)
      assert.equal(event?.rule, "alibaba.quota_weekly")
      assert.equal(event?.matched, "alibaba")
    }
  })

  it("generic permanent rules and the permanent gate carry generic ids with NO matched provider", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const cases: Array<{ sessionID: string; providerID: string; error: SessionRetry["error"]; rule: string; category: string }> = [
      {
        sessionID: "ses_gen_billing",
        providerID: "openai",
        error: { type: "provider.budget-limit", message: "BudgetLimitExceeded", status: 402 },
        rule: "generic.billing",
        category: "billing",
      },
      {
        sessionID: "ses_gen_auth",
        providerID: "openai",
        error: { type: "provider.auth", message: "InvalidApiKey", status: 401 },
        rule: "generic.auth",
        category: "authentication",
      },
      {
        // The definitive permanent gate on Alibaba: same category as
        // alibaba.billing, but a generic rule identity and no matched provider.
        sessionID: "ses_gate",
        providerID: "alibaba",
        error: { type: "provider.quota", message: "week allocated quota exceeded", status: 402 },
        rule: "generic.billing",
        category: "billing",
      },
      {
        // Alibaba's own permanent rule keeps provider attribution.
        sessionID: "ses_ali_billing",
        providerID: "alibaba",
        error: {
          type: "provider.quota",
          message: "429",
          status: 429,
          response: { body: JSON.stringify({ code: "Arrearage", message: "Access denied, please make sure your account is in good standing." }) },
        },
        rule: "alibaba.billing",
        category: "billing",
      },
    ]
    withFixedNow(() => {
      for (const testCase of cases) {
        harness.hooks.retryCallbacks[0]?.(
          makeRetry({ sessionID: testCase.sessionID, providerID: testCase.providerID, error: testCase.error, decision: { retry: true, delay: 2000 } }),
        )
      }
    })
    await cleanup?.()
    const events = readEvents(dir)
    for (const testCase of cases) {
      const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === `${testCase.sessionID}:2`)
      const providerError = events.find((event) => event.type === "provider.error" && event.correlationId === `${testCase.sessionID}:2`)
      assert.ok(decision)
      assert.ok(providerError)
      for (const event of [decision, providerError]) {
        assert.equal(event.rule, testCase.rule)
        assert.equal(event.category, testCase.category)
        if (testCase.rule.startsWith("generic.")) assert.equal(event.matched, undefined)
        else assert.equal(event.matched, "alibaba")
      }
      assert.equal(decision.override, true) // permanent stop over native retry
      assert.deepEqual(decision.final, { retry: false })
    }
  })

  it("generic rate_limit, quota_unknown and the fallback stay distinguishable", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const cases: Array<{ sessionID: string; providerID: string; error: SessionRetry["error"]; rule: string; category: string; matched?: string }> = [
      {
        sessionID: "ses_rate",
        providerID: "alibaba",
        error: { type: "provider.rate-limit", message: "rate limited", status: 429 },
        rule: "generic.rate_limit",
        category: "rate_limit",
      },
      {
        sessionID: "ses_gen_unknown",
        providerID: "openai",
        // No 429 status: a bare 429 is generic.rate_limit first (accepted order).
        error: { type: "provider.quota", message: "quota exhausted" },
        rule: "generic.quota_unknown",
        category: "quota_unknown",
      },
      {
        sessionID: "ses_ali_unknown",
        providerID: "alibaba",
        error: { type: "provider.quota", message: "Allocated quota exceeded, please increase your quota limit.", status: 429 },
        rule: "alibaba.quota_unknown",
        category: "quota_unknown",
        matched: "alibaba",
      },
      {
        sessionID: "ses_fallback",
        providerID: "alibaba",
        error: { type: "unknown", message: "something odd happened" },
        rule: "generic.other",
        category: "other",
      },
    ]
    withFixedNow(() => {
      for (const testCase of cases) {
        harness.hooks.retryCallbacks[0]?.(
          makeRetry({ sessionID: testCase.sessionID, providerID: testCase.providerID, error: testCase.error, decision: { retry: true, delay: 2000 } }),
        )
      }
    })
    await cleanup?.()
    const events = readEvents(dir)
    for (const testCase of cases) {
      const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === `${testCase.sessionID}:2`)
      const providerError = events.find((event) => event.type === "provider.error" && event.correlationId === `${testCase.sessionID}:2`)
      assert.ok(decision)
      assert.ok(providerError)
      for (const event of [decision, providerError]) {
        assert.equal(event.rule, testCase.rule)
        assert.equal(event.category, testCase.category)
        assert.equal(event.matched, testCase.matched)
      }
      // Unknown/fallback categories keep the native decision (no_override).
      assert.equal(decision.override, false)
    }
  })

  it("a disabled Alibaba classifier logs generic rules without a matched provider", async () => {
    const dir = tempDir()
    const harness = makeHarness({ providers: { alibaba: { enabled: false } }, ...loggingOptions(dir) })
    const cleanup = await setupQuotaMatata(harness.ctx)
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ decision: { retry: false } })))
    await cleanup?.()
    const events = readEvents(dir)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type)
      assert.equal(event?.rule, "generic.rate_limit")
      assert.equal(event?.category, "rate_limit")
      assert.equal(event?.matched, undefined)
    }
  })

  it("an alias provider records the canonical matched provider while context stays host-accurate", async () => {
    const dir = tempDir()
    const harness = makeHarness({ providers: { alibaba: { aliases: ["dashscope"] } }, ...loggingOptions(dir) })
    const cleanup = await setupQuotaMatata(harness.ctx)
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ providerID: "DASHSCOPE", decision: { retry: false } })))
    await cleanup?.()
    const events = readEvents(dir)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type)
      assert.equal(event?.rule, "alibaba.quota_weekly")
      assert.equal(event?.matched, "alibaba")
      assert.equal((event?.context as Record<string, unknown>).provider, "DASHSCOPE")
    }
  })

  it("classification never leaks raw body secrets into the real JSONL", async () => {
    for (const capture of [false, true]) {
      const dir = tempDir()
      const harness = makeHarness(loggingOptions(dir, { captureErrorDetails: capture }))
      const cleanup = await setupQuotaMatata(harness.ctx)
      const secret = "sk-abcdefghijklmnop1234567890"
      withFixedNow(() =>
        harness.hooks.retryCallbacks[0]?.(
          makeRetry({
            error: {
              type: "provider.quota",
              message: "429",
              status: 429,
              response: { body: JSON.stringify({ error: { message: `week allocated quota exceeded; key ${secret}`, code: "Throttling.AllocationQuota" } }) },
            },
            decision: { retry: false },
          }),
        ),
      )
      await cleanup?.()
      const events = readEvents(dir)
      const decision = events.find((event) => event.type === "retry.decision")
      assert.equal(decision?.rule, "alibaba.quota_weekly")
      assert.equal(decision?.matched, "alibaba")
      const raw = JSON.stringify(events)
      assert.ok(!raw.includes(secret))
      if (!capture) assert.ok(!raw.includes("allocated quota exceeded"))
    }
  })

  it("terminal observations carry context-free classification: generic rule, no matched, no inferred context", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    // A direct retry record with provider-specific provenance exists first.
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(makeRetry({ decision: { retry: false } })))
    harness.bus.push(failedEvent("ses_1", weeklyError()))
    await tick()
    harness.bus.push(failedEvent("ses_1", { type: "unknown", message: "mystery failure" }))
    await tick()
    harness.bus.push(failedEvent("ses_1", { type: "provider.auth", message: "InvalidApiKey", status: 401 }))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.rule, "alibaba.quota_weekly")
    assert.equal(decision?.matched, "alibaba")
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 3)
    // Each terminal's rule reflects ITS OWN error, classified without provider
    // context — never the preceding retry record's provider-specific rule.
    assert.equal(terminals[0]?.rule, "generic.rate_limit") // weeklyError has status 429
    assert.equal(terminals[0]?.category, "rate_limit")
    assert.equal(terminals[1]?.rule, "generic.other")
    assert.equal(terminals[1]?.category, "other")
    assert.equal(terminals[2]?.rule, "generic.auth")
    assert.equal(terminals[2]?.category, "authentication")
    for (const terminal of terminals) {
      assert.equal(terminal.matched, undefined)
      assert.equal(terminal.correlationId, "ses_1:terminal")
      const context = terminal.context as Record<string, unknown>
      assert.equal(context.sessionID, "ses_1")
      assert.equal(context.agent, undefined)
      assert.equal(context.provider, undefined)
      assert.equal(context.model, undefined)
      assert.equal(context.attempt, undefined)
      assert.ok(String(terminal.reason).includes("independently"))
      assert.ok(String(terminal.reason).includes("context-free"))
      assert.ok(!String(terminal.reason).includes("terminal confirmation"))
    }
  })

  it("a hostile terminal error keeps the observation (without classification) and never throws", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const hostile = {
      type: "provider.quota",
      get message(): string {
        throw new Error("terminal SECRET payload")
      },
    }
    harness.bus.push(failedEvent("ses_hostile", hostile as SessionRetry["error"]))
    await tick()
    await cleanup?.()
    const events = readEvents(dir)
    const terminal = events.find((event) => event.source === "event.session.execution.failed")
    assert.ok(terminal, "the observation itself must survive a hostile error shape")
    assert.equal(terminal.correlationId, "ses_hostile:terminal")
    assert.equal(terminal.rule, undefined)
    assert.equal(terminal.category, undefined)
    assert.equal(terminal.matched, undefined)
    assert.equal(events.filter((event) => event.type === "plugin.error").length, 0)
    assert.ok(!JSON.stringify(events).includes("SECRET"))
  })
})

// ---------------------------------------------------------------------------
// R27-02: the required public category is concurrency_limit. The real JSONL
// category, policy path and applied delay must use it end-to-end: default 5s
// short delay, user-configured policy, provider override, non-Alibaba
// isolation and disabled paths. The stable rule identity stays
// alibaba.quota_concurrency (rule labels are independent of category names).
// ---------------------------------------------------------------------------
describe("R27-02: concurrency_limit in real JSONL", () => {
  const concurrencyError = (): SessionRetry["error"] => ({
    type: "provider.quota",
    message: "429 Too Many Requests",
    status: 429,
    response: {
      body: JSON.stringify({ error: { message: "concurrency allocated quota exceeded", type: "insufficient_quota", code: null } }),
    },
  })

  for (const capture of [false, true]) {
    it(`default 5s retry carries category/policy/rule in both records (captureErrorDetails=${capture})`, async () => {
      const dir = tempDir()
      const harness = makeHarness(loggingOptions(dir, { captureErrorDetails: capture }))
      const cleanup = await setupQuotaMatata(harness.ctx)
      const input = makeRetry({ sessionID: "ses_conc", error: concurrencyError(), decision: { retry: false } })
      withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
      await cleanup?.()
      assert.deepEqual(input.decision, { retry: true, delay: 5_000 })
      const events = readEvents(dir)
      const providerError = events.find((event) => event.type === "provider.error" && event.correlationId === "ses_conc:2")
      const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === "ses_conc:2")
      assert.ok(providerError)
      assert.ok(decision)
      for (const event of [providerError, decision]) {
        assert.equal(event.category, "concurrency_limit")
        assert.equal(event.rule, "alibaba.quota_concurrency")
        assert.equal(event.matched, "alibaba")
      }
      assert.equal(decision.policy, "providers.alibaba.categories.concurrency_limit")
      assert.equal(decision.delay, 5_000)
      assert.equal(decision.override, true)
      assert.deepEqual(decision.final, { retry: true, delay: 5_000 })
      assert.equal(decision.nextRetryAt, new Date(FIXED_NOW + 5_000).toISOString())
      // Privacy is unchanged: with capture off the phrase never reaches disk.
      if (!capture) assert.ok(!JSON.stringify(events).includes("allocated quota exceeded"))
    })
  }

  it("user-configured categories.concurrency_limit delay reaches the decision and JSONL", async () => {
    const dir = tempDir()
    const harness = makeHarness({ categories: { concurrency_limit: { delayMs: 1234 } }, ...loggingOptions(dir) })
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({ sessionID: "ses_conc_cfg", error: concurrencyError(), decision: { retry: false } })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    await cleanup?.()
    assert.deepEqual(input.decision, { retry: true, delay: 1234 })
    const events = readEvents(dir)
    const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === "ses_conc_cfg:2")
    assert.equal(decision?.category, "concurrency_limit")
    assert.equal(decision?.rule, "alibaba.quota_concurrency")
    assert.equal(decision?.delay, 1234)
    assert.deepEqual(decision?.final, { retry: true, delay: 1234 })
    assert.equal(decision?.policy, "providers.alibaba.categories.concurrency_limit")
  })

  it("provider override wins over the global concurrency_limit policy", async () => {
    const dir = tempDir()
    const harness = makeHarness({
      categories: { concurrency_limit: { delayMs: 7_000 } },
      providers: { alibaba: { categories: { concurrency_limit: { delayMs: 2_000 } } } },
      ...loggingOptions(dir),
    })
    const cleanup = await setupQuotaMatata(harness.ctx)
    const input = makeRetry({ sessionID: "ses_conc_ovr", error: concurrencyError(), decision: { retry: false } })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    await cleanup?.()
    assert.deepEqual(input.decision, { retry: true, delay: 2_000 })
    const events = readEvents(dir)
    const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === "ses_conc_ovr:2")
    assert.equal(decision?.category, "concurrency_limit")
    assert.equal(decision?.delay, 2_000)
    assert.equal(decision?.policy, "providers.alibaba.categories.concurrency_limit")
  })

  it("non-Alibaba providers stay isolated: generic rate_limit, native decision untouched", async () => {
    const dir = tempDir()
    const harness = makeHarness(loggingOptions(dir))
    const cleanup = await setupQuotaMatata(harness.ctx)
    const native: SessionRetry["decision"] = { retry: true, delay: 2000 }
    const input = makeRetry({ sessionID: "ses_conc_iso", providerID: "openai", error: concurrencyError(), decision: native })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    await cleanup?.()
    assert.strictEqual(input.decision, native)
    const events = readEvents(dir)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type && candidate.correlationId === "ses_conc_iso:2")
      assert.ok(event)
      assert.equal(event.category, "rate_limit")
      assert.equal(event.rule, "generic.rate_limit")
      assert.equal(event.matched, undefined)
    }
    const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === "ses_conc_iso:2")
    assert.equal(decision?.override, false)
    assert.deepEqual(decision?.final, { retry: true, delay: 2000 })
  })

  it("disabled concurrency_limit policy keeps the native decision but logs the category", async () => {
    const dir = tempDir()
    const harness = makeHarness({ categories: { concurrency_limit: { enabled: false } }, ...loggingOptions(dir) })
    const cleanup = await setupQuotaMatata(harness.ctx)
    const native: SessionRetry["decision"] = { retry: true, delay: 2000 }
    const input = makeRetry({ sessionID: "ses_conc_off", error: concurrencyError(), decision: native })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    await cleanup?.()
    assert.strictEqual(input.decision, native)
    const events = readEvents(dir)
    const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === "ses_conc_off:2")
    assert.equal(decision?.category, "concurrency_limit")
    assert.equal(decision?.rule, "alibaba.quota_concurrency")
    assert.equal(decision?.matched, "alibaba")
    assert.equal(decision?.override, false)
    assert.deepEqual(decision?.final, { retry: true, delay: 2000 })
    assert.ok(String(decision?.reason).includes("disabled"))
  })

  it("disabled Alibaba classifier logs the generic rate limit for the concurrency phrase", async () => {
    const dir = tempDir()
    const harness = makeHarness({ providers: { alibaba: { enabled: false } }, ...loggingOptions(dir) })
    const cleanup = await setupQuotaMatata(harness.ctx)
    const native: SessionRetry["decision"] = { retry: false }
    const input = makeRetry({ sessionID: "ses_conc_dis", error: concurrencyError(), decision: native })
    withFixedNow(() => harness.hooks.retryCallbacks[0]?.(input))
    await cleanup?.()
    assert.strictEqual(input.decision, native)
    const events = readEvents(dir)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type && candidate.correlationId === "ses_conc_dis:2")
      assert.ok(event)
      assert.equal(event.category, "rate_limit")
      assert.equal(event.rule, "generic.rate_limit")
      assert.equal(event.matched, undefined)
    }
  })
})