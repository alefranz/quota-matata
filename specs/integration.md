# Quota Matata integration — adapter design spec

Slice: wire the accepted pure core (`evaluateQuota`) and the accepted
privacy-safe JSONL logger to the supported OpenCode v2 Promise plugin API
(`@opencode/plugin@2.3.0`). Status: implemented (`src/adapter.ts`,
`src/index.ts`). The core engine and logger files are unchanged by this slice;
the only pre-existing edits are the package entry/export surface
(`src/index.ts` → re-exports `src/core.ts` + plugin default) and packaging
(`package.json`/lock: SDK pin, exports, smoke script).

The accepted boundaries remain authoritative: `specs/core.md` (pure engine),
`specs/logging.md` (logger). This document covers only the adapter and the
host contract it relies on.

## Host contract evidence (verified, not assumed)

Host source: `/tmp/opencode-wt/v2.3.0`, commit
`a6b15d33daf6ab7d35569f6d711fdb630b9f04e7` (read-only). Published SDK:
`@opencode/plugin@2.3.0` tarball (verified copy `/tmp/opencode/qm-sdk`); its
`dist` declaration types for plugin/registration/options/event/session match
the host source, and its runtime is compiled ESM JavaScript (not TS source):
`Plugin.define` imports and runs on plain Node ESM, and the package's `./*`
wildcard export resolves the `promise/*` type subpaths. `effect@4.1.0`
matches the host catalog.

- `packages/core/src/session/runner/retry.ts` — the native policy decides
  first; when its schedule is exhausted it returns `{retry:false}` **without
  calling the plugin hook**. Within budget the hook event
  `{sessionID, agent, model, error, attempt, decision}` is passed to plugins
  and the host reads `event.decision` **after** the hook returns, so both
  mutation and reassignment of `decision` are honored. Delay normalization:
  finite and ≥ 0 → `Math.ceil`, otherwise the native delay. The wait is
  `Effect.sleep(Duration.millis(remaining))` after publishing
  `SessionEvent.RetryScheduled` — cancellable, host-owned.
- `packages/core/src/model-retry.ts` — native schedule: exponential 2 s capped
  10 s per gap, 10 retries; provider retry-after capped at 15 min; unreachable
  transport gets its own 1 h window (30 s gap cap); timeout attempts capped
  at 3. The plugin cannot extend these caps and this adapter never tries.
- `packages/plugin/src/promise/adapter.ts:632` — session hook callbacks are
  wrapped as `Effect.promise(() => Promise.resolve(callback(event)))`.
  A thrown or rejected callback becomes an Effect **defect** in the session
  execution, so adapter callbacks must never throw. Setup is likewise wrapped
  (`:674`); the returned cleanup becomes a finalizer (`:676`), and event
  subscriptions are closed by a scope finalizer (`:51`).
- `packages/plugin/src/promise/session.ts` — `SessionRetry` (mutable
  `decision: {retry:false} | {retry:true, delay:number}`),
  `SessionHttpResponse` (`request: Request`, `response: Response`,
  `kind: "primary"|"compaction"|"title"|"generate"`), `SessionHooks` names.
  `packages/plugin/src/promise/registration.ts` — `ModelHooks` with optional
  `{providerID}` scoping; **unscoped hooks apply to every provider** (this
  adapter registers unscoped, covering primary and subagent sessions alike);
  `Registration.dispose(): Promise<void>`.
- `packages/plugin/src/promise/event.ts` + `packages/plugin/src/promise/adapter.ts:331-341`
  (`event.subscribe`) + `makeStreams:47-77` → `packages/core/src/plugin/host.ts:268-284`
  → `packages/core/src/bus.ts:730-762` — the **in-process** Promise-plugin
  event route (R21-N1 correction). `event.subscribe({types?, signal?})`
  returns an `AsyncIterable` of wire events encoded by the SDK
  (`encodeOpenCodeEvent`); the core bus delivers only the requested types
  through one **unbounded** `PubSub` per subscription, preserving publish
  order across types. The network client's `shared-events.ts`
  capacity/overflow/`server.connected` behavior is NOT this path's contract:
  there is no subscriber capacity bound here, and `server.connected` is not a
  requestable server event on this route (the SDK's subscribe type excludes
  it; the adapter still ignores unknown types defensively). Abort closes the
  Effect iterator via `iterator.return()` (`makeStreams`), resolving any
  pending `next()` with `{done:true}`; a scope finalizer closes every
  subscription on unload (both verified against the real SDK iterator). A
  stream error still costs terminal observations: the adapter reports one
  `plugin.error` and the retry hook keeps working.
