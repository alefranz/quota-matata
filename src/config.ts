/**
 * Configuration defaults and strict validation.
 *
 * Validation collects every problem and throws a single ConfigError listing
 * them with dotted paths. Unknown keys are rejected so typos fail loudly.
 */
import type {
  CategoryPolicyConfig,
  LoggingConfig,
  PolicyAction,
  ProviderConfig,
  QuotaCategory,
  QuotaMatataConfig,
  ResolvedCategoryPolicy,
  ResolvedConfig,
  ResolvedLogging,
  ResolvedProvider,
} from "./types.js"
import { QUOTA_CATEGORIES } from "./types.js"

/**
 * Hard ceiling for any single delay the engine may emit, and for maxWaitMs.
 * 2^31-1 ms (~24.8 days) keeps waits inside signed 32-bit millisecond timers
 * used by common hosts. The weekly default (8 days) fits comfortably.
 */
export const MAX_DELAY_MS = 2_147_483_647

/** Default weekly margin added after the Monday 00:00 UTC+8 reset. */
export const DEFAULT_WEEKLY_MARGIN_MS = 60_000

/** Default max single wait: 8 days, enough for a full weekly reset plus margin. */
export const DEFAULT_MAX_WAIT_MS = 8 * 86_400_000

const MAX_MARGIN_MS = 86_400_000
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
const ACTIONS: readonly PolicyAction[] = ["no_override", "retry", "stop"]

/** Categories that must never be configured to retry (permanent failures). */
const PERMANENT_CATEGORIES: readonly QuotaCategory[] = ["authentication", "billing"]

interface CategoryDefaults {
  readonly action: PolicyAction
  readonly delayMs?: number
  readonly marginMs?: number
  readonly untilReset?: boolean
}

const CATEGORY_DEFAULTS: Readonly<Record<QuotaCategory, CategoryDefaults>> = {
  // Rolling 5-hour window; the exact reset instant is not published, so the
  // default probes after 30 minutes instead of assuming a full 5-hour wait.
  quota_five_hour: { action: "retry", delayMs: 1_800_000 },
  // Known reset: Monday 00:00 UTC+8, plus a small configurable margin.
  quota_weekly: { action: "retry", marginMs: DEFAULT_WEEKLY_MARGIN_MS },
  // Subscription-day reset, not calendar month: stop unless explicitly opted
  // in to until-reset AND a reliable reset instant is supplied at runtime.
  quota_monthly: { action: "stop", untilReset: false },
  // Official guidance: wait one minute.
  quota_temporary: { action: "retry", delayMs: 60_000 },
  // Official guidance: wait a moment; platform adjusts concurrency dynamically.
  concurrency_limit: { action: "retry", delayMs: 5_000 },
  rate_limit: { action: "no_override" },
  quota_unknown: { action: "no_override" },
  provider_unavailable: { action: "no_override" },
  authentication: { action: "stop" },
  billing: { action: "stop" },
  other: { action: "no_override" },
}

/** Thrown for invalid configuration; `issues` lists every problem found. */
export class ConfigError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`invalid quota-matata configuration:\n- ${issues.join("\n- ")}`)
    this.name = "ConfigError"
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
}

