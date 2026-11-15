import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveConfig } from "../src/config.js"
import { classifyError, evaluateQuota, normalizeError } from "../src/index.js"
import type { EvaluateInput, HostError } from "../src/types.js"

const MONDAY_UTC8 = Date.UTC(2026, 10, 15, 16, 0, 0, 0)
const WEDNESDAY_UTC8 = Date.UTC(2026, 10, 18, 4, 30, 0, 0)
const config = resolveConfig()

function evaluate(error: HostError, overrides: Partial<EvaluateInput> = {}, cfg = config) {
  return evaluateQuota(
    {
      provider: "alibaba",
      model: "qwen3-max",
      error,
      attempt: 2,
      decision: { retry: true, delay: 2000 },
      now: WEDNESDAY_UTC8,
      ...overrides,
    },
    cfg,
  )
}

describe("end-to-end evaluation", () => {
  it("classifies and waits for the Alibaba weekly reset from a realistic hook error", () => {
    const body = JSON.stringify({
      error: { message: "week allocated quota exceeded", type: "insufficient_quota", code: null },
    })
    const result = evaluate({
      type: "provider.quota",
      message: "429 Too Many Requests",
      status: 429,
      response: { body },
    })
    assert.equal(result.action, "retry")
    assert.equal(result.category, "quota_weekly")
    const expected = MONDAY_UTC8 + 7 * 86_400_000 - WEDNESDAY_UTC8 + 60_000
    assert.equal(result.action === "retry" && result.delayMs, expected)
  })

  it("forces a retry over a native false decision for weekly quota", () => {
    const result = evaluate(
      { type: "provider.quota", message: "week allocated quota exceeded", status: 429 },
      { decision: { retry: false } },
    )
    assert.equal(result.action, "retry")
  })

  it("keeps the native decision for native rate limits", () => {
    const result = evaluate({ type: "provider.rate-limit", message: "rate limited", status: 429, retryAfterMs: 5000 })
    assert.equal(result.action, "no_override")
    assert.equal(result.category, "rate_limit")
  })

  it("stops on permanent billing even when the host wanted to retry", () => {
    const body = JSON.stringify({ code: "Arrearage", message: "Access denied, please make sure your account is in good standing." })
    const result = evaluate({ type: "provider.quota", message: "429", status: 429, response: { body } })
    assert.equal(result.action, "stop")
    assert.equal(result.category, "billing")
  })

  it("merges error.retryAfterMs as a minimum cooldown (larger wins)", () => {
    const error: HostError = { type: "provider.quota", message: "concurrency allocated quota exceeded", status: 429, retryAfterMs: 30_000 }
    const base = evaluate(error)
    assert.equal(base.action === "retry" && base.delayMs, 30_000)
    const withMeta = evaluate(error, { metadata: { retryAfterMs: 45_000 } })
    assert.equal(withMeta.action === "retry" && withMeta.delayMs, 45_000)
    const smallerMeta = evaluate(error, { metadata: { retryAfterMs: 10_000 } })
    assert.equal(smallerMeta.action === "retry" && smallerMeta.delayMs, 30_000)
  })

  it("invalid error.retryAfterMs is ignored end-to-end", () => {
    const error = { type: "provider.quota", message: "concurrency allocated quota exceeded", status: 429, retryAfterMs: -5 }
    const result = evaluate(error as HostError)
    assert.equal(result.action === "retry" && result.delayMs, 5_000)
  })

  it("disabled engine never overrides", () => {
    const disabled = resolveConfig({ enabled: false })
    const result = evaluate({ type: "provider.quota", message: "week allocated quota exceeded", status: 429 }, {}, disabled)
    assert.equal(result.action, "no_override")
    assert.equal(result.policy, "engine.disabled")
  })

  it("tolerates a completely malformed host error", () => {
    const result = evaluate({} as HostError)
    assert.equal(result.action, "no_override")
    assert.equal(result.category, "other")
  })

  it("non-Alibaba providers are isolated end-to-end", () => {
    const result = evaluate(
      { type: "provider.quota", message: "hour allocated quota exceeded", status: 429 },
      { provider: "anthropic" },
    )
    assert.equal(result.category, "rate_limit")
    assert.equal(result.action, "no_override")
  })

  it("monthly until-reset flows supplied metadata through", () => {
    const cfg = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    const resetAtMs = WEDNESDAY_UTC8 + 2 * 86_400_000
    const result = evaluate(
      { type: "provider.quota", message: "month allocated quota exceeded", status: 429 },
      { metadata: { resetAtMs } },
      cfg,
    )
    assert.equal(result.action === "retry" && result.delayMs, 2 * 86_400_000)
  })

  it("does not mutate inputs", () => {
    const error: HostError = Object.freeze({
      type: "provider.quota",
      message: "week allocated quota exceeded",
      status: 429,
      response: Object.freeze({ body: "{}" }),
    })
    const input: EvaluateInput = Object.freeze({
      provider: "alibaba",
      model: "qwen3-max",
      error,
      attempt: 2,
      decision: Object.freeze({ retry: true, delay: 2000 }),
      now: WEDNESDAY_UTC8,
      metadata: Object.freeze({ retryAfterMs: 1000 }),
    })
    const before = JSON.stringify(input)
    evaluateQuota(input, config)
    assert.equal(JSON.stringify(input), before)
  })
})