- `packages/client/src/promise/generated/types.ts` — wire envelope
  `{id, created, type, durable:{aggregateID,seq,version}, data}`;
  `session.execution.failed` data is `{sessionID, error}`;
  `session.execution.interrupted` data is
  `{sessionID, reason: "user"|"shutdown"|"superseded"|"inactivity"}`;
  `session.execution.started` / `session.execution.succeeded` data is
  `{sessionID}` (`packages/schema/src/session-event.ts:244-263`).
  Terminal events carry **no agent/model/attempt**.
- `packages/core/src/session/execution.ts:133-216` +
  `packages/core/src/session/run-coordinator.ts:61-67` — one busy period per
  execution: `Execution.Started` is published once before the first drain
  (uninterruptible), retry hooks run inside the drains, and exactly one
  terminal event (`Succeeded`/`Failed`/`Interrupted`) is published by the
  settled hook after the last drain. This is the **producer's publish order
  only**. It does NOT order this plugin's asynchronous event subscriber against
  the direct retry/HTTP hooks: the bus publishes to an unbounded PubSub and
  returns without awaiting the subscriber, while the hooks run inline in the
  drain. A hook can therefore run before the subscriber has processed an earlier
  `started`, and a queued old `failed` can be processed after a newer
  execution's hook. Terminal events also carry **no execution identity** (only
  `sessionID`), so no supported ID ties a terminal to a specific retry attempt
  or execution. The adapter therefore keeps **no cross-surface correlation
  cache** (see "Correlation visibility" below).
- `packages/core/src/plugin/module.ts` — the loader validates the **default
  export** as `{id, setup}` (Promise) or `{id, effect}`; options arrive from
  the config entry. `packages/core/src/config/plugin/source.ts` +
  `packages/schema/src/config/plugin.ts` — `plugins` entries are a string
  (package name, optionally `@version`, or path) or
  `{package: string, options?: Record<string, unknown>}`; a `-` prefix removes
  a plugin. `packages/plugin/src/host.ts` — the server entrypoint resolves the
  `server` subpath first, then the package root; this package exports both to
  the same entry.
- `effect@4.1.0` `dist/internal/effect.js:2898-2922` — `ClockImpl.sleepMillis`
  recursively chunks durations > 2^31−1 ms into `setTimeout` segments with a
  `clearTimeout` finalizer: weekly-scale waits are supported and cancellable.
  Non-finite durations never resolve; ≤ 0 yields. The core additionally keeps
  every emitted delay a finite integer ≤ 2^31−1 ms.
- `packages/core/src/session/to-session-error.ts:38-40` (re-verified
  2026-11-15 at the same commit) — any AI error whose body contains
  `subscription_sharing_usage_limit_exceeded` becomes native
  `provider.chatgpt-limit` (ChatGPT subscription usage limit), regardless of
  the underlying reason tag.
  `packages/core/src/plugin/provider/openai.ts:25` — the ChatGPT/Codex login
  surface uses `https://chatgpt.com/backend-api/codex`. The plugin maps
  `provider.chatgpt-limit` to `billing`/stop (specs/core.md, provider
  coverage evidence). OpenAI's SIWC error-recovery docs describe that code's
  semantics for the SIWC direct route — a different surface — so the full
  SIWC recovery table is not claimed for the host's Codex endpoint; only
  this shared code→type mapping is relied on.
- Official docs (fetched 2026-11-14): `opencode.ai/docs/plugins` confirms the
  `plugins` array with `{package, options}` entries, version pinning, and `-`
  removal; `/docs/build/plugins` and `/docs/build/plugins/server` describe the
  Promise entry surface.

## Adapter design

Entry: `src/index.ts` default-exports `Plugin.define({id: "quota-matata",
setup: setupQuotaMatata})` and re-exports the SDK-free core surface from
`src/core.ts` (also available without the SDK as `quota-matata/core`).

Surfaces (all registered unscoped, server-wide):

