import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { MAX_DELAY_MS, resolveConfig } from "../src/config.js"
import { decideQuota, nextWeeklyResetUtc8Ms, UTC8_OFFSET_MS } from "../src/policy.js"
import type { NativeDecision, PolicyInput, QuotaCategory, QuotaMatataConfig } from "../src/types.js"

const DAY = 86_400_000
const WEEK = 7 * DAY

// 2026-11-16 is a Monday. Monday 00:00 UTC+8 == Sunday 16:00 UTC.
const MONDAY_UTC8 = Date.UTC(2026, 10, 15, 16, 0, 0, 0)
const NEXT_MONDAY_UTC8 = MONDAY_UTC8 + WEEK
// Wednesday 2026-11-18 12:30 UTC+8.
const WEDNESDAY_UTC8 = Date.UTC(2026, 10, 18, 4, 30, 0, 0)

function input(overrides: Partial<PolicyInput> & { category: QuotaCategory }, config = resolveConfig()): PolicyInput {
  return {
    provider: "alibaba",
    model: "qwen3-max",
    attempt: 2,
    decision: { retry: true, delay: 2000 },
    now: WEDNESDAY_UTC8,
    config,
    ...overrides,
  }
}

describe("weekly reset computation (UTC+8 Monday boundary, TZ-independent)", () => {
  it("mid-week waits until next Monday 00:00 UTC+8", () => {
    assert.equal(nextWeeklyResetUtc8Ms(WEDNESDAY_UTC8), NEXT_MONDAY_UTC8)
  })

  it("1ms before the boundary waits 1ms", () => {
    assert.equal(nextWeeklyResetUtc8Ms(MONDAY_UTC8 - 1), MONDAY_UTC8)
  })

  it("exactly at the boundary rolls to the following week (no zero wait)", () => {
    assert.equal(nextWeeklyResetUtc8Ms(MONDAY_UTC8), NEXT_MONDAY_UTC8)
  })

  it("1ms after the boundary waits almost a full week", () => {
    assert.equal(nextWeeklyResetUtc8Ms(MONDAY_UTC8 + 1), NEXT_MONDAY_UTC8)
  })

  it("Sunday late evening UTC+8 crosses the day boundary correctly", () => {
    const sundayLate = MONDAY_UTC8 - 2 * 3_600_000 // Sunday 22:00 UTC+8
    assert.equal(nextWeeklyResetUtc8Ms(sundayLate), MONDAY_UTC8)
  })

  it("crosses a year boundary", () => {
    const fridayNewYear = Date.UTC(2026, 11, 31, 16, 0, 0) // 2027-01-01 00:00 UTC+8 (Friday)
    const expected = Date.UTC(2027, 0, 3, 16, 0, 0) // Monday 2027-01-04 00:00 UTC+8
    assert.equal(nextWeeklyResetUtc8Ms(fridayNewYear), expected)
  })

  it("always returns a future instant within (now, now + 7 days]", () => {
    for (let offset = -DAY; offset <= DAY; offset += 3_600_000) {
      const now = MONDAY_UTC8 + offset
      const reset = nextWeeklyResetUtc8Ms(now)
      assert.ok(reset > now, `reset must be future for offset ${offset}`)
      assert.ok(reset - now <= WEEK, `reset must be within a week for offset ${offset}`)
      // Reset is always Monday 00:00 UTC+8.
      const shifted = new Date(reset + UTC8_OFFSET_MS)
      assert.equal(shifted.getUTCDay(), 1, "reset weekday must be Monday")
      assert.equal((reset + UTC8_OFFSET_MS) % DAY, 0, "reset must be midnight UTC+8")
    }
  })
})

