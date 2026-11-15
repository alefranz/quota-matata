/**
 * Pure quota decision policy.
 *
 * No clocks, sleeps, counters or I/O: `now` and all cumulative state arrive
 * as inputs. The engine never mutates the native decision and never clamps a
 * required wait into a shorter retry — when a bound would be violated it
 * stops instead.
 */
import { matchProvider, MAX_DELAY_MS } from "./config.js"
import type {
  DecisionMetadata,
  PolicyInput,
  QuotaCategory,
  QuotaDecision,
  ResolvedCategoryPolicy,
  ResolvedConfig,
} from "./types.js"

/** Fixed UTC+8 offset; Alibaba weekly resets are defined in this zone, no DST. */
export const UTC8_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/**
 * Largest absolute epoch-ms value a JavaScript Date can represent
 * (±100,000,000 days). Timestamps beyond this are finite numbers but cannot
 * be formatted or used for calendar math; they are rejected before any
 * Date arithmetic or toISOString() call (R4-04).
 */
const MAX_DATE_MS = 8.64e15

/**
 * Next Monday 00:00:00.000 UTC+8 strictly after `now` (epoch ms).
 * Pure UTC arithmetic: independent of the host timezone. When `now` is
 * exactly the reset instant, the following week's reset is returned so a
 * persisting error never produces a zero-wait retry at the boundary.
 * Throws TypeError when `now` is not a finite in-Date-range epoch-ms number.
 * The result can exceed the Date range near the upper boundary; callers that
 * format it must check (decideQuota stops safely in that case).
 */