1. `session.hook("retry", …)` — the only surface that can change a decision.
   The **entire callback** (reads, validation, metadata formatting,
   evaluation, logging, decision application) runs inside one no-throw
   boundary. It snapshots the native decision first, reads host fields
   through guarded accessors, and validates `attempt` as a finite number
   **before any string coercion** — a malformed/hostile non-number (throwing
   `Symbol.toPrimitive`/`toString`, symbol, getter) fails native instead of
   escaping into the host's `Effect.promise`. It then runs `evaluateQuota`
   with `now: Date.now()`, logs `provider.error` + `retry.decision`
   (original/final/policy/delay/reason, category, correlation context), and
   applies **only validated overrides**. Both records carry the FULL
   classification provenance from `result.classification` (R27-01): `rule` =
   the classifier's stable `ruleId`, and `matched` = the canonical
   `classification.provider` **only when a provider-specific rule actually
   matched** — generic/fallback rules leave `matched` unset, so no provider
   identity is fabricated. The logger sanitizes/bounds these fields through
   its accepted path like any other string. Override application: `retry`
   re-checks integer
   0..2^31−1 before assigning `{retry:true, delay}`; `stop` assigns
   `{retry:false}`; `no_override` leaves the host object untouched (same
   reference). Any internal failure fails native: the decision is left
   exactly as received and a sanitized `plugin.error` is logged (fallback
   context reuses only guarded reads; an unusable attempt gets the
   `sessionID:retry` correlation label). Unknown categories are logged and
   left native.
2. `session.hook("http.response", …)` — metadata-only observation of
   status ≥ 400: status, `Retry-After` header (delta-seconds or HTTP-date,
   clamped to the delay ceiling), request kind. It never reads the request,
   URLs, other headers, or the one-shot response body stream (tests use
   hostile getters that throw if read). Logged as `provider.error` with a
   synthetic `{type:"http.error", status, retryAfterMs?}` payload and an
   explicit metadata-only reason. This surface observes; it never decides.
3. `event.subscribe({types, signal})` — terminal `session.execution.failed`
   observations only (provider.error even when the native schedule exhausted
   and no retry hook ran). A terminal event is an **independent observation
   source**: the host supplies only `{sessionID, error}` on it, so the adapter
   logs exactly those fields and never infers agent/model/attempt or an
   execution. The observed error is classified **context-free** (R27-01): no
   provider/model identity is supplied on a terminal, so only generic rules
   can match. The record carries the classifier's actual `rule` for THIS
   error (e.g. `generic.rate_limit`, `generic.other`) — never a
   provider-specific rule and never a `matched` provider borrowed from a
   retry/HTTP record. Classification is pure and per-event (no cross-surface
   state) and guarded: a hostile error shape that throws on property reads
   keeps the observation itself, logged without classification. Lifecycle
   events (`started`/`succeeded`/`interrupted`/`deleted`)
   are **not subscribed**: they are not provider errors, and with no correlation
   cache there is nothing to scope or release.

Correlation visibility (R21-02 / R23; provenance R27-01): the adapter keeps
**no cross-surface correlation state**. Each surface logs an independent record:

- `session.retry` records carry the accurate host-supplied
  session/agent/provider/model/attempt under `correlationId = sessionID:attempt`
  (or `sessionID:retry` when the attempt is unreadable), plus the classification
  provenance on both the `provider.error` and `retry.decision` records: `rule`
  (stable classifier ruleId) and `matched` (canonical provider, only for
  provider-specific rules).
- `session.http.response` records carry session/agent/provider/model under
  `correlationId = sessionID:http:kind`.
- `session.execution.failed` records carry only `sessionID` (the host supplies
  nothing else) under `correlationId = sessionID:terminal`, with a reason that
  explicitly states the terminal is an independent observation and points to the
  direct-hook records by sessionID. Their `rule` is the context-free generic
  classification of the terminal error itself (when classification succeeds);
  they never carry `matched` or any provider-specific rule.

The relationship between a terminal failure and the retry attempts that preceded
it is made clear by the shared `sessionID` (and timestamps), **not** by a
fabricated attempt/model/confirmation label. This is deliberate: the public API
provides no stable execution identity on terminal events, and the event bus
delivers them asynchronously relative to the direct hooks, so any inferred
"same-execution confirmation" could attribute a new execution's model/attempt to
an old queued failure (or lose the context entirely) under arbitrary no-barrier
delivery. Removing the cache makes terminal attribution correct for **every**
delivery order — including a delayed old failure arriving after a newer
execution's retry hook, successes/interruptions across requests, and multiple
concurrent sessions. The direct retry/HTTP records remain the authoritative
per-attempt source. The logger hoists `source`/`correlationId`/`hostVersion` to
top-level event fields (accepted logger schema); `context` keeps only the fields
the host actually supplies.

