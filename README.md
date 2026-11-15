# Quota Matata

**No worries, just retries.**

MIT-licensed quota-aware retry plugin for OpenCode v2, with first-class
support for the Alibaba Cloud Model Studio / Coding Plan (`alibaba` provider)
and safe generic policies for every other provider. It also ships a pure,
SDK-free decision core and a privacy-safe JSONL diagnostics logger you can
use standalone.

## Install (OpenCode v2)

Requires OpenCode v2.3.0 or newer (the supported `@opencode/plugin@2.3.0`
Promise API — **not** the V1 `@opencode-ai/plugin`). Add the package to the
`plugins` array of your `opencode.json` / `opencode.jsonc` (global
`~/.config/opencode/opencode.jsonc` or project-level). OpenCode installs npm
plugin packages automatically.

Minimal:

```jsonc
{
  "plugins": ["quota-matata"]
}
```

With options — the supported `{ "package", "options" }` form (options are the
plugin configuration described below, passed JSON):

```jsonc
{
  "plugins": [
    {
      "package": "quota-matata",
      "options": {
        "maxWaitMs": 691200000,
        "categories": { "quota_five_hour": { "delayMs": 1800000 } },
        "logging": { "enabled": true, "level": "info" }
      }
    }
  ]
}
```

- Pin a version with `"quota-matata@0.1.0"` (or in `package`).
- Disable without uninstalling: add `"-quota-matata"` to `plugins`, or set
  `"options": { "enabled": false }` — the plugin then registers nothing and
  writes nothing.
- Local development checkout: `"plugins": ["/absolute/path/to/quota-matata"]`
  (a directory; run `npm run build` first).

Invalid options fail loudly at plugin setup with a `ConfigError` listing
every problem (dotted paths); nothing is silently ignored.

## What it does

Once installed, the plugin observes provider failures server-wide — every
provider, primary and subagent sessions alike:

- **Retry hook**: classifies each failure the host consults plugins for and
  applies only validated policy overrides to the host's retry decision
  (force a bounded retry, stop permanent failures, or leave the native
  decision untouched). On any internal error it falls back to the native
  decision — it never throws into the host.
- **Terminal events**: logs the final failure even when the host's native
  retry schedule was exhausted and the retry hook never ran.
- **HTTP metadata**: optionally observes HTTP ≥ 400 status/`Retry-After`
  metadata. It never reads requests, URLs, or response bodies.
- Waits are the host's own cancellable sleeps: no plugin timers, schedulers,
  or global retry counters; credentials and model selection are never edited.

## Categories and default policies

| Category | Meaning | Default policy |
| --- | --- | --- |
| `quota_five_hour` | Alibaba Coding Plan 5-hour quota (`hour allocated quota exceeded`) | retry after **30 min** (rolling window; exact reset not published) |
| `quota_weekly` | Alibaba weekly quota (`week allocated quota exceeded`) | retry at next **Monday 00:00 UTC+8** + 60 s margin |
| `quota_monthly` | Alibaba monthly quota (`month allocated quota exceeded`) | **stop** — resets on the subscription day, never calendar-assumed; retry only with `untilReset: true` and a reliable `metadata.resetAtMs` |
| `quota_temporary` | Alibaba short-period rate quota (`usage allocated quota exceeded`) | retry after **60 s** (official guidance: wait one minute) |
| `concurrency_limit` | Alibaba plan concurrency (`concurrency allocated quota exceeded`) | retry after **5 s** (official guidance: wait a moment) |
| `rate_limit` | Native/unknown rate limits (incl. bare 429) | **no_override** — native handling preserved |
| `quota_unknown` | Unrecognized quota errors (incl. bare `Allocated quota exceeded`, `insufficient_quota`) | **no_override** |
| `provider_unavailable` | Provider internal errors / 5xx | **no_override** |
| `authentication` | Auth failures (401/403, `InvalidApiKey`, native `provider.auth`) | **stop** (permanent) |
| `billing` | Permanent billing failures (`Arrearage`, `*BillOverdue`, `BudgetLimitExceeded`, 402, …) | **stop** (permanent) |
| `other` | Everything else | **no_override** |

Safety invariants:

- No blanket “quota exceeded” or 429→quota mapping. The five plan phrases are
  matched case-insensitively, with surrounding text and inside structured
  JSON bodies (DashScope and OpenAI-style envelopes).
