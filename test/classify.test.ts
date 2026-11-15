import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { classifyError, normalizeError, parseBody } from "../src/classify.js"
import { resolveConfig } from "../src/config.js"
import type { HostError, NormalizedError } from "../src/types.js"

const config = resolveConfig()

function norm(provider: string, error: HostError, model = "qwen3-max"): NormalizedError {
  return normalizeError(provider, model, error)
}

function classify(provider: string, error: HostError, cfg = config) {
  return classifyError(norm(provider, error), cfg)
}

const PHRASE_CASES = [
  ["hour allocated quota exceeded", "quota_five_hour", "alibaba.quota_five_hour"],
  ["week allocated quota exceeded", "quota_weekly", "alibaba.quota_weekly"],
  ["month allocated quota exceeded", "quota_monthly", "alibaba.quota_monthly"],
  ["usage allocated quota exceeded", "quota_temporary", "alibaba.quota_temporary"],
  ["concurrency allocated quota exceeded", "concurrency_limit", "alibaba.quota_concurrency"],
] as const

describe("Alibaba five-phrase classification", () => {
  for (const [phrase, category, ruleId] of PHRASE_CASES) {
    it(`maps exact phrase "${phrase}"`, () => {
      const result = classify("alibaba", { type: "provider.quota", message: phrase, status: 429 })
      assert.equal(result.category, category)
      assert.equal(result.ruleId, ruleId)
      assert.equal(result.provider, "alibaba")
    })

    it(`maps case-insensitively with surrounding text: "${phrase}"`, () => {
      const message = `HTTP 429: ${phrase.toUpperCase()} — please try again later (request id abc).`
      const result = classify("alibaba", { type: "provider.quota", message, status: 429 })
      assert.equal(result.category, category)
    })

    it(`maps inside a DashScope structured body: "${phrase}"`, () => {
      const body = JSON.stringify({ code: "Throttling.AllocationQuota", message: `Error: ${phrase}.`, request_id: "x" })
      const result = classify("alibaba", { type: "provider.quota", message: "429", status: 429, response: { body } })
      assert.equal(result.category, category)
    })

    it(`maps inside an OpenAI-style structured body: "${phrase}"`, () => {
      const body = JSON.stringify({ error: { message: phrase, type: "insufficient_quota", code: null } })
      const result = classify("alibaba", { type: "provider.rate-limit", message: "429", status: 429, response: { body } })
      assert.equal(result.category, category)
    })
  }

  it("first match wins in fixed rule order when several phrases appear", () => {
    const message = "week allocated quota exceeded; also hour allocated quota exceeded"
    assert.equal(classify("alibaba", { type: "provider.quota", message }).category, "quota_five_hour")
  })

  it("matches phrase in body even when host message is generic", () => {
    const body = JSON.stringify({ error: { message: "Concurrency allocated quota exceeded", code: "Throttling" } })
    const result = classify("alibaba", { type: "provider.unknown", message: "request failed", response: { body } })
    assert.equal(result.category, "concurrency_limit")
  })
})

describe("no blanket quota mapping", () => {
  it("bare 'Allocated quota exceeded' is quota_unknown, never a plan category", () => {
    const result = classify("alibaba", {
      type: "provider.quota",
      message: "Allocated quota exceeded, please increase your quota limit.",
      status: 429,
    })
    assert.equal(result.category, "quota_unknown")
    assert.equal(result.ruleId, "alibaba.quota_unknown")
  })

  it("insufficient_quota code with billing-flavored message stays quota_unknown", () => {
    const body = JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    })
    const result = classify("alibaba", { type: "provider.quota", message: "429", status: 429, response: { body } })
    assert.equal(result.category, "quota_unknown")
  })

  it("arbitrary 'quota exceeded' text with 429 is a rate limit, not a plan quota", () => {
    const result = classify("alibaba", { type: "provider.unknown", message: "quota exceeded", status: 429 })
    assert.equal(result.category, "rate_limit")
    assert.equal(result.ruleId, "generic.rate_limit")
  })

  it("429 without any quota evidence is rate_limit", () => {
    const result = classify("alibaba", { type: "provider.unknown", message: "slow down", status: 429 })
    assert.equal(result.category, "rate_limit")
  })

  it("token-plan exhaustion phrase is quota_unknown (no calendar assumption)", () => {
    const result = classify("alibaba", {
      type: "provider.quota",
      message: "Your token-plan quota has been exhausted",
      status: 429,
    })
    assert.equal(result.category, "quota_unknown")
  })
})

