# Quota Matata core — design spec

Slice: pure, tested, configurable quota decision engine + standalone package
bootstrap. Status: implemented. The hook adapter and JSONL logging are later
slices and are deliberately out of scope here.

## Goals and non-goals

Goals:

1. Classify provider errors deterministically into quota/rate/auth/billing
   categories for every provider (generic rules), with optional
   provider-specific mappings — Alibaba Coding Plan today — that match
   official guidance.
2. Decide, purely, whether to leave the host's native retry decision alone
   (`no_override`), force a bounded retry (`retry` + delay), or `stop`.
3. Strict, small-surface configuration with safe defaults, per-category
   tuning, provider overrides/aliases, and classifier toggles.
4. Zero runtime dependencies; Node/npm toolchain (no Bun); TypeScript strict;
   ESM output suitable for the later `@opencode/plugin@2.3.0` Promise entry.

Non-goals (later slices): filesystem logging, plugin hook registration,
installation docs, per-model rule language (explicitly not built — `model` is
context only), live provider probing.

## Host contract evidence (upstream v2.3.0, commit a6b15d33daf6ab7d35569f6d711fdb630b9f04e7)

Read inline from `/tmp/opencode-wt/v2.3.0` (read-only; host checkout not
mutated):

- `packages/ai/src/providers/alibaba.ts:22` — canonical provider ID is
  `ProviderID.make("alibaba")`.
- `packages/schema/src/session-error.ts` — hook error shape:
  `{type: string, message: string, status?: 100..599, response?: {body: string},
  retryAfterMs?: non-negative int}`. There is **no** `code` or `headers` field;
  provider codes must be parsed from the body safely.
- `packages/plugin/src/promise/session.ts` — `SessionRetry` hook:
  `{sessionID, agent, model: Model.Ref {id, providerID, variant?}, error,
  attempt, decision}`; `decision` is mutable
  (`{retry:false} | {retry:true, delay:number}`).
- `packages/core/src/session/runner/retry.ts` — native policy exhaustion
  returns `{retry:false}` **without consulting the plugin**; within budget the
  plugin may force retry (even over native false), veto, or change delay.
  Delay normalization: finite and ≥ 0 → `Math.ceil`, otherwise fall back to
  the native delay. Sleep is `Effect.sleep(Duration.millis(...))`
  (cancellable).
- `packages/core/src/model-retry.ts` — native schedule: exponential 2 s capped
  10 s, 10 retries; native retry-after capped at 15 min; unreachable transport
  gets its own 1 h budget; timeout attempts capped at 3. The core never
  modifies these caps.
- `packages/core/src/session/to-session-error.ts` — native `type` values
  (`provider.rate-limit`, `provider.quota`, `provider.auth`,
  `provider.internal`, `provider.budget-limit`, `provider.free-limit`,
  `provider.chatgpt-limit`, `provider.go-limit`, `provider.transport`,
  `provider.timeout`, `unknown`, …). Generic rules key off these.

Open item for the adapter slice: verify the published `@opencode/plugin@2.3.0`
tarball exports against this source, and verify `Effect.sleep` behavior for
weekly-scale durations on the installed host. The core sidesteps the risk by
keeping every emitted delay a finite integer ≤ 2^31−1 ms (~24.8 days).

## Alibaba rule sources (public docs fetched 2026-11-14; no credential probes)

Coding Plan FAQ (alibabacloud.com/help/en/model-studio/coding-plan-faq):

| Phrase (case-insensitive) | Official meaning | Official guidance |
| --- | --- | --- |
| `hour allocated quota exceeded` | 5-hour request quota exhausted | wait 5 h (rolling) |
| `week allocated quota exceeded` | weekly quota exhausted | wait until Monday 00:00:00 UTC+8 |
| `month allocated quota exceeded` | monthly quota exhausted | wait until the subscription-month corresponding day 00:00:00 UTC+8 (not calendar month) |
| `usage allocated quota exceeded` | requests too frequent in a short period | wait one minute |
| `concurrency allocated quota exceeded` | concurrent requests above dynamically allocated limit | wait a moment |

Error-code page (alibabacloud.com/help/en/model-studio/error-code):

