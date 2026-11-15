# Quota Matata

**No worries, just retries.**

MIT-licensed quota-aware retry plugin for OpenCode v2. It is
provider-agnostic: a generic classification and policy engine applies to
every provider out of the box, and optional provider-specific rules layer on
top only where official documentation justifies them (Alibaba Cloud Model
Studio / Coding Plan rules ship enabled for the `alibaba` provider). It also
ships a pure, SDK-free decision core and a privacy-safe JSONL diagnostics
logger you can use standalone.

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
  (force a bounded retry, stop failures the policy treats as non-retryable,
  or leave the native decision untouched). On any internal error it falls
  back to the native decision — it never throws into the host.
- **Terminal events**: logs the final failure even when the host's native
  retry schedule was exhausted and the retry hook never ran.
- **HTTP metadata**: optionally observes HTTP ≥ 400 status/`Retry-After`
  metadata. It never reads requests, URLs, or response bodies.
- Waits are the host's own cancellable sleeps: no plugin timers, schedulers,
  or global retry counters; credentials and model selection are never edited.

## Provider coverage

The plugin is generic first. Every provider gets the same conservative
engine: native host error types, HTTP status, and safely parsed provider
codes decide the category, and most categories keep the host's native retry
decision (`no_override`) — the generic fallback does **not** retry every
error. Provider-specific rules are optional additions that run only when the
host's provider ID matches a configured provider key or alias
(case-insensitive) — never by model name. Only the Alibaba Coding Plan rule
set ships enabled today. There is no promise of universal compatibility:
coverage depends on what the host surfaces in the error, and unrecognized
failures keep native handling.

### Alibaba: Coding Plan vs Token Plan