describe("permanent billing and auth safety", () => {
  const billingCodes = [
    "Arrearage",
    "isv.OUT_OF_SERVICE",
    "PrepaidBillOverdue",
    "PostpaidBillOverdue",
    "BudgetLimitExceeded",
    "CommodityNotPurchased",
    "AllocationQuota.FreeTierOnly",
  ]
  for (const code of billingCodes) {
    it(`billing code ${code} classifies as billing even with status 429`, () => {
      const body = JSON.stringify({ code, message: "access denied" })
      const result = classify("alibaba", { type: "provider.quota", message: "429", status: 429, response: { body } })
      assert.equal(result.category, "billing")
      assert.equal(result.ruleId, "alibaba.billing")
    })
  }

  it("Arrearage message marker wins over 403", () => {
    const result = classify("alibaba", {
      type: "provider.auth",
      message: "Access denied, please make sure your account is in good standing.",
      status: 403,
    })
    assert.equal(result.category, "billing")
  })

  it("free allocated quota exceeded is permanent billing", () => {
    const result = classify("alibaba", { type: "provider.quota", message: "Free allocated quota exceeded.", status: 429 })
    assert.equal(result.category, "billing")
  })

  it("InvalidApiKey code is authentication", () => {
    const body = JSON.stringify({ code: "InvalidApiKey", message: "Invalid API-key provided." })
    const result = classify("alibaba", { type: "provider.auth", message: "401", status: 401, response: { body } })
    assert.equal(result.category, "authentication")
    assert.equal(result.ruleId, "alibaba.auth")
  })

  it("generic 401/403 and provider.auth are authentication", () => {
    assert.equal(classify("other-provider", { type: "x", message: "", status: 401 }).category, "authentication")
    assert.equal(classify("other-provider", { type: "x", message: "", status: 403 }).category, "authentication")
    assert.equal(classify("other-provider", { type: "provider.auth", message: "" }).category, "authentication")
  })

  it("generic billing markers and 402 are billing", () => {
    assert.equal(classify("other-provider", { type: "x", message: "", status: 402 }).category, "billing")
    assert.equal(
      classify("other-provider", { type: "x", message: "Your API key has run out of credits" }).category,
      "billing",
    )
    assert.equal(classify("other-provider", { type: "provider.budget-limit", message: "" }).category, "billing")
    assert.equal(classify("other-provider", { type: "provider.free-limit", message: "" }).category, "billing")
  })
})

describe("generic categories and native types", () => {
  it("native provider.rate-limit stays rate_limit", () => {
    const result = classify("anthropic", { type: "provider.rate-limit", message: "rate limited", status: 429 })
    assert.equal(result.category, "rate_limit")
    assert.equal(result.ruleId, "generic.rate_limit")
  })

  it("native provider.quota and provider.go-limit are quota_unknown", () => {
    assert.equal(classify("openai", { type: "provider.quota", message: "" }).category, "quota_unknown")
    assert.equal(classify("openai", { type: "provider.go-limit", message: "" }).category, "quota_unknown")
  })

  it("provider.internal and 5xx are provider_unavailable", () => {
    assert.equal(classify("openai", { type: "provider.internal", message: "" }).category, "provider_unavailable")
    for (const status of [500, 502, 503, 504]) {
      assert.equal(classify("openai", { type: "x", message: "", status }).category, "provider_unavailable")
    }
  })

  it("unknown types fall back to other", () => {
    assert.equal(classify("openai", { type: "provider.timeout", message: "" }).category, "other")
    assert.equal(classify("openai", { type: "provider.transport", message: "" }).category, "other")
    assert.equal(classify("openai", { type: "totally-unknown", message: "" }).category, "other")
    assert.equal(classify("openai", { type: "", message: "" }).category, "other")
  })

  it("Alibaba Throttling.Concurrency (non-plan) is rate_limit, not concurrency_limit", () => {
    const body = JSON.stringify({ code: "Throttling.Concurrency", message: "Too many concurrent requests." })
    const result = classify("alibaba", { type: "provider.rate-limit", message: "429", status: 429, response: { body } })
    assert.equal(result.category, "rate_limit")
    assert.equal(result.ruleId, "alibaba.rate_limit")
  })

  it("Alibaba Throttling.RateQuota is rate_limit", () => {
    const body = JSON.stringify({ code: "Throttling.RateQuota", message: "Requests rate limit exceeded, please try again later." })
    const result = classify("alibaba", { type: "provider.rate-limit", message: "429", status: 429, response: { body } })
    assert.equal(result.category, "rate_limit")
  })
})