describe("R4-01: mixed-signal end-to-end safety", () => {
  it("auth signal + hour phrase stops instead of retrying 30 minutes", () => {
    const result = evaluate({ type: "provider.auth", status: 401, message: "hour allocated quota exceeded" })
    assert.equal(result.action, "stop")
    assert.equal(result.category, "authentication")
  })

  it("402 + usage phrase stops instead of retrying 60 seconds", () => {
    const result = evaluate({ type: "provider.quota", status: 402, message: "usage allocated quota exceeded" })
    assert.equal(result.action, "stop")
    assert.equal(result.category, "billing")
  })

  it("403 + 'Too many requests' stops instead of keeping the native retry", () => {
    const result = evaluate({ type: "provider.rate-limit", status: 403, message: "Too many requests" })
    assert.equal(result.action, "stop")
    assert.equal(result.category, "authentication")
  })

  it("native budget-limit type + weekly phrase stops", () => {
    const result = evaluate({ type: "provider.budget-limit", status: 429, message: "week allocated quota exceeded" })
    assert.equal(result.action, "stop")
    assert.equal(result.category, "billing")
  })
})

describe("R4-01 final: billing text mixed with quota/concurrency stops end-to-end", () => {
  const transientPhrases = [
    "hour allocated quota exceeded",
    "week allocated quota exceeded",
    "month allocated quota exceeded",
    "usage allocated quota exceeded",
    "concurrency allocated quota exceeded",
  ] as const

  const billingMarkers = [
    "insufficient balance",
    "run out of credits",
    "billing error",
    "account is in good standing",
    "bill is overdue",
  ] as const

  it("R6 reproduction: insufficient balance + usage phrase stops, never retry/60000", () => {
    const result = evaluate({ type: "provider.quota", status: 429, message: "insufficient balance; usage allocated quota exceeded" })
    assert.equal(result.action, "stop")
    assert.equal(result.category, "billing")
  })

  for (const marker of billingMarkers) {
    for (const phrase of transientPhrases) {
      it(`"${marker}" + "${phrase}" stops`, () => {
        const result = evaluate({ type: "provider.quota", status: 429, message: `${marker}; ${phrase}` })
        assert.equal(result.action, "stop")
        assert.equal(result.category, "billing")
      })
    }
  }

  it("billing text in nested structured bodies stops", () => {
    const dashscope = JSON.stringify({ code: "Throttling.AllocationQuota", message: "run out of credits; usage allocated quota exceeded" })
    const openai = JSON.stringify({
      error: { message: "billing error; concurrency allocated quota exceeded", type: "insufficient_quota", code: null },
    })
    for (const body of [dashscope, openai]) {
      const result = evaluate({ type: "provider.quota", status: 429, message: "429", response: { body } })
      assert.equal(result.action, "stop")
      assert.equal(result.category, "billing")
    }
  })

  it("alias providers stop on mixed billing text", () => {
    const cfg = resolveConfig({ providers: { alibaba: { aliases: ["dashscope"] } } })
    const result = evaluate(
      { type: "provider.quota", status: 429, message: "bill is overdue; week allocated quota exceeded" },
      { provider: "DASHSCOPE" },
      cfg,
    )
    assert.equal(result.action, "stop")
    assert.equal(result.category, "billing")
  })

  it("disabled Alibaba classifier still stops on mixed billing text", () => {
    const cfg = resolveConfig({ providers: { alibaba: { enabled: false } } })
    const result = evaluate(
      { type: "provider.quota", status: 429, message: "insufficient balance; concurrency allocated quota exceeded" },
      {},
      cfg,
    )
    assert.equal(result.action, "stop")
    assert.equal(result.category, "billing")
  })

  it("mixed billing text stops even over a native false decision", () => {
    const result = evaluate(
      { type: "provider.quota", status: 429, message: "insufficient balance; hour allocated quota exceeded" },
      { decision: { retry: false } },
    )
    assert.equal(result.action, "stop")
    assert.equal(result.category, "billing")
  })

  it("transient-only phrases still retry (no over-blocking)", () => {
    const usage = evaluate({ type: "provider.quota", status: 429, message: "usage allocated quota exceeded" })
    assert.equal(usage.action === "retry" && usage.delayMs, 60_000)
    const concurrency = evaluate({ type: "provider.quota", status: 429, message: "concurrency allocated quota exceeded" })
    assert.equal(concurrency.action === "retry" && concurrency.delayMs, 5_000)
  })

  it("ambiguous quota without permanent signals keeps the native decision", () => {
    const result = evaluate({
      type: "provider.quota",
      status: 429,
      message: "Allocated quota exceeded, please increase your quota limit.",
    })
    assert.equal(result.action, "no_override")
    assert.equal(result.category, "quota_unknown")
  })
})

