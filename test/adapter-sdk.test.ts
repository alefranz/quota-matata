/**
 * Real-SDK boundary regressions for R21-01/R21-02.
 *
 * Unlike test/adapter.test.ts (fake host implementing the SDK signatures),
 * this suite drives the adapter through the ACTUAL published
 * @opencode/plugin@2.3.0 Promise→Effect wrapper (`fromPromise`): hook
 * callbacks are the real `Effect.promise(() => Promise.resolve(callback(…)))`
 * wraps from `promise/adapter.ts`, events pass the real SDK
 * `encodeOpenCodeEvent` schema encoding, and the subscription runs through
 * the real `makeStreams` iterator/scope-finalizer machinery. A callback that
 * throws would surface as an Effect defect (Exit.Failure) — exactly the host
 * failure mode the no-throw boundary must prevent.
 *
 * The synthetic Effect host below provides only the domains the adapter
 * uses (app/options/session.hook/event.subscribe); everything else is an
 * inert stub, mirroring the independent R21 review probe. Logging assertions
 * read real JSONL files written by the accepted logger.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { Effect, Exit, PubSub, Queue, Scope, Stream } from "effect"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import type { Context as EffectHostContext } from "@opencode/plugin/effect/plugin"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import type { OpenCodeEvent } from "@opencode/client"
import plugin from "../src/index.js"

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-adapter-sdk-"))
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

const QUOTA_ERROR: SessionRetry["error"] = {
  type: "provider.quota",
  message: "429 Too Many Requests",
  status: 429,
  response: { body: '{"error":{"message":"week allocated quota exceeded","code":"Throttling.AllocationQuota"}}' },
}

function retryInput(sessionID: string, overrides: { attempt?: number; error?: SessionRetry["error"] } = {}): SessionRetry {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "alibaba", id: "qwen" },
    error: overrides.error ?? QUOTA_ERROR,
    attempt: overrides.attempt ?? 2,
    decision: { retry: false },
  } as SessionRetry
}

/** Wire envelope as encoded by the host bus (schema session-event.ts). */
function wireEvent(type: OpenCodeEvent["type"], sessionID: string, error?: SessionRetry["error"]): unknown {
  return {
    id: "evt_sdk",
    created: Date.now(),
    type,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: {
      sessionID,
      ...(error === undefined ? {} : { error }),
      ...(type === "session.execution.interrupted" ? { reason: "user" } : {}),
    },
  }
}

type WrappedHook = (input: SessionRetry) => Effect.Effect<void>

interface SdkHarness {
  readonly directory: string
  readonly setup: Promise<void>
  readonly close: () => Promise<void>
  readonly push: (event: unknown) => Promise<void>
  readonly callbacks: Map<string, WrappedHook>
  readonly disposed: () => number
  readonly subscribed: () => number
  readonly finalized: () => number
  readonly selectedTypes: () => ReadonlyArray<string> | undefined
}

/**
 * Synthetic Effect host: real SDK `fromPromise` runs against it. The event
 * domain is a Queue-backed Stream filtered by the requested types, matching
 * the core bus contract (only requested types delivered, publish order kept).
 * `opts` tunes the plugin options (capture mode / provider classifier toggles)
 * without changing the host machinery.
 */