- Unknown/native rate limits are never overridden by default.
- Permanent billing/auth errors stop; config validation refuses to make them
  retry. Definitive permanent evidence (native `provider.auth`/billing types,
  HTTP 401/402/403, and recognized billing messages such as “insufficient
  balance”, “run out of credits”, “billing error”, “bill is overdue”) outranks
  any quota/rate phrase in the same error — including inside structured JSON
  bodies — so a mixed-signal failure never turns into a retry.
- Reliable provider cooldowns (`retryAfterMs`) are respected as a **minimum**.
- A reliable supplied future reset (`metadata.resetAtMs`) floors **any**
  emitted retry (plus the category's configured margin): the engine never
  retries before a known quota reset. Monthly until-reset still requires the
  explicit `untilReset: true` opt-in.
- Waits are finite integers ≤ 2^31−1 ms. If a required wait exceeds
  `maxWaitMs` (default **8 days**, enough for a full weekly reset plus margin)
  or an explicit `maxElapsedMs` budget, the engine **stops — it never clamps**
  a wait into a retry before the reset. Reset floors apply before these
  bounds.
- Timestamps outside the JavaScript Date range (±8.64e15 ms, e.g. `1e20`)
  never reach date formatting: an out-of-range `now` throws `TypeError`, an
  out-of-range `resetAtMs` is invalid metadata (monthly stops, other
  categories ignore it).
- The engine keeps no counters, sleeps, or clocks: `now`, `attempt`, and any
  cumulative `elapsedMs` are explicit inputs. The host's native retry caps
  are untouched.

## Configuration

Everything is optional; defaults are safe. Pass options via the plugin entry
(above) or to `resolveConfig` directly.

```ts
resolveConfig({
  enabled: true,            // master switch; false => fully inert plugin / no_override engine
  maxWaitMs: 691_200_000,   // 8 days; per-delay bound, 1..2^31-1
  maxElapsedMs: undefined,  // optional cumulative budget (needs metadata.elapsedMs)
  categories: {             // per-category tuning
    quota_weekly: { marginMs: 60_000 },
    quota_monthly: { action: "retry", untilReset: true },
    concurrency_limit: { delayMs: 5_000, maxAttempts: 10 },
  },
  providers: {
    alibaba: {              // ships enabled by default
      enabled: true,        // false disables Alibaba-specific classification
      aliases: ["dashscope"],
      categories: { concurrency_limit: { delayMs: 2_000 } }, // field-level override
    },
  },
  logging: {                // opt-in JSONL diagnostics (see Logging below)
    enabled: false,
    level: "info",
    directory: undefined,
    captureErrorDetails: false,
    rotation: { maxSizeBytes: 1_048_576, maxFiles: 5 },
  },
})
```

Invalid configuration throws `ConfigError` listing every problem with dotted
paths; unknown keys are rejected at every level. Category field rules:
`delayMs` only for delay-based retry categories (never weekly/monthly),
`marginMs` weekly only, `untilReset` monthly only, monthly `action: "retry"`
requires `untilReset: true`, and `authentication`/`billing` refuse retry
entirely. Provider category overrides inherit **every unspecified field**
(including `maxAttempts`) from the resolved global categories, and cross-field
rules validate the effective merged policy. Provider keys that collide
case-insensitively, and reserved JavaScript property names (`__proto__`,
`constructor`, `prototype`), are rejected — safe for JSON-origin configs.
See [specs/core.md](specs/core.md) for the full design and rule order.

### Providers

Alibaba classification ships enabled; every other provider gets the generic
rules only. Provider-specific phrases can never match another provider
(isolation is tested). Add aliases (e.g. `dashscope`) or disable the Alibaba
classifier with `providers.alibaba.enabled: false`; tune per-provider
category policies with field-level overrides. `model` is context only — there
is deliberately no per-model rule language.

## Logging (JSONL diagnostics)

Logging is **off by default** (`logging.enabled: false` creates no directories
and writes nothing). Enable it in the plugin options to get bounded,
privacy-safe diagnostic events:

- `provider.error` — every observed failure (retry hook, HTTP metadata,
  terminal events), including unknown errors. Retry-hook and terminal records
  carry the classifier's stable `rule` id (see below).
- `retry.decision` — original vs final decision, category, policy path, delay,
  `nextRetryAt`, reason, plus the classification provenance (`rule`/`matched`).
  Emitted only when the host actually consults the retry hook (native
  exhaustion skips it; the terminal `provider.error` still records the
  failure).
- `plugin.error` — plugin-owned failures (sink failure, queue overflow,
  adapter errors), structural diagnostics only.

Each line is one JSON event: unique `id`, UTC `ts`, `pluginVersion`, optional
`hostVersion`, `source` (host surface), `correlationId`, `context`
(sessionID/agent/provider/model/attempt when the host supplies them — never
fabricated), sanitized `error`, and decision fields. Correlation IDs name the
surface that produced the record: `ses_…:2` for retry attempt 2 (`ses_…:retry`
when the attempt is unreadable), `ses_…:http:primary` for HTTP observations,
`ses_…:terminal` for terminal events. Terminal events are **independent
observations**: the host supplies only `{sessionID, error}` on them, so they
are logged with exactly those fields — never an inferred agent/model/attempt
or a "confirmation" label for a prior retry record. The shared `sessionID`
(and timestamps) links a terminal failure to that session's retry/HTTP
records; the direct-hook records are the authoritative per-attempt source.
The plugin keeps no cross-surface correlation state, so terminal attribution
is correct under every event-delivery order — a delayed old failure never
inherits a newer execution's attempt/model.

Classification provenance: retry-hook `provider.error` and `retry.decision`
records both carry `rule` — the stable id of the classifier rule that actually
matched (e.g. `alibaba.quota_weekly`, `generic.billing`, `generic.rate_limit`)
— and `matched`, the canonical provider id, **only when a provider-specific
rule matched**. Generic/fallback rules leave `matched` unset: no provider
identity is fabricated. Terminal records are classified context-free (the host
supplies no provider/model identity on them), so only generic rules can apply:
they carry a generic `rule` when classification succeeds and never `matched`.
The standalone core exposes the same provenance as `decision.classification`
(see below).

Files: `logging.directory` (default `$XDG_DATA_HOME/quota-matata/logs` or the
platform user-data dir), one file per logger instance
(`quota-matata-<pid>-<n>-<rand>.jsonl`), rotation ≤ `maxFiles` ×
`maxSizeBytes`, directories `0700` / files `0600` where supported, symlinked
paths refused (best effort). Delivery is best effort: a bounded 256-event
queue drops overflow (reported once), any I/O failure disables the sink after
one safe report, and crashes can lose the last appends. Files of dead
processes are left alone — clean old logs yourself.

### Privacy

Full model in [specs/logging.md](specs/logging.md). Summary:

- Request prompts, conversation history and request bodies are never
  accepted or logged: request-data keys are excluded **recursively, for
  every event type, regardless of `captureErrorDetails`**. The plugin itself
  never reads HTTP requests or response bodies at all.
- Provider error free text (message/response body) is **withheld by
  default**; only vetted structural fields are kept (type/status/retryAfterMs,
  enum-like provider codes). `captureErrorDetails: true` opts in to sanitized,
  bounded details (error-envelope fields reduced recursively, never the full
  response); unsupported structured bodies fail closed, and there is still no
  prompt/conversation/request data. Bodies are never JSON-parsed beyond
  64 KiB on any path.
- `plugin.error` payloads keep structural diagnostics only — Error
  `message`/`stack` are never dumped in either capture mode.
- Everything logged is recursively redacted (values **and object keys**:
  credential keys, bearer/basic tokens, cookies, sk-/AKIA keys, JWTs, URL
  userinfo/query/fragment) and bounded (16 KiB per event). Redaction is
  best-effort defense-in-depth, not a guarantee — the default withhold is the
  primary control.

## Extending / standalone core API

The package root is the plugin entry; the same named exports are available
SDK-free from the `quota-matata/core` subpath (verified to load without the
OpenCode SDK installed):

```ts
import { evaluateQuota, resolveConfig } from "quota-matata/core"

const config = resolveConfig({
  categories: { quota_five_hour: { delayMs: 30 * 60_000 } },
})

const decision = evaluateQuota(
  {
    provider: "alibaba",            // model.providerID from the host hook
    model: "qwen3-max",             // model.id from the host hook
    error: {                        // SessionError.Error shape from the host
      type: "provider.quota",
      message: "429 Too Many Requests",
      status: 429,
      response: { body: '{"error":{"message":"week allocated quota exceeded"}}' },
    },
    attempt: 2,                     // host attempt counter
    decision: { retry: false },     // host native decision (read-only)
    now: Date.now(),                // caller supplies the clock
    metadata: { resetAtMs: undefined, elapsedMs: undefined },
  },
  config,
)
// decision.action: "no_override" | "retry" | "stop"
// decision.delayMs (retry only), decision.category, decision.policy, decision.reason
// decision.classification: { category, ruleId, provider? } — the FULL classifier
//   provenance. ruleId is the stable matched rule (e.g. "alibaba.quota_weekly",
//   "generic.rate_limit"); provider is the canonical matched provider, present
//   only when a provider-specific rule matched (never fabricated for generic
//   rules). The plugin logs ruleId as `rule` and provider as `matched`.
```

Also exported: `normalizeError`, `classifyError`, `decideQuota`,
`nextWeeklyResetUtc8Ms`, `resolveConfig`, `ConfigError`, `matchProvider`, and
the diagnostics surface `createLogger` / `defaultLogDirectory` (reusable,
never throws into the caller; `flush()`/`close()` for deterministic cleanup).
The plugin applies the result to the hook's mutable `decision`:
`no_override` leaves it untouched, `retry` sets `{ retry: true, delay }`,
`stop` sets `{ retry: false }`. Embedders can drive `setupQuotaMatata(ctx)`
directly with a real `Plugin.Context`.

## Compatibility and limits

Target: OpenCode v2.3.0 (`@opencode/plugin@2.3.0`), verified against upstream
commit `a6b15d33daf6ab7d35569f6d711fdb630b9f04e7` and the published SDK
tarball. Host facts that shape the plugin (source evidence in
[specs/integration.md](specs/integration.md)):

- The `session.retry` hook receives `{sessionID, agent, model:{id,providerID},
  error, attempt, decision}` with a mutable `decision`; the error shape is
  `{type, message, status?, response?:{body}, retryAfterMs?}` (no `code` field —
  provider codes are extracted from the body safely).
- The host skips the plugin entirely once its native retry schedule is
  exhausted (exponential 2 s→10 s, 10 retries; retry-after capped at 15 min).
  Within budget the plugin may force a retry, veto, or change the delay;
  invalid delays fall back to the native delay. The plugin cannot extend the
  native cap.
- Weekly-scale waits rely on the host's cancellable `Effect.sleep`; the
  installed `effect@4.1.0` chunks durations beyond 2^31−1 ms safely, and the
  core keeps all delays below that ceiling regardless.

Honest limits:

- **Verification boundary**: compatibility is verified against host source,
  the published SDK types/runtime, boundary tests with real SDK shapes, and a
  pack→install→import smoke test — not against a live host with real provider
  credentials. No live-provider end-to-end run is claimed.
- Long waits are **process-lifetime, not durable**: a host restart loses a
  pending weekly wait (the host owns the sleep).
- `maxWaitMs` bounds **each delay**, not cumulative waiting. `maxElapsedMs`
  only applies when a caller supplies cumulative `metadata.elapsedMs`; the
  plugin keeps no global counters.
- The monthly subscription anniversary is not published on the wire: monthly
  failures stop by default; no calendar reset is invented.
- Terminal events carry no agent/model/attempt and no execution identity.
  They are logged as independent observations with `sessionID` only — those
  fields are never inferred from retry/HTTP records, even when such records
  exist. Correlate terminal failures with retry/HTTP records by `sessionID`;
  the direct-hook records are the authoritative per-attempt source. When the
  native schedule is exhausted the retry hook never runs (no `retry.decision`
  event), but the terminal failure is still observed this way.
- HTTP observation is metadata-only (status/Retry-After/kind), so
  provider-code classification comes from the retry hook's error body.
- Cancellation is host-owned: an interruption cancels the pending retry wait;
  interruptions are not logged as provider errors. Cleanup aborts the event
  subscription and flushes the logger; no background work survives.
- Logging is best effort (see above); a broken event stream costs terminal
  observations but never affects retry decisions.

## Development

```sh
npm install        # typescript, @types/node, and the pinned @opencode/plugin SDK
npm run typecheck  # strict TypeScript, src + tests (real SDK types)
npm test           # compile, then node --test
npm run build      # ESM + declarations into dist/
npm run smoke      # pack -> temporary install -> import checks (no publish)
```

Tests are timezone-independent: the suite passes unchanged under `TZ=UTC`,
`TZ=America/New_York`, `TZ=Asia/Shanghai`, and `TZ=Pacific/Kiritimati`.
Design specs: [core](specs/core.md), [logging](specs/logging.md),
[integration](specs/integration.md).

## License

MIT — see [LICENSE](LICENSE).