describe("R4-03/R4-04: reset metadata end-to-end", () => {
  it("supplied future reset floors a concurrency retry end-to-end", () => {
    const resetAtMs = WEDNESDAY_UTC8 + 3_600_000
    const result = evaluate(
      { type: "provider.quota", message: "concurrency allocated quota exceeded", status: 429 },
      { metadata: { resetAtMs } },
    )
    assert.equal(result.action === "retry" && result.delayMs, 3_600_000)
  })

  it("monthly out-of-range reset stops end-to-end without throwing", () => {
    const cfg = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    const result = evaluate(
      { type: "provider.quota", message: "month allocated quota exceeded", status: 429 },
      { metadata: { resetAtMs: 1e20 } },
      cfg,
    )
    assert.equal(result.action, "stop")
    assert.match(result.reason, /resetAtMs/)
  })
})

// ---------------------------------------------------------------------------
// R27-01: the pure evaluateQuota contract preserves the FULL classifier
// provenance (category, stable ruleId, canonical matched provider) instead of
// returning only the policy decision's category. Driven through the public
// package entry, exactly as an embedder consumes it.
// ---------------------------------------------------------------------------
describe("R27-01: evaluateQuota preserves full classifier provenance", () => {
  const planCases = [
    ["hour allocated quota exceeded", "quota_five_hour", "alibaba.quota_five_hour"],
    ["week allocated quota exceeded", "quota_weekly", "alibaba.quota_weekly"],
    ["month allocated quota exceeded", "quota_monthly", "alibaba.quota_monthly"],
    ["usage allocated quota exceeded", "quota_temporary", "alibaba.quota_temporary"],
    ["concurrency allocated quota exceeded", "concurrency_limit", "alibaba.quota_concurrency"],
  ] as const

  for (const [phrase, category, ruleId] of planCases) {
    it(`"${phrase}" keeps ruleId ${ruleId} and canonical provider`, () => {
      const result = evaluate({ type: "provider.quota", message: phrase, status: 429 })
      assert.deepEqual(result.classification, { category, ruleId, provider: "alibaba" })
      assert.equal(result.category, category)
    })
  }

  it("structured-body phrases keep the same provenance (R27 reproduction shape)", () => {
    const body = JSON.stringify({
      error: { message: "week allocated quota exceeded", type: "insufficient_quota", code: null },
    })
    const result = evaluate({ type: "provider.quota", message: "429 Too Many Requests", status: 429, response: { body } })
    assert.deepEqual(result.classification, {
      category: "quota_weekly",
      ruleId: "alibaba.quota_weekly",
      provider: "alibaba",
    })
    // The decision surface itself is unchanged by the provenance addition.
    assert.equal(result.action, "retry")
    assert.equal(result.policy, "providers.alibaba.categories.quota_weekly")
  })

  it("Alibaba permanent rules keep provider attribution", () => {
    const body = JSON.stringify({ code: "Arrearage", message: "Access denied, please make sure your account is in good standing." })
    const result = evaluate({ type: "provider.quota", message: "429", status: 429, response: { body } })
    assert.deepEqual(result.classification, { category: "billing", ruleId: "alibaba.billing", provider: "alibaba" })
    assert.equal(result.action, "stop")
  })

  it("the generic permanent gate on Alibaba is distinguishable from provider rules", () => {
    // Same category/policy path as alibaba.billing, but a DIFFERENT stable rule
    // identity and no matched provider — the distinction R27-01 requires.
    const result = evaluate({ type: "provider.quota", status: 402, message: "week allocated quota exceeded" })
    assert.deepEqual(result.classification, { category: "billing", ruleId: "generic.billing" })
    assert.equal(result.action, "stop")
  })

  it("generic permanent rules on other providers carry no matched provider", () => {
    const billing = evaluate({ type: "provider.budget-limit", message: "BudgetLimitExceeded", status: 402 }, { provider: "openai" })
    assert.deepEqual(billing.classification, { category: "billing", ruleId: "generic.billing" })
    const auth = evaluate({ type: "provider.auth", message: "InvalidApiKey", status: 401 }, { provider: "openai" })
    assert.deepEqual(auth.classification, { category: "authentication", ruleId: "generic.auth" })
  })

  it("generic rate_limit and quota_unknown keep generic identities", () => {
    const rate = evaluate({ type: "provider.rate-limit", message: "rate limited", status: 429 })
    assert.deepEqual(rate.classification, { category: "rate_limit", ruleId: "generic.rate_limit" })
    const unknown = evaluate({ type: "provider.quota", message: "quota exhausted" }, { provider: "openai" })
    assert.deepEqual(unknown.classification, { category: "quota_unknown", ruleId: "generic.quota_unknown" })
  })

  it("ambiguous Alibaba quota keeps the provider-specific unknown rule", () => {
    const result = evaluate({
      type: "provider.quota",
      status: 429,
      message: "Allocated quota exceeded, please increase your quota limit.",
    })
    assert.deepEqual(result.classification, { category: "quota_unknown", ruleId: "alibaba.quota_unknown", provider: "alibaba" })
    assert.equal(result.action, "no_override")
  })

  it("disabled Alibaba classifier falls through to generic rules without a matched provider", () => {
    const cfg = resolveConfig({ providers: { alibaba: { enabled: false } } })
    const result = evaluate({ type: "provider.quota", message: "week allocated quota exceeded", status: 429 }, {}, cfg)
    assert.deepEqual(result.classification, { category: "rate_limit", ruleId: "generic.rate_limit" })
    assert.equal(result.action, "no_override")
  })

  it("unknown/fallback errors keep the generic.other identity, never a fabricated rule", () => {
    const malformed = evaluate({} as HostError)
    assert.deepEqual(malformed.classification, { category: "other", ruleId: "generic.other" })
    const odd = evaluate({ type: "unknown", message: "something odd happened" })
    assert.deepEqual(odd.classification, { category: "other", ruleId: "generic.other" })
  })

  it("aliases report the CANONICAL matched provider, not the alias spelling", () => {
    const cfg = resolveConfig({ providers: { alibaba: { aliases: ["dashscope"] } } })
    const result = evaluate(
      { type: "provider.quota", message: "week allocated quota exceeded", status: 429 },
      { provider: "DASHSCOPE" },
      cfg,
    )
    assert.deepEqual(result.classification, { category: "quota_weekly", ruleId: "alibaba.quota_weekly", provider: "alibaba" })
  })

  it("classification is preserved losslessly: identical to classifyError(normalizeError(...))", () => {
    const errors: Array<{ provider: string; error: HostError; cfg?: ReturnType<typeof resolveConfig> }> = [
      { provider: "alibaba", error: { type: "provider.quota", message: "hour allocated quota exceeded", status: 429 } },
      { provider: "alibaba", error: { type: "provider.quota", status: 402, message: "usage allocated quota exceeded" } },
      { provider: "alibaba", error: { type: "unknown", message: "mystery" } },
      { provider: "openai", error: { type: "provider.rate-limit", message: "429", status: 429 } },
      { provider: "openai", error: { type: "provider.auth", message: "no", status: 403 } },
      {
        provider: "alibaba",
        error: { type: "provider.quota", message: "week allocated quota exceeded", status: 429 },
        cfg: resolveConfig({ providers: { alibaba: { enabled: false } } }),
      },
    ]
    for (const { provider, error, cfg } of errors) {
      const config = cfg ?? resolveConfig()
      const result = evaluateQuota(
        { provider, model: "m", error, attempt: 1, decision: { retry: true, delay: 2000 }, now: WEDNESDAY_UTC8 },
        config,
      )
      const direct = classifyError(normalizeError(provider, "m", error), config)
      assert.deepEqual(result.classification, direct)
      assert.equal(result.category, direct.category)
    }
  })

  it("each evaluation returns its own fresh classification (no shared state)", () => {
    const first = evaluate({ type: "provider.quota", message: "week allocated quota exceeded", status: 429 })
    const second = evaluate({ type: "provider.quota", message: "week allocated quota exceeded", status: 429 })
    assert.notStrictEqual(first.classification, second.classification)
    assert.deepEqual(first.classification, second.classification)
  })
})