function makeSdkHarness(
  opts: { captureErrorDetails?: boolean; providers?: Record<string, unknown>; categories?: Record<string, unknown> } = {},
): SdkHarness {
  const directory = tempDir()
  const scope = Scope.makeUnsafe()
  const callbacks = new Map<string, WrappedHook>()
  let disposed = 0
  let subscribed = 0
  let finalized = 0
  let selected: ReadonlyArray<string> | undefined
  let queue: Queue.Queue<unknown>
  const stub: unknown = new Proxy(() => Effect.void, { get: () => stub })
  // The SDK eagerly reads nested domains (e.g. session.instructions.entry)
  // while building the Promise context: every unused path must stay a stub.
  const session = new Proxy(
    {
      hook: (name: string, callback: WrappedHook) =>
        Effect.gen(function* () {
          callbacks.set(name, callback)
          return { dispose: Effect.sync(() => void disposed++) }
        }),
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : stub) },
  )
  const event = new Proxy(
    {
      subscribe: (options?: { types?: ReadonlyArray<string> }) => {
        selected = options?.types
        const types = new Set(options?.types ?? [])
        return Stream.fromQueue(queue).pipe(
          Stream.filter((event) => types.has((event as { type: string }).type)),
          Stream.onStart(Effect.sync(() => void subscribed++)),
          Stream.ensuring(Effect.sync(() => void finalized++)),
        )
      },
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : stub) },
  )
  const special = {
    app: { name: "opencode", version: "2.3.0", channel: "stable" },
    options: {
      logging: {
        enabled: true,
        directory,
        ...(opts.captureErrorDetails === undefined ? {} : { captureErrorDetails: opts.captureErrorDetails }),
      },
      ...(opts.providers === undefined ? {} : { providers: opts.providers }),
      ...(opts.categories === undefined ? {} : { categories: opts.categories }),
    },
    session,
    event,
  }
  const host = new Proxy(special, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : stub),
  }) as unknown as EffectHostContext
  const setup = Effect.runPromise(Queue.unbounded<unknown>()).then((created) => {
    queue = created
    return Effect.runPromise(fromPromise(plugin).effect(host).pipe(Effect.provideService(Scope.Scope, scope)))
  })
  return {
    directory,
    setup,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    push: async (event) => {
      await setup
      await Effect.runPromise(Queue.offer(queue, event))
    },
    callbacks,
    disposed: () => disposed,
    subscribed: () => subscribed,
    finalized: () => finalized,
    selectedTypes: () => selected,
  }
}

function readEvents(dir: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.trim() !== "") events.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return events
}

describe("real SDK wrapper: hostile attempt never defects (R21-01)", () => {
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
  ]

  for (const { name, value } of hostileAttempts) {
    it(`real Effect.promise callback survives ${name} and fails native`, async () => {
      const harness = makeSdkHarness()
      await harness.setup
      await tick()
      const input = retryInput("ses_hostile")
      const savedDecision = input.decision
      ;(input as { attempt: unknown }).attempt = value
      const hook = harness.callbacks.get("retry")
      assert.ok(hook, "retry hook registered through the real SDK")
      // The real wrapper turns a thrown callback into an Effect defect.
      const exit = await Effect.runPromise(Effect.exit(hook(input)))
      assert.ok(Exit.isSuccess(exit), `callback must not defect the host (${name})`)
      assert.strictEqual(input.decision, savedDecision) // native reference preserved
      await harness.close()
      const events = readEvents(harness.directory)
      const pluginError = events.find((event) => event.type === "plugin.error")
      assert.ok(pluginError, "failure reported safely")
      assert.equal(pluginError.message, "retry hook evaluation failed; native decision preserved")
      const providerError = events.find((event) => event.type === "provider.error")
      assert.ok(providerError, "provider.error still attempted")
      assert.equal(providerError.correlationId, "ses_hostile:retry")
      assert.equal((providerError.context as Record<string, unknown>).attempt, undefined)
      assert.ok(!JSON.stringify(events).includes("SECRET"))
    })
  }

  it("a throwing attempt getter fails native through the real wrapper", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    const input = retryInput("ses_getter")
    Object.defineProperty(input, "attempt", {
      get() {
        throw new Error("attempt getter SECRET")
      },
    })
    const savedDecision = input.decision
    const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(input)))
    assert.ok(Exit.isSuccess(exit))
    assert.strictEqual(input.decision, savedDecision)
    await harness.close()
    const events = readEvents(harness.directory)
    assert.ok(events.some((event) => event.type === "plugin.error"))
    assert.ok(!JSON.stringify(events).includes("SECRET"))
  })

  it("valid weekly retries still work through the real wrapper after hostile ones", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    const hostile = retryInput("ses_hostile")
    ;(hostile as { attempt: unknown }).attempt = {
      [Symbol.toPrimitive]() {
        throw new Error("attempt conversion failure")
      },
    }
    assert.ok(Exit.isSuccess(await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(hostile)))))
    const input = retryInput("ses_valid")
    await Effect.runPromise(harness.callbacks.get("retry")!(input))
    assert.equal(input.decision.retry, true)
    if (input.decision.retry) {
      assert.ok(input.decision.delay > 0 && input.decision.delay <= 691_200_000)
    }
    await harness.close()
    const decision = readEvents(harness.directory).find(
      (event) => event.type === "retry.decision" && (event.context as Record<string, unknown>).sessionID === "ses_valid",
    )
    assert.ok(decision)
    assert.equal(decision.category, "quota_weekly")
    assert.equal(decision.correlationId, "ses_valid:2")
  })
})