describe("provider isolation, aliases and toggles", () => {
  it("non-Alibaba providers never match Alibaba plan phrases", () => {
    for (const provider of ["anthropic", "openai", "google", "alibaba-ish"]) {
      const result = classify(provider, { type: "provider.quota", message: "hour allocated quota exceeded", status: 429 })
      assert.notEqual(result.category, "quota_five_hour")
      assert.equal(result.provider, undefined)
    }
  })

  it("configured aliases route to Alibaba rules (case-insensitive)", () => {
    const cfg = resolveConfig({ providers: { alibaba: { aliases: ["dashscope", "Alibaba-Coding"] } } })
    for (const provider of ["dashscope", "DASHSCOPE", "alibaba-coding", "ALIBABA"]) {
      const result = classify(provider, { type: "provider.quota", message: "week allocated quota exceeded", status: 429 }, cfg)
      assert.equal(result.category, "quota_weekly")
      assert.equal(result.provider, "alibaba")
    }
  })

  it("disabling the Alibaba classifier falls through to generic rules", () => {
    const cfg = resolveConfig({ providers: { alibaba: { enabled: false } } })
    const result = classify("alibaba", { type: "provider.quota", message: "hour allocated quota exceeded", status: 429 }, cfg)
    assert.equal(result.category, "rate_limit")
    assert.equal(result.ruleId, "generic.rate_limit")
  })

  it("Alibaba rules work out of the box without any provider config", () => {
    const result = classify("alibaba", { type: "provider.quota", message: "month allocated quota exceeded", status: 429 })
    assert.equal(result.category, "quota_monthly")
  })
})

describe("normalization robustness", () => {
  it("drops invalid status values", () => {
    for (const status of [99, 600, 429.5, Number.NaN, "429"]) {
      const normalized = norm("alibaba", { type: "x", message: "", status: status as number })
      assert.equal(normalized.status, undefined)
    }
    assert.equal(norm("alibaba", { type: "x", message: "", status: 429 }).status, 429)
  })

  it("drops invalid retryAfterMs values", () => {
    for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60"]) {
      const normalized = norm("alibaba", { type: "x", message: "", retryAfterMs: retryAfterMs as number })
      assert.equal(normalized.retryAfterMs, undefined)
    }
    assert.equal(norm("alibaba", { type: "x", message: "", retryAfterMs: 0 }).retryAfterMs, 0)
    assert.equal(norm("alibaba", { type: "x", message: "", retryAfterMs: 1500 }).retryAfterMs, 1500)
  })

  it("tolerates malformed JSON bodies and still uses the message", () => {
    const result = classify("alibaba", {
      type: "provider.quota",
      message: "usage allocated quota exceeded",
      status: 429,
      response: { body: "{definitely not json" },
    })
    assert.equal(result.category, "quota_temporary")
  })

  it("tolerates non-object JSON bodies", () => {
    for (const body of ["[]", '"text"', "42", "null"]) {
      const info = parseBody(body)
      assert.equal(info.code, undefined)
      assert.deepEqual(info.messages, [])
    }
  })

  it("extracts code from top-level, error.code, then error.type", () => {
    assert.equal(parseBody(JSON.stringify({ code: "A" })).code, "A")
    assert.equal(parseBody(JSON.stringify({ error: { code: "B" } })).code, "B")
    assert.equal(parseBody(JSON.stringify({ error: { type: "C" } })).code, "C")
    assert.equal(parseBody(JSON.stringify({ code: 7 })).code, undefined)
    assert.equal(parseBody(undefined).code, undefined)
  })

  it("handles completely empty errors", () => {
    const normalized = norm("alibaba", {} as HostError)
    assert.equal(normalized.message, "")
    assert.equal(classifyError(normalized, config).category, "other")
  })
})