Safety model:

- Callbacks never throw (host `Effect.promise` defect risk). Every surface
  wraps its **entire** work — including preamble reads, validation and
  formatting — and validates values before coercing them; failures become
  sanitized `plugin.error` events with the native decision preserved.
  Logging itself is additionally guarded so a misbehaving sink cannot break
  the host.
- No timers, schedulers, or global counters: waits are the host's cancellable
  `Effect.sleep`; the adapter adds no retry loop of its own and never edits
  credentials, models, or native caps. It also keeps no cross-surface
  correlation state, so asynchronous event delivery cannot mislabel a terminal
  observation (see "Correlation visibility").
- `enabled: false` is fully inert: no hooks, no subscription, no logger, no
  files. Invalid options reject from setup with `ConfigError` listing every
  dotted-path issue (never silent).
- Cleanup: abort the subscription signal, dispose every registration, await
  the event loop's exit, `logger.close()` (flush). Idempotent;
  no background work survives. Partial setup failure unwinds everything
  acquired and rethrows.

## Verification

The adapter/entry suites (`test/adapter.test.ts`, `test/entry.test.ts`,
`test/adapter-sdk.test.ts`) compile against the **real published SDK types**. The fake-host suites drive a host that implements the
actual SDK signatures and abort/iterator semantics; `adapter-sdk.test.ts`
additionally runs the adapter through the **real published SDK wrapper**
(`fromPromise`): hook callbacks are the actual
`Effect.promise(() => Promise.resolve(callback(…)))` wraps (a throw surfaces
as `Exit.Failure`), events pass the real SDK schema encoding, and cleanup
runs through the real scope finalizers. Logging assertions read real JSONL
files written by the accepted logger. Coverage:
setup/options/inert/bad-config/partial-failure, weekly force over native
false, no_override reference preservation, permanent stop, cooldown merge,
stop-not-clamp bounds, unknown errors, hostile getters/throwing clock/failed
sink fail-native, malformed/hostile attempt values (throwing
`Symbol.toPrimitive`/`toString`, symbol, nonnumeric string, NaN/Infinity,
throwing getter) fail native without defecting the real SDK callback and
keep the callback usable, HTTP metadata-only (hostile request/body getters),
Retry-After parsing, terminal independence (unknown-error capture, no inferred
agent/model/attempt, mismatch/HTTP/lifecycle never attributed, multi-session
primary+subagent isolation, high-volume no-shared-state, broken stream),
lifecycle/ordering regressions (success→new-execution, missed terminal,
same-execution, consecutive executions, concurrent sessions, lifecycle events
never logged as errors), cleanup disposal+abort+flush+idempotence, real
`Plugin.define` entry shape and SDK-free core subpath, and classifier
provenance in real JSONL (R27-01: both capture modes, five Alibaba plan rules
with canonical `matched`, generic/fallback rules with `rule` but no fabricated
`matched`, disabled classifier, alias canonicalization, and context-free
terminal `rule` with no `matched`/inferred context), and the required public
`concurrency_limit` category in real JSONL (R27-02: default 5 s delay with
`category`/`policy`/`rule`/`matched` on both records in both capture modes,
user-configured global and provider-override delays applied to the host
decision, non-Alibaba isolation and disabled category/classifier paths keeping
the native decision; the stable rule label stays `alibaba.quota_concurrency`).

**Hostile terminal shapes and the wire boundary (R27-01 / R29):** the adapter's
guarded terminal classifier keeps an observation even when the error throws on
property reads (logged without classification). That guard is exercised at the
correct layer by the fake-host suite, which delivers events directly. On the
REAL wire such a raw throwing-getter object cannot reach the plugin: the host
bus schema-encodes events before publishing and the SDK `fromPromise` re-encodes
on subscribe (`encodeOpenCodeEvent`), so the hostile getter throws upstream and
defects the stream rather than entering the adapter. The installed-package
probe therefore asserts the hostile shape is rejected by the real wire schema
and that a valid terminal after it is still observed — it does not inject an
impossible pre-boundary object.

