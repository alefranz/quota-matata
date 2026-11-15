/**
 * Quota Matata — No worries, just retries.
 *
 * Pure, configurable quota decision core for OpenCode v2, plus a reusable
 * privacy-safe bounded JSONL diagnostics logger. This module is the SDK-free
 * core surface (package subpath `quota-matata/core`); the package root also
 * re-exports everything here and adds the OpenCode plugin default entry.
 * See README.md, specs/core.md, specs/logging.md and specs/integration.md.
 */
export {
  ConfigError,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_WEEKLY_MARGIN_MS,
  MAX_DELAY_MS,
  matchProvider,
  resolveConfig,
} from "./config.js"
export { ALIBABA_PROVIDER_ID, classifyError, normalizeError, parseBody } from "./classify.js"
export {
  createLogger,
  defaultLogDirectory,
  MAX_EVENT_BYTES,
  MAX_QUEUE_EVENTS,
  MAX_STRING_CHARS,
  PLUGIN_VERSION,
} from "./logging.js"
export type {
  DiagnosticEventInput,
  DiagnosticEventType,
  DiagnosticLogger,
  LoggerContext,
  LoggerState,
  LogLevel,
} from "./logging.js"
export { decideQuota, nextWeeklyResetUtc8Ms, UTC8_OFFSET_MS } from "./policy.js"
export { QUOTA_CATEGORIES } from "./types.js"
export type {
  CategoryPolicyConfig,
  Classification,
  DecisionMetadata,
  EvaluateInput,
  HostError,
  LoggingConfig,
  NativeDecision,
  NormalizedError,
  PolicyAction,
  PolicyInput,
  ProviderConfig,
  QuotaCategory,
  QuotaDecision,
  QuotaEvaluation,
  QuotaMatataConfig,
  ResolvedCategoryPolicy,
  ResolvedConfig,
  ResolvedLogging,
  ResolvedProvider,
} from "./types.js"

import { classifyError, normalizeError } from "./classify.js"
import { decideQuota } from "./policy.js"
import type { DecisionMetadata, EvaluateInput, QuotaEvaluation, ResolvedConfig } from "./types.js"

/**
 * Normalize, classify and decide in one pure call. This is the surface the
 * hook adapter uses: pass the host's retry-hook arguments plus a
 * caller-supplied `now`, and apply the returned decision to the hook's
 * mutable `decision` object.
 *
 * A valid `error.retryAfterMs` is merged into metadata as a minimum cooldown
 * (the larger of error and metadata values wins).
 *
 * The result carries the FULL classifier provenance alongside the decision
 * (`classification`: category, stable ruleId, canonical matched provider when
 * provider-specific) so diagnostics can report the actual matched rule
 * without re-classifying or reconstructing a lossy subset (R27-01).
 */
export function evaluateQuota(input: EvaluateInput, config: ResolvedConfig): QuotaEvaluation {
  const normalized = normalizeError(input.provider, input.model, input.error)
  const classification = classifyError(normalized, config)
  const errorCooldown = normalized.retryAfterMs
  const metaCooldown = input.metadata?.retryAfterMs
  const cooldowns = [errorCooldown, metaCooldown].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  )
  const metadata: DecisionMetadata = {
    ...input.metadata,
    ...(cooldowns.length > 0 ? { retryAfterMs: Math.max(...cooldowns) } : {}),
  }
  const decision = decideQuota({
    category: classification.category,
    provider: input.provider,
    model: input.model,
    attempt: input.attempt,
    decision: input.decision,
    now: input.now,
    config,
    metadata,
  })
  // Preserve the classifier's full provenance (ruleId + canonical provider)
  // rather than returning only the policy decision's category (R27-01).
  return { ...decision, classification }
}