/**
 * Normalization and deterministic first-match classification.
 *
 * Provider-specific rules run first (only for their provider ID or configured
 * aliases), then generic rules. The first matching rule wins; rule order is
 * fixed and documented in specs/core.md. One exception outranks transient
 * provider phrases: definitive permanent evidence (native auth/billing types,
 * HTTP 401/402/403, and the recognized permanent billing message markers) is
 * checked before any quota/rate phrase can match, so a quota phrase embedded
 * in an auth or billing failure never causes a retry.
 * Nothing here invents wire layouts: unknown payloads fall through to
 * conservative categories.
 */
import { matchProvider } from "./config.js"
import type { Classification, HostError, NormalizedError, QuotaCategory, ResolvedConfig } from "./types.js"

/** Canonical OpenCode provider ID for Alibaba (packages/ai/src/providers/alibaba.ts, v2.3.0). */
export const ALIBABA_PROVIDER_ID = "alibaba"

interface BodyInfo {
  readonly code?: string
  readonly messages: readonly string[]
}

/**
 * Safely extract a provider code and nested messages from a response body.
 * Handles DashScope-style `{code, message}` and OpenAI-style
 * `{error: {code, type, message}}` envelopes. Malformed JSON is tolerated.
 */
export function parseBody(body: string | undefined): BodyInfo {
  if (body === undefined || body === "") return { messages: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { messages: [] }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { messages: [] }
  const record = parsed as Record<string, unknown>
  const errorField = record.error
  const errorRecord =
    typeof errorField === "object" && errorField !== null && !Array.isArray(errorField)
      ? (errorField as Record<string, unknown>)
      : undefined
  const candidates = [record.code, errorRecord?.code, errorRecord?.type]
  const code = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate !== "")
  const messages: string[] = []
  for (const candidate of [record.message, errorRecord?.message]) {
    if (typeof candidate === "string" && candidate !== "") messages.push(candidate)
  }
  return code === undefined ? { messages } : { code, messages }
}

function validStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function validRetryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Normalize a host-shaped error plus model identity. Invalid optional fields
 * are dropped, never repaired; required fields degrade to empty strings so
 * classification stays total.
 */