describe("real SDK event encoding: terminal independence (R21-02)", () => {
  it("success then a new execution: terminal failure inherits nothing old", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    // Only the terminal failure is consumed; lifecycle events are not subscribed
    // (there is no cross-surface correlation cache to scope).
    assert.deepEqual(harness.selectedTypes(), ["session.execution.failed"])
    await Effect.runPromise(harness.callbacks.get("retry")!(retryInput("ses_stale")))
    await harness.push(wireEvent("session.execution.succeeded", "ses_stale"))
    await tick()
    await harness.push(wireEvent("session.execution.started", "ses_stale"))
    await tick()
    await harness.push(wireEvent("session.execution.failed", "ses_stale", QUOTA_ERROR))
    await tick()
    await harness.close()
    const terminal = readEvents(harness.directory).find(
      (event) => event.source === "event.session.execution.failed",
    )
    assert.ok(terminal, "terminal observation delivered through real SDK encoding")
    assert.equal(terminal.correlationId, "ses_stale:terminal")
    const context = terminal.context as Record<string, unknown>
    assert.equal(context.attempt, undefined)
    assert.equal(context.agent, undefined)
    assert.equal(context.model, undefined)
    assert.ok(String(terminal.reason).includes("independently"))
    assert.ok(!String(terminal.reason).includes("terminal confirmation"))
  })

  it("same-execution terminal is independent; the retry record keeps accurate context", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    await harness.push(wireEvent("session.execution.started", "ses_live"))
    await tick()
    await Effect.runPromise(harness.callbacks.get("retry")!(retryInput("ses_live")))
    await harness.push(wireEvent("session.execution.failed", "ses_live", QUOTA_ERROR))
    await tick()
    await harness.close()
    const events = readEvents(harness.directory)
    const terminal = events.find((event) => event.source === "event.session.execution.failed")
    assert.equal(terminal?.correlationId, "ses_live:terminal")
    assert.equal((terminal?.context as Record<string, unknown>).attempt, undefined)
    assert.ok(!String(terminal?.reason).includes("terminal confirmation"))
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.correlationId, "ses_live:2")
    assert.equal((decision?.context as Record<string, unknown>).attempt, 2)
  })

  it("consecutive executions and concurrent sessions stay isolated", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    // Two concurrent sessions observe retries in the same busy window.
    await Effect.runPromise(harness.callbacks.get("retry")!(retryInput("ses_a", { attempt: 2 })))
    await Effect.runPromise(harness.callbacks.get("retry")!(retryInput("ses_b", { attempt: 3 })))
    // ses_a succeeds and starts a new execution; ses_b keeps running.
    await harness.push(wireEvent("session.execution.succeeded", "ses_a"))
    await harness.push(wireEvent("session.execution.started", "ses_a"))
    await tick()
    await harness.push(wireEvent("session.execution.failed", "ses_b", QUOTA_ERROR))
    await tick()
    // ses_a's new execution fails with the same fingerprint, no retry hook.
    await harness.push(wireEvent("session.execution.failed", "ses_a", QUOTA_ERROR))
    await tick()
    await harness.close()
    const terminals = readEvents(harness.directory).filter(
      (event) => event.source === "event.session.execution.failed",
    )
    assert.equal(terminals.length, 2)
    const bySession = new Map(
      terminals.map((event) => [(event.context as Record<string, unknown>).sessionID, event]),
    )
    // Both terminals are independent; neither inherits a retry attempt/model.
    assert.equal(bySession.get("ses_b")?.correlationId, "ses_b:terminal")
    assert.equal((bySession.get("ses_b")?.context as Record<string, unknown>).attempt, undefined)
    assert.equal(bySession.get("ses_a")?.correlationId, "ses_a:terminal")
    assert.equal((bySession.get("ses_a")?.context as Record<string, unknown>).attempt, undefined)
    // Real SDK cleanup machinery: both hooks disposed, stream finalized once.
    assert.equal(harness.disposed(), 2)
    assert.equal(harness.subscribed(), 1)
    assert.equal(harness.finalized(), 1)
  })
})