class Issues {
  private readonly list: string[] = []

  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`)
  }

  /** Returns the value when it is a boolean, otherwise records an issue. */
  boolean(value: unknown, path: string): boolean | undefined {
    if (value === undefined) return undefined
    if (typeof value !== "boolean") {
      this.add(path, "must be a boolean")
      return undefined
    }
    return value
  }

  integer(value: unknown, path: string, min: number, max: number): number | undefined {
    if (value === undefined) return undefined
    if (!isInteger(value)) {
      this.add(path, "must be a finite integer")
      return undefined
    }
    if (value < min || value > max) {
      this.add(path, `must be between ${min} and ${max}`)
      return undefined
    }
    return value
  }

  finish(): void {
    if (this.list.length > 0) throw new ConfigError(this.list)
  }
}

function checkUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: Issues): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.add(path, `unknown key "${key}"`)
  }
}

const CATEGORY_FIELDS = ["enabled", "action", "delayMs", "marginMs", "untilReset", "maxAttempts"] as const

function resolveCategory(
  raw: unknown,
  category: QuotaCategory,
  path: string,
  issues: Issues,
  base: ResolvedCategoryPolicy,
): ResolvedCategoryPolicy {
  if (raw === undefined) return base
  if (!isRecord(raw)) {
    issues.add(path, "must be an object")
    return base
  }
  checkUnknownKeys(raw, CATEGORY_FIELDS, path, issues)

  // Every field inherits from the base (resolved global) policy unless the
  // raw entry explicitly overrides it (R4-02). Cross-field validation below
  // runs on the effective merged values, not on the raw override alone.
  const enabled = issues.boolean(raw.enabled, `${path}.enabled`) ?? base.enabled
  let action = base.action
  if (raw.action !== undefined) {
    if (typeof raw.action !== "string" || !ACTIONS.includes(raw.action as PolicyAction)) {
      issues.add(`${path}.action`, `must be one of ${ACTIONS.join(", ")}`)
    } else {
      action = raw.action as PolicyAction
    }
  }

  const isPermanent = PERMANENT_CATEGORIES.includes(category)

  let delayMs = base.delayMs
  if (raw.delayMs !== undefined) {
    if (category === "quota_weekly" || category === "quota_monthly") {
      issues.add(`${path}.delayMs`, `not supported for "${category}" (delay is computed from the reset)`)
    } else if (action !== "retry") {
      issues.add(`${path}.delayMs`, 'only allowed with action "retry"')
    } else {
      delayMs = issues.integer(raw.delayMs, `${path}.delayMs`, 0, MAX_DELAY_MS) ?? base.delayMs
    }
  }

  let marginMs = base.marginMs
  if (raw.marginMs !== undefined) {
    if (category !== "quota_weekly") {
      issues.add(`${path}.marginMs`, 'only supported for "quota_weekly"')
    } else {
      marginMs = issues.integer(raw.marginMs, `${path}.marginMs`, 0, MAX_MARGIN_MS) ?? base.marginMs
    }
  }

  let untilReset = base.untilReset
  if (raw.untilReset !== undefined) {
    if (category !== "quota_monthly") {
      issues.add(`${path}.untilReset`, 'only supported for "quota_monthly"')
    } else {
      untilReset = issues.boolean(raw.untilReset, `${path}.untilReset`) ?? base.untilReset
    }
  }

  let maxAttempts = base.maxAttempts
  if (raw.maxAttempts !== undefined) {
    if (isPermanent) {
      issues.add(`${path}.maxAttempts`, `not supported for permanent category "${category}"`)
    } else {
      maxAttempts = issues.integer(raw.maxAttempts, `${path}.maxAttempts`, 1, Number.MAX_SAFE_INTEGER) ?? base.maxAttempts
    }
  }

  if (isPermanent && action === "retry") {
    issues.add(`${path}.action`, `category "${category}" is permanent and must not retry`)
  }
  if (category === "quota_monthly" && action === "retry" && !untilReset) {
    issues.add(`${path}.action`, 'monthly retry requires "untilReset: true" (reset is never calendar-assumed)')
    // Keep the resolved action safe regardless of the collected issues.
    action = "stop"
  }

  return maxAttempts === undefined
    ? { enabled, action, delayMs, marginMs, untilReset }
    : { enabled, action, delayMs, marginMs, untilReset, maxAttempts }
}

function categoryBase(category: QuotaCategory): ResolvedCategoryPolicy {
  const defaults = CATEGORY_DEFAULTS[category]
  return {
    enabled: true,
    action: defaults.action,
    delayMs: defaults.delayMs ?? 0,
    marginMs: defaults.marginMs ?? 0,
    untilReset: defaults.untilReset ?? false,
  }
}

function resolveCategories(
  raw: unknown,
  path: string,
  issues: Issues,
  bases: Readonly<Record<QuotaCategory, ResolvedCategoryPolicy>>,
): Record<QuotaCategory, ResolvedCategoryPolicy> {
  const out = {} as Record<QuotaCategory, ResolvedCategoryPolicy>
  for (const category of QUOTA_CATEGORIES) out[category] = bases[category]
  if (raw === undefined) return out
  if (!isRecord(raw)) {
    issues.add(path, "must be an object")
    return out
  }
  for (const key of Object.keys(raw)) {
    if (!(QUOTA_CATEGORIES as readonly string[]).includes(key)) {
      issues.add(path, `unknown category "${key}"`)
      continue
    }
    const category = key as QuotaCategory
    out[category] = resolveCategory(raw[key], category, `${path}.${category}`, issues, bases[category])
  }
  return out
}

function globalCategoryBases(): Record<QuotaCategory, ResolvedCategoryPolicy> {
  const out = {} as Record<QuotaCategory, ResolvedCategoryPolicy>
  for (const category of QUOTA_CATEGORIES) out[category] = categoryBase(category)
  return out
}

const PROVIDER_FIELDS = ["enabled", "aliases", "categories"] as const

/**
 * Provider keys become dictionary keys on a plain object, so JavaScript
 * reserved property names are rejected outright (R4-05): "__proto__" from a
 * JSON config would otherwise mutate the output prototype instead of adding
 * an entry, and "constructor"/"prototype" shadow built-ins.
 */
const RESERVED_PROVIDER_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"]

function resolveProviders(
  raw: unknown,
  path: string,
  issues: Issues,
  globalCategories: Readonly<Record<QuotaCategory, ResolvedCategoryPolicy>>,
): Record<string, ResolvedProvider> {
  const out: Record<string, ResolvedProvider> = {}
  if (raw !== undefined && !isRecord(raw)) {
    issues.add(path, "must be an object")
    return out
  }
  const entries: Record<string, unknown> = raw === undefined ? {} : raw
  // Alibaba rules ship enabled by default; users may disable or alias them.
  const seen = new Map<string, string>([["alibaba", "alibaba"]])
  const claim = (name: string, owner: string): void => {
    const key = name.toLowerCase()
    const prior = seen.get(key)
    if (prior !== undefined && prior.toLowerCase() !== owner.toLowerCase()) {
      issues.add(path, `provider name or alias "${name}" is claimed by both "${prior}" and "${owner}"`)
    } else {
      seen.set(key, owner)
    }
  }
  // Canonical provider names are lowercased, so two keys that normalize to
  // the same name would silently overwrite each other; reject the duplicate
  // instead (R4-05). Reserved keys are rejected before any claim is made.
  const canonicals = new Set<string>()
  const validKeys: string[] = []
  for (const key of Object.keys(entries)) {
    if (key.trim() === "") {
      issues.add(path, "provider keys must be non-empty strings")
      continue
    }
    const canonical = key.toLowerCase()
    if (RESERVED_PROVIDER_KEYS.includes(canonical)) {
      issues.add(path, `provider key "${key}" is a reserved JavaScript property name`)
      continue
    }
    if (canonicals.has(canonical)) {
      issues.add(path, `provider key "${key}" duplicates canonical provider "${canonical}"`)
      continue
    }
    canonicals.add(canonical)
    validKeys.push(key)
    claim(key, key)
  }
  for (const key of validKeys) {
    const providerPath = `${path}.${key}`
    const entry = entries[key]
    const canonical = key.toLowerCase()
    if (!isRecord(entry)) {
      issues.add(providerPath, "must be an object")
      continue
    }
    checkUnknownKeys(entry, PROVIDER_FIELDS, providerPath, issues)
    const enabled = issues.boolean(entry.enabled, `${providerPath}.enabled`) ?? true
    let aliases: string[] = []
    if (entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases)) {
        issues.add(`${providerPath}.aliases`, "must be an array of non-empty strings")
      } else {
        const local = new Set<string>()
        for (const [index, alias] of (entry.aliases as unknown[]).entries()) {
          const aliasPath = `${providerPath}.aliases[${index}]`
          if (typeof alias !== "string" || alias.trim() === "") {
            issues.add(aliasPath, "must be a non-empty string")
            continue
          }
          const lower = alias.toLowerCase()
          if (lower === canonical) {
            issues.add(aliasPath, "alias duplicates its own provider key")
            continue
          }
          if (local.has(lower)) {
            issues.add(aliasPath, `duplicate alias "${alias}"`)
            continue
          }
          local.add(lower)
          claim(alias, key)
          aliases.push(alias)
        }
      }
    }
    const categories = resolveCategories(entry.categories, `${providerPath}.categories`, issues, globalCategories)
    out[canonical] = { enabled, aliases, categories }
  }
  if (out.alibaba === undefined) {
    out.alibaba = {
      enabled: true,
      aliases: [],
      categories: resolveCategories(undefined, `${path}.alibaba.categories`, issues, globalCategories),
    }
  }
  return out
}

const LOGGING_FIELDS = ["enabled", "level", "directory", "captureErrorDetails", "rotation"] as const
const ROTATION_FIELDS = ["maxSizeBytes", "maxFiles"] as const

function resolveLogging(raw: unknown, path: string, issues: Issues): ResolvedLogging {
  const base: ResolvedLogging = {
    enabled: false,
    level: "info",
    captureErrorDetails: false,
    rotation: { maxSizeBytes: 1_048_576, maxFiles: 5 },
  }
  if (raw === undefined) return base
  if (!isRecord(raw)) {
    issues.add(path, "must be an object")
    return base
  }
  checkUnknownKeys(raw, LOGGING_FIELDS, path, issues)
  const enabled = issues.boolean(raw.enabled, `${path}.enabled`) ?? base.enabled
  let level = base.level
  if (raw.level !== undefined) {
    if (typeof raw.level !== "string" || !(LOG_LEVELS as readonly string[]).includes(raw.level)) {
      issues.add(`${path}.level`, `must be one of ${LOG_LEVELS.join(", ")}`)
    } else {
      level = raw.level as ResolvedLogging["level"]
    }
  }
  let directory: string | undefined
  if (raw.directory !== undefined) {
    if (typeof raw.directory !== "string" || raw.directory.trim() === "") {
      issues.add(`${path}.directory`, "must be a non-empty string")
    } else {
      directory = raw.directory
    }
  }
  const captureErrorDetails = issues.boolean(raw.captureErrorDetails, `${path}.captureErrorDetails`) ?? base.captureErrorDetails
  let rotation = base.rotation
  if (raw.rotation !== undefined) {
    if (!isRecord(raw.rotation)) {
      issues.add(`${path}.rotation`, "must be an object")
    } else {
      checkUnknownKeys(raw.rotation, ROTATION_FIELDS, `${path}.rotation`, issues)
      const maxSizeBytes = issues.integer(raw.rotation.maxSizeBytes, `${path}.rotation.maxSizeBytes`, 1, 104_857_600)
      const maxFiles = issues.integer(raw.rotation.maxFiles, `${path}.rotation.maxFiles`, 1, 1000)
      rotation = {
        maxSizeBytes: maxSizeBytes ?? base.rotation.maxSizeBytes,
        maxFiles: maxFiles ?? base.rotation.maxFiles,
      }
    }
  }
  return directory === undefined
    ? { enabled, level, captureErrorDetails, rotation }
    : { enabled, level, directory, captureErrorDetails, rotation }
}

const TOP_LEVEL_FIELDS = ["enabled", "maxWaitMs", "maxElapsedMs", "categories", "providers", "logging"] as const

/**
 * Validate user configuration and apply defaults. Throws ConfigError with
 * every issue found. The result is frozen so policies cannot drift at runtime.
 */
export function resolveConfig(input: QuotaMatataConfig = {}): ResolvedConfig {
  const issues = new Issues()
  if (!isRecord(input)) {
    throw new ConfigError(["config: must be an object"])
  }
  checkUnknownKeys(input, TOP_LEVEL_FIELDS, "config", issues)
  const enabled = issues.boolean(input.enabled, "config.enabled") ?? true
  const maxWaitMs = issues.integer(input.maxWaitMs, "config.maxWaitMs", 1, MAX_DELAY_MS) ?? DEFAULT_MAX_WAIT_MS
  const maxElapsedMs = issues.integer(input.maxElapsedMs, "config.maxElapsedMs", 1, Number.MAX_SAFE_INTEGER)
  const categories = resolveCategories(input.categories, "config.categories", issues, globalCategoryBases())
  const providers = resolveProviders(input.providers, "config.providers", issues, categories)
  const logging = resolveLogging(input.logging, "config.logging", issues)
  issues.finish()
  const resolved: ResolvedConfig =
    maxElapsedMs === undefined
      ? { enabled, maxWaitMs, categories, providers, logging }
      : { enabled, maxWaitMs, maxElapsedMs, categories, providers, logging }
  return deepFreeze(resolved)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** Find the canonical provider entry matching a provider ID or alias (case-insensitive). */
export function matchProvider(
  config: ResolvedConfig,
  providerID: string,
): { readonly canonical: string; readonly provider: ResolvedProvider } | undefined {
  const needle = providerID.toLowerCase()
  for (const [canonical, provider] of Object.entries(config.providers)) {
    if (canonical === needle || provider.aliases.some((alias) => alias.toLowerCase() === needle)) {
      return { canonical, provider }
    }
  }
  return undefined
}