describe("fixed-delay categories", () => {
  it("quota_five_hour defaults to 30 minutes (rolling window, reset unknown)", () => {
    const result = decideQuota(input({ category: "quota_five_hour" }))
    assert.equal(result.action, "retry")
    assert.equal(result.action === "retry" && result.delayMs, 1_800_000)
  })

  it("quota_temporary defaults to 60s (documented one-minute wait)", () => {
    const result = decideQuota(input({ category: "quota_temporary" }))
    assert.equal(result.action === "retry" && result.delayMs, 60_000)
  })

  it("concurrency_limit defaults to 5s", () => {
    const result = decideQuota(input({ category: "concurrency_limit" }))
    assert.equal(result.action === "retry" && result.delayMs, 5_000)
  })

  it("custom per-category delayMs is honored", () => {
    const config = resolveConfig({ categories: { quota_five_hour: { delayMs: 600_000 } } })
    const result = decideQuota(input({ category: "quota_five_hour" }, config))
    assert.equal(result.action === "retry" && result.delayMs, 600_000)
  })

  it("zero delay is allowed", () => {
    const config = resolveConfig({ categories: { concurrency_limit: { delayMs: 0 } } })
    const result = decideQuota(input({ category: "concurrency_limit" }, config))
    assert.equal(result.action === "retry" && result.delayMs, 0)
  })
})

describe("weekly policy", () => {
  it("waits until Monday 00:00 UTC+8 plus the default 60s margin", () => {
    const result = decideQuota(input({ category: "quota_weekly" }))
    assert.equal(result.action, "retry")
    assert.equal(result.action === "retry" && result.delayMs, NEXT_MONDAY_UTC8 - WEDNESDAY_UTC8 + 60_000)
  })

  it("custom margin is honored, zero margin waits exactly to the reset", () => {
    const config = resolveConfig({ categories: { quota_weekly: { marginMs: 0 } } })
    const result = decideQuota(input({ category: "quota_weekly", now: MONDAY_UTC8 - 1 }, config))
    assert.equal(result.action === "retry" && result.delayMs, 1)
  })

  it("worst-case weekly wait fits the default 8-day maxWait", () => {
    const result = decideQuota(input({ category: "quota_weekly", now: MONDAY_UTC8 + 1 }))
    assert.equal(result.action, "retry")
    const delay = result.action === "retry" ? result.delayMs : 0
    assert.ok(delay <= 691_200_000)
    assert.ok(delay > WEEK - 1)
  })

  it("stops instead of clamping when the reset exceeds maxWaitMs", () => {
    const config = resolveConfig({ maxWaitMs: 3_600_000 })
    const result = decideQuota(input({ category: "quota_weekly" }, config))
    assert.equal(result.action, "stop")
    assert.match(result.reason, /maxWaitMs/)
  })

  it("provider cooldown never shortens the wait to the reset", () => {
    const config = resolveConfig({ categories: { quota_weekly: { marginMs: 0 } } })
    const result = decideQuota(
      input({ category: "quota_weekly", now: MONDAY_UTC8 - 1, metadata: { retryAfterMs: 10 } }, config),
    )
    // Reset wait (1ms) is smaller than cooldown (10ms): cooldown wins, still >= reset.
    assert.equal(result.action === "retry" && result.delayMs, 10)
  })
})

describe("monthly policy", () => {
  it("stops by default (subscription-day reset is not calendar-assumed)", () => {
    const result = decideQuota(input({ category: "quota_monthly" }))
    assert.equal(result.action, "stop")
    assert.match(result.reason, /subscription day/)
  })

  it("stops with untilReset enabled but no reliable reset supplied", () => {
    const config = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    const result = decideQuota(input({ category: "quota_monthly" }, config))
    assert.equal(result.action, "stop")
    assert.match(result.reason, /resetAtMs/)
  })

  it("stops when resetAtMs is invalid", () => {
    const config = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    for (const resetAtMs of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, "tomorrow"]) {
      const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs: resetAtMs as number } }, config))
      assert.equal(result.action, "stop", `resetAtMs=${String(resetAtMs)} must stop`)
    }
  })

  it("waits exactly to a reliable supplied reset", () => {
    const config = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    const resetAtMs = WEDNESDAY_UTC8 + 3 * DAY
    const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs } }, config))
    assert.equal(result.action === "retry" && result.delayMs, 3 * DAY)
  })

  it("a reset already in the past yields zero delay, not negative", () => {
    const config = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs: WEDNESDAY_UTC8 - 1000 } }, config))
    assert.equal(result.action === "retry" && result.delayMs, 0)
  })

  it("stops when the supplied reset exceeds maxWaitMs", () => {
    const config = resolveConfig({
      maxWaitMs: DAY,
      categories: { quota_monthly: { action: "retry", untilReset: true } },
    })
    const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs: WEDNESDAY_UTC8 + 30 * DAY } }, config))
    assert.equal(result.action, "stop")
  })

  it("ignores a supplied reset when untilReset is not enabled", () => {
    const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs: WEDNESDAY_UTC8 + DAY } }))
    assert.equal(result.action, "stop")
  })
})