// ---------------------------------------------------------------------------
// No-barrier real-SDK + unbounded-PubSub regressions (R23 reproductions).
//
// The Queue harness above lets a test await each push, which can hide the
// cross-surface ordering race. The host's in-process route is an UNBOUNDED
// PubSub per subscription (core bus.ts): `PubSub.publish` offers to the bus and
// returns WITHOUT awaiting this plugin's async subscriber, while the retry hook
// runs inline in the producer (Effect.promise). These tests drive the REAL
// published fromPromise wrapper + SDK event encoding over that host-equivalent
// PubSub and insert NO tick/barrier between publication and hook invocation
// inside a producer — the exact asynchronous delivery R23 reproduced.
// ---------------------------------------------------------------------------

interface PubSubHarness {
  readonly directory: string
  readonly setup: Promise<void>
  readonly close: () => Promise<void>
  readonly bus: () => PubSub.PubSub<unknown>
  readonly callbacks: Map<string, WrappedHook>
  readonly disposed: () => number
  readonly subscribed: () => number
  readonly finalized: () => number
  readonly selectedTypes: () => ReadonlyArray<string> | undefined
}

function makePubSubHarness(): PubSubHarness {
  const directory = tempDir()
  const scope = Scope.makeUnsafe()
  const callbacks = new Map<string, WrappedHook>()
  let disposed = 0
  let subscribed = 0
  let finalized = 0
  let selected: ReadonlyArray<string> | undefined
  let pubsub: PubSub.PubSub<unknown>
  const stub: unknown = new Proxy(() => Effect.void, { get: () => stub })
  const session = new Proxy(
    {
      hook: (name: string, callback: WrappedHook) =>
        Effect.gen(function* () {
          callbacks.set(name, callback)
          return { dispose: Effect.sync(() => void disposed++) }
        }),
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : stub) },
  )
  const event = new Proxy(
    {
      subscribe: (options?: { types?: ReadonlyArray<string> }) => {
        selected = options?.types
        const types = new Set(options?.types ?? [])
        return Stream.fromPubSub(pubsub).pipe(
          Stream.filter((event) => types.has((event as { type: string }).type)),
          Stream.onStart(Effect.sync(() => void subscribed++)),
          Stream.ensuring(Effect.sync(() => void finalized++)),
        )
      },
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : stub) },
  )
  const special = {
    app: { name: "opencode", version: "2.3.0", channel: "stable" },
    options: { logging: { enabled: true, directory } },
    session,
    event,
  }
  const host = new Proxy(special, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : stub),
  }) as unknown as EffectHostContext
  const setup = Effect.runPromise(PubSub.unbounded<unknown>()).then((created) => {
    pubsub = created
    return Effect.runPromise(fromPromise(plugin).effect(host).pipe(Effect.provideService(Scope.Scope, scope)))
  })
  return {
    directory,
    setup,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    bus: () => pubsub,
    callbacks,
    disposed: () => disposed,
    subscribed: () => subscribed,
    finalized: () => finalized,
    selectedTypes: () => selected,
  }
}

/** Setup-only synchronization: wait until the SDK subscription is attached. */
async function waitSubscribed(harness: PubSubHarness): Promise<void> {
  const deadline = Date.now() + 5000
  while (harness.subscribed() < 1) {
    if (Date.now() > deadline) throw new Error("PubSub subscription did not start")
    await tick()
  }
  await tick()
}