export function nextWeeklyResetUtc8Ms(now: number): number {
  if (typeof now !== "number" || !Number.isFinite(now) || Math.abs(now) > MAX_DATE_MS) {
    throw new TypeError("nextWeeklyResetUtc8Ms: now must be a finite epoch-ms number within the supported Date range")
  }
  const shifted = now + UTC8_OFFSET_MS
  const dayIndex = Math.floor(shifted / DAY_MS)
  const dayStart = dayIndex * DAY_MS
  // Weekday from epoch-day arithmetic (1970-01-01 was Thursday = 4),
  // equivalent to getUTCDay on the shifted instant but total even when
  // `shifted` itself falls outside the representable Date range (R4-04).
  const dayOfWeek = ((dayIndex % 7) + 11) % 7
  const daysUntilMonday = (1 - dayOfWeek + 7) % 7
  let reset = dayStart + daysUntilMonday * DAY_MS - UTC8_OFFSET_MS
  if (reset <= now) reset += WEEK_MS
  return reset
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * A reliable reset instant: finite, positive, and inside the representable
 * Date range so formatting and duration math stay safe (R4-04). Out-of-range
 * values like 1e20 or Number.MAX_VALUE are invalid metadata, not crashes.
 */
function validReset(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS ? value : undefined
}

interface EffectivePolicy {
  readonly policy: ResolvedCategoryPolicy
  /** Dotted policy path used in decision output. */
  readonly path: string
}

function effectivePolicy(config: ResolvedConfig, provider: string, category: QuotaCategory): EffectivePolicy {
  const matched = matchProvider(config, provider)
  if (matched !== undefined) {
    return {
      policy: matched.provider.categories[category],
      path: `providers.${matched.canonical}.categories.${category}`,
    }
  }
  return { policy: config.categories[category], path: `categories.${category}` }
}

function decision(
  action: QuotaDecision["action"],
  category: QuotaCategory,
  path: string,
  reason: string,
  delayMs?: number,
): QuotaDecision {
  const base = { category, policy: path, reason }
  if (action === "retry") {
    if (delayMs === undefined) throw new TypeError("retry decision requires a delay")
    return { action, delayMs, ...base }
  }
  return action === "stop" ? { action, ...base } : { action, ...base }
}

/**
 * Decide what to do with a classified error. See specs/core.md for the full
 * decision table. Throws TypeError only for invalid required inputs (now,
 * attempt, decision, config); optional metadata is tolerated and ignored
 * when invalid. `now` must be a finite epoch-ms number inside the Date range
 * (±8.64e15 ms); out-of-range timestamps never reach Date formatting.
 */
export function decideQuota(input: PolicyInput): QuotaDecision {
  const { category, provider, attempt, now, config } = input
  if (typeof now !== "number" || !Number.isFinite(now) || Math.abs(now) > MAX_DATE_MS) {
    throw new TypeError("decideQuota: now must be a finite epoch-ms number within the supported Date range")
  }
  if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt < 0) {
    throw new TypeError("decideQuota: attempt must be a finite non-negative number")
  }
  if (typeof input.decision?.retry !== "boolean") {
    throw new TypeError("decideQuota: decision.retry must be a boolean")
  }
  if (config === undefined || config.categories === undefined) {
    throw new TypeError("decideQuota: config must be a resolved configuration")
  }

  const { policy, path } = effectivePolicy(config, provider, category)
  const metadata: DecisionMetadata = input.metadata ?? {}

  if (!config.enabled) {
    return decision("no_override", category, "engine.disabled", "quota-matata is disabled")
  }
  if (!policy.enabled) {
    return decision("no_override", category, path, "category policy is disabled")
  }
  if (policy.action === "no_override") {
    return decision("no_override", category, path, `category "${category}" keeps the native decision`)
  }
  if (policy.action === "stop") {
    if (category === "quota_monthly") {
      return decision(
        "stop",
        category,
        path,
        "monthly quota resets on the subscription day, not the calendar month; untilReset is not enabled",
      )
    }
    return decision("stop", category, path, `category "${category}" is configured to stop`)
  }

  // action === "retry"
  if (policy.maxAttempts !== undefined && attempt >= policy.maxAttempts) {
    return decision("stop", category, path, `attempt ${attempt} reached maxAttempts ${policy.maxAttempts}`)
  }

  let baseDelay: number
  let detail: string
  if (category === "quota_weekly") {
    const resetAt = nextWeeklyResetUtc8Ms(now)
    // Near the upper Date-range edge the next reset can fall outside the
    // representable range; stop safely instead of formatting an invalid Date.
    if (!Number.isFinite(resetAt) || resetAt > MAX_DATE_MS) {
      return decision("stop", category, path, "weekly reset instant is outside the supported timestamp range")
    }
    baseDelay = resetAt - now + policy.marginMs
    detail = `weekly quota resets ${new Date(resetAt).toISOString()} (Monday 00:00 UTC+8), margin ${policy.marginMs}ms`
  } else if (category === "quota_monthly") {
    if (!policy.untilReset) {
      return decision(
        "stop",
        category,
        path,
        "monthly quota resets on the subscription day, not the calendar month; untilReset is not enabled",
      )
    }
    const resetAt = validReset(metadata.resetAtMs)
    if (resetAt === undefined) {
      return decision("stop", category, path, "monthly untilReset requires a reliable metadata.resetAtMs; none supplied")
    }
    baseDelay = Math.max(0, resetAt - now)
    detail = `monthly quota resets at supplied instant ${new Date(resetAt).toISOString()}`
  } else {
    baseDelay = policy.delayMs
    detail = `configured delay ${policy.delayMs}ms`
  }

  // A reliable supplied future reset floors ANY emitted retry (R4-03), not
  // just monthly: never retry before the quota is known to reset. The
  // category's configured margin applies consistently (weekly marginMs; 0
  // for every other category). Applied before the bounds checks below so an
  // over-long wait stops instead of being clamped below the reset.
  const suppliedReset = validReset(metadata.resetAtMs)
  let resetFloor = 0
  let resetInstant: number | undefined
  if (suppliedReset !== undefined && suppliedReset > now) {
    resetFloor = suppliedReset - now + policy.marginMs
    resetInstant = suppliedReset
  }

  const cooldowns = [finiteNonNegative(metadata.retryAfterMs)].filter((value): value is number => value !== undefined)
  const cooldown = cooldowns.length > 0 ? Math.max(...cooldowns) : undefined
  let delay = Math.ceil(Math.max(baseDelay, resetFloor, cooldown ?? 0))
  const cooldownNote =
    cooldown !== undefined && cooldown > Math.max(baseDelay, resetFloor) ? `, honoring provider cooldown ${cooldown}ms` : ""
  const resetNote =
    resetInstant !== undefined && resetFloor > Math.max(baseDelay, cooldown ?? 0)
      ? `, honoring supplied reset ${new Date(resetInstant).toISOString()}`
      : ""

  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MS) {
    return decision("stop", category, path, `computed wait ${delay}ms is not a finite safe duration`)
  }
  const elapsed = finiteNonNegative(metadata.elapsedMs)
  if (config.maxElapsedMs !== undefined && elapsed !== undefined && elapsed + delay > config.maxElapsedMs) {
    return decision(
      "stop",
      category,
      path,
      `elapsed ${elapsed}ms plus wait ${delay}ms exceeds maxElapsedMs ${config.maxElapsedMs}`,
    )
  }
  if (delay > config.maxWaitMs) {
    return decision("stop", category, path, `required wait ${delay}ms exceeds maxWaitMs ${config.maxWaitMs}; stopping instead of clamping`)
  }
  return decision("retry", category, path, `${detail}${cooldownNote}${resetNote}; retry in ${delay}ms`, delay)
}