/**
 * Quota Matata core types.
 *
 * The core is pure: no I/O, no clocks of its own, no counters, no sleeps.
 * Every function takes explicit inputs (including `now`) and returns data.
 * The OpenCode hook adapter and the JSONL logger are later slices and are
 * intentionally absent here.
 */

/** Error categories produced by the classifier. */
export const QUOTA_CATEGORIES = [
  "quota_five_hour",
  "quota_weekly",
  "quota_monthly",
  "quota_temporary",
  "concurrency_limit",
  "rate_limit",
  "quota_unknown",
  "provider_unavailable",
  "authentication",
  "billing",
  "other",
] as const

export type QuotaCategory = (typeof QUOTA_CATEGORIES)[number]

/** What the engine tells the adapter to do with the host's native decision. */
export type PolicyAction = "no_override" | "retry" | "stop"

/**
 * Error shape handed to the OpenCode v2.3.0 `session.retry` hook
 * (`SessionError.Error` in @opencode/plugin). `status` is 100..599 when
 * present; `retryAfterMs` is a non-negative integer counted from when the
 * failure was recorded. There is no `code` field on the wire shape: provider
 * codes must be extracted from `response.body` safely.
 */
export interface HostError {
  readonly type: string
  readonly message: string
  readonly status?: number
  readonly response?: { readonly body: string }
  readonly retryAfterMs?: number
}

/** Normalized classifier input. Optional fields are dropped when invalid. */
export interface NormalizedError {
  readonly provider: string
  readonly model: string
  readonly type?: string
  readonly status?: number
  readonly code?: string
  readonly message: string
  readonly body?: string
  readonly retryAfterMs?: number
}

/**
 * The host's native retry decision as seen by the plugin hook:
 * `{ retry: false }` or `{ retry: true, delay: number }` (delay in ms).
 * The core never mutates it.
 */
export interface NativeDecision {
  readonly retry: boolean
  readonly delay?: number
}

/**
 * Explicit, caller-supplied metadata. The core keeps no global counters:
 * cumulative elapsed time must be passed in on every call if a bound is
 * configured.
 */
export interface DecisionMetadata {
  /** Provider-requested cooldown in ms. Invalid values are ignored. */
  readonly retryAfterMs?: number
  /**
   * Reliable quota reset instant (epoch ms, within the JavaScript Date
   * range). A valid future value floors ANY emitted retry delay (plus the
   * category's configured margin): the engine never retries before a known
   * reset. The monthly category additionally requires it when `untilReset`
   * is explicitly enabled. Past or invalid values are ignored for flooring;
   * the core never guesses a reset from the calendar.
   */
  readonly resetAtMs?: number
  /** Cumulative ms already spent retrying this request, supplied by the caller. */
  readonly elapsedMs?: number
}

/** Per-category policy tuning. Allowed fields depend on the category. */
export interface CategoryPolicyConfig {
  /** Default true. When false the engine never overrides this category. */
  readonly enabled?: boolean
  /** Default depends on the category; see specs/core.md. */
  readonly action?: PolicyAction
  /** Fixed retry delay in ms. Only for delay-based categories with action "retry". */
  readonly delayMs?: number
  /** Weekly only: extra ms added after the Monday 00:00 UTC+8 reset. Default 60000. */
  readonly marginMs?: number
  /** Monthly only: opt in to waiting for a reliable supplied reset. Default false. */
  readonly untilReset?: boolean
  /** Stop once the host attempt counter reaches this value. Optional. */
  readonly maxAttempts?: number
}

/** Provider-scoped classifier toggle, aliases and category overrides. */
export interface ProviderConfig {
  /** Default true. When false, provider-specific classification rules are skipped. */
  readonly enabled?: boolean
  /** Alternative provider IDs that should use this provider's rules/overrides. */
  readonly aliases?: readonly string[]
  /** Field-level overrides merged over the global category policies. */
  readonly categories?: Partial<Record<QuotaCategory, CategoryPolicyConfig>>
}

/**
 * Logging configuration shape. Validated now, consumed by the later logging
 * slice; the core itself never logs or touches the filesystem.
 */
export interface LoggingConfig {
  readonly enabled?: boolean
  readonly level?: "debug" | "info" | "warn" | "error"
  readonly directory?: string
  /** Default false: error bodies/messages may contain sensitive data. */
  readonly captureErrorDetails?: boolean
  readonly rotation?: {
    readonly maxSizeBytes?: number
    readonly maxFiles?: number
  }
}

