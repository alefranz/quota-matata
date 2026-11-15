import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

// Dependency-security contract (T5, 2026-11-15). The supported SDK pin
// `@opencode/plugin@2.3.0` transitively pulls `glob`/`minimatch` through
// `@opencode/util` and the npm-cli internals (arborist/pacote/rimraf/...).
// No newer SDK release exists, so package.json `overrides` force the patched
// majors repo-wide. These tests guard the remediation floors so a future
// install cannot silently reintroduce a vulnerable copy:
//   - glob      GHSA-3g3m-2fjr-6pw4 (fixed 14.0.2) and
//               GHSA-qxr8-q827-836c (fixed 14.0.6)  -> floor 14.0.6
//   - minimatch GHSA-g3hv-75wg-m249 (fixed 11.0.1) and
//               GHSA-cf2h-pxjq-68xw (fixed 11.0.7)  -> floor 11.0.8
// See specs/integration.md "Dependency security remediation".

const ROOT = new URL("../../", import.meta.url)
const GLOB_FLOOR = [14, 0, 6] as const
const MINIMATCH_FLOOR = [11, 0, 8] as const

function readJson(relative: string): any {
  return JSON.parse(readFileSync(new URL(relative, ROOT), "utf8"))
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10))
}

function atLeast(version: string, floor: readonly number[]): boolean {
  const parts = versionParts(version)
  for (let i = 0; i < floor.length; i++) {
    const actual = parts[i] ?? 0
    const expected = floor[i] ?? 0
    if (actual !== expected) return actual > expected
  }
  return true
}

describe("dependency security contract", () => {
  it("keeps the supported SDK pin exact", () => {
    const pkg = readJson("package.json")
    assert.equal(pkg.dependencies["@opencode/plugin"], "2.3.0")
  })

  it("declares glob/minimatch overrides", () => {
    const pkg = readJson("package.json")
    assert.equal(typeof pkg.overrides?.glob, "string")
    assert.equal(typeof pkg.overrides?.minimatch, "string")
    assert.ok(pkg.overrides.glob.length > 0)
    assert.ok(pkg.overrides.minimatch.length > 0)
  })

  it("locks every glob/minimatch copy at or above the patched floors", () => {
    const lock = readJson("package-lock.json")
    const entries = Object.entries(lock.packages ?? {}) as Array<[string, any]>
    const checked: string[] = []
    for (const [path, entry] of entries) {
      const name = path.split("node_modules/").pop()
      if (name !== "glob" && name !== "minimatch") continue
      const floor = name === "glob" ? GLOB_FLOOR : MINIMATCH_FLOOR
      assert.ok(
        atLeast(entry.version, floor),
        `${path}@${entry.version} is below the patched floor ${floor.join(".")}`,
      )
      checked.push(path)
    }
    assert.ok(checked.includes("node_modules/glob"))
    assert.ok(checked.includes("node_modules/minimatch"))
  })

  it("installs glob/minimatch at or above the patched floors", () => {
    const glob = readJson("node_modules/glob/package.json")
    const minimatch = readJson("node_modules/minimatch/package.json")
    assert.ok(atLeast(glob.version, GLOB_FLOOR), `installed glob ${glob.version}`)
    assert.ok(
      atLeast(minimatch.version, MINIMATCH_FLOOR),
      `installed minimatch ${minimatch.version}`,
    )
  })
})