describe("R4-01: definitive permanent signals outrank transient Alibaba phrases", () => {
  it("provider.auth + 401 with hour quota phrase is authentication, not a retry category", () => {
    const result = classify("alibaba", { type: "provider.auth", status: 401, message: "hour allocated quota exceeded" })
    assert.equal(result.category, "authentication")
    assert.equal(result.ruleId, "generic.auth")
  })

  it("402 with usage quota phrase is billing", () => {
    const result = classify("alibaba", { type: "provider.quota", status: 402, message: "usage allocated quota exceeded" })
    assert.equal(result.category, "billing")
    assert.equal(result.ruleId, "generic.billing")
  })

  it("403 with 'Too many requests' is authentication, not rate_limit", () => {
    const result = classify("alibaba", { type: "provider.rate-limit", status: 403, message: "Too many requests" })
    assert.equal(result.category, "authentication")
  })

  it("native billing types outrank weekly and monthly phrases", () => {
    for (const type of ["provider.budget-limit", "provider.model-budget-limit", "provider.free-limit", "provider.chatgpt-limit"]) {
      const result = classify("alibaba", { type, status: 429, message: "week allocated quota exceeded" })
      assert.equal(result.category, "billing", type)
    }
    const monthly = classify("alibaba", { type: "provider.free-limit", message: "month allocated quota exceeded" })
    assert.equal(monthly.category, "billing")
  })

  it("permanent status outranks phrases inside a structured body", () => {
    const body = JSON.stringify({ code: "Throttling.RateQuota", message: "concurrency allocated quota exceeded" })
    const result = classify("alibaba", { type: "provider.quota", status: 401, message: "429", response: { body } })
    assert.equal(result.category, "authentication")
  })

  it("Alibaba permanent rules keep provider attribution when they also match", () => {
    const body = JSON.stringify({ code: "InvalidApiKey", message: "Invalid API-key provided." })
    const result = classify("alibaba", { type: "provider.auth", status: 401, message: "401", response: { body } })
    assert.equal(result.category, "authentication")
    assert.equal(result.ruleId, "alibaba.auth")
    assert.equal(result.provider, "alibaba")
  })

  it("transient phrases still classify when no permanent signal is present", () => {
    const result = classify("alibaba", { type: "provider.quota", status: 429, message: "hour allocated quota exceeded" })
    assert.equal(result.category, "quota_five_hour")
    assert.equal(result.ruleId, "alibaba.quota_five_hour")
  })

  it("aliases get the same permanent-signal precedence", () => {
    const cfg = resolveConfig({ providers: { alibaba: { aliases: ["dashscope"] } } })
    const result = classify("dashscope", { type: "provider.auth", status: 401, message: "week allocated quota exceeded" }, cfg)
    assert.equal(result.category, "authentication")
  })

  it("disabled Alibaba classifier still stops on permanent signals via generic rules", () => {
    const cfg = resolveConfig({ providers: { alibaba: { enabled: false } } })
    const result = classify("alibaba", { type: "provider.quota", status: 402, message: "usage allocated quota exceeded" }, cfg)
    assert.equal(result.category, "billing")
  })
})