/** User-facing configuration. Everything is optional; defaults are safe. */
export interface QuotaMatataConfig {
  /** Master switch. Default true. When false every decision is no_override. */
  readonly enabled?: boolean
  /**
   * Maximum single wait the engine may request, in ms. Default 8 days
   * (691200000), which covers a full weekly reset plus margin and stays below
   * 2^31-1 ms for host timer compatibility. Waits above it stop, never clamp.
   */
  readonly maxWaitMs?: number
  /** Optional cumulative retry budget in ms; enforced only with metadata.elapsedMs. */
  readonly maxElapsedMs?: number
  readonly categories?: Partial<Record<QuotaCategory, CategoryPolicyConfig>>
  readonly providers?: Readonly<Record<string, ProviderConfig>>
  readonly logging?: LoggingConfig
}

/** Fully resolved category policy (defaults applied). */
export interface ResolvedCategoryPolicy {
  readonly enabled: boolean
  readonly action: PolicyAction
  readonly delayMs: number
  readonly marginMs: number
  readonly untilReset: boolean
  readonly maxAttempts?: number
}

/** Fully resolved provider entry. */
export interface ResolvedProvider {
  readonly enabled: boolean
  readonly aliases: readonly string[]
  readonly categories: Readonly<Record<QuotaCategory, ResolvedCategoryPolicy>>
}

/** Fully resolved logging settings. */
export interface ResolvedLogging {
  readonly enabled: boolean
  readonly level: "debug" | "info" | "warn" | "error"
  readonly directory?: string
  readonly captureErrorDetails: boolean
  readonly rotation: { readonly maxSizeBytes: number; readonly maxFiles: number }
}

/** Validated configuration with all defaults applied. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly maxWaitMs: number
  readonly maxElapsedMs?: number
  readonly categories: Readonly<Record<QuotaCategory, ResolvedCategoryPolicy>>
  /** Keys are canonical provider IDs, lowercased. */
  readonly providers: Readonly<Record<string, ResolvedProvider>>
  readonly logging: ResolvedLogging
}

/** Result of classification: first matching rule wins. */
export interface Classification {
  readonly category: QuotaCategory
  /** Deterministic rule identifier, e.g. "alibaba.quota_weekly" or "generic.rate_limit". */
  readonly ruleId: string
  /** Canonical provider whose rules matched, when provider-specific. */
  readonly provider?: string
}

/** Engine output. `policy` identifies the applied policy path; `reason` is human-readable. */
export type QuotaDecision =
  | {
      readonly action: "no_override"
      readonly category: QuotaCategory
      readonly policy: string
      readonly reason: string
    }
  | {
      readonly action: "retry"
      readonly delayMs: number
      readonly category: QuotaCategory
      readonly policy: string
      readonly reason: string
    }
  | {
      readonly action: "stop"
      readonly category: QuotaCategory
      readonly policy: string
      readonly reason: string
    }

/**
 * Output of `evaluateQuota`: the policy decision plus the FULL classifier
 * provenance. `classification` is the classifier's own result, preserved
 * unchanged (category, stable `ruleId`, canonical `provider` when a
 * provider-specific rule matched) — never a reconstructed subset (R27-01).
 * `classification.category` always equals the decision's `category`; the
 * adapter logs `classification.ruleId` as `rule` and `classification.provider`
 * as `matched` (omitted for generic rules — no fabricated provider identity).
 * `decideQuota`'s own output (`QuotaDecision`) is unchanged.
 */
export type QuotaEvaluation = QuotaDecision & {
  readonly classification: Classification
}

/** Pure policy input. `now` is epoch ms supplied by the caller. */
export interface PolicyInput {
  readonly category: QuotaCategory
  readonly provider: string
  readonly model: string
  /** Host attempt counter (the next attempt number). */
  readonly attempt: number
  /** The host's native decision, read-only context. */
  readonly decision: NativeDecision
  readonly now: number
  readonly config: ResolvedConfig
  readonly metadata?: DecisionMetadata
}

/** Convenience input for normalize + classify + decide in one call. */
export interface EvaluateInput {
  readonly provider: string
  readonly model: string
  readonly error: HostError
  readonly attempt: number
  readonly decision: NativeDecision
  readonly now: number
  readonly metadata?: DecisionMetadata
}