- Permanent billing: `Arrearage` (“Access denied, please make sure your
  account is in good standing.”), `isv.OUT_OF_SERVICE`, `PrepaidBillOverdue`,
  `PostpaidBillOverdue`, `BudgetLimitExceeded`, `CommodityNotPurchased`,
  `AllocationQuota.FreeTierOnly`, “Free allocated quota exceeded.” (free tier
  exhausted, model has no pay-as-you-go).
- Auth: `InvalidApiKey`/`invalid_api_key`, `AccessDenied`/`access_denied`
  (403 family; permanent until configuration changes).
- Throttling: `Throttling.RateQuota`, `Throttling.BurstRate`,
  `Throttling.Concurrency`, `Throttling.ServiceOverloaded`,
  `Throttling.ResourceExhausted`, `LimitRequests`/`limit_requests`.
- Ambiguous: `Throttling.AllocationQuota`/`insufficient_quota` with bare
  “Allocated quota exceeded …” is documented as TPS/TPM throttling, while the
  Codex page documents bare “429 Allocated quota exceeded” as token-plan
  exhaustion. Because the same surface text covers both, it maps to
  `quota_unknown` (no override), never to a plan category.

## Provider coverage evidence (2026-11-15; documentation only, no runtime change)

Positioning: the engine is generic/provider-agnostic first; provider-specific
rules are optional, documentation-justified additions keyed by provider-ID
config matching (canonical key or alias, case-insensitive), never by model.
Only `alibaba` ships enabled. The generic fallback is conservative — most
categories are `no_override`; it does not retry every error. No universal
compatibility is claimed.

### Alibaba Token Plan is not Coding Plan

Public docs re-verified 2026-11-15 (no credential probes):

