/**
 * Real package entry tests: the default export must be the supported
 * Plugin.define shape from the actual @opencode/plugin SDK, and the core
 * named exports must remain usable from the same entry.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Plugin } from "@opencode/plugin"
import plugin, { PLUGIN_ID, evaluateQuota, resolveConfig, createLogger, setupQuotaMatata } from "../src/index.js"
import * as core from "../src/core.js"

describe("package entry", () => {
  it("default export is a real Plugin.define definition with id quota-matata", () => {
    // Type-level check against the published SDK interface.
    const definition: Plugin.Plugin = plugin
    assert.equal(definition.id, "quota-matata")
    assert.equal(PLUGIN_ID, "quota-matata")
    assert.equal(typeof definition.setup, "function")
    assert.strictEqual(definition.setup, setupQuotaMatata)
  })

  it("keeps the useful core/logger named exports on the root entry", () => {
    assert.equal(typeof evaluateQuota, "function")
    assert.equal(typeof resolveConfig, "function")
    assert.equal(typeof createLogger, "function")
    const config = resolveConfig()
    const decision = evaluateQuota(
      {
        provider: "alibaba",
        model: "qwen3-max",
        error: {
          type: "provider.quota",
          message: "429",
          status: 429,
          response: { body: '{"error":{"message":"week allocated quota exceeded"}}' },
        },
        attempt: 2,
        decision: { retry: false },
        now: Date.UTC(2026, 10, 18, 4, 30, 0, 0),
      },
      config,
    )
    assert.equal(decision.action, "retry")
    assert.equal(decision.category, "quota_weekly")
  })

  it("the SDK-free core subpath module exposes the same named surface", () => {
    assert.equal(typeof core.evaluateQuota, "function")
    assert.equal(typeof core.resolveConfig, "function")
    assert.equal(typeof core.createLogger, "function")
    assert.equal(typeof core.classifyError, "function")
    assert.equal(typeof core.decideQuota, "function")
    assert.equal(typeof core.nextWeeklyResetUtc8Ms, "function")
    assert.equal(core.PLUGIN_VERSION, "0.1.0")
    // The core module must not pull in the plugin default entry.
    assert.equal("default" in core, false)
  })
})