describe("cooldown, bounds and budgets", () => {
  it("respects a reliable provider cooldown as a minimum", () => {
    const result = decideQuota(input({ category: "concurrency_limit", metadata: { retryAfterMs: 120_000 } }))
    assert.equal(result.action === "retry" && result.delayMs, 120_000)
  })

  it("rounds fractional cooldowns up to whole ms", () => {
    const config = resolveConfig({ categories: { concurrency_limit: { delayMs: 1_000 } } })
    const result = decideQuota(input({ category: "concurrency_limit", metadata: { retryAfterMs: 1500.5 } }, config))
    assert.equal(result.action === "retry" && result.delayMs, 1501)
  })

  it("ignores invalid cooldown metadata", () => {
    for (const retryAfterMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60"]) {
      const result = decideQuota(input({ category: "concurrency_limit", metadata: { retryAfterMs: retryAfterMs as number } }))
      assert.equal(result.action === "retry" && result.delayMs, 5_000, `retryAfterMs=${String(retryAfterMs)}`)
    }
  })

  it("stops when the cooldown exceeds maxWaitMs (no clamping before reset)", () => {
    const config = resolveConfig({ maxWaitMs: 60_000 })
    const result = decideQuota(input({ category: "concurrency_limit", metadata: { retryAfterMs: 120_000 } }, config))
    assert.equal(result.action, "stop")
    assert.match(result.reason, /maxWaitMs/)
  })

  it("enforces explicit cumulative elapsed budget without global counters", () => {
    const config = resolveConfig({ maxElapsedMs: 100_000 })
    const stop = decideQuota(input({ category: "quota_temporary", metadata: { elapsedMs: 90_000 } }, config))
    assert.equal(stop.action, "stop")
    assert.match(stop.reason, /maxElapsedMs/)
    const retry = decideQuota(input({ category: "quota_temporary", metadata: { elapsedMs: 30_000 } }, config))
    assert.equal(retry.action, "retry")
    // Same input twice: pure, no hidden accumulation.
    const again = decideQuota(input({ category: "quota_temporary", metadata: { elapsedMs: 30_000 } }, config))
    assert.deepEqual(again, retry)
  })

  it("ignores invalid elapsedMs and absent maxElapsedMs", () => {
    const config = resolveConfig({ maxElapsedMs: 100_000 })
    const result = decideQuota(input({ category: "quota_temporary", metadata: { elapsedMs: -5 } }, config))
    assert.equal(result.action, "retry")
    const unbounded = decideQuota(input({ category: "quota_temporary", metadata: { elapsedMs: 10 ** 12 } }))
    assert.equal(unbounded.action, "retry")
  })

  it("maxAttempts stops once the host attempt counter reaches it", () => {
    const config = resolveConfig({ categories: { quota_temporary: { maxAttempts: 3 } } })
    assert.equal(decideQuota(input({ category: "quota_temporary", attempt: 2 }, config)).action, "retry")
    assert.equal(decideQuota(input({ category: "quota_temporary", attempt: 3 }, config)).action, "stop")
    assert.equal(decideQuota(input({ category: "quota_temporary", attempt: 9 }, config)).action, "stop")
  })

  it("emits only finite integer delays within the host-safe ceiling", () => {
    const config = resolveConfig({ maxWaitMs: MAX_DELAY_MS, categories: { quota_five_hour: { delayMs: MAX_DELAY_MS } } })
    const result = decideQuota(input({ category: "quota_five_hour" }, config))
    assert.equal(result.action === "retry" && result.delayMs, MAX_DELAY_MS)
    assert.ok(Number.isInteger(MAX_DELAY_MS))
  })
})