- [Token Plan FAQ](https://www.alibabacloud.com/help/en/model-studio/token-plan-faq)
  (updated 2026-11-13): Token Plan, Coding Plan, and pay-as-you-go API keys
  and Base URLs are isolated (Token Plan keys start `sk-sp-`).
  `429 insufficient_quota: Your token-plan quota has been exhausted.` means
  plan/usage-pack exhaustion — wait for the next subscription month, upgrade,
  or purchase a usage pack. `429 Requests rate limit exceeded` is
  short-period rate limiting (wait about one minute; dynamic limits).
  401/403/404 are key/Base-URL/model configuration errors; 502 is transient.
- [Usage and quota](https://www.alibabacloud.com/help/en/model-studio/token-plan-usage-quota)
  (updated 2026-11-13): quota resets per **subscription month**, based on the
  subscription date, not the calendar month; no carryover; no published
  reset time-of-day. Exhaustion blocks Credit-consuming calls; there is no
  automatic pay-as-you-go fallback.
- [Codex guide](https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/codex):
  bare `429 Allocated quota exceeded` or the token-plan exhaustion message
  means monthly Token Plan exhaustion; the documented reset hint example
  `The quota will reset at HH:MM:SS UTC` is UTC and shows a time without a
  date. It is a documentation example, not a stable wire format, and is not
  parsed by this plugin.
- [OpenCode guide](https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/opencode):
  the documented Token Plan integration is a custom provider with ID
  `qwencloud-token-plan-personal` (connect label “Alibaba Token Plan
  (China)”), listing models such as `qwen4-max-preview`. That provider ID
  does not match the `alibaba` classifier by default.

Current runtime consequence (unchanged by this documentation slice): there
is **no Token Plan-specific parsing or scheduling**. Under `alibaba`, the
exhaustion phrase and `insufficient_quota` match `alibaba.quota_unknown`
(no override) because the surface text is ambiguous with Coding Plan
throttling; under any other provider ID the same errors get generic handling
(`rate_limit` on 429 / `quota_unknown` on native quota types — both
no override). Aliasing the Token Plan provider ID to `alibaba` changes rule
attribution, not these outcomes. The user's actual plan identity is
unconfirmed; observed monthly/5-hour/7-day windows are observations, not
contracts, and no reset dates or timing heuristics are invented from them.
Any future Token Plan handling is conditional future work requiring
documented wire evidence plus sanitized diagnostics and offline tests.

### OpenAI: subscription usage vs API billing

Public docs re-verified 2026-11-15:

- [Codex pricing](https://learn.chatgpt.com/docs/pricing): five-hour usage
  estimates apply to Plus and Standard Business only; **Pro plans currently
  have no five-hour limit**; weekly limits may also apply. The estimates are
  not fixed message limits; current limits and reset times are shown in the
  usage dashboard. Credits can extend usage; API-key usage is billed
  separately at API token prices. None of these windows is assumed by the
  plugin, and “currently” is a dated observation, not a contract.
- [SIWC errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery):
  `subscription_sharing_usage_limit_exceeded` (429) means pause new requests
  and check ChatGPT Settings → Usage; do not assume the entire plan is empty
  or infer a reset time from the code alone (app-specific limits can apply).
  `subscription_sharing_usage_unavailable`/`user_unavailable` (503) warrant
  bounded backoff; `invalid_user` (401) re-sign-in;
  `user_not_eligible`/`route_not_supported`/`chatpass_v2_*` (403) must not be
  repeated; `unsupported_capability` (400) must not retry the same body.
  **Applicability caveat:** these docs describe the Sign-in-with-ChatGPT
  direct route (`POST /v1/responses`). OpenCode's ChatGPT/Codex login uses
  `https://chatgpt.com/backend-api/codex`
  (`packages/core/src/plugin/provider/openai.ts:25`, host commit `a6b15d33`,
  re-verified 2026-11-15) — a different surface, so the full SIWC recovery
  table is not claimed for it.
- Host mapping relied on instead:
  `packages/core/src/session/to-session-error.ts:38-40` (same commit) maps
  any AI error whose body contains `subscription_sharing_usage_limit_exceeded`
  to native `provider.chatgpt-limit`. The generic `billing` rule matches that
  type, so the plugin **stops**.

Stop semantics: `billing`/`authentication` `stop` is a conservative
non-retry policy, not an assertion that the condition is literally permanent.
A ChatGPT subscription usage limit can lift with time or added credits; the
plugin still refuses to guess a reset, and config validation continues to
refuse retry for these categories. Other subscription failures surface as
native types/statuses and get generic handling (401/403 → authentication
stop; 503 → `provider_unavailable`, no override). API-key billing/quota
errors likewise get generic handling only.

## Architecture

```
HostError + provider/model ── normalizeError ──▶ NormalizedError
NormalizedError + ResolvedConfig ── classifyError ──▶ {category, ruleId, provider?}
{category, provider, model, attempt, decision, now, config, metadata}
    ── decideQuota ──▶ {action: no_override|retry|stop, delayMs?, category, policy, reason}
evaluateQuota = normalize + classify + decide (merges error.retryAfterMs into metadata)
    ──▶ QuotaEvaluation = QuotaDecision & {classification: {category, ruleId, provider?}}
```

All functions are pure: no I/O, no `Date.now`, no sleeps, no module-level
mutable state. `resolveConfig` deep-freezes its result. Tests prove purity by
freezing inputs and by stubbing `Date.now` to throw during decisions.

### Evaluation output provenance (R27-01)

`evaluateQuota` returns `QuotaEvaluation = QuotaDecision & { classification:
Classification }`: the policy decision **plus the classifier's full
provenance**, preserved unchanged — `classification.category`, the stable
`classification.ruleId` (e.g. `alibaba.quota_weekly`, `generic.billing`,
`generic.rate_limit`), and the canonical `classification.provider` **only when
a provider-specific rule actually matched**. `classification.category` always
equals the decision's `category`. Generic/fallback rules leave
`classification.provider` unset — no provider identity is fabricated, so a
generic permanent gate hit on Alibaba (`generic.billing`) stays distinguishable
from Alibaba's own permanent rule (`alibaba.billing`). `decideQuota`'s own
output (`QuotaDecision`) is unchanged; the provenance is additive on the
`evaluateQuota` surface only. The adapter logs `classification.ruleId` as the
JSONL `rule` field and `classification.provider` as `matched` on both
`provider.error` and `retry.decision` records (specs/integration.md,
specs/logging.md), so diagnostics report the actual matched rule without
re-classifying or reconstructing a lossy subset.

### Normalization

- `message`/`type` degrade to `""`/absent when not strings; `status` kept only
  when an integer 100..599; `retryAfterMs` kept only when finite ≥ 0; body kept
  only when a non-empty string.
- `parseBody` safely JSON-parses the body and extracts the first string code
  from `code`, `error.code`, `error.type` (DashScope and OpenAI-style
  envelopes), plus nested `message`/`error.message` for text search. Malformed
  JSON, arrays, primitives → no code, no crash.

### Classification (deterministic first match)

Provider-specific rules run only when the provider ID matches a configured
canonical key or alias (case-insensitive) and that provider's classifier is
enabled. The `alibaba` entry ships enabled by default. Generic rules always
run afterwards. Fixed order:

Alibaba: `billing` → `auth` → **definitive permanent-signal gate** →
`quota_five_hour` → `quota_weekly` → `quota_monthly` → `quota_temporary` →
`concurrency_limit` → `quota_unknown` (bare “allocated quota exceeded”,
`Throttling.AllocationQuota`, `insufficient_quota`, token-plan exhaustion) →
`rate_limit` (throttling codes and messages).

The concurrency rule's public category is `concurrency_limit` (R27-02), the
user-required taxonomy name; its stable rule label remains
`alibaba.quota_concurrency`. Rule ids are provider-specific diagnostic
identities, independent of the category taxonomy: the category rename changes
configuration, decisions and the JSONL `category`/`policy` fields, never the
diagnostic rule identity logged as `rule`.

The gate (R4-01) runs the complete existing generic permanent predicates
before any transient phrase can match: HTTP 402, a native billing type
(`provider.budget-limit`, `provider.model-budget-limit`, `provider.free-limit`,
`provider.chatgpt-limit`), or a recognized permanent billing message marker
(`insufficient balance`, `run out of credits`, `billing error`, `account is in
good standing`, `bill is overdue`) → `billing`; `provider.auth`, 401 or 403 →
`authentication` (reported as `generic.billing`/`generic.auth`). Markers are
searched in the host message, the raw body, and nested body messages, exactly
as in the generic rules — no new or widened fuzzy predicates. A quota phrase
embedded in an auth or billing failure therefore never turns into a retry.
When Alibaba's own permanent rules also match, they run first and keep
provider attribution (`alibaba.billing`/`alibaba.auth`).

Generic: `billing` (402, native budget/free/chatgpt limit types, billing
message markers) → `auth` (`provider.auth`, 401, 403) → `rate_limit`
(`provider.rate-limit`, 429) → `quota_unknown` (`provider.quota`,
`provider.go-limit`) → `provider_unavailable` (`provider.internal`,
500/502/503/504) → `other` (fallback).

Consequences: definitive permanent failures are recognized before quota
phrases even when mixed into the same error; plan phrases beat ambiguous
codes; a bare 429 is a rate limit, never a plan quota; non-Alibaba providers
can never match Alibaba phrases (isolation).

### Policy decision table

Inputs: category, provider, model (context only), attempt, native decision
(read-only), now, resolved config, metadata `{retryAfterMs?, resetAtMs?,
elapsedMs?}`.

1. `config.enabled === false` → `no_override` (policy `engine.disabled`).
2. Category policy `enabled === false` → `no_override`.
3. Action `no_override` → `no_override` (defaults for `rate_limit`,
   `quota_unknown`, `provider_unavailable`, `other`).
4. Action `stop` → `stop` (defaults for `authentication`, `billing`,
   `quota_monthly`; monthly reason explains the subscription-day reset).
5. Action `retry`:
   - `maxAttempts` configured and `attempt >= maxAttempts` → `stop`.
   - Base delay:
     - fixed categories: configured `delayMs` (defaults: five_hour 30 min,
       temporary 60 s, concurrency_limit 5 s);
     - weekly: `nextWeeklyResetUtc8Ms(now) - now + marginMs` (default margin
       60 s);
     - monthly: requires `untilReset` **and** a finite positive
       `metadata.resetAtMs` inside the Date range; delay `max(0, resetAtMs -
       now)`; otherwise `stop`. Never calendar-assumed.
   - Reset floor (R4-03): a valid `metadata.resetAtMs` strictly in the future
     floors **any** emitted retry, not just monthly: the delay is at least
     `resetAtMs - now + marginMs`, using the category's configured margin
     (weekly default 60 s; 0 for every other category). The engine never
     retries before a known reset. Past or invalid values are ignored for
     flooring; `no_override`/`stop` paths are unaffected.
   - Cooldown: `delay = ceil(max(baseDelay, resetFloor, valid
     metadata.retryAfterMs))`. `evaluateQuota` merges a valid
     `error.retryAfterMs` into metadata (larger wins). Invalid cooldown values
     are ignored.
   - Bounds, in order, **after** the floor (an over-long wait stops, it is
     never clamped below a reset/cooldown): non-finite/negative/`> 2^31−1` →
     `stop`; explicit `elapsedMs + delay > maxElapsedMs` → `stop`;
     `delay > maxWaitMs` → `stop`.
   - Otherwise `retry` with integer `delayMs`.

Invalid required inputs (`now`, `attempt`, `decision.retry`, resolved config)
throw `TypeError`; invalid optional metadata is ignored. `now` must also lie
inside the JavaScript Date range (±8.64e15 ms): out-of-range values such as
`1e20` throw `TypeError` instead of reaching Date formatting (R4-04).
`resetAtMs` outside the Date range is invalid metadata — monthly stops, other
categories ignore it. A weekly reset computed beyond the Date range (possible
only for `now` near the upper boundary) stops safely. The native decision
object is never mutated; forcing retry over native `false` is allowed because
the host permits it within the remaining native budget.

### Weekly reset math (TZ-independent)

`nextWeeklyResetUtc8Ms(now)`: shift `now` by +8 h, floor to UTC day, compute
the weekday from epoch-day arithmetic (1970-01-01 was Thursday; equivalent to
`getUTCDay` on the shifted instant, but total even when the shifted instant
leaves the Date range), then unshift. Throws `TypeError` for non-finite or
out-of-Date-range `now`. If the candidate ≤ now (exactly-at-boundary case),
add 7 days so a persisting error never yields a zero-wait retry at the reset
instant. Only UTC math is used; no local-timezone dependency. Verified at
±1 ms around Monday 00:00 UTC+8, mid-week, Sunday evening, across a year
boundary, and at both Date-range edges; the full suite passes under four host
timezones.

### Defaults and bounds rationale

- `maxWaitMs` default 8 days (691 200 000 ms): covers the worst weekly wait
  (7 days − 1 ms + 60 s margin ≈ 604 860 000 ms) with headroom, and stays below
  2^31−1 ms so any signed-32-bit host timer remains safe. Configurable range
  1..2^31−1; smaller values legitimately turn weekly waits into `stop`.
- Five-hour default 30 min: the 5-hour window is rolling and its reset instant
  is not published, so the engine probes instead of assuming a full 5-hour
  wait; users may raise `delayMs` up to the ceiling.
- `maxElapsedMs` is optional and only enforced when the caller supplies
  cumulative `metadata.elapsedMs` — no global counters exist in the core.

## Configuration validation

`resolveConfig` collects **all** issues and throws one `ConfigError`
(`issues: string[]`, dotted paths). Unknown keys are rejected at every level.
Highlights:

- Category field applicability: `delayMs` only for delay-based categories with
  effective action `retry` (never weekly/monthly); `marginMs` weekly only
  (0..1 day); `untilReset` monthly only; monthly `action: "retry"` requires
  `untilReset: true`; `authentication`/`billing` refuse `action: "retry"` and
  `maxAttempts` (permanent safety enforced at config time).
- Numbers must be finite integers in range: `delayMs` 0..2^31−1, `maxWaitMs`
  1..2^31−1, `maxElapsedMs` 1..MAX_SAFE_INTEGER, `maxAttempts` ≥ 1.
- Providers: non-empty keys (lowercased canonical), boolean `enabled`, alias
  arrays of non-empty unique strings; aliases may not duplicate their own key
  or collide with any other canonical key/alias (including the built-in
  `alibaba`). Two keys that normalize to the same canonical name are rejected
  as duplicates — no silent overwrite (R4-05). Reserved JavaScript property
  names (`__proto__`, `constructor`, `prototype`) are rejected as provider
  keys so JSON-origin configs can never mutate the output dictionary's
  prototype (R4-05). Provider category overrides merge **field-level over the
  resolved global categories** — every field, including `maxAttempts` — so
  global tuning propagates into provider entries unless explicitly overridden
  (R4-02). Cross-field rules (monthly retry requires `untilReset`, permanent
  categories never retry) validate the **effective merged policy**, not the
  raw override: an inherited `untilReset: true` satisfies a provider-level
  monthly `action: "retry"`, and a provider `untilReset: false` under an
  inherited monthly retry is rejected.
- Logging shape (validated now, consumed later): `enabled` (default false),
  `level` debug|info|warn|error (default info), non-empty `directory`,
  `captureErrorDetails` (default false — privacy), `rotation.maxSizeBytes`
  1..100 MiB (default 1 MiB), `rotation.maxFiles` 1..1000 (default 5).

## Package conventions

- ESM (`"type": "module"`), TypeScript strict + `noUncheckedIndexedAccess`,
  target ES2022, NodeNext resolution. `dist/` holds JS + declarations; the
  later adapter can add a `./plugin` export with the Promise entry
  (`Plugin.define({id, setup})`) without touching the core.
- Scripts: `npm run build` (src → dist), `npm run typecheck` (src+test,
  noEmit), `npm test` (compile src+test → dist-test, `node --test`).
- Dev dependencies only: `typescript`, `@types/node`. Zero runtime deps.

## Verification

The classify/policy/config/evaluate suites cover five
phrases (exact/case/surrounding text/both structured envelopes), first-match
precedence, no-blanket-quota, permanent billing/auth, mixed-signal permanent
precedence (R4-01: every permanent predicate — auth/billing status, native
types, Alibaba codes/texts, and the recognized generic billing text markers —
outranks all five quota phrases and rate text, in messages and nested bodies,
including aliases and a disabled classifier; classifier + end-to-end), native
type mapping, non-Alibaba
isolation, aliases and classifier toggles, malformed bodies and invalid
metadata, weekly boundary ±1 ms and year crossing, monthly until-reset
semantics, universal reset-floor minima with margin and bounds ordering
(R4-03), out-of-Date-range timestamp safety at ±8.64e15 edges (R4-04),
cooldown minimums, stop-not-clamp bounds, elapsed budgets, maxAttempts,
provider override merging in both directions with effective-policy
validation (R4-02), canonical-collision and JSON-origin reserved-key
rejection (R4-05), config rejection matrix, purity (frozen inputs,
`Date.now` stub), and full evaluation provenance (R27-01: every plan phrase,
structured bodies, provider attribution, generic gate vs provider rule
distinction, and no fabricated matched provider — asserted on the public
`.classification` field), and the required public `concurrency_limit` category
(R27-02: canonical category set, accepted global/provider tuning with
field-level inheritance, rejection of the retired `quota_concurrency`
category name, default 5 s delay, isolation and disabled paths — through the
public `evaluateQuota` entry). Suite passes under TZ=UTC, America/New_York,
Asia/Shanghai, Pacific/Kiritimati.

## Deferred (honest limitations)

- No plugin adapter: nothing registers hooks yet; native exhaustion still
  skips consultation (host behavior, cannot be changed from a plugin).
- No logging implementation; `logging` config is shape-only.
- Weekly-scale `Effect.sleep` support on the installed host is claimed but
  unverified; the adapter slice must verify it (core delays stay < 2^31 ms).
- Published SDK tarball vs source equivalence to be confirmed in the adapter
  slice.
- Monthly until-reset requires the caller/adapter to supply a reliable reset
  instant; no documented wire field for it is assumed today.
- No Token Plan-specific classification or reset handling: its exhaustion
  text is deliberately `quota_unknown` under `alibaba` (ambiguous surface)
  and generic elsewhere; the subscription-month reset is not parsed from
  error text. Any addition is conditional future work requiring documented
  wire evidence plus sanitized diagnostics and offline tests.
- No ChatGPT subscription reset scheduling: `provider.chatgpt-limit` stops
  via generic billing; reset/credit recovery is left to the user and the
  provider dashboard (see provider coverage evidence above).