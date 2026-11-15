import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ConfigError, DEFAULT_MAX_WAIT_MS, MAX_DELAY_MS, resolveConfig } from "../src/config.js"
import { QUOTA_CATEGORIES } from "../src/types.js"

function expectIssues(build: () => unknown, ...fragments: string[]): ConfigError {
  try {
    build()
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`)
    for (const fragment of fragments) {
      assert.ok(error.message.includes(fragment), `message should mention "${fragment}":\n${error.message}`)
    }
    return error
  }
  throw new assert.AssertionError({ message: "expected ConfigError to be thrown" })
}

describe("defaults", () => {
  it("resolves an empty config to safe defaults", () => {
    const config = resolveConfig()
    assert.equal(config.enabled, true)
    assert.equal(config.maxWaitMs, DEFAULT_MAX_WAIT_MS)
    assert.equal(config.maxWaitMs, 691_200_000)
    assert.equal(config.maxElapsedMs, undefined)

    assert.deepEqual(config.categories.quota_five_hour, {
      enabled: true,
      action: "retry",
      delayMs: 1_800_000,
      marginMs: 0,
      untilReset: false,
    })
    assert.deepEqual(config.categories.quota_weekly, {
      enabled: true,
      action: "retry",
      delayMs: 0,
      marginMs: 60_000,
      untilReset: false,
    })
    assert.deepEqual(config.categories.quota_monthly, {
      enabled: true,
      action: "stop",
      delayMs: 0,
      marginMs: 0,
      untilReset: false,
    })
    assert.equal(config.categories.quota_temporary.delayMs, 60_000)
    assert.equal(config.categories.concurrency_limit.delayMs, 5_000)
    for (const category of ["rate_limit", "quota_unknown", "provider_unavailable", "other"] as const) {
      assert.equal(config.categories[category].action, "no_override")
    }
    assert.equal(config.categories.authentication.action, "stop")
    assert.equal(config.categories.billing.action, "stop")
  })

  it("ships the Alibaba classifier enabled by default", () => {
    const config = resolveConfig()
    assert.ok(config.providers.alibaba)
    assert.equal(config.providers.alibaba.enabled, true)
    assert.deepEqual(config.providers.alibaba.aliases, [])
  })

  it("resolves logging defaults without enabling anything", () => {
    const config = resolveConfig()
    assert.deepEqual(config.logging, {
      enabled: false,
      level: "info",
      captureErrorDetails: false,
      rotation: { maxSizeBytes: 1_048_576, maxFiles: 5 },
    })
  })

  it("freezes the resolved config", () => {
    const config = resolveConfig()
    assert.ok(Object.isFrozen(config))
    assert.ok(Object.isFrozen(config.categories))
    assert.ok(Object.isFrozen(config.categories.quota_weekly))
    assert.ok(Object.isFrozen(config.providers.alibaba))
    assert.ok(Object.isFrozen(config.logging.rotation))
  })
})

describe("strict unknown-key rejection", () => {
  it("rejects unknown top-level keys", () => {
    expectIssues(() => resolveConfig({ bogus: 1 } as never), "bogus")
  })

  it("rejects unknown categories", () => {
    expectIssues(() => resolveConfig({ categories: { nope: {} } } as never), "nope")
  })

  it("rejects unknown category fields", () => {
    expectIssues(() => resolveConfig({ categories: { quota_weekly: { delayMs: 5 } } }), "delayMs")
    expectIssues(() => resolveConfig({ categories: { concurrency_limit: { marginMs: 5 } } }), "marginMs")
    expectIssues(() => resolveConfig({ categories: { quota_weekly: { untilReset: true } } }), "untilReset")
    expectIssues(() => resolveConfig({ categories: { concurrency_limit: { bogus: 1 } } } as never), "bogus")
  })

  it("rejects unknown provider and logging fields", () => {
    expectIssues(() => resolveConfig({ providers: { alibaba: { bogus: 1 } } } as never), "bogus")
    expectIssues(() => resolveConfig({ logging: { bogus: 1 } } as never), "bogus")
    expectIssues(() => resolveConfig({ logging: { rotation: { bogus: 1 } } } as never), "bogus")
  })
})

describe("category validation", () => {
  it("rejects delayMs for weekly and monthly (computed delays)", () => {
    expectIssues(() => resolveConfig({ categories: { quota_weekly: { delayMs: 1000 } } }), "quota_weekly", "delayMs")
    expectIssues(() => resolveConfig({ categories: { quota_monthly: { delayMs: 1000 } } }), "quota_monthly", "delayMs")
  })

  it("rejects delayMs when action is not retry", () => {
    expectIssues(
      () => resolveConfig({ categories: { concurrency_limit: { action: "stop", delayMs: 1000 } } }),
      "delayMs",
      "retry",
    )
    expectIssues(() => resolveConfig({ categories: { rate_limit: { delayMs: 1000 } } }), "delayMs")
  })

  it("requires untilReset for monthly retry", () => {
    expectIssues(() => resolveConfig({ categories: { quota_monthly: { action: "retry" } } }), "untilReset")
    const ok = resolveConfig({ categories: { quota_monthly: { action: "retry", untilReset: true } } })
    assert.equal(ok.categories.quota_monthly.action, "retry")
    assert.equal(ok.categories.quota_monthly.untilReset, true)
  })

  it("forbids retry for permanent categories", () => {
    expectIssues(() => resolveConfig({ categories: { authentication: { action: "retry" } } }), "permanent")
    expectIssues(() => resolveConfig({ categories: { billing: { action: "retry" } } }), "permanent")
    expectIssues(() => resolveConfig({ categories: { authentication: { maxAttempts: 3 } } }), "maxAttempts")
  })

  it("rejects invalid action values", () => {
    expectIssues(() => resolveConfig({ categories: { other: { action: "explode" } } } as never), "action")
  })

  it("rejects invalid numeric values", () => {
    expectIssues(() => resolveConfig({ categories: { concurrency_limit: { delayMs: -1 } } }), "delayMs")
    expectIssues(() => resolveConfig({ categories: { concurrency_limit: { delayMs: 1.5 } } }), "delayMs")
    expectIssues(() => resolveConfig({ categories: { concurrency_limit: { delayMs: Number.NaN } } }), "delayMs")
    expectIssues(
      () => resolveConfig({ categories: { concurrency_limit: { delayMs: Number.POSITIVE_INFINITY } } }),
      "delayMs",
    )
    expectIssues(() => resolveConfig({ categories: { concurrency_limit: { delayMs: "5" } } } as never), "delayMs")
    expectIssues(() => resolveConfig({ categories: { concurrency_limit: { delayMs: MAX_DELAY_MS + 1 } } }), "delayMs")
    expectIssues(() => resolveConfig({ categories: { quota_weekly: { marginMs: -1 } } }), "marginMs")
    expectIssues(() => resolveConfig({ categories: { quota_weekly: { marginMs: 86_400_001 } } }), "marginMs")
    expectIssues(() => resolveConfig({ categories: { quota_temporary: { maxAttempts: 0 } } }), "maxAttempts")
    expectIssues(() => resolveConfig({ categories: { quota_temporary: { maxAttempts: 1.5 } } }), "maxAttempts")
    expectIssues(() => resolveConfig({ categories: { quota_temporary: { maxAttempts: -2 } } }), "maxAttempts")
  })

  it("rejects invalid booleans and non-object entries", () => {
    expectIssues(() => resolveConfig({ enabled: "yes" } as never), "enabled")
    expectIssues(() => resolveConfig({ categories: { quota_weekly: { enabled: 1 } } } as never), "enabled")
    expectIssues(() => resolveConfig({ categories: { quota_weekly: { untilReset: "true" } } } as never), "untilReset")
    expectIssues(() => resolveConfig({ categories: 5 } as never), "categories")
    expectIssues(() => resolveConfig({ categories: { quota_weekly: 5 } } as never), "quota_weekly")
  })

  it("accepts boundary values", () => {
    const config = resolveConfig({
      maxWaitMs: MAX_DELAY_MS,
      categories: { concurrency_limit: { delayMs: 0 }, quota_weekly: { marginMs: 0 } },
    })
    assert.equal(config.maxWaitMs, MAX_DELAY_MS)
    assert.equal(config.categories.concurrency_limit.delayMs, 0)
    assert.equal(config.categories.quota_weekly.marginMs, 0)
  })
})

describe("top-level bounds", () => {
  it("rejects invalid maxWaitMs", () => {
    expectIssues(() => resolveConfig({ maxWaitMs: 0 }), "maxWaitMs")
    expectIssues(() => resolveConfig({ maxWaitMs: -5 }), "maxWaitMs")
    expectIssues(() => resolveConfig({ maxWaitMs: MAX_DELAY_MS + 1 }), "maxWaitMs")
    expectIssues(() => resolveConfig({ maxWaitMs: Number.POSITIVE_INFINITY }), "maxWaitMs")
    expectIssues(() => resolveConfig({ maxWaitMs: 1000.5 }), "maxWaitMs")
  })

  it("rejects invalid maxElapsedMs", () => {
    expectIssues(() => resolveConfig({ maxElapsedMs: 0 }), "maxElapsedMs")
    expectIssues(() => resolveConfig({ maxElapsedMs: -1 }), "maxElapsedMs")
    const ok = resolveConfig({ maxElapsedMs: 1000 })
    assert.equal(ok.maxElapsedMs, 1000)
  })

  it("rejects non-object configs", () => {
    expectIssues(() => resolveConfig(5 as never), "object")
    expectIssues(() => resolveConfig(null as never), "object")
  })
})

describe("provider validation", () => {
  it("rejects non-object provider entries and empty keys", () => {
    expectIssues(() => resolveConfig({ providers: { alibaba: 5 } } as never), "alibaba")
    expectIssues(() => resolveConfig({ providers: { "  ": {} } }), "non-empty")
    expectIssues(() => resolveConfig({ providers: [] } as never), "providers")
  })

  it("rejects invalid aliases", () => {
    expectIssues(() => resolveConfig({ providers: { alibaba: { aliases: "dashscope" } } } as never), "aliases")
    expectIssues(() => resolveConfig({ providers: { alibaba: { aliases: [""] } } }), "non-empty")
    expectIssues(() => resolveConfig({ providers: { alibaba: { aliases: [5] } } } as never), "non-empty")
    expectIssues(() => resolveConfig({ providers: { alibaba: { aliases: ["x", "X"] } } }), "duplicate")
    expectIssues(() => resolveConfig({ providers: { alibaba: { aliases: ["alibaba"] } } }), "duplicates")
  })

  it("rejects alias collisions across providers, including the built-in alibaba", () => {
    expectIssues(
      () => resolveConfig({ providers: { one: { aliases: ["shared"] }, two: { aliases: ["shared"] } } }),
      "claimed",
    )
    expectIssues(() => resolveConfig({ providers: { other: { aliases: ["alibaba"] } } }), "claimed")
    expectIssues(() => resolveConfig({ providers: { one: { aliases: ["two"] }, two: {} } }), "claimed")
  })

  it("normalizes provider keys case-insensitively without false collisions", () => {
    const config = resolveConfig({ providers: { Alibaba: { enabled: false } } })
    assert.equal(config.providers.alibaba?.enabled, false)
    assert.equal(Object.keys(config.providers).length, 1)
  })

  it("merges provider category overrides field-level over globals", () => {
    const config = resolveConfig({
      categories: { concurrency_limit: { delayMs: 7_000 } },
      providers: { alibaba: { categories: { concurrency_limit: { maxAttempts: 4 } } } },
    })
    const alibaba = config.providers.alibaba?.categories.concurrency_limit
    assert.equal(alibaba?.delayMs, 7_000)
    assert.equal(alibaba?.maxAttempts, 4)
    assert.equal(alibaba?.action, "retry")
    assert.equal(config.categories.concurrency_limit.delayMs, 7_000)
    assert.equal(config.categories.concurrency_limit.maxAttempts, undefined)
  })

  it("validates provider category overrides with the same strictness", () => {
    expectIssues(
      () => resolveConfig({ providers: { alibaba: { categories: { authentication: { action: "retry" } } } } }),
      "permanent",
    )
  })
})

describe("logging configuration shape", () => {
  it("accepts a full logging config", () => {
    const config = resolveConfig({
      logging: {
        enabled: true,
        level: "debug",
        directory: "/tmp/quota-matata-logs",
        captureErrorDetails: true,
        rotation: { maxSizeBytes: 2_097_152, maxFiles: 3 },
      },
    })
    assert.deepEqual(config.logging, {
      enabled: true,
      level: "debug",
      directory: "/tmp/quota-matata-logs",
      captureErrorDetails: true,
      rotation: { maxSizeBytes: 2_097_152, maxFiles: 3 },
    })
  })

  it("rejects invalid logging values", () => {
    expectIssues(() => resolveConfig({ logging: { enabled: 1 } } as never), "enabled")
    expectIssues(() => resolveConfig({ logging: { level: "trace" } } as never), "level")
    expectIssues(() => resolveConfig({ logging: { directory: "" } }), "directory")
    expectIssues(() => resolveConfig({ logging: { directory: 5 } } as never), "directory")
    expectIssues(() => resolveConfig({ logging: { captureErrorDetails: "yes" } } as never), "captureErrorDetails")
    expectIssues(() => resolveConfig({ logging: { rotation: { maxSizeBytes: 0 } } }), "maxSizeBytes")
    expectIssues(() => resolveConfig({ logging: { rotation: { maxSizeBytes: 104_857_601 } } }), "maxSizeBytes")
    expectIssues(() => resolveConfig({ logging: { rotation: { maxFiles: 0 } } }), "maxFiles")
    expectIssues(() => resolveConfig({ logging: { rotation: { maxFiles: 1001 } } }), "maxFiles")
    expectIssues(() => resolveConfig({ logging: { rotation: [] } } as never), "rotation")
    expectIssues(() => resolveConfig({ logging: 5 } as never), "logging")
  })
})

describe("error reporting", () => {
  it("collects every issue in one ConfigError", () => {
    const error = expectIssues(
      () => resolveConfig({ enabled: "yes", maxWaitMs: -1, categories: { quota_weekly: { marginMs: -5 } } } as never),
      "enabled",
      "maxWaitMs",
      "marginMs",
    )
    assert.ok(error.issues.length >= 3)
    assert.equal(error.name, "ConfigError")
  })
})

describe("R4-02: provider inheritance covers every field and validates the effective policy", () => {
  it("global maxAttempts survives a provider delay-only override", () => {
    const config = resolveConfig({
      categories: { concurrency_limit: { maxAttempts: 3 } },
      providers: { alibaba: { categories: { concurrency_limit: { delayMs: 2_000 } } } },
    })
    const policy = config.providers.alibaba?.categories.concurrency_limit
    assert.equal(policy?.maxAttempts, 3)
    assert.equal(policy?.delayMs, 2_000)
    assert.equal(policy?.action, "retry")
  })

  it("global monthly retry+untilReset accepts a provider maxAttempts-only override", () => {
    const config = resolveConfig({
      categories: { quota_monthly: { action: "retry", untilReset: true } },
      providers: { alibaba: { categories: { quota_monthly: { maxAttempts: 3 } } } },
    })
    const policy = config.providers.alibaba?.categories.quota_monthly
    assert.equal(policy?.action, "retry")
    assert.equal(policy?.untilReset, true)
    assert.equal(policy?.maxAttempts, 3)
  })

  it("provider action override inherits global delayMs and maxAttempts", () => {
    const config = resolveConfig({
      categories: { quota_temporary: { delayMs: 30_000, maxAttempts: 5 } },
      providers: { alibaba: { categories: { quota_temporary: { action: "stop" } } } },
    })
    const policy = config.providers.alibaba?.categories.quota_temporary
    assert.equal(policy?.action, "stop")
    assert.equal(policy?.delayMs, 30_000)
    assert.equal(policy?.maxAttempts, 5)
  })

  it("global enabled:false and margin propagate unless explicitly overridden", () => {
    const config = resolveConfig({
      categories: { quota_weekly: { enabled: false, marginMs: 500 } },
      providers: { alibaba: { categories: { quota_weekly: { marginMs: 1_000 } } } },
    })
    const policy = config.providers.alibaba?.categories.quota_weekly
    assert.equal(policy?.enabled, false)
    assert.equal(policy?.marginMs, 1_000)
  })

  it("provider turning off untilReset while inheriting monthly retry is rejected", () => {
    expectIssues(
      () =>
        resolveConfig({
          categories: { quota_monthly: { action: "retry", untilReset: true } },
          providers: { alibaba: { categories: { quota_monthly: { untilReset: false } } } },
        }),
      "untilReset",
    )
  })

  it("provider monthly retry is valid when untilReset is inherited from globals", () => {
    const config = resolveConfig({
      categories: { quota_monthly: { untilReset: true } },
      providers: { alibaba: { categories: { quota_monthly: { action: "retry" } } } },
    })
    assert.equal(config.providers.alibaba?.categories.quota_monthly.action, "retry")
    assert.equal(config.providers.alibaba?.categories.quota_monthly.untilReset, true)
  })
})

describe("R4-05: canonical collisions and prototype hazards are rejected", () => {
  it("rejects case-colliding canonical provider keys instead of silently overwriting", () => {
    expectIssues(
      () => resolveConfig({ providers: { alibaba: { enabled: false }, ALIBABA: { enabled: true } } }),
      "duplicates canonical",
    )
    expectIssues(() => resolveConfig({ providers: { Foo: {}, foo: {} } }), "duplicates canonical")
  })

  it("rejects JSON-origin __proto__, constructor and prototype provider keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const json = `{"providers":{${JSON.stringify(key)}:{"enabled":true}}}`
      expectIssues(() => resolveConfig(JSON.parse(json)), "reserved")
    }
  })

  it("JSON-origin configs resolve without prototype pollution", () => {
    const config = resolveConfig(JSON.parse('{"providers":{"dashscope":{"enabled":true},"alibaba":{"aliases":["coding"]}}}'))
    assert.equal(Object.getPrototypeOf(config.providers), Object.prototype)
    assert.deepEqual(Object.keys(config.providers).sort(), ["alibaba", "dashscope"])
    assert.equal(config.providers.dashscope?.enabled, true)
    assert.ok(Object.isFrozen(config.providers))
  })

  it("a single case-variant key still normalizes (no false collision)", () => {
    const config = resolveConfig({ providers: { ALIBABA: { enabled: false } } })
    assert.equal(config.providers.alibaba?.enabled, false)
    assert.equal(Object.keys(config.providers).length, 1)
  })
})

// ---------------------------------------------------------------------------
// R27-02: the required public category is concurrency_limit. Configuration
// must accept it everywhere the taxonomy applies (global + provider overrides,
// same strict validation and field-level inheritance), and the retired
// implementation-invented name must not survive as a legacy surface.
// ---------------------------------------------------------------------------
describe("R27-02: concurrency_limit is the required public category", () => {
  it("exposes exactly the canonical category set, including concurrency_limit", () => {
    assert.deepEqual(QUOTA_CATEGORIES, [
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
    ])
  })

  it("accepts categories.concurrency_limit tuning (R27 installed reproduction)", () => {
    const config = resolveConfig({ categories: { concurrency_limit: { delayMs: 1234 } } })
    assert.equal(config.categories.concurrency_limit.delayMs, 1234)
    assert.equal(config.categories.concurrency_limit.action, "retry")
    assert.equal(config.categories.concurrency_limit.enabled, true)
  })

  it("rejects the retired quota_concurrency name as an unknown category (no legacy surface)", () => {
    expectIssues(
      () => resolveConfig({ categories: { quota_concurrency: { delayMs: 1234 } } } as never),
      'unknown category "quota_concurrency"',
    )
    expectIssues(
      () =>
        resolveConfig({
          providers: { alibaba: { categories: { quota_concurrency: { delayMs: 1234 } } } },
        } as never),
      'unknown category "quota_concurrency"',
    )
  })

  it("provider overrides inherit every field and validate with the same strictness", () => {
    const config = resolveConfig({
      categories: { concurrency_limit: { delayMs: 7_000, maxAttempts: 4 } },
      providers: { alibaba: { categories: { concurrency_limit: { delayMs: 2_000 } } } },
    })
    const policy = config.providers.alibaba?.categories.concurrency_limit
    assert.equal(policy?.delayMs, 2_000)
    assert.equal(policy?.maxAttempts, 4)
    assert.equal(policy?.action, "retry")
    assert.equal(policy?.enabled, true)
    expectIssues(
      () => resolveConfig({ providers: { alibaba: { categories: { concurrency_limit: { marginMs: 5 } } } } }),
      "marginMs",
    )
    expectIssues(
      () => resolveConfig({ providers: { alibaba: { categories: { concurrency_limit: { untilReset: true } } } } }),
      "untilReset",
    )
    expectIssues(
      () =>
        resolveConfig({ providers: { alibaba: { categories: { concurrency_limit: { action: "stop", delayMs: 5 } } } } }),
      "delayMs",
    )
  })

  it("enabled:false and action overrides resolve for concurrency_limit", () => {
    const off = resolveConfig({ categories: { concurrency_limit: { enabled: false } } })
    assert.equal(off.categories.concurrency_limit.enabled, false)
    const stop = resolveConfig({ categories: { concurrency_limit: { action: "stop" } } })
    assert.equal(stop.categories.concurrency_limit.action, "stop")
    const native = resolveConfig({ categories: { concurrency_limit: { action: "no_override" } } })
    assert.equal(native.categories.concurrency_limit.action, "no_override")
  })
})