export function normalizeError(provider: string, model: string, error: HostError): NormalizedError {
  const message = typeof error?.message === "string" ? error.message : ""
  const type = typeof error?.type === "string" && error.type !== "" ? error.type : undefined
  const status = validStatus(error?.status)
  const body = typeof error?.response?.body === "string" && error.response.body !== "" ? error.response.body : undefined
  const retryAfterMs = validRetryAfter(error?.retryAfterMs)
  const code = parseBody(body).code
  const base = { provider, model, message }
  return {
    ...base,
    ...(type === undefined ? {} : { type }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(body === undefined ? {} : { body }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

interface Rule {
  readonly id: string
  readonly category: QuotaCategory
  readonly match: (error: NormalizedError, text: string, code: string) => boolean
}

const includesAny = (text: string, phrases: readonly string[]): boolean => phrases.some((phrase) => text.includes(phrase))

/**
 * Alibaba Coding Plan / Model Studio rules, in first-match order.
 * Sources: official Coding Plan FAQ and Model Studio error-code page
 * (fetched 2026-11-14), plus provider ID from upstream v2.3.0 source.
 *
 * The five plan phrases are matched case-insensitively anywhere in the
 * message or body (including structured JSON bodies). Bare "allocated quota
 * exceeded" / insufficient_quota is deliberately NOT mapped to a plan
 * category: upstream documents it as ambiguous (TPS/TPM throttling or token
 * plan exhaustion), so it lands in quota_unknown and keeps the native decision.
 */
const ALIBABA_RULES: readonly Rule[] = [
  {
    id: "alibaba.billing",
    category: "billing",
    match: (_error, text, code) =>
      includesAny(code, [
        "arrearage",
        "isv.out_of_service",
        "prepaidbilloverdue",
        "postpaidbilloverdue",
        "budgetlimitexceeded",
        "commoditynotpurchased",
        "allocationquota.freetieronly",
      ]) ||
      includesAny(text, [
        "account is in good standing",
        "prepaid bill is overdue",
        "postpaid bill is overdue",
        "free allocated quota exceeded",
      ]),
  },
  {
    id: "alibaba.auth",
    category: "authentication",
    match: (_error, text, code) =>
      includesAny(code, ["invalidapikey", "invalid_api_key", "accessdenied", "access_denied"]) ||
      includesAny(text, ["invalid api-key provided", "incorrect api key provided"]),
  },
  {
    id: "alibaba.quota_five_hour",
    category: "quota_five_hour",
    match: (_error, text) => text.includes("hour allocated quota exceeded"),
  },
  {
    id: "alibaba.quota_weekly",
    category: "quota_weekly",
    match: (_error, text) => text.includes("week allocated quota exceeded"),
  },
  {
    id: "alibaba.quota_monthly",
    category: "quota_monthly",
    match: (_error, text) => text.includes("month allocated quota exceeded"),
  },
  {
    id: "alibaba.quota_temporary",
    category: "quota_temporary",
    match: (_error, text) => text.includes("usage allocated quota exceeded"),
  },
  {
    // The rule label is the stable provider-specific diagnostic identity and
    // is independent of the public category name (R27-02): the category is
    // `concurrency_limit`, while the ruleId stays `alibaba.quota_concurrency`.
    id: "alibaba.quota_concurrency",
    category: "concurrency_limit",
    match: (_error, text) => text.includes("concurrency allocated quota exceeded"),
  },
  {
    id: "alibaba.quota_unknown",
    category: "quota_unknown",
    match: (_error, text, code) =>
      includesAny(code, ["throttling.allocationquota", "insufficient_quota"]) ||
      includesAny(text, ["allocated quota exceeded", "token-plan quota has been exhausted"]),
  },
  {
    id: "alibaba.rate_limit",
    category: "rate_limit",
    match: (_error, text, code) =>
      includesAny(code, [
        "throttling.ratequota",
        "throttling.burstrate",
        "throttling.concurrency",
        "throttling.serviceoverloaded",
        "throttling.resourceexhausted",
        "limitrequests",
        "limit_requests",
      ]) ||
      includesAny(text, ["requests rate limit exceeded", "too many concurrent requests", "too many requests"]),
  },
]

/**
 * Generic rules for every provider, in first-match order. Native host error
 * types come from OpenCode v2.3.0 to-session-error.ts. Status fallbacks are
 * intentionally narrow: 429 alone is a rate limit, never a plan quota.
 */
const GENERIC_RULES: readonly Rule[] = [
  {
    id: "generic.billing",
    category: "billing",
    match: (error, text) =>
      error.status === 402 ||
      includesAny(error.type ?? "", [
        "provider.budget-limit",
        "provider.model-budget-limit",
        "provider.free-limit",
        "provider.chatgpt-limit",
      ]) ||
      includesAny(text, [
        "insufficient balance",
        "run out of credits",
        "billing error",
        "account is in good standing",
        "bill is overdue",
      ]),
  },
  {
    id: "generic.auth",
    category: "authentication",
    match: (error) => error.type === "provider.auth" || error.status === 401 || error.status === 403,
  },
  {
    id: "generic.rate_limit",
    category: "rate_limit",
    match: (error) => error.type === "provider.rate-limit" || error.status === 429,
  },
  {
    id: "generic.quota_unknown",
    category: "quota_unknown",
    match: (error) => error.type === "provider.quota" || error.type === "provider.go-limit",
  },
  {
    id: "generic.provider_unavailable",
    category: "provider_unavailable",
    match: (error) =>
      error.type === "provider.internal" ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504,
  },
  {
    id: "generic.other",
    category: "other",
    match: () => true,
  },
]

/** Searchable text: host message + raw body + nested body messages, lowercased. */
function searchText(error: NormalizedError): string {
  const parts = [error.message, error.body ?? "", ...parseBody(error.body).messages]
  return parts.join("\n").toLowerCase()
}

const isPermanentRule = (rule: Rule): boolean => rule.category === "billing" || rule.category === "authentication"
const ALIBABA_PERMANENT_RULES: readonly Rule[] = ALIBABA_RULES.filter(isPermanentRule)
const ALIBABA_TRANSIENT_RULES: readonly Rule[] = ALIBABA_RULES.filter((rule) => !isPermanentRule(rule))
/**
 * Definitive permanent evidence (R4-01): the complete existing generic
 * permanent predicates — native billing/auth types, HTTP 401/402/403, and the
 * recognized permanent billing message markers, searched across the host
 * message and nested body messages. These signals are certain regardless of
 * any quota/rate phrase present, so they are checked before transient
 * provider rules can match. Billing outranks auth, mirroring generic order.
 * Only the exact existing generic rules are reused; no fuzzy predicates are
 * added or widened.
 */
const GENERIC_PERMANENT_RULES: readonly Rule[] = GENERIC_RULES.filter(isPermanentRule)

/**
 * Classify a normalized error. Provider-specific rules apply only when the
 * provider matches a configured canonical ID or alias AND that provider's
 * classifier is enabled. Order for Alibaba: provider permanent rules →
 * all definitive permanent signals (generic billing/auth predicates: native
 * types, status, and recognized billing text) → provider transient rules →
 * generic rules. Generic rules always run afterwards for other providers.
 */
export function classifyError(error: NormalizedError, config: ResolvedConfig): Classification {
  const text = searchText(error)
  const code = (error.code ?? "").toLowerCase()
  const matched = matchProvider(config, error.provider)
  if (matched !== undefined && matched.provider.enabled && matched.canonical === ALIBABA_PROVIDER_ID) {
    for (const rule of ALIBABA_PERMANENT_RULES) {
      if (rule.match(error, text, code)) {
        return { category: rule.category, ruleId: rule.id, provider: matched.canonical }
      }
    }
    // Every definitive permanent signal outranks any transient Alibaba phrase,
    // including recognized billing text in the message or nested body messages.
    for (const rule of GENERIC_PERMANENT_RULES) {
      if (rule.match(error, text, code)) {
        return { category: rule.category, ruleId: rule.id }
      }
    }
    for (const rule of ALIBABA_TRANSIENT_RULES) {
      if (rule.match(error, text, code)) {
        return { category: rule.category, ruleId: rule.id, provider: matched.canonical }
      }
    }
  }
  for (const rule of GENERIC_RULES) {
    if (rule.match(error, text, code)) {
      return { category: rule.category, ruleId: rule.id }
    }
  }
  // Unreachable: generic.other always matches.
  return { category: "other", ruleId: "generic.other" }
}