These are separate products with separate API keys and Base URLs (official
[Token Plan FAQ](https://www.alibabacloud.com/help/en/model-studio/token-plan-faq),
fetched 2026-11-15):

- **Coding Plan** — supported by the five plan phrases in the category table
  below (5-hour, weekly, monthly, short-period rate, concurrency), sourced
  from the official Coding Plan FAQ.
- **Token Plan** — a subscription with a monthly quota that resets per
  *subscription month*: based on the subscription date, not the calendar
  month, with no carryover and no published reset time-of-day
  ([Usage and quota](https://www.alibabacloud.com/help/en/model-studio/token-plan-usage-quota)).
  Official docs describe `429 insufficient_quota` / `Your token-plan quota
  has been exhausted.` as plan/usage-pack exhaustion (wait for the next
  subscription month, upgrade, or buy a usage pack), and `429 Requests rate
  limit exceeded` as short-period rate limiting (wait about a minute). The
  [Codex guide](https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/codex)
  also documents bare `429 Allocated quota exceeded` as Token Plan exhaustion
  and shows a human-readable reset hint (`The quota will reset at HH:MM:SS
  UTC`) — a documentation example, not a stable wire format.

  The plugin has **no Token Plan-specific parsing or scheduling**. Under the
  `alibaba` provider ID, the exhaustion phrase and `insufficient_quota` map
  to `quota_unknown` (no override), because the same surface text is
  ambiguous with Coding Plan throttling; under any other provider ID they
  get generic handling (`rate_limit`/`quota_unknown`, both no override). The
  documented OpenCode integration for Token Plan uses the custom provider ID
  `qwencloud-token-plan-personal`
  ([QwenCloud OpenCode guide](https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/opencode)),
  which does not match the `alibaba` classifier by default. Reset hints in
  error text are never parsed into retry schedules.

### OpenAI: ChatGPT/Codex subscription vs API billing

Subscription usage (ChatGPT sign-in, including Codex) and API-key billing
are separate contracts:

- Official [Codex pricing docs](https://learn.chatgpt.com/docs/pricing)
  (fetched 2026-11-15) publish five-hour usage *estimates* for Plus and
  Standard Business only; Pro plans currently have no five-hour limit.
  Weekly limits may also apply. The estimates are not fixed message limits,
  and current limits/reset times live in the usage dashboard — the plugin
  assumes none of these windows.
- When a ChatGPT subscription usage limit is hit, OpenCode maps the
  provider's `subscription_sharing_usage_limit_exceeded` error to the native
  `provider.chatgpt-limit` type (host source, commit `a6b15d33`). The plugin
  classifies that as `billing` and **stops** — it does not retry blindly.
  A stop here is a policy decision, not a claim that the subscription is
  permanently exhausted: OpenAI's
  [Sign-in-with-ChatGPT error docs](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
  say to pause requests and check the usage dashboard, and not to assume the
  whole plan is empty or infer a reset time (app-specific limits can apply).
  Recovery can come from a reset or added credits; the plugin schedules
  neither. Those docs describe the SIWC direct route, while OpenCode's
  ChatGPT login uses `chatgpt.com/backend-api/codex` — the full SIWC recovery
  table is therefore not claimed for that surface; only the host's shared
  error-code mapping is relied on.
- API-key usage is pay-per-token under separate API pricing; its quota and
  billing errors get the generic rules (e.g. 402/billing markers stop, a
  bare 429 keeps native handling).

### Observations are not contracts

The plan identity behind any particular user's observations is not confirmed
here. Observed monthly, five-hour, or seven-day windows are observations,
not provider contracts; the plugin never invents reset dates or timing
heuristics from them. Future provider-specific rules must be justified by
official documentation plus sanitized diagnostic evidence (see Logging),
and verified with offline tests — never by live provider probing.

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
| `authentication` | Auth failures (401/403, `InvalidApiKey`, native `provider.auth`) | **stop** — no retry until credentials/config change |
| `billing` | Billing/usage-limit failures treated as non-retryable (`Arrearage`, `*BillOverdue`, `BudgetLimitExceeded`, 402, native budget/free/ChatGPT-limit types, …) | **stop** — see note below |
| `other` | Everything else | **no_override** |

A `stop` is a policy decision not to retry blindly — not a claim that the
underlying condition is literally permanent. Subscription usage limits
(e.g. OpenAI's `provider.chatgpt-limit`) can lift with time or added credits;
the plugin still stops instead of guessing a reset, and configuration
validation refuses to make `billing`/`authentication` retryable.

Safety invariants:

- No blanket “quota exceeded” or 429→quota mapping. The five plan phrases are
  matched case-insensitively, with surrounding text and inside structured
  JSON bodies (DashScope and OpenAI-style envelopes).
- Unknown/native rate limits are never overridden by default.
- Billing/auth errors stop; config validation refuses to make them
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

Generic rules apply to every provider. Provider-specific rules match the
host's provider ID against configured keys/aliases (case-insensitive):
Alibaba classification ships enabled; every other provider gets the generic
rules only — including custom provider IDs such as the documented Token Plan
integration `qwencloud-token-plan-personal`, unless you alias them. For the
documented Token Plan exhaustion/rate-limit errors, aliasing does not change
the outcome: they remain no-override. Provider-specific phrases can never
match another provider (isolation is tested). Add aliases (e.g. `dashscope`)
or disable the Alibaba classifier with `providers.alibaba.enabled: false`;
tune per-provider category policies with field-level overrides. `model` is
context only — there is deliberately no per-model rule language.

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

### Diagnostics as evidence for future provider rules

These sanitized records are the intended evidence base for extending
provider coverage: the stable `rule` id, `matched` provider (when a
provider-specific rule matched), vetted provider codes, status, and decision
fields show what the host actually surfaced — without credentials, prompts,
or raw response bodies. New provider rules should be justified by official
documentation plus such sanitized evidence (opt-in `captureErrorDetails`
when structural fields are not enough), and verified with offline synthetic
tests — never by live provider probing or by collecting/sharing raw
sensitive logs.

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

- **Provider coverage**: provider-specific rules are limited to the
  documented Alibaba Coding Plan phrases. Token Plan exhaustion and ChatGPT
  subscription usage limits are handled conservatively (no override / stop)
  with no reset scheduling — see [Provider coverage](#provider-coverage).
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
[integration](specs/integration.md), [publishing](specs/publishing.md).

## Publishing (maintainers)

Releases reach npm through **staged publishing**: the GitHub Actions workflow
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) validates a
release and *stages* it with `npm stage publish`; a maintainer then approves
the staged version **with 2FA** before it becomes public. CI alone never
publishes the released version; for a brand-new package, staging itself
creates the package with a public `0.0.0-stage` placeholder (see "First
publication" below). This is npm's supported token-based CI/CD path:
npm removes direct publishing with granular access tokens in **January 2027**
([npm docs](https://docs.npmjs.com/about-access-tokens)), and staging keeps a
human 2FA proof-of-presence on every release.

Flow: publish a GitHub Release → workflow gates (toolchain, package identity,
tag/version match, version-not-already-published, typecheck, tests, build,
package smoke, staging dry-run) → `npm stage publish` using the `NPM_TOKEN`
secret → maintainer approves with 2FA → version is live.

### One-time setup

1. **npm account with 2FA enabled.** Staged publishing requires 2FA on the
   account (approval is a 2FA challenge; npm uses security keys/passkeys).
   See [npm 2FA docs](https://docs.npmjs.com/about-two-factor-authentication).
2. **Create a granular access token** on
   [npmjs.com](https://www.npmjs.com) → profile → **Access Tokens** →
   **Generate New Token** (granular tokens can currently only be created on
   the website, not via the CLI):
   - **Token name:** e.g. `quota-matata-ci-stage`.
   - **Bypass two-factor authentication:** leave **unchecked** (the default).
     This workflow never needs it.
   - **Packages and scopes → Permissions:** **Read and write (stage only)**.
     The token can stage versions for review but cannot publish directly
     (`npm publish` with it fails with `E_STAGE_REQUIRED`).
   - **Select Packages:** *Only select packages and scopes* → `quota-matata`.
     **First-release caveat:** the selector lists packages your account
     already has access to, and `quota-matata` does not exist yet (see
     below). For the very first release, temporarily choose **All Packages**,
     then once the package exists (after the first staging) replace the token
     with a `quota-matata`-only one and revoke the broad token. (Inference
     from the documented selector; verify in the UI.)
   - **Organizations:** **No access** (org access never grants publishing
     rights anyway).
   - **Expiration:** pick a bounded period (e.g. 90 days; any date ≥ 1 day in
     the future). Rotate before it expires (below).
   - **Allowed IP Ranges:** optional; GitHub-hosted runner egress IPs are
     dynamic, so an IP allowlist is impractical for this workflow.
   - Copy the token immediately — the full value is shown only once.
3. **Create the GitHub secret:** repository **Settings → Secrets and
   variables → Actions → New repository secret**, name exactly **`NPM_TOKEN`**,
   value = the token. The workflow injects it only into the final staging
   step (as `NODE_AUTH_TOKEN`); no other step sees it.

### Cutting a release

1. Bump the version in **every version site** — they must stay in sync:
   - `version` in `package.json` and `package-lock.json` (e.g.
     `npm version 0.1.1 --no-git-tag-version` updates both without touching
     Git).
   - `PLUGIN_VERSION` in `src/logging.ts` — exported at runtime and stamped
     into every diagnostic event; the package smoke test asserts it equals
     the packed version.
   - The literal version assertions in `test/entry.test.ts`
     (`core.PLUGIN_VERSION`) and `test/adapter.test.ts` (`event.pluginVersion`).
2. Verify locally before tagging: `npm run typecheck && npm test &&
   npm run build && npm run smoke`. A missed site fails here (smoke reports
   e.g. `0.1.0 !== 0.1.1`), before anything is committed or tagged.
3. Commit, tag `v<version>` (e.g. `v0.1.1`), push the tag.
4. Create a GitHub Release from that tag and **publish** it (not a draft, and
   **not a prerelease** — prereleases are skipped by the workflow; the tag
   must equal the package version, with or without the `v` prefix). The
   version must be canonical stable semver `X.Y.Z` — no leading zeros
   (`00.1.0` is rejected: npm would silently normalize it to `0.1.0`).
5. The workflow runs all gates and stages the version. Its summary shows the
   approval instructions.
6. **Approve with 2FA:** npmjs.com → account → **Staged Packages** tab →
   review (name, version, dist-tag, shasum; download the tarball if needed) →
   **Approve**; or `npm stage list quota-matata` then
   `npm stage approve <stage-id>`. Reject with `npm stage reject <stage-id>`
   if anything looks wrong. Only after approval is the version public.

### First publication — facts and limits

- As of **2026-11-15**, `npm view quota-matata` returns **404**: the name is
  unclaimed on the public registry. Nothing reserves it — it must still be
  free when the first `npm stage publish` runs.
- The **first staging creates the package**: staging a brand-new package
  immediately publishes a **public placeholder version `0.0.0-stage`**, owned
  by the npm account whose token staged it. The staged version and its
  contents stay private until approval; approval then publishes the staged
  version to the package page
  ([npm docs](https://docs.npmjs.com/staged-publishing)). No ownership is
  assumed or pre-configured anywhere in this repository.
- A version that already exists (published *or* staged) cannot be staged
  again; the workflow fails fast if the version is already published.

### Token rotation and security limits

- **Rotation:** before expiry, generate a new token with the same settings,
  update the `NPM_TOKEN` secret, then revoke the old token (npmjs.com →
  Access Tokens, or `npm token revoke`). Prefer short expirations.
- A stage-only token is still sensitive: besides staging, it can **deprecate
  versions and move dist-tags**. Treat it like any write credential.
- **Bypass-2FA tokens are deliberately not used.** Publishing to npm requires
  account 2FA or a bypass-2FA token; since August 2026 bypass tokens cannot
  perform account-governance actions (token creation, maintainer changes),
  and direct token publishing ends January 2027.
- **Package publishing access:** once the package exists (after the first
  staging), select **"Require two-factor authentication and disallow tokens
  (recommended)"** on the package's Settings → Publishing access page — npm's
  staged-publishing best practice. It blocks direct publishing with granular
  tokens (bypass or not), which this workflow never does: CI only runs
  `npm stage publish` (no 2FA prompt), and the release goes live solely via
  the maintainer's interactive 2FA approval
  ([npm stage best practices](https://docs.npmjs.com/cli/v12/commands/npm-stage#best-practices),
  [package 2FA settings](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification)).
- Restrict who can create releases/tags in the GitHub repository settings;
  anyone who can publish a release can trigger staging, but only a maintainer
  with 2FA can make it live.

### Local verification (no publish)

```sh
npm run smoke                 # pack -> temporary install -> import checks
npm stage publish --dry-run   # reports what would be staged; no writes, no login needed
```

### Alternatives (not implemented)

- **Trusted publishing (OIDC, no secret)** — npm's preferred long-term path,
  but it is configured per *existing* package, requires `repository.url` in
  `package.json` to exactly match the GitHub repo (this package has no
  `repository` field yet), needs GitHub-hosted runners, and a new
  configuration expires unless its first publish succeeds within 2 days.
  Automatic provenance additionally requires a **public** repository; this
  repo is not publicly visible via the unauthenticated GitHub API as of
  2026-11-15. See [npm docs](https://docs.npmjs.com/trusted-publishers).
- **Direct `npm publish` with a bypass-2FA token** — works only until
  January 2027 and weakens 2FA; rejected.

Design rationale, evidence, and the security analysis:
[specs/publishing.md](specs/publishing.md).

## License

MIT — see [LICENSE](LICENSE).