describe("no-override and permanent categories", () => {
  it("rate_limit, quota_unknown, provider_unavailable and other keep the native decision", () => {
    for (const category of ["rate_limit", "quota_unknown", "provider_unavailable", "other"] as const) {
      const result = decideQuota(input({ category, metadata: { retryAfterMs: 999_999 } }))
      assert.equal(result.action, "no_override", category)
    }
  })

  it("authentication and billing stop", () => {
    assert.equal(decideQuota(input({ category: "authentication" })).action, "stop")
    assert.equal(decideQuota(input({ category: "billing" })).action, "stop")
  })

  it("disabled category policy yields no_override", () => {
    const config = resolveConfig({ categories: { quota_weekly: { enabled: false } } })
    assert.equal(decideQuota(input({ category: "quota_weekly" }, config)).action, "no_override")
  })

  it("disabled engine yields no_override for every category", () => {
    const config = resolveConfig({ enabled: false })
    for (const category of ["quota_weekly", "quota_five_hour", "authentication", "other"] as const) {
      assert.equal(decideQuota(input({ category }, config)).action, "no_override")
    }
  })

  it("can force a retry even when the native decision is false (host allows within budget)", () => {
    const result = decideQuota(input({ category: "quota_weekly", decision: { retry: false } }))
    assert.equal(result.action, "retry")
  })

  it("never mutates the native decision or config", () => {
    const decision: NativeDecision = Object.freeze({ retry: true, delay: 2000 })
    const config = resolveConfig()
    const frozenInput = Object.freeze(input({ category: "quota_weekly", decision }))
    const before = JSON.stringify(frozenInput)
    decideQuota(frozenInput)
    assert.equal(JSON.stringify(frozenInput), before)
    assert.deepEqual(decision, { retry: true, delay: 2000 })
    assert.ok(Object.isFrozen(config))
  })

  it("does not read the clock: Date.now is never consulted", () => {
    const original = Date.now
    Date.now = () => {
      throw new Error("policy must not read the clock")
    }
    try {
      const result = decideQuota(input({ category: "quota_weekly" }))
      assert.equal(result.action, "retry")
    } finally {
      Date.now = original
    }
  })
})

describe("provider overrides", () => {
  it("provider category override applies only to that provider", () => {
    const config = resolveConfig({
      providers: { alibaba: { categories: { concurrency_limit: { delayMs: 2_000 } } } },
    })
    const alibaba = decideQuota(input({ category: "concurrency_limit", provider: "alibaba" }, config))
    assert.equal(alibaba.action === "retry" && alibaba.delayMs, 2_000)
    assert.equal(alibaba.policy, "providers.alibaba.categories.concurrency_limit")
    const other = decideQuota(input({ category: "concurrency_limit", provider: "anthropic" }, config))
    assert.equal(other.action === "retry" && other.delayMs, 5_000)
    assert.equal(other.policy, "categories.concurrency_limit")
  })

  it("alias providers receive the same overrides", () => {
    const config = resolveConfig({
      providers: { alibaba: { aliases: ["dashscope"], categories: { concurrency_limit: { delayMs: 2_000 } } } },
    })
    const result = decideQuota(input({ category: "concurrency_limit", provider: "dashscope" }, config))
    assert.equal(result.action === "retry" && result.delayMs, 2_000)
  })

  it("provider override merges field-level over global defaults", () => {
    const config = resolveConfig({
      categories: { quota_temporary: { delayMs: 30_000 } },
      providers: { alibaba: { categories: { quota_temporary: { maxAttempts: 2 } } } },
    })
    const result = decideQuota(input({ category: "quota_temporary", attempt: 1 }, config))
    assert.equal(result.action === "retry" && result.delayMs, 30_000)
    assert.equal(decideQuota(input({ category: "quota_temporary", attempt: 2 }, config)).action, "stop")
  })
})