describe("real SDK + unbounded PubSub: no-barrier ordering (R23 reproductions)", () => {
  it("started -> retry hook -> failed with NO barrier: terminal independent, retry record intact", async () => {
    const harness = makePubSubHarness()
    await harness.setup
    await waitSubscribed(harness)
    const bus = harness.bus()
    const retryHook = harness.callbacks.get("retry")!
    assert.ok(retryHook, "retry hook registered through the real SDK")
    // One producer, NO tick/barrier between publication and the hook. The hook
    // overtakes the async subscriber — the exact R23 same-execution case where a
    // lifecycle-clearing cache lost the context. The terminal must be an
    // independent observation and the direct retry record must stay intact.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PubSub.publish(bus, wireEvent("session.execution.started", "ses_fast"))
        yield* retryHook(retryInput("ses_fast"))
        yield* PubSub.publish(bus, wireEvent("session.execution.failed", "ses_fast", QUOTA_ERROR))
      }),
    )
    await tick()
    await harness.close()
    const events = readEvents(harness.directory)
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 1)
    const terminal = terminals[0]!
    assert.equal(terminal.correlationId, "ses_fast:terminal")
    const context = terminal.context as Record<string, unknown>
    assert.equal(context.attempt, undefined)
    assert.equal(context.model, undefined)
    assert.equal(context.agent, undefined)
    assert.ok(String(terminal.reason).includes("independently"))
    // The relationship to the direct-hook records is made explicit, not fabricated.
    assert.ok(String(terminal.reason).includes("session.retry"))
    assert.ok(String(terminal.reason).includes("sessionID"))
    assert.ok(!String(terminal.reason).includes("terminal confirmation"))
    // The direct retry record keeps its accurate same-execution context.
    const decision = events.find((event) => event.type === "retry.decision")
    assert.ok(decision)
    assert.equal(decision.correlationId, "ses_fast:2")
    assert.equal((decision.context as Record<string, unknown>).attempt, 2)
    assert.equal((decision.context as Record<string, unknown>).model, "qwen")
  })

  it("backlogged old failure after a new retry: no cross-execution attribution", async () => {
    const harness = makePubSubHarness()
    await harness.setup
    await waitSubscribed(harness)
    const bus = harness.bus()
    const retryHook = harness.callbacks.get("retry")!
    // Execution A records attempt 2 via the direct hook.
    await Effect.runPromise(retryHook(retryInput("ses_cross", { attempt: 2 })))
    const inputB = {
      ...retryInput("ses_cross", { attempt: 7 }),
      model: { providerID: "alibaba", id: "NEW_MODEL" },
    } as SessionRetry
    // One producer: failed(A) -> started(B) -> retry(B, attempt7/NEW_MODEL) ->
    // failed(B), with NO subscriber barriers. The old failure is still queued
    // when the new execution's hook runs — the exact R23 serious case where the
    // old terminal was labeled with the NEW model/attempt.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PubSub.publish(bus, wireEvent("session.execution.failed", "ses_cross", QUOTA_ERROR))
        yield* PubSub.publish(bus, wireEvent("session.execution.started", "ses_cross"))
        yield* retryHook(inputB)
        yield* PubSub.publish(bus, wireEvent("session.execution.failed", "ses_cross", QUOTA_ERROR))
      }),
    )
    await tick()
    await harness.close()
    const events = readEvents(harness.directory)
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 2)
    for (const terminal of terminals) {
      assert.equal(terminal.correlationId, "ses_cross:terminal")
      const context = terminal.context as Record<string, unknown>
      assert.equal(context.attempt, undefined)
      assert.equal(context.model, undefined)
      assert.equal(context.agent, undefined)
      assert.ok(!String(terminal.reason).includes("terminal confirmation"))
    }
    // The FIRST terminal (execution A) must NOT carry B's attempt 7 / NEW_MODEL.
    assert.equal((terminals[0]!.context as Record<string, unknown>).attempt, undefined)
    assert.equal((terminals[0]!.context as Record<string, unknown>).model, undefined)
    // Each direct retry record keeps its own accurate attempt/model.
    const decisions = events.filter((event) => event.type === "retry.decision")
    assert.equal(decisions.length, 2)
    assert.equal(decisions[0]!.correlationId, "ses_cross:2")
    assert.equal((decisions[0]!.context as Record<string, unknown>).attempt, 2)
    assert.equal((decisions[0]!.context as Record<string, unknown>).model, "qwen")
    assert.equal(decisions[1]!.correlationId, "ses_cross:7")
    assert.equal((decisions[1]!.context as Record<string, unknown>).attempt, 7)
    assert.equal((decisions[1]!.context as Record<string, unknown>).model, "NEW_MODEL")
  })

  it("multi-session + unknown error + lifecycle, no barriers: all terminals independent", async () => {
    const harness = makePubSubHarness()
    await harness.setup
    await waitSubscribed(harness)
    const bus = harness.bus()
    const retryHook = harness.callbacks.get("retry")!
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PubSub.publish(bus, wireEvent("session.execution.started", "ses_x"))
        yield* retryHook(retryInput("ses_x", { attempt: 2 }))
        yield* PubSub.publish(bus, wireEvent("session.execution.succeeded", "ses_x"))
        yield* PubSub.publish(bus, wireEvent("session.execution.failed", "ses_x", QUOTA_ERROR))
        yield* PubSub.publish(bus, wireEvent("session.execution.interrupted", "ses_y"))
        yield* PubSub.publish(
          bus,
          wireEvent("session.execution.failed", "ses_y", { type: "unknown", message: "mystery failure" }),
        )
      }),
    )
    await tick()
    await harness.close()
    const events = readEvents(harness.directory)
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 2)
    const bySession = new Map(
      terminals.map((event) => [(event.context as Record<string, unknown>).sessionID, event]),
    )
    assert.equal(bySession.get("ses_x")?.correlationId, "ses_x:terminal")
    assert.equal((bySession.get("ses_x")?.context as Record<string, unknown>).attempt, undefined)
    // The unknown terminal error is still captured, with no inferred context.
    assert.equal(bySession.get("ses_y")?.correlationId, "ses_y:terminal")
    assert.deepEqual(bySession.get("ses_y")?.error, { type: "unknown" })
    // Direct retry record for ses_x intact.
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.correlationId, "ses_x:2")
    // Lifecycle signals are not logged as errors; no plugin errors.
    assert.ok(!events.some((event) => String(event.reason ?? "").includes("interrupted")))
    assert.equal(events.filter((event) => event.type === "plugin.error").length, 0)
    assert.equal(harness.disposed(), 2)
    assert.equal(harness.finalized(), 1)
  })
})