**No-barrier ordering regressions (R23):** `adapter-sdk.test.ts` also drives the
real SDK wrapper over a host-equivalent **unbounded PubSub** (`PubSub.unbounded`
/ `Stream.fromPubSub`, matching core `bus.ts`) and runs producers that publish
lifecycle/terminal events and invoke the real retry hook with **no tick/barrier
between them** — the exact asynchronous cross-surface delivery that defeated the
old lifecycle-clearing cache. Both R23 reproductions are covered: (1)
`started → retry hook → failed` (terminal stays independent, retry record
intact), and (2) a backlogged old `failed` processed after a newer execution's
`retry` hook (the old terminal is NOT labeled with the new attempt/model). A
third case interleaves multiple sessions, an unknown-error terminal, and
lifecycle events. These assert the conservative invariants, not the old
confirmation inference. Suite passes under TZ=UTC, America/New_York,
Asia/Shanghai, Pacific/Kiritimati.

`npm run smoke` (`scripts/package-smoke.mjs`): `npm pack` → install the
tarball into a throwaway consumer → import the installed root on plain Node
ESM (default definition + named exports + a real decision) → remove the
installed SDK and import `quota-matata/core` in a fresh process (must still
work; negative control: the root must then fail). Nothing is published.

**Verification boundary (honest limits):** all host behavior above is verified
against host source, the published SDK, and boundary tests — **not** against
a live OpenCode host with real provider credentials. No live-provider E2E was
run; weekly waits are verified structurally (effect chunking + cancellable
sleep), not by waiting a week.

## Deferred / honest limitations

- Native exhaustion skips the hook: when the host's own schedule runs out,
  there is no `retry.decision` event (the hook was never called); the failure
  is still observed via the terminal `provider.error` when the event stream
  delivers it. The plugin cannot extend the native cap.
- Long waits are process-lifetime, not durable: a host restart/crash loses a
  pending weekly wait (the host owns the sleep). `maxWaitMs` bounds each
  emitted delay, not cumulative waiting; `maxElapsedMs` only applies when a
  caller supplies cumulative `metadata.elapsedMs` — the adapter keeps no
  global counters and does not supply it.
- Monthly subscription anniversary is not published on the wire: default
  monthly policy stops; `untilReset` retry requires a reliable caller-supplied
  `resetAtMs`. No calendar reset is invented.
- ChatGPT subscription usage limits (`provider.chatgpt-limit`) stop via the
  generic billing rule: the adapter schedules no reset-based retry for them
  and infers no reset time. Stop is a non-retry policy, not a claim of
  literal permanence (see specs/core.md, provider coverage evidence).
- HTTP observation is metadata-only by design: no body is read, so provider
  codes for classification come from the retry hook's error body, not the
  HTTP surface. The same failure may appear on several surfaces; the shared
  `sessionID` links the records (the direct-hook records carry the accurate
  per-attempt context). Terminal failures are logged independently, not dropped
  and not labeled as confirmations.
- Terminal events carry no agent/model/attempt and no execution identity. The
  adapter logs them as independent observations (`sessionID` only) and never
  infers those fields or a same-execution confirmation — a visibility limitation
  of the public API, not a dropped observation: every terminal `provider.error`
  is still captured, including unknown errors. Correlate terminal failures with
  retry/HTTP records by `sessionID`; the direct-hook records are the
  authoritative per-attempt source (see "Correlation visibility").
- Cancellation is host-owned: an interruption cancels the pending retry wait
  (`Effect.sleep`), and the adapter neither logs interruption as a provider
  error nor subscribes to it. Cleanup aborts the subscription signal, which
  closes the Effect iterator and resolves any pending `next()` with
  `{done:true}`; no background work survives.
- A broken event stream costs terminal observations (one `plugin.error`
  report); the retry hook keeps working. The in-process bus is unbounded, so
  subscriber overflow is not a failure mode of this route (R21-N1). Because
  delivery is asynchronous relative to the direct hooks, terminal attribution
  never depends on event/hook ordering (R21-02 / R23).
- Logger privacy/bounds/limitations are unchanged and documented in
  `specs/logging.md` (best-effort delivery, opt-in details, per-instance
  retention).