describe("R4-01 final: every permanent predicate outranks transient Alibaba matches", () => {
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

  // Recognized generic billing text × every plan phrase (the remaining R6 gap).
  for (const marker of billingMarkers) {
    for (const phrase of transientPhrases) {
      it(`billing text "${marker}" + "${phrase}" is billing`, () => {
        const result = classify("alibaba", { type: "provider.quota", status: 429, message: `${marker}; ${phrase}` })
        assert.equal(result.category, "billing")
        // "account is in good standing" is also an Alibaba marker: provider attribution wins.
        assert.equal(result.ruleId, marker === "account is in good standing" ? "alibaba.billing" : "generic.billing")
      })
    }
  }

  it("billing text outranks transient rate-limit text and throttling codes", () => {
    for (const marker of billingMarkers) {
      const text = classify("alibaba", { type: "provider.rate-limit", status: 429, message: `${marker}; too many requests` })
      assert.equal(text.category, "billing", marker)
      const body = JSON.stringify({ code: "Throttling.RateQuota", message: `${marker}; concurrency allocated quota exceeded` })
      const coded = classify("alibaba", { type: "provider.quota", status: 429, message: "429", response: { body } })
      assert.equal(coded.category, "billing", marker)
    }
  })

  for (const marker of billingMarkers) {
    it(`billing text "${marker}" inside nested structured bodies is billing`, () => {
      const dashscope = JSON.stringify({
        code: "Throttling.AllocationQuota",
        message: `${marker}; usage allocated quota exceeded`,
        request_id: "x",
      })
      const openai = JSON.stringify({
        error: { message: `${marker}; concurrency allocated quota exceeded`, type: "insufficient_quota", code: null },
      })
      for (const body of [dashscope, openai]) {
        const result = classify("alibaba", { type: "provider.quota", status: 429, message: "429", response: { body } })
        assert.equal(result.category, "billing", marker)
      }
    })
  }

  // Alibaba's own permanent codes/texts keep provider attribution when mixed.
  const alibabaBillingCodes = [
    "Arrearage",
    "isv.OUT_OF_SERVICE",
    "PrepaidBillOverdue",
    "PostpaidBillOverdue",
    "BudgetLimitExceeded",
    "CommodityNotPurchased",
    "AllocationQuota.FreeTierOnly",
  ]
  for (const code of alibabaBillingCodes) {
    it(`billing code ${code} + transient phrases keeps alibaba.billing`, () => {
      const body = JSON.stringify({ code, message: "usage allocated quota exceeded; concurrency allocated quota exceeded" })
      const result = classify("alibaba", { type: "provider.quota", status: 429, message: "429", response: { body } })
      assert.equal(result.category, "billing")
      assert.equal(result.ruleId, "alibaba.billing")
      assert.equal(result.provider, "alibaba")
    })
  }

  const alibabaBillingTexts = [
    "account is in good standing",
    "prepaid bill is overdue",
    "postpaid bill is overdue",
    "free allocated quota exceeded",
  ]
  for (const marker of alibabaBillingTexts) {
    it(`Alibaba billing text "${marker}" + transient phrase keeps alibaba.billing`, () => {
      const result = classify("alibaba", { type: "provider.quota", status: 429, message: `${marker}; week allocated quota exceeded` })
      assert.equal(result.category, "billing")
      assert.equal(result.ruleId, "alibaba.billing")
      assert.equal(result.provider, "alibaba")
    })
  }

  const alibabaAuthCodes = ["InvalidApiKey", "invalid_api_key", "AccessDenied", "access_denied"]
  for (const code of alibabaAuthCodes) {
    it(`auth code ${code} + transient phrase keeps alibaba.auth`, () => {
      const body = JSON.stringify({ code, message: "hour allocated quota exceeded" })
      const result = classify("alibaba", { type: "provider.quota", status: 429, message: "429", response: { body } })
      assert.equal(result.category, "authentication")
      assert.equal(result.ruleId, "alibaba.auth")
      assert.equal(result.provider, "alibaba")
    })
  }

  for (const marker of ["invalid api-key provided", "incorrect api key provided"]) {
    it(`Alibaba auth text "${marker}" + transient phrase keeps alibaba.auth`, () => {
      const result = classify("alibaba", {
        type: "provider.quota",
        status: 429,
        message: `${marker}; concurrency allocated quota exceeded`,
      })
      assert.equal(result.category, "authentication")
      assert.equal(result.ruleId, "alibaba.auth")
      assert.equal(result.provider, "alibaba")
    })
  }

  for (const type of ["provider.budget-limit", "provider.model-budget-limit", "provider.free-limit", "provider.chatgpt-limit"]) {
    for (const phrase of transientPhrases) {
      it(`native ${type} + "${phrase}" is billing`, () => {
        const result = classify("alibaba", { type, status: 429, message: phrase })
        assert.equal(result.category, "billing")
        assert.equal(result.ruleId, "generic.billing")
      })
    }
  }

  const permanentSignals: ReadonlyArray<{ readonly label: string; readonly error: HostError }> = [
    { label: "402", error: { type: "provider.quota", status: 402, message: "" } },
    { label: "provider.auth", error: { type: "provider.auth", message: "" } },
    { label: "401", error: { type: "provider.quota", status: 401, message: "" } },
    { label: "403", error: { type: "provider.quota", status: 403, message: "" } },
  ]
  for (const { label, error } of permanentSignals) {
    for (const phrase of transientPhrases) {
      it(`${label} + "${phrase}" stays permanent`, () => {
        const result = classify("alibaba", { ...error, message: phrase })
        assert.equal(result.category, label === "402" ? "billing" : "authentication")
      })
    }
  }

  it("aliases get billing-text precedence (case-insensitive)", () => {
    const cfg = resolveConfig({ providers: { alibaba: { aliases: ["dashscope", "Alibaba-Coding"] } } })
    for (const provider of ["dashscope", "DASHSCOPE", "alibaba-coding", "ALIBABA"]) {
      const result = classify(
        provider,
        { type: "provider.quota", status: 429, message: "insufficient balance; usage allocated quota exceeded" },
        cfg,
      )
      assert.equal(result.category, "billing", provider)
    }
  })

  it("disabled Alibaba classifier still stops on billing text via generic rules", () => {
    const cfg = resolveConfig({ providers: { alibaba: { enabled: false } } })
    const result = classify(
      "alibaba",
      { type: "provider.quota", status: 429, message: "run out of credits; concurrency allocated quota exceeded" },
      cfg,
    )
    assert.equal(result.category, "billing")
    assert.equal(result.ruleId, "generic.billing")
  })

  it("non-Alibaba providers keep generic billing-text handling (isolation)", () => {
    const result = classify("anthropic", {
      type: "provider.quota",
      status: 429,
      message: "insufficient balance; hour allocated quota exceeded",
    })
    assert.equal(result.category, "billing")
    assert.equal(result.ruleId, "generic.billing")
    assert.equal(result.provider, undefined)
  })

  it("no fuzzy expansion: billing-flavored text that is not a marker stays transient", () => {
    const result = classify("alibaba", {
      type: "provider.quota",
      status: 429,
      message: "check your plan and billing details; usage allocated quota exceeded",
    })
    assert.equal(result.category, "quota_temporary")
    assert.equal(result.ruleId, "alibaba.quota_temporary")
  })

  it("ambiguous quota fallback is preserved without permanent signals", () => {
    const body = JSON.stringify({
      error: {
        message: "Allocated quota exceeded; check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    })
    const result = classify("alibaba", { type: "provider.quota", status: 429, message: "429", response: { body } })
    assert.equal(result.category, "quota_unknown")
    assert.equal(result.ruleId, "alibaba.quota_unknown")
  })

  it("Alibaba billing attribution wins when both Alibaba and generic markers match", () => {
    const result = classify("alibaba", {
      type: "provider.quota",
      status: 429,
      message: "free allocated quota exceeded; insufficient balance",
    })
    assert.equal(result.category, "billing")
    assert.equal(result.ruleId, "alibaba.billing")
    assert.equal(result.provider, "alibaba")
  })
})

describe("R27-02: concurrency_limit category with stable rule identity", () => {
  it("the rule label stays alibaba.quota_concurrency while the category is concurrency_limit", () => {
    const result = classify("alibaba", { type: "provider.quota", message: "concurrency allocated quota exceeded", status: 429 })
    assert.equal(result.category, "concurrency_limit")
    assert.equal(result.ruleId, "alibaba.quota_concurrency")
    assert.equal(result.provider, "alibaba")
  })

  it("non-Alibaba providers never match the concurrency phrase", () => {
    for (const provider of ["anthropic", "openai", "google", "alibaba-ish"]) {
      const result = classify(provider, { type: "provider.quota", message: "concurrency allocated quota exceeded", status: 429 })
      assert.equal(result.category, "rate_limit")
      assert.equal(result.ruleId, "generic.rate_limit")
      assert.equal(result.provider, undefined)
    }
  })

  it("disabled Alibaba classifier falls through to generic rate_limit", () => {
    const cfg = resolveConfig({ providers: { alibaba: { enabled: false } } })
    const result = classify("alibaba", { type: "provider.quota", message: "concurrency allocated quota exceeded", status: 429 }, cfg)
    assert.equal(result.category, "rate_limit")
    assert.equal(result.ruleId, "generic.rate_limit")
    assert.equal(result.provider, undefined)
  })
})