// ---------------------------------------------------------------------------
// R27-01: classifier provenance through the REAL published SDK wrapper into
// real JSONL files. The installed-package reproduction saw 136 decisions with
// zero rule fields; these regressions pin the actual matched rule identity on
// every record the retry hook emits, plus context-free terminal classification.
// ---------------------------------------------------------------------------
describe("real SDK wrapper: classifier provenance in real JSONL (R27-01)", () => {
  const planCases = [
    ["hour allocated quota exceeded", "quota_five_hour", "alibaba.quota_five_hour"],
    ["week allocated quota exceeded", "quota_weekly", "alibaba.quota_weekly"],
    ["month allocated quota exceeded", "quota_monthly", "alibaba.quota_monthly"],
    ["usage allocated quota exceeded", "quota_temporary", "alibaba.quota_temporary"],
    ["concurrency allocated quota exceeded", "concurrency_limit", "alibaba.quota_concurrency"],
  ] as const

  function planError(phrase: string): SessionRetry["error"] {
    return {
      type: "provider.quota",
      message: "429 Too Many Requests",
      status: 429,
      response: { body: JSON.stringify({ error: { message: phrase, type: "insufficient_quota", code: null } }) },
    }
  }

  for (const capture of [false, true]) {
    it(`all five Alibaba plan rules carry rule/matched through the real wrapper (captureErrorDetails=${capture})`, async () => {
      const harness = makeSdkHarness({ captureErrorDetails: capture })
      await harness.setup
      await tick()
      for (const [i, [phrase]] of planCases.entries()) {
        const input = retryInput(`ses_sdk_${i}`, { error: planError(phrase) })
        const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(input)))
        assert.ok(Exit.isSuccess(exit), "callback must not defect the host")
      }
      await harness.close()
      const events = readEvents(harness.directory)
      for (const [i, [, category, ruleId]] of planCases.entries()) {
        const correlationId = `ses_sdk_${i}:2`
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
      assert.equal(events.filter((event) => event.type === "plugin.error").length, 0)
      if (!capture) assert.ok(!JSON.stringify(events).includes("allocated quota exceeded"))
    })
  }

  it("generic permanent, the permanent gate and the fallback keep generic ids without matched", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    const cases: Array<{ sessionID: string; providerID: string; error: SessionRetry["error"]; rule: string; category: string }> = [
      {
        sessionID: "ses_sdk_billing",
        providerID: "openai",
        error: { type: "provider.budget-limit", message: "BudgetLimitExceeded", status: 402 },
        rule: "generic.billing",
        category: "billing",
      },
      {
        sessionID: "ses_sdk_gate",
        providerID: "alibaba",
        error: { type: "provider.quota", message: "week allocated quota exceeded", status: 402 },
        rule: "generic.billing",
        category: "billing",
      },
      {
        sessionID: "ses_sdk_fallback",
        providerID: "alibaba",
        error: { type: "unknown", message: "mystery failure" },
        rule: "generic.other",
        category: "other",
      },
    ]
    for (const testCase of cases) {
      const input = {
        ...retryInput(testCase.sessionID, { error: testCase.error }),
        model: { providerID: testCase.providerID, id: "some-model" },
      } as SessionRetry
      const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(input)))
      assert.ok(Exit.isSuccess(exit))
    }
    await harness.close()
    const events = readEvents(harness.directory)
    for (const testCase of cases) {
      const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === `${testCase.sessionID}:2`)
      const providerError = events.find((event) => event.type === "provider.error" && event.correlationId === `${testCase.sessionID}:2`)
      assert.ok(decision)
      assert.ok(providerError)
      for (const event of [decision, providerError]) {
        assert.equal(event.rule, testCase.rule)
        assert.equal(event.category, testCase.category)
        assert.equal(event.matched, undefined)
      }
    }
  })

  it("a disabled Alibaba classifier logs generic rules through the real wrapper", async () => {
    const harness = makeSdkHarness({ providers: { alibaba: { enabled: false } } })
    await harness.setup
    await tick()
    const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(retryInput("ses_sdk_disabled"))))
    assert.ok(Exit.isSuccess(exit))
    await harness.close()
    const events = readEvents(harness.directory)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type)
      assert.equal(event?.rule, "generic.rate_limit")
      assert.equal(event?.matched, undefined)
    }
  })

  it("terminal observations through real SDK encoding carry context-free rules, never matched", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    await Effect.runPromise(harness.callbacks.get("retry")!(retryInput("ses_sdk_term")))
    await harness.push(wireEvent("session.execution.failed", "ses_sdk_term", QUOTA_ERROR))
    await tick()
    await harness.push(wireEvent("session.execution.failed", "ses_sdk_term", { type: "unknown", message: "mystery failure" }))
    await tick()
    await harness.close()
    const events = readEvents(harness.directory)
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.rule, "alibaba.quota_weekly")
    assert.equal(decision?.matched, "alibaba")
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 2)
    assert.equal(terminals[0]?.rule, "generic.rate_limit") // QUOTA_ERROR carries status 429
    assert.equal(terminals[1]?.rule, "generic.other")
    for (const terminal of terminals) {
      assert.equal(terminal.matched, undefined)
      assert.equal(terminal.correlationId, "ses_sdk_term:terminal")
      const context = terminal.context as Record<string, unknown>
      assert.equal(context.sessionID, "ses_sdk_term")
      assert.equal(context.agent, undefined)
      assert.equal(context.provider, undefined)
      assert.equal(context.model, undefined)
      assert.equal(context.attempt, undefined)
      assert.ok(String(terminal.reason).includes("independently"))
      assert.ok(String(terminal.reason).includes("context-free"))
    }
  })

  it("no-barrier PubSub: provenance never crosses surfaces under async delivery", async () => {
    const harness = makePubSubHarness()
    await harness.setup
    await waitSubscribed(harness)
    const bus = harness.bus()
    const retryHook = harness.callbacks.get("retry")!
    // One producer, NO barrier: the retry hook overtakes the async subscriber.
    // The terminal must classify its OWN error context-free, never inheriting
    // the retry record's provider-specific rule/matched.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* PubSub.publish(bus, wireEvent("session.execution.started", "ses_prov"))
        yield* retryHook(retryInput("ses_prov"))
        yield* PubSub.publish(bus, wireEvent("session.execution.failed", "ses_prov", QUOTA_ERROR))
      }),
    )
    await tick()
    await harness.close()
    const events = readEvents(harness.directory)
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.rule, "alibaba.quota_weekly")
    assert.equal(decision?.matched, "alibaba")
    assert.equal(decision?.correlationId, "ses_prov:2")
    const terminals = events.filter((event) => event.source === "event.session.execution.failed")
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0]?.rule, "generic.rate_limit")
    assert.equal(terminals[0]?.matched, undefined)
    assert.equal(terminals[0]?.correlationId, "ses_prov:terminal")
    assert.equal((terminals[0]?.context as Record<string, unknown>).attempt, undefined)
  })
})