describe("invalid required inputs", () => {
  it("throws TypeError for invalid now", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, "123"]) {
      assert.throws(() => decideQuota(input({ category: "other", now: now as number })), TypeError)
    }
  })

  it("throws TypeError for invalid attempt", () => {
    for (const attempt of [-1, Number.NaN, "2"]) {
      assert.throws(() => decideQuota(input({ category: "other", attempt: attempt as number })), TypeError)
    }
  })

  it("throws TypeError for invalid native decision", () => {
    assert.throws(() => decideQuota(input({ category: "other", decision: {} as NativeDecision })), TypeError)
  })

  it("tolerates absent metadata", () => {
    const { metadata: _metadata, ...rest } = input({ category: "concurrency_limit" })
    assert.equal(decideQuota(rest).action, "retry")
  })
})

describe("configuration shapes used by policy", () => {
  it("default maxWait allows a full weekly reset plus margin", () => {
    const config = resolveConfig()
    assert.equal(config.maxWaitMs, 8 * DAY)
    assert.ok(config.maxWaitMs > WEEK + 60_000)
    assert.ok(config.maxWaitMs <= MAX_DELAY_MS)
  })

  it("accepts a custom user config end-to-end", () => {
    const user: QuotaMatataConfig = {
      maxWaitMs: 2 * DAY,
      categories: { quota_weekly: { marginMs: 500 } },
    }
    const config = resolveConfig(user)
    const result = decideQuota(input({ category: "quota_weekly", now: MONDAY_UTC8 - 1000 }, config))
    assert.equal(result.action === "retry" && result.delayMs, 1500)
  })
})

describe("R4-02: inherited provider fields are enforced at decision time", () => {
  it("inherited global maxAttempts stops provider retries", () => {
    const config = resolveConfig({
      categories: { concurrency_limit: { maxAttempts: 3 } },
      providers: { alibaba: { categories: { concurrency_limit: { delayMs: 2_000 } } } },
    })
    const retry = decideQuota(input({ category: "concurrency_limit", attempt: 2 }, config))
    assert.equal(retry.action === "retry" && retry.delayMs, 2_000)
    const stopped = decideQuota(input({ category: "concurrency_limit", attempt: 3 }, config))
    assert.equal(stopped.action, "stop")
    assert.equal(stopped.policy, "providers.alibaba.categories.concurrency_limit")
  })

  it("inherited monthly untilReset enables provider until-reset retries with the inherited cap", () => {
    const config = resolveConfig({
      categories: { quota_monthly: { action: "retry", untilReset: true } },
      providers: { alibaba: { categories: { quota_monthly: { maxAttempts: 3 } } } },
    })
    const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs: WEDNESDAY_UTC8 + DAY } }, config))
    assert.equal(result.action === "retry" && result.delayMs, DAY)
    const capped = decideQuota(
      input({ category: "quota_monthly", attempt: 3, metadata: { resetAtMs: WEDNESDAY_UTC8 + DAY } }, config),
    )
    assert.equal(capped.action, "stop")
  })
})

