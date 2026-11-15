/**
 * Quota Matata — package distributability smoke test (no publish).
 *
 * 1. `npm pack` the working tree into a temporary directory.
 * 2. Install the tarball into a throwaway consumer project (real npm
 *    resolution of the declared `@opencode/plugin@2.3.0` dependency).
 * 3. Import the installed package root on plain Node ESM: the default export
 *    must be the supported `Plugin.define` definition and the named core
 *    exports must work (this catches SDK export/runtime quirks that
 *    typechecking alone cannot).
 * 4. Remove the installed SDK, then import `quota-matata/core` in a fresh
 *    process: the SDK-free subpath must still work, proving the core surface
 *    does not load the OpenCode SDK at runtime. The root entry must now fail
 *    to load (negative control: it really does depend on the SDK).
 *
 * Temporary directories are removed on exit. Nothing is published.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
const tempRoot = mkdtempSync(join(tmpdir(), "qm-smoke-"))
const packDir = join(tempRoot, "pack")
const consumerDir = join(tempRoot, "consumer")

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 300_000 })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function nodeEval(cwd, code) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  })
  if (result.status !== 0) {
    throw new Error(`node child failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures++
    console.error(`FAIL - ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

try {
  // 1. Pack.
  const { mkdirSync } = await import("node:fs")
  mkdirSync(packDir, { recursive: true })
  mkdirSync(consumerDir, { recursive: true })
  const packJson = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", packDir], repoRoot))
  const packed = packJson[0]
  const tarball = join(packDir, packed.filename)
  check("tarball ships dist + LICENSE + README only (no src/test/node_modules)", () => {
    const files = packed.files.map((entry) => entry.path)
    if (!files.includes("dist/index.js")) throw new Error("dist/index.js missing")
    if (!files.includes("dist/core.js")) throw new Error("dist/core.js missing")
    if (!files.includes("LICENSE") || !files.includes("README.md")) throw new Error("LICENSE/README missing")
    for (const file of files) {
      if (file.startsWith("src/") || file.startsWith("test/") || file.includes("node_modules")) {
        throw new Error(`unexpected packed file: ${file}`)
      }
    }
  })

  // 2. Install into a throwaway consumer (real dependency resolution).
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "qm-smoke-consumer", private: true, type: "module" }))
  run("npm", ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error"], consumerDir)
  const installed = JSON.parse(readFileSync(join(consumerDir, "node_modules", "quota-matata", "package.json"), "utf8"))
  check("installed package metadata", () => {
    if (installed.name !== "quota-matata") throw new Error(`name ${installed.name}`)
    if (installed.version !== packed.version) throw new Error(`version ${installed.version} != ${packed.version}`)
    if (installed.dependencies?.["@opencode/plugin"] !== "2.3.0") throw new Error("SDK pin not 2.3.0")
  })

  // 3. Root entry on plain Node ESM: default Plugin.define + named exports.
  const rootOut = nodeEval(
    consumerDir,
    `
    import assert from "node:assert/strict"
    import plugin, { PLUGIN_ID, evaluateQuota, resolveConfig, createLogger, setupQuotaMatata } from "quota-matata"
    assert.equal(plugin.id, "quota-matata")
    assert.equal(PLUGIN_ID, "quota-matata")
    assert.equal(typeof plugin.setup, "function")
    assert.strictEqual(plugin.setup, setupQuotaMatata)
    const config = resolveConfig()
    const decision = evaluateQuota({
      provider: "alibaba", model: "qwen3-max",
      error: { type: "provider.quota", message: "429", status: 429,
               response: { body: '{"error":{"message":"week allocated quota exceeded"}}' } },
      attempt: 2, decision: { retry: false }, now: Date.UTC(2026, 10, 18, 4, 30, 0, 0),
    }, config)
    assert.equal(decision.action, "retry")
    assert.equal(decision.category, "quota_weekly")
    assert.equal(typeof createLogger(config.logging).log, "function")
    // enabled:false setup must be inert even without a host context.
    assert.equal(await setupQuotaMatata({ options: { enabled: false } }), undefined)
    console.log("ROOT_OK")
    `,
  )
  check("installed root entry imports and decides on plain Node ESM", () => {
    if (!rootOut.includes("ROOT_OK")) throw new Error("root child did not confirm")
  })

  // 4. SDK-free core subpath: remove the SDK, then import core in a fresh process.
  rmSync(join(consumerDir, "node_modules", "@opencode"), { recursive: true, force: true })
  const coreOut = nodeEval(
    consumerDir,
    `
    import assert from "node:assert/strict"
    import * as core from "quota-matata/core"
    assert.equal("default" in core, false)
    assert.equal(typeof core.evaluateQuota, "function")
    assert.equal(typeof core.createLogger, "function")
    assert.equal(core.PLUGIN_VERSION, ${JSON.stringify(packed.version)})
    const config = core.resolveConfig({ logging: { enabled: false } })
    const decision = core.evaluateQuota({
      provider: "alibaba", model: "qwen3-max",
      error: { type: "provider.auth", message: "InvalidApiKey", status: 401 },
      attempt: 1, decision: { retry: true, delay: 2000 }, now: Date.now(),
    }, config)
    assert.equal(decision.action, "stop")
    console.log("CORE_OK")
    `,
  )
  check("core subpath works at runtime with the SDK physically absent", () => {
    if (!coreOut.includes("CORE_OK")) throw new Error("core child did not confirm")
  })
  const negative = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import("quota-matata"); console.log("UNEXPECTED_ROOT_OK")`],
    { cwd: consumerDir, encoding: "utf8", timeout: 120_000 },
  )
  check("root entry really requires the SDK (negative control fails without it)", () => {
    if (negative.status === 0) throw new Error("root imported without the SDK")
  })

  if (failures > 0) {
    console.error(`package smoke: ${failures} check(s) failed`)
    process.exitCode = 1
  } else {
    console.log("package smoke: all checks passed (pack -> install -> import; nothing published)")
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