// ---------------------------------------------------------------------------
// R27-02: the required public category concurrency_limit through the REAL
// published SDK wrapper into real JSONL: default 5s delay, configured policy,
// non-Alibaba isolation and disabled classifier. The stable rule identity
// stays alibaba.quota_concurrency.
// ---------------------------------------------------------------------------
describe("real SDK wrapper: concurrency_limit category in real JSONL (R27-02)", () => {
  const concurrencyError: SessionRetry["error"] = {
    type: "provider.quota",
    message: "429 Too Many Requests",
    status: 429,
    response: {
      body: JSON.stringify({ error: { message: "concurrency allocated quota exceeded", type: "insufficient_quota", code: null } }),
    },
  }

  it("default 5s retry: category/rule/matched/policy through the real wrapper", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    const input = retryInput("ses_sdk_conc", { error: concurrencyError })
    const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(input)))
    assert.ok(Exit.isSuccess(exit), "callback must not defect the host")
    assert.deepEqual(input.decision, { retry: true, delay: 5_000 })
    await harness.close()
    const events = readEvents(harness.directory)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type && candidate.correlationId === "ses_sdk_conc:2")
      assert.ok(event, `${type} record`)
      assert.equal(event.category, "concurrency_limit")
      assert.equal(event.rule, "alibaba.quota_concurrency")
      assert.equal(event.matched, "alibaba")
    }
    const decision = events.find((event) => event.type === "retry.decision")
    assert.equal(decision?.policy, "providers.alibaba.categories.concurrency_limit")
    assert.equal(decision?.delay, 5_000)
    assert.deepEqual(decision?.final, { retry: true, delay: 5_000 })
    assert.equal(events.filter((event) => event.type === "plugin.error").length, 0)
  })

  it("configured categories.concurrency_limit delay applies through the real wrapper", async () => {
    const harness = makeSdkHarness({ categories: { concurrency_limit: { delayMs: 1234 } } })
    await harness.setup
    await tick()
    const input = retryInput("ses_sdk_conc_cfg", { error: concurrencyError })
    const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(input)))
    assert.ok(Exit.isSuccess(exit))
    assert.deepEqual(input.decision, { retry: true, delay: 1234 })
    await harness.close()
    const events = readEvents(harness.directory)
    const decision = events.find((event) => event.type === "retry.decision" && event.correlationId === "ses_sdk_conc_cfg:2")
    assert.equal(decision?.category, "concurrency_limit")
    assert.equal(decision?.delay, 1234)
    assert.deepEqual(decision?.final, { retry: true, delay: 1234 })
    assert.equal(decision?.policy, "providers.alibaba.categories.concurrency_limit")
  })

  it("non-Alibaba isolation keeps the generic rate limit and the native reference", async () => {
    const harness = makeSdkHarness()
    await harness.setup
    await tick()
    const input = {
      ...retryInput("ses_sdk_conc_iso", { error: concurrencyError }),
      model: { providerID: "openai", id: "some-model" },
    } as SessionRetry
    const native = input.decision
    const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(input)))
    assert.ok(Exit.isSuccess(exit))
    assert.strictEqual(input.decision, native)
    await harness.close()
    const events = readEvents(harness.directory)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type && candidate.correlationId === "ses_sdk_conc_iso:2")
      assert.ok(event)
      assert.equal(event.category, "rate_limit")
      assert.equal(event.rule, "generic.rate_limit")
      assert.equal(event.matched, undefined)
    }
  })

  it("disabled Alibaba classifier logs the generic rate limit through the real wrapper", async () => {
    const harness = makeSdkHarness({ providers: { alibaba: { enabled: false } } })
    await harness.setup
    await tick()
    const input = retryInput("ses_sdk_conc_dis", { error: concurrencyError })
    const native = input.decision
    const exit = await Effect.runPromise(Effect.exit(harness.callbacks.get("retry")!(input)))
    assert.ok(Exit.isSuccess(exit))
    assert.strictEqual(input.decision, native)
    await harness.close()
    const events = readEvents(harness.directory)
    for (const type of ["provider.error", "retry.decision"]) {
      const event = events.find((candidate) => candidate.type === type && candidate.correlationId === "ses_sdk_conc_dis:2")
      assert.ok(event)
      assert.equal(event.category, "rate_limit")
      assert.equal(event.rule, "generic.rate_limit")
      assert.equal(event.matched, undefined)
    }
  })
})