describe("R4-03: reliable future reset floors any emitted retry", () => {
  it("concurrency with a supplied reset 1h out waits the full hour, not 5s", () => {
    const result = decideQuota(input({ category: "concurrency_limit", metadata: { resetAtMs: WEDNESDAY_UTC8 + 3_600_000 } }))
    assert.equal(result.action === "retry" && result.delayMs, 3_600_000)
    assert.match(result.reason, /supplied reset/)
  })

  it("five_hour and temporary categories are floored too", () => {
    for (const category of ["quota_five_hour", "quota_temporary"] as const) {
      const result = decideQuota(input({ category, metadata: { resetAtMs: WEDNESDAY_UTC8 + 2 * 3_600_000 } }))
      assert.equal(result.action === "retry" && result.delayMs, 2 * 3_600_000, category)
    }
  })

  it("user-configured retry categories are floored (rate_limit opt-in)", () => {
    const config = resolveConfig({ categories: { rate_limit: { action: "retry", delayMs: 1_000 } } })
    const result = decideQuota(input({ category: "rate_limit", metadata: { resetAtMs: WEDNESDAY_UTC8 + 60_000 } }, config))
    assert.equal(result.action === "retry" && result.delayMs, 60_000)
  })

  it("reset floor and cooldown combine by maximum", () => {
    const resetAtMs = WEDNESDAY_UTC8 + 60_000
    const smallerCooldown = decideQuota(input({ category: "concurrency_limit", metadata: { resetAtMs, retryAfterMs: 10_000 } }))
    assert.equal(smallerCooldown.action === "retry" && smallerCooldown.delayMs, 60_000)
    const largerCooldown = decideQuota(input({ category: "concurrency_limit", metadata: { resetAtMs, retryAfterMs: 120_000 } }))
    assert.equal(largerCooldown.action === "retry" && largerCooldown.delayMs, 120_000)
  })

  it("weekly applies its configured margin to a later supplied reset", () => {
    const supplied = NEXT_MONDAY_UTC8 + DAY
    const result = decideQuota(input({ category: "quota_weekly", metadata: { resetAtMs: supplied } }))
    assert.equal(result.action === "retry" && result.delayMs, supplied - WEDNESDAY_UTC8 + 60_000)
  })

  it("an earlier supplied reset never shortens the weekly wait", () => {
    const result = decideQuota(input({ category: "quota_weekly", metadata: { resetAtMs: WEDNESDAY_UTC8 + 1_000 } }))
    assert.equal(result.action === "retry" && result.delayMs, NEXT_MONDAY_UTC8 - WEDNESDAY_UTC8 + 60_000)
  })

  it("floor applies before maxWaitMs: over-long reset stops, never clamps", () => {
    const config = resolveConfig({ maxWaitMs: 3_600_000 })
    const result = decideQuota(
      input({ category: "concurrency_limit", metadata: { resetAtMs: WEDNESDAY_UTC8 + 2 * 3_600_000 } }, config),
    )
    assert.equal(result.action, "stop")
    assert.match(result.reason, /maxWaitMs/)
  })

  it("floor applies before the elapsed budget", () => {
    const config = resolveConfig({ maxElapsedMs: 100_000 })
    const result = decideQuota(
      input({ category: "concurrency_limit", metadata: { resetAtMs: WEDNESDAY_UTC8 + 60_000, elapsedMs: 50_000 } }, config),
    )
    assert.equal(result.action, "stop")
    assert.match(result.reason, /maxElapsedMs/)
  })

  it("past, present or invalid resets are ignored for non-monthly categories", () => {
    for (const resetAtMs of [WEDNESDAY_UTC8 - 1_000, WEDNESDAY_UTC8, 0, -5, Number.NaN, "soon"]) {
      const result = decideQuota(input({ category: "concurrency_limit", metadata: { resetAtMs: resetAtMs as number } }))
      assert.equal(result.action === "retry" && result.delayMs, 5_000, `resetAtMs=${String(resetAtMs)}`)
    }
  })

  it("no_override categories stay native even with a future reset", () => {
    for (const category of ["rate_limit", "quota_unknown", "provider_unavailable", "other"] as const) {
      const result = decideQuota(input({ category, metadata: { resetAtMs: WEDNESDAY_UTC8 + DAY } }))
      assert.equal(result.action, "no_override", category)
    }
  })

  it("disabled engine/category stay no_override even with a future reset", () => {
    const disabled = resolveConfig({ enabled: false })
    assert.equal(
      decideQuota(input({ category: "concurrency_limit", metadata: { resetAtMs: WEDNESDAY_UTC8 + DAY } }, disabled)).action,
      "no_override",
    )
    const off = resolveConfig({ categories: { concurrency_limit: { enabled: false } } })
    assert.equal(
      decideQuota(input({ category: "concurrency_limit", metadata: { resetAtMs: WEDNESDAY_UTC8 + DAY } }, off)).action,
      "no_override",
    )
  })

  it("monthly semantics unchanged: exact wait to the supplied reset", () => {
    const config = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs: WEDNESDAY_UTC8 + 3 * DAY } }, config))
    assert.equal(result.action === "retry" && result.delayMs, 3 * DAY)
  })
})