// ---------------------------------------------------------------------------
// R27-02: the required public category is concurrency_limit, end-to-end
// through the public package entry: default 5s short delay, user-configured
// policy, provider overrides with inheritance, isolation and disabled paths.
// The stable rule identity stays alibaba.quota_concurrency (rule labels are
// provider-specific diagnostic identity, independent of the category name).
// ---------------------------------------------------------------------------
describe("R27-02: concurrency_limit end-to-end through the public entry", () => {
  const concurrencyError: HostError = {
    type: "provider.quota",
    message: "concurrency allocated quota exceeded",
    status: 429,
  }

  it("defaults to the 5s short delay with full provenance and the provider policy path", () => {
    const result = evaluate(concurrencyError)
    assert.equal(result.action, "retry")
    assert.equal(result.category, "concurrency_limit")
    assert.equal(result.action === "retry" && result.delayMs, 5_000)
    assert.equal(result.policy, "providers.alibaba.categories.concurrency_limit")
    assert.deepEqual(result.classification, {
      category: "concurrency_limit",
      ruleId: "alibaba.quota_concurrency",
      provider: "alibaba",
    })
  })

  it("structured-body phrase keeps the same category and provenance (R27 shape)", () => {
    const body = JSON.stringify({
      error: { message: "concurrency allocated quota exceeded", type: "insufficient_quota", code: null },
    })
    const result = evaluate({ type: "provider.quota", message: "429 Too Many Requests", status: 429, response: { body } })
    assert.equal(result.category, "concurrency_limit")
    assert.deepEqual(result.classification, {
      category: "concurrency_limit",
      ruleId: "alibaba.quota_concurrency",
      provider: "alibaba",
    })
  })

  it("user-configured global delayMs propagates through provider inheritance", () => {
    const cfg = resolveConfig({ categories: { concurrency_limit: { delayMs: 1234 } } })
    const result = evaluate(concurrencyError, {}, cfg)
    assert.equal(result.action === "retry" && result.delayMs, 1234)
    assert.equal(result.policy, "providers.alibaba.categories.concurrency_limit")
  })

  it("provider override beats the global delay; inherited maxAttempts still stops", () => {
    const cfg = resolveConfig({
      categories: { concurrency_limit: { delayMs: 7_000, maxAttempts: 2 } },
      providers: { alibaba: { categories: { concurrency_limit: { delayMs: 2_000 } } } },
    })
    const retry = evaluate(concurrencyError, { attempt: 1 }, cfg)
    assert.equal(retry.action === "retry" && retry.delayMs, 2_000)
    const stopped = evaluate(concurrencyError, { attempt: 2 }, cfg)
    assert.equal(stopped.action, "stop")
    assert.equal(stopped.category, "concurrency_limit")
  })

  it("disabled category policy keeps the native decision", () => {
    const cfg = resolveConfig({ categories: { concurrency_limit: { enabled: false } } })
    const result = evaluate(concurrencyError, { decision: { retry: true, delay: 2000 } }, cfg)
    assert.equal(result.action, "no_override")
    assert.equal(result.category, "concurrency_limit")
    assert.equal(result.policy, "providers.alibaba.categories.concurrency_limit")
  })

  it("non-Alibaba providers never classify the phrase as concurrency_limit (isolation)", () => {
    for (const provider of ["anthropic", "openai", "alibaba-ish"]) {
      const result = evaluate(concurrencyError, { provider })
      assert.equal(result.category, "rate_limit")
      assert.equal(result.action, "no_override")
      assert.deepEqual(result.classification, { category: "rate_limit", ruleId: "generic.rate_limit" })
    }
  })

  it("disabled Alibaba classifier falls through to the generic rate limit", () => {
    const cfg = resolveConfig({ providers: { alibaba: { enabled: false } } })
    const result = evaluate(concurrencyError, {}, cfg)
    assert.equal(result.category, "rate_limit")
    assert.equal(result.action, "no_override")
    assert.deepEqual(result.classification, { category: "rate_limit", ruleId: "generic.rate_limit" })
  })
})