describe("R4-04: out-of-Date-range timestamps are safe", () => {
  const MAX_DATE = 8.64e15

  it("monthly resetAtMs beyond the Date range stops instead of throwing RangeError", () => {
    const config = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    for (const resetAtMs of [1e20, Number.MAX_VALUE, MAX_DATE + 1]) {
      const result = decideQuota(input({ category: "quota_monthly", metadata: { resetAtMs } }, config))
      assert.equal(result.action, "stop", `resetAtMs=${resetAtMs}`)
      assert.match(result.reason, /resetAtMs/)
    }
  })

  it("monthly accepts the exact Date-range boundary", () => {
    const config = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    const result = decideQuota(
      input({ category: "quota_monthly", now: MAX_DATE - DAY, metadata: { resetAtMs: MAX_DATE } }, config),
    )
    assert.equal(result.action === "retry" && result.delayMs, DAY)
  })

  it("out-of-range reset metadata is ignored for non-monthly categories", () => {
    for (const resetAtMs of [1e20, Number.MAX_VALUE]) {
      const result = decideQuota(input({ category: "concurrency_limit", metadata: { resetAtMs } }))
      assert.equal(result.action === "retry" && result.delayMs, 5_000)
    }
  })

  it("weekly now beyond the Date range throws TypeError, not RangeError", () => {
    for (const now of [1e20, Number.MAX_VALUE, -1e20, MAX_DATE + 1]) {
      assert.throws(() => decideQuota(input({ category: "quota_weekly", now })), TypeError)
    }
  })

  it("out-of-range now is rejected for every category (required input)", () => {
    for (const category of ["other", "concurrency_limit", "authentication"] as const) {
      assert.throws(() => decideQuota(input({ category, now: 1e20 })), TypeError)
    }
  })

  it("weekly at the upper Date boundary stops safely when the reset overflows the range", () => {
    const result = decideQuota(input({ category: "quota_weekly", now: MAX_DATE }))
    assert.equal(result.action, "stop")
    assert.match(result.reason, /timestamp range/)
  })

  it("weekly near the upper boundary still retries while the reset fits", () => {
    const result = decideQuota(input({ category: "quota_weekly", now: MAX_DATE - 2 * WEEK }))
    assert.equal(result.action, "retry")
  })

  it("weekly at the lower Date boundary works", () => {
    const result = decideQuota(input({ category: "quota_weekly", now: -MAX_DATE }))
    assert.equal(result.action, "retry")
  })

  it("nextWeeklyResetUtc8Ms rejects out-of-range instants", () => {
    for (const now of [1e20, Number.MAX_VALUE, -1e20, Number.NaN]) {
      assert.throws(() => nextWeeklyResetUtc8Ms(now), TypeError)
    }
  })

  it("nextWeeklyResetUtc8Ms stays finite at the Date-range edge (no Date construction)", () => {
    const reset = nextWeeklyResetUtc8Ms(MAX_DATE)
    assert.ok(Number.isFinite(reset))
    assert.ok(reset > MAX_DATE)
    assert.ok(reset - MAX_DATE <= WEEK)
  })
})