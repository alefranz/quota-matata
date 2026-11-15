/**
 * Logging slice tests: privacy, bounds, rotation, permissions, symlinks,
 * queue concurrency and failure isolation. All temp files live under
 * /tmp/opencode and are removed afterwards; failures are injected via
 * filesystem shapes (never chmod, so the suite also works as root).
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { after, before, describe, it } from "node:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolveConfig } from "../src/config.js"
import * as publicApi from "../src/index.js"
import {
  createLogger,
  defaultLogDirectory,
  MAX_EVENT_BYTES,
  MAX_QUEUE_EVENTS,
  MAX_STRING_CHARS,
  PLUGIN_VERSION,
} from "../src/logging.js"
import type { DiagnosticLogger } from "../src/logging.js"

const TEMP_ROOT = "/tmp/opencode"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const OWNED_FILE_RE = /^quota-matata-.*\.jsonl(\.\d+)?$/

let root: string
const tracked: DiagnosticLogger[] = []

before(async () => {
  await mkdir(TEMP_ROOT, { recursive: true })
  root = await mkdtemp(join(TEMP_ROOT, "qm-logging-"))
})

after(async () => {
  for (const logger of tracked) await logger.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
})

function track(logger: DiagnosticLogger): DiagnosticLogger {
  tracked.push(logger)
  return logger
}

/** Path inside the owned temp root; not created (logger must create it). */
function dirPath(name: string): string {
  return join(root, name)
}

async function ensureDir(name: string): Promise<string> {
  const dir = dirPath(name)
  await mkdir(dir, { recursive: true })
  return dir
}

function configFor(directory: string | undefined, overrides: Record<string, unknown> = {}) {
  return resolveConfig({ logging: { enabled: true, ...(directory === undefined ? {} : { directory }), ...overrides } })
    .logging
}

function makeLogger(directory: string | undefined, overrides: Record<string, unknown> = {}): DiagnosticLogger {
  return track(createLogger(configFor(directory, overrides)))
}

async function lines(file: string): Promise<any[]> {
  const text = await readFile(file, "utf8")
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
}

async function ownedFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir)
  return names.filter((name) => OWNED_FILE_RE.test(name)).sort()
}

async function allLines(dir: string): Promise<any[]> {
  const out: any[] = []
  for (const name of await ownedFiles(dir)) out.push(...(await lines(join(dir, name))))
  return out
}

async function rawText(dir: string): Promise<string> {
  let text = ""
  for (const name of await ownedFiles(dir)) text += await readFile(join(dir, name), "utf8")
  return text
}

const HOST_ERROR = {
  type: "provider.quota",
  message: "429 Too Many Requests",
  status: 429,
  response: { body: '{"code":"Throttling.RateQuota","message":"week allocated quota exceeded"}' },
}

describe("defaultLogDirectory", () => {
  it("honors XDG_DATA_HOME on any platform", () => {
    assert.equal(defaultLogDirectory({ XDG_DATA_HOME: "/xdg" }, "linux", "/home/u"), "/xdg/quota-matata/logs")
    assert.equal(defaultLogDirectory({ XDG_DATA_HOME: "/xdg" }, "darwin", "/home/u"), "/xdg/quota-matata/logs")
  })
  it("falls back to ~/.local/share on linux when XDG is unset or empty", () => {
    assert.equal(defaultLogDirectory({}, "linux", "/home/u"), "/home/u/.local/share/quota-matata/logs")
    assert.equal(defaultLogDirectory({ XDG_DATA_HOME: "  " }, "linux", "/home/u"), "/home/u/.local/share/quota-matata/logs")
  })
  it("uses Library/Application Support on darwin", () => {
    assert.equal(defaultLogDirectory({}, "darwin", "/Users/u"), "/Users/u/Library/Application Support/quota-matata/logs")
  })
  it("uses LOCALAPPDATA, then APPDATA, then home on win32", () => {
    // join() is platform-dependent; compare against the same platform join.
    assert.equal(defaultLogDirectory({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\Users\\u"), join("C:\\L", "quota-matata", "logs"))
    assert.equal(defaultLogDirectory({ APPDATA: "C:\\R" }, "win32", "C:\\Users\\u"), join("C:\\R", "quota-matata", "logs"))
    assert.equal(
      defaultLogDirectory({}, "win32", "C:\\Users\\u"),
      join("C:\\Users\\u", "AppData", "Local", "quota-matata", "logs"),
    )
  })
})

describe("directory resolution", () => {
  it("expands ~/ in supplied directories without touching disk", () => {
    const logger = makeLogger("~/qm-log-test-no-write")
    assert.ok(logger.state.filePath?.startsWith(homedir() + "/"))
    assert.equal(logger.state.written, 0)
  })
  it("expands a bare ~ to the home directory", () => {
    const logger = makeLogger("~")
    assert.equal(dirname(logger.state.filePath ?? ""), homedir())
  })
  it("resolves relative directories to absolute paths", () => {
    const logger = makeLogger("relative-log-dir")
    assert.ok(isAbsolute(logger.state.filePath ?? ""))
  })
  it("uses the user-data default when no directory is configured", () => {
    const logger = makeLogger(undefined)
    assert.ok(logger.state.filePath?.startsWith(defaultLogDirectory()))
  })
})

describe("disabled and inert loggers", () => {
  it("enabled:false never creates the directory or files", async () => {
    const dir = dirPath("disabled")
    const logger = track(createLogger(configFor(dir, { enabled: false })))
    logger.log({ type: "provider.error", error: HOST_ERROR })
    await logger.flush()
    await logger.close()
    assert.equal(logger.state.enabled, false)
    assert.equal(logger.state.written, 0)
    await assert.rejects(readdir(dir), { code: "ENOENT" })
  })
  it("default config logging is disabled", async () => {
    const logger = track(createLogger(resolveConfig().logging))
    logger.log({ type: "plugin.error", message: "x" })
    await logger.flush()
    assert.equal(logger.state.enabled, false)
  })
  it("tolerates invalid logging config and invalid events without throwing", async () => {
    const logger = track(createLogger(null as any))
    logger.log(null as any)
    logger.log(undefined as any)
    await logger.flush()
    await logger.close()
    assert.equal(logger.state.enabled, false)
  })
})

describe("event schema", () => {
  it("writes a minimal provider.error with id/ts/level/pluginVersion", async () => {
    const dir = await ensureDir("schema-min")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error" })
    await logger.flush()
    const events = await allLines(dir)
    assert.equal(events.length, 1)
    const event = events[0]
    assert.match(event.id, UUID_RE)
    assert.match(event.ts, ISO_RE)
    assert.equal(event.type, "provider.error")
    assert.equal(event.level, "warn")
    assert.equal(event.pluginVersion, PLUGIN_VERSION)
    assert.equal(event.context, undefined)
    assert.equal(event.error, undefined)
  })
  it("passes context and correlation fields through", async () => {
    const dir = await ensureDir("schema-ctx")
    const logger = makeLogger(dir)
    logger.log({
      type: "retry.decision",
      context: {
        sessionID: "ses_1",
        agent: "build",
        provider: "alibaba",
        model: "qwen3-max",
        attempt: 3,
        hostVersion: "2.3.0",
        source: "session.retry",
        correlationId: "ses_1:3",
      },
    })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.deepEqual(event.context, { sessionID: "ses_1", agent: "build", provider: "alibaba", model: "qwen3-max", attempt: 3 })
    assert.equal(event.hostVersion, "2.3.0")
    assert.equal(event.source, "session.retry")
    assert.equal(event.correlationId, "ses_1:3")
  })
  it("records retry.decision fields and computes nextRetryAt from ts + delay", async () => {
    const dir = await ensureDir("schema-decision")
    const logger = makeLogger(dir)
    logger.log({
      type: "retry.decision",
      category: "quota_weekly",
      rule: "alibaba.quota_weekly",
      matched: "alibaba",
      original: { retry: true, delay: 2000 },
      final: { retry: true, delay: 1_800_000 },
      policy: "categories.quota_weekly",
      delay: 1_800_000,
      reason: "weekly quota resets soon",
    })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.category, "quota_weekly")
    assert.equal(event.rule, "alibaba.quota_weekly")
    assert.equal(event.matched, "alibaba")
    assert.deepEqual(event.original, { retry: true, delay: 2000 })
    assert.deepEqual(event.final, { retry: true, delay: 1_800_000 })
    assert.equal(event.override, true)
    assert.equal(event.policy, "categories.quota_weekly")
    assert.equal(event.delay, 1_800_000)
    assert.equal(event.reason, "weekly quota resets soon")
    assert.equal(event.nextRetryAt, new Date(Date.parse(event.ts) + 1_800_000).toISOString())
  })
  it("omits nextRetryAt for stop decisions and computes override when omitted", async () => {
    const dir = await ensureDir("schema-stop")
    const logger = makeLogger(dir)
    logger.log({ type: "retry.decision", original: { retry: true, delay: 2000 }, final: { retry: false } })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.override, true)
    assert.equal(event.nextRetryAt, undefined)
  })
  it("respects an explicit override flag", async () => {
    const dir = await ensureDir("schema-override")
    const logger = makeLogger(dir)
    logger.log({ type: "retry.decision", original: { retry: false }, final: { retry: true, delay: 5 }, override: false })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.override, false)
    assert.equal(event.nextRetryAt, new Date(Date.parse(event.ts) + 5).toISOString())
  })
  it("logs plugin.error with structural Error details (message/stack withheld, not gated)", async () => {
    const dir = await ensureDir("schema-plugin-error")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", message: "hook wiring failed", error: new Error("boom") })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.level, "error")
    // The top-level message is the explicit plugin-owned diagnostic channel.
    assert.equal(event.message, "hook wiring failed")
    // The error payload keeps stable structural diagnostics only: arbitrary
    // Error message/stack may embed request data and are never dumped.
    assert.equal(event.error.name, "Error")
    assert.equal(event.error.message, undefined)
    assert.equal(event.error.stack, undefined)
  })
  it("coerces unknown event types to plugin.error and invalid levels to the default", async () => {
    const dir = await ensureDir("schema-coerce")
    const logger = makeLogger(dir, { level: "debug" })
    logger.log({ type: "bogus" } as any)
    logger.log({ type: "provider.error", level: "loud" } as any)
    await logger.flush()
    const [first, second] = await allLines(dir)
    assert.equal(first.type, "plugin.error")
    assert.equal(second.level, "warn")
  })
  it("drops invalid attempt values and floors fractional ones", async () => {
    const dir = await ensureDir("schema-attempt")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error", context: { attempt: -1 } })
    logger.log({ type: "provider.error", context: { attempt: Number.NaN } })
    logger.log({ type: "provider.error", context: { attempt: "3" } as any })
    logger.log({ type: "provider.error", context: { attempt: 2.9 } })
    await logger.flush()
    const events = await allLines(dir)
    assert.equal(events[0].context, undefined)
    assert.equal(events[1].context, undefined)
    assert.equal(events[2].context, undefined)
    assert.equal(events[3].context.attempt, 2)
  })
  it("ignores malformed original/final/delay without requiring metadata", async () => {
    const dir = await ensureDir("schema-malformed-meta")
    const logger = makeLogger(dir)
    logger.log({ type: "retry.decision", original: "nope", final: 42, delay: -5 } as any)
    logger.log({ type: "retry.decision", final: { retry: true, delay: 1e20 } })
    await logger.flush()
    const [first, second] = await allLines(dir)
    assert.equal(first.original, undefined)
    assert.equal(first.final, undefined)
    assert.equal(first.delay, undefined)
    assert.equal(second.nextRetryAt, undefined) // out of Date range: never formatted
  })
  it("emits unique ids and UTC timestamps for every event", async () => {
    const dir = await ensureDir("schema-ids")
    const logger = makeLogger(dir)
    for (let i = 0; i < 10; i++) logger.log({ type: "provider.error" })
    await logger.flush()
    const events = await allLines(dir)
    assert.equal(new Set(events.map((event) => event.id)).size, 10)
    for (const event of events) assert.match(event.ts, ISO_RE)
  })
  it("redacts and bounds context strings", async () => {
    const dir = await ensureDir("schema-ctx-bounds")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error", context: { sessionID: "x".repeat(5000), provider: "token=SECRET" } })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.ok(event.context.sessionID.length <= 256 + "...[truncated]".length)
    assert.ok(!event.context.provider.includes("SECRET"))
  })
})

describe("level filtering", () => {
  it("applies default levels per event type", async () => {
    const dir = await ensureDir("level-defaults")
    const logger = makeLogger(dir, { level: "error" })
    logger.log({ type: "provider.error" })
    logger.log({ type: "retry.decision" })
    logger.log({ type: "plugin.error", message: "x" })
    await logger.flush()
    const events = await allLines(dir)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, "plugin.error")
  })
  it("filters below the configured level and honors per-event overrides", async () => {
    const dir = await ensureDir("level-filter")
    const logger = makeLogger(dir, { level: "warn" })
    logger.log({ type: "retry.decision" }) // info: filtered
    logger.log({ type: "provider.error" }) // warn: kept
    logger.log({ type: "retry.decision", level: "error" }) // override: kept
    await logger.flush()
    const events = await allLines(dir)
    assert.equal(events.length, 2)
    assert.equal(events[1].level, "error")
  })
  it("debug keeps everything", async () => {
    const dir = await ensureDir("level-debug")
    const logger = makeLogger(dir, { level: "debug" })
    logger.log({ type: "retry.decision" })
    logger.log({ type: "provider.error" })
    await logger.flush()
    assert.equal((await allLines(dir)).length, 2)
  })
})

describe("privacy: captureErrorDetails gating", () => {
  it("withholds provider message/body by default but keeps structural fields", async () => {
    const dir = await ensureDir("gate-default")
    const logger = makeLogger(dir)
    logger.log({
      type: "provider.error",
      error: {
        type: "provider.quota",
        message: "SECRET PROMPT conversation text",
        status: 429,
        response: { body: '{"code":"Throttling.RateQuota","message":"SECRET body text","api_key":"SECRET-KEY"}' },
      },
    })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("SECRET"))
    const [event] = await allLines(dir)
    assert.equal(event.error.type, "provider.quota")
    assert.equal(event.error.status, 429)
    assert.equal(event.error.code, "Throttling.RateQuota")
    assert.equal(event.error.message, undefined)
    assert.equal(event.error.details, undefined)
  })
  it("opt-in includes sanitized message and a whitelisted body envelope", async () => {
    const dir = await ensureDir("gate-optin")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({
      type: "provider.error",
      error: {
        type: "provider.quota",
        message: "week allocated quota exceeded",
        status: 429,
        response: {
          body: JSON.stringify({
            code: "Throttling.AllocationQuota",
            message: "week allocated quota exceeded",
            prompt: "SECRET PROMPT",
            choices: [{ text: "SECRET COMPLETION" }],
          }),
        },
      },
    })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("SECRET"))
    const [event] = await allLines(dir)
    assert.equal(event.error.message, "week allocated quota exceeded")
    assert.equal(event.error.details.code, "Throttling.AllocationQuota")
    assert.equal(event.error.details.message, "week allocated quota exceeded")
    assert.equal(event.error.details.prompt, undefined)
    assert.equal(event.error.details.choices, undefined)
  })
  it("opt-in keeps nested OpenAI-style error envelopes", async () => {
    const dir = await ensureDir("gate-nested")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({
      type: "provider.error",
      error: { type: "provider.rate-limit", response: { body: '{"error":{"code":"rate_limit","message":"slow down"}}' } },
    })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error.details.error.code, "rate_limit")
    assert.equal(event.error.details.error.message, "slow down")
  })
  it("opt-in redacts free-text bodies and bounds them", async () => {
    const dir = await ensureDir("gate-text")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({ type: "provider.error", error: { type: "x", response: { body: "upstream said Bearer abc123SECRET then failed" } } })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("abc123SECRET"))
    const [event] = await allLines(dir)
    assert.ok(event.error.details.text.includes("[redacted]"))
  })
  it("never JSON-parses bodies beyond the parse bound (actual parser invocations)", async () => {
    // Observe JSON.parse itself during the synchronous log() call: the bound
    // must hold before parseBody/bodyDetails, with capture on AND off, for
    // valid and malformed oversized bodies (R11-04).
    const valid = JSON.stringify({ code: "RateLimit", padding: "x".repeat(2_000_000) })
    const malformed = `{"code":"RateLimit","padding":"${"x".repeat(2_000_000)}`
    for (const capture of [false, true]) {
      for (const [kind, body] of [["valid", valid], ["malformed", malformed]] as const) {
        const dir = await ensureDir(`gate-huge-body-${capture ? "on" : "off"}-${kind}`)
        const logger = makeLogger(dir, { captureErrorDetails: capture })
        const originalParse = JSON.parse
        const seen: number[] = []
        JSON.parse = (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
          seen.push(text.length)
          return originalParse(text, reviver)
        }
        try {
          logger.log({ type: "provider.error", error: { type: "x", status: 429, response: { body } } })
        } finally {
          JSON.parse = originalParse
        }
        await logger.flush()
        assert.ok(
          seen.every((n) => n <= 65_536),
          `JSON.parse saw ${Math.max(...seen)} chars (capture=${capture}, ${kind})`,
        )
        const [event] = await allLines(dir)
        assert.equal(event.error.status, 429)
        assert.equal(event.error.code, undefined) // oversized body: never parsed
        // Oversized structured-looking bodies fail closed (R11-01): they are
        // withheld, never excerpted as raw text that could echo request data.
        if (capture) {
          assert.equal(event.error.details.withheld, true)
          assert.equal(event.error.details.text, undefined)
        } else assert.equal(event.error.details, undefined)
      }
    }
  })
  it("caps the opt-in envelope payload bytes", async () => {
    const dir = await ensureDir("gate-payload-cap")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    // Body stays under the 64KiB parse bound; four nested envelope levels
    // each carry a message truncated to ~2KiB, so the sanitized envelope
    // still exceeds the 8KiB payload cap (unknown fields are dropped, not
    // walked, so the cap must be exercised with whitelisted fields).
    let envelope: Record<string, unknown> = { message: "y".repeat(9_000) }
    for (let i = 0; i < 3; i++) envelope = { message: "y".repeat(9_000), error: envelope }
    logger.log({ type: "provider.error", error: { type: "x", response: { body: JSON.stringify(envelope) } } })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error.details.truncated, true)
  })
  it("gates bare-string provider errors", async () => {
    const dir = await ensureDir("gate-string")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error", error: "SECRET free text" })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.ok(!JSON.stringify(event).includes("SECRET"))
    assert.ok(String(event.error).includes("[withheld"))

    const dir2 = await ensureDir("gate-string-optin")
    const logger2 = makeLogger(dir2, { captureErrorDetails: true })
    logger2.log({ type: "provider.error", error: "failed with Bearer abcSECRET" })
    await logger2.flush()
    const [event2] = await allLines(dir2)
    assert.ok(!JSON.stringify(event2).includes("abcSECRET"))
    assert.ok(String(event2.error).includes("[redacted]"))
  })
  it("gates Error-instance provider errors (name kept, text withheld)", async () => {
    const dir = await ensureDir("gate-error-instance")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error", error: new Error("SECRET message") })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error.name, "Error")
    assert.equal(event.error.message, undefined)
    assert.equal(event.error.stack, undefined)
  })
  it("withholds unknown provider object free text by default (structural allowlist)", async () => {
    const dir = await ensureDir("gate-unknown-object")
    const logger = makeLogger(dir)
    logger.log({
      type: "provider.error",
      error: {
        code: "SomeCode",
        status: 500,
        message: "SECRET",
        description: "SECRET",
        details: ["SECRET"],
        detail: { message: "SECRET2", ok: 1 },
        request: { data: { input: "SECRET" } },
      },
    })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("SECRET"))
    const [event] = await allLines(dir)
    assert.equal(event.error.code, "SomeCode")
    assert.equal(event.error.status, 500)
    // Unknown keys/nested objects are withheld, not walked (R11-02).
    assert.equal(event.error.message, undefined)
    assert.equal(event.error.description, undefined)
    assert.equal(event.error.details, undefined)
    assert.equal(event.error.detail, undefined)
    assert.equal(event.error.request, undefined)
  })
  it("never retains prompt/conversation fields even with capture enabled", async () => {
    const dir = await ensureDir("gate-prompt-fields")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({
      type: "provider.error",
      error: { type: "x", message: "ok", prompt: "SECRET PROMPT", messages: ["SECRET"], conversation: "SECRET" },
    })
    await logger.flush()
    assert.ok(!(await rawText(dir)).includes("SECRET"))
  })
})

describe("R11 regressions: recursive request-data exclusion", () => {
  it("R11-01: nested opt-in envelopes never persist prompt/conversation/request data", async () => {
    const dir = await ensureDir("r11-01-nested")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({
      type: "provider.error",
      error: {
        type: "provider.bad-request",
        status: 400,
        response: {
          body: '{"error":{"code":"BadRequest","prompt":"PROMPT_R11","messages":[{"content":"CONVERSATION_R11"}],"request":{"body":"REQUEST_R11"}}}',
        },
      },
    })
    await logger.flush()
    const text = await rawText(dir)
    for (const marker of ["PROMPT_R11", "CONVERSATION_R11", "REQUEST_R11"]) assert.ok(!text.includes(marker), marker)
    const [event] = await allLines(dir)
    // Useful structural evidence survives the recursive reduction.
    assert.equal(event.error.code, "BadRequest")
    assert.equal(event.error.details.error.code, "BadRequest")
    assert.equal(event.error.details.error.prompt, undefined)
    assert.equal(event.error.details.error.messages, undefined)
    assert.equal(event.error.details.error.request, undefined)
  })
  it("R11-01: unknown provider conversation is excluded with capture on and off", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r11-01-unknown-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      logger.log({ type: "provider.error", error: { messages: [{ content: "CONVERSATION_R11" }] } })
      await logger.flush()
      assert.ok(!(await rawText(dir)).includes("CONVERSATION_R11"))
    }
  })
  it("R11-01: plugin.error request bodies and Error attachments are excluded regardless of capture", async () => {
    const dir = await ensureDir("r11-01-plugin")
    const logger = makeLogger(dir)
    const err = new Error("boom") as Error & { request?: unknown; prompt?: unknown }
    err.request = { body: "REQUEST_R11" }
    err.prompt = "PROMPT_R11"
    logger.log({ type: "plugin.error", error: { request: { body: "REQUEST_R11" } } })
    logger.log({ type: "plugin.error", error: err })
    logger.log({ type: "plugin.error", error: { a: { b: { c: { request: { body: "REQUEST_R11" }, prompt: "PROMPT_R11" } } } } })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("REQUEST_R11"))
    assert.ok(!text.includes("PROMPT_R11"))
    const events = await allLines(dir)
    // Plugin Error text is structural-only: the class name stays diagnostic,
    // arbitrary message/stack (which may embed request data) are withheld.
    assert.equal(events[1].error.name, "Error")
    assert.equal(events[1].error.message, undefined)
    assert.equal(events[1].error.request, undefined)
    assert.equal(events[1].error.prompt, undefined)
  })
  it("R11-01: excluded and unknown keys are never read (hostile getters)", async () => {
    const dir = await ensureDir("r11-01-hostile")
    const logger = makeLogger(dir)
    let touched = 0
    const trap = () => {
      touched++
      throw new Error("trap")
    }
    logger.log({
      type: "provider.error",
      error: { code: "Ok", get prompt() { return trap() }, get request() { return trap() }, get description() { return trap() } },
    })
    logger.log({ type: "plugin.error", error: { get prompt() { return trap() }, get request() { return trap() }, ok: 1 } })
    await logger.flush()
    assert.equal(touched, 0)
    assert.equal(logger.state.failed, false)
    const [a, b] = await allLines(dir)
    assert.equal(a.error.code, "Ok")
    assert.equal(b.error.ok, 1)
  })
})

describe("R13 regressions: fail-closed bodies and wrapped host errors (R11-01)", () => {
  // Exact R13 reproduction definitions (archive/2026-11.md, R13).
  const envelope = {
    error: {
      code: "BadRequest",
      prompt: "PROMPT_SENTINEL_R13",
      messages: [{ content: "HISTORY_SENTINEL_R13" }],
      request: { body: "REQUEST_SENTINEL_R13" },
    },
  }
  const host = (body: string) => ({ type: "provider.bad-request", response: { body } })
  const MARKERS = ["PROMPT_SENTINEL_R13", "HISTORY_SENTINEL_R13", "REQUEST_SENTINEL_R13"]
  const assertNoMarkers = async (dir: string) => {
    const text = await rawText(dir)
    for (const marker of MARKERS) assert.ok(!text.includes(marker), `${marker} persisted`)
  }

  it("R13 case 1: host envelope body never persists request data (both modes)", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r13-case1-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      logger.log({ type: "provider.error", error: host(JSON.stringify(envelope)) })
      await logger.flush()
      await assertNoMarkers(dir)
      const [event] = await allLines(dir)
      // Vetted structural evidence survives the reduction.
      assert.equal(event.error.type, "provider.bad-request")
      assert.equal(event.error.code, "BadRequest")
      if (capture) {
        assert.equal(event.error.details.error.code, "BadRequest")
        assert.equal(event.error.details.error.prompt, undefined)
        assert.equal(event.error.details.error.messages, undefined)
        assert.equal(event.error.details.error.request, undefined)
      } else assert.equal(event.error.details, undefined)
    }
  })
  it("R13 case 2: oversized JSON body fails closed, never a raw text excerpt", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r13-case2-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      logger.log({ type: "provider.error", error: host(JSON.stringify({ ...envelope, padding: "x".repeat(70_000) })) })
      // Leading whitespace/BOM must not bypass the structured-prefix check.
      logger.log({ type: "provider.error", error: host(` \n\uFEFF${JSON.stringify({ ...envelope, padding: "x".repeat(70_000) })}`) })
      await logger.flush()
      await assertNoMarkers(dir)
      const events = await allLines(dir)
      for (const event of events) {
        if (capture) {
          assert.equal(event.error.details.withheld, true)
          assert.equal(event.error.details.text, undefined)
        } else assert.equal(event.error.details, undefined)
      }
    }
  })
  it("R13 case 3: array JSON body fails closed, never a raw text excerpt", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r13-case3-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      logger.log({ type: "provider.error", error: host(JSON.stringify([envelope])) })
      await logger.flush()
      await assertNoMarkers(dir)
      const [event] = await allLines(dir)
      assert.equal(event.error.code, undefined) // parseBody: arrays carry no code
      if (capture) {
        assert.equal(event.error.details.withheld, true)
        assert.equal(event.error.details.text, undefined)
      } else assert.equal(event.error.details, undefined)
    }
  })
  it("R13 case 4: plugin.error wrapping a host error reduces it structurally (both modes)", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r13-case4-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      logger.log({ type: "plugin.error", error: { cause: host(JSON.stringify(envelope)) } })
      await logger.flush()
      await assertNoMarkers(dir)
      const [event] = await allLines(dir)
      assert.equal(event.error.cause.type, "provider.bad-request")
      assert.equal(event.error.cause.code, "BadRequest")
      assert.equal(event.error.cause.response, undefined)
      assert.equal(event.error.cause.details, undefined) // plugin path: no opt-in body details
    }
  })
  it("R13 case 5: provider.error wrapping a host error never copies the body (both modes)", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r13-case5-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      logger.log({ type: "provider.error", error: { cause: host(JSON.stringify(envelope)) } })
      await logger.flush()
      await assertNoMarkers(dir)
      const [event] = await allLines(dir)
      if (capture) {
        assert.equal(event.error.cause.type, "provider.bad-request")
        assert.equal(event.error.cause.code, "BadRequest")
        assert.equal(event.error.cause.response, undefined)
      } else {
        // Capture-off unknown shapes keep the structural allowlist only.
        assert.equal(event.error.cause, undefined)
      }
    }
  })
  it("plugin.error never dumps arbitrary Error message/stack (both modes)", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r13-plugin-errtext-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      const err = new Error(`failed: ${JSON.stringify(envelope)}`)
      err.stack = `Error: failed: ${JSON.stringify(envelope)}\n    at REQUEST_SENTINEL_R13`
      logger.log({ type: "plugin.error", message: "adapter hook failed", error: err })
      // Duck-typed error shapes are treated the same way.
      logger.log({ type: "plugin.error", error: { name: "ProviderError", message: JSON.stringify(envelope), stack: "HISTORY_SENTINEL_R13" } })
      await logger.flush()
      await assertNoMarkers(dir)
      const [first, second] = await allLines(dir)
      assert.equal(first.error.name, "Error")
      assert.equal(first.error.message, undefined)
      assert.equal(first.error.stack, undefined)
      assert.equal(first.message, "adapter hook failed") // explicit plugin channel stays
      assert.equal(second.error.name, "ProviderError")
      assert.equal(second.error.message, undefined)
      assert.equal(second.error.stack, undefined)
    }
  })
  it("Error instances with cause/response attachments stay structural (both modes)", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r13-error-attach-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      // Non-enumerable ES2022 cause wrapping a host error.
      logger.log({ type: "plugin.error", error: new Error("boom", { cause: host(JSON.stringify(envelope)) }) })
      // Host response attached to an Error instance (plugin and provider paths).
      logger.log({ type: "plugin.error", error: Object.assign(new Error("boom"), host(JSON.stringify(envelope))) })
      logger.log({ type: "provider.error", error: Object.assign(new Error("boom"), host(JSON.stringify(envelope))) })
      await logger.flush()
      await assertNoMarkers(dir)
      const events = await allLines(dir)
      assert.equal(events[1].error.code, "BadRequest")
      assert.equal(events[1].error.response, undefined)
      assert.equal(events[2].error.code, "BadRequest")
      assert.equal(events[2].error.response, undefined)
    }
  })
  it("deeply nested and array-wrapped host errors are reduced (opt-in walker)", async () => {
    const dir = await ensureDir("r13-nested-wrappers")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({ type: "provider.error", error: { a: { b: host(JSON.stringify(envelope)) } } })
    logger.log({ type: "provider.error", error: [host(JSON.stringify(envelope))] })
    logger.log({ type: "plugin.error", error: { cause: { cause: host(JSON.stringify(envelope)) } } })
    await logger.flush()
    await assertNoMarkers(dir)
    const [first, second, third] = await allLines(dir)
    assert.equal(first.error.a.b.code, "BadRequest")
    assert.equal(first.error.a.b.response, undefined)
    assert.equal(second.error[0].code, "BadRequest")
    assert.equal(second.error[0].response, undefined)
    assert.equal(third.error.cause.cause.code, "BadRequest")
    assert.equal(third.error.cause.cause.response, undefined)
  })
  it("oversized plain-text bodies keep the bounded redacted excerpt (supported free text)", async () => {
    const dir = await ensureDir("r13-oversized-text")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({ type: "provider.error", error: host(`upstream said Bearer abc123SECRET ${"x".repeat(70_000)}`) })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("abc123SECRET"))
    const [event] = await allLines(dir)
    assert.ok(event.error.details.text.length <= 1024 + "...[truncated]".length)
    assert.ok(event.error.details.text.includes("[redacted]"))
  })
  it("hostile getters on wrapped host errors degrade safely", async () => {
    const dir = await ensureDir("r13-hostile-wrapper")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    let touched = 0
    const trap = () => {
      touched++
      throw new Error("trap")
    }
    logger.log({ type: "plugin.error", error: { cause: { get response() { return trap() } } } })
    logger.log({ type: "provider.error", error: { cause: { get response() { return trap() } } } })
    await logger.flush()
    assert.equal(logger.state.failed, false)
    const [first, second] = await allLines(dir)
    assert.equal(first.error.cause, "[unreadable]")
    assert.equal(second.error.cause, "[unreadable]")
    assert.equal(touched, 2) // read once per wrapper, then degraded — no throw
  })
})

describe("R15 regressions: truncated/BOM structured bodies fail closed (R11-01)", () => {
  // Exact R13/R15 reproduction definitions (archive/2026-11.md, R13 and R15).
  const envelope = {
    error: {
      code: "BadRequest",
      prompt: "PROMPT_SENTINEL_R13",
      messages: [{ content: "HISTORY_SENTINEL_R13" }],
      request: { body: "REQUEST_SENTINEL_R13" },
    },
  }
  const host = (body: string) => ({ type: "provider.bad-request", response: { body } })
  const MARKERS = ["PROMPT_SENTINEL_R13", "HISTORY_SENTINEL_R13", "REQUEST_SENTINEL_R13"]
  const assertNoMarkers = async (dir: string) => {
    const text = await rawText(dir)
    for (const marker of MARKERS) assert.ok(!text.includes(marker), `${marker} persisted`)
  }
  // The three exact R15 bodies: truncated object, truncated array, short BOM.
  const r15Bodies: ReadonlyArray<readonly [string, string]> = [
    ["truncated-object", JSON.stringify(envelope).slice(0, -1)],
    ["truncated-array", JSON.stringify([envelope]).slice(0, -1)],
    ["short-BOM-object", "\uFEFF" + JSON.stringify(envelope)],
  ]

  it("R15: all 12 capture=true real-file cases never persist request data", async () => {
    // 3 bodies x provider.error/retry.decision x direct/cause-wrapped.
    for (const [kind, body] of r15Bodies) {
      for (const type of ["provider.error", "retry.decision"] as const) {
        for (const wrapped of [false, true]) {
          const dir = await ensureDir(`r15-${kind}-${type}-${wrapped ? "wrap" : "direct"}`)
          const logger = makeLogger(dir, { captureErrorDetails: true })
          logger.log({ type, error: wrapped ? { cause: host(body) } : host(body) })
          await logger.flush()
          await assertNoMarkers(dir)
        }
      }
    }
  })
  it("R15: truncated bodies fail closed with a marker; structural type survives", async () => {
    for (const [kind, body] of r15Bodies.slice(0, 2)) {
      const dir = await ensureDir(`r15-shape-${kind}`)
      const logger = makeLogger(dir, { captureErrorDetails: true })
      logger.log({ type: "provider.error", error: host(body) })
      logger.log({ type: "retry.decision", error: { cause: host(body) } })
      await logger.flush()
      const [direct, wrapped] = await allLines(dir)
      assert.equal(direct.error.type, "provider.bad-request")
      assert.equal(direct.error.details.withheld, true)
      assert.equal(direct.error.details.text, undefined)
      assert.equal(wrapped.error.cause.details.withheld, true)
      assert.equal(wrapped.error.cause.details.text, undefined)
    }
  })
  it("R15: BOM-normalized valid envelope keeps vetted code evidence (capture useful)", async () => {
    const dir = await ensureDir("r15-bom-useful")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({ type: "provider.error", error: host("\uFEFF" + JSON.stringify(envelope)) })
    await logger.flush()
    await assertNoMarkers(dir)
    const [event] = await allLines(dir)
    assert.equal(event.error.code, "BadRequest")
    assert.equal(event.error.details.error.code, "BadRequest")
    assert.equal(event.error.details.error.prompt, undefined)
    assert.equal(event.error.details.error.messages, undefined)
    assert.equal(event.error.details.error.request, undefined)
  })
  it("R15: capture-off and plugin controls stay structural for all three bodies", async () => {
    for (const [kind, body] of r15Bodies) {
      const off = await ensureDir(`r15-off-${kind}`)
      const offLogger = makeLogger(off)
      offLogger.log({ type: "provider.error", error: host(body) })
      offLogger.log({ type: "retry.decision", error: { cause: host(body) } })
      await offLogger.flush()
      await assertNoMarkers(off)
      for (const event of await allLines(off)) assert.equal(event.error.details, undefined)

      for (const capture of [false, true]) {
        const dir = await ensureDir(`r15-plugin-${kind}-${capture ? "on" : "off"}`)
        const logger = makeLogger(dir, { captureErrorDetails: capture })
        logger.log({ type: "plugin.error", error: host(body) })
        logger.log({ type: "plugin.error", error: { cause: host(body) } })
        await logger.flush()
        await assertNoMarkers(dir)
        for (const event of await allLines(dir)) {
          assert.equal(event.error.details, undefined)
          assert.equal(event.error.cause?.details, undefined)
          assert.equal(event.error.response, undefined)
          assert.equal(event.error.cause?.response, undefined)
        }
      }
    }
  })
  it("R15 nearby: truncation/BOM variants never leak across paths and capture modes", async () => {
    const json = JSON.stringify(envelope)
    const nearby: ReadonlyArray<readonly [string, string]> = [
      ["half-truncated", json.slice(0, Math.floor(json.length / 2))],
      ["cut-inside-prompt", json.slice(0, json.indexOf("PROMPT_SENTINEL_R13") + 6)],
      ["truncated-array-ws-bom", " \n\uFEFF" + JSON.stringify([envelope]).slice(0, -1)],
      ["bom-ws-object", "\uFEFF \n" + json],
      ["multi-bom", "\uFEFF\uFEFF" + json],
      ["bom-array", "\uFEFF" + JSON.stringify([envelope])],
      ["trailing-bom", json + "\uFEFF"],
      ["malformed-object", '{"error":{"code":"BadRequest","prompt":"PROMPT_SENTINEL_R13"'],
      ["truncated-json-string", '"PROMPT_SENTINEL_R13 HISTORY_SENTINEL_R13 REQUEST_SENTINEL_R13'],
    ]
    for (const [kind, body] of nearby) {
      for (const capture of [false, true]) {
        const dir = await ensureDir(`r15-nearby-${kind}-${capture ? "on" : "off"}`)
        const logger = makeLogger(dir, { captureErrorDetails: capture })
        logger.log({ type: "provider.error", error: host(body) })
        logger.log({ type: "retry.decision", error: { cause: host(body) } })
        logger.log({ type: "plugin.error", error: { cause: host(body) } })
        await logger.flush()
        await assertNoMarkers(dir)
      }
    }
  })
  it("R15 nearby: unparseable structured bodies fail closed (no raw excerpt)", async () => {
    const json = JSON.stringify(envelope)
    const unparseable = [
      json.slice(0, Math.floor(json.length / 2)),
      " \n\uFEFF" + JSON.stringify([envelope]).slice(0, -1),
      "\uFEFF" + JSON.stringify([envelope]),
      json + "\uFEFF",
      '{"error":{"code":"BadRequest","prompt":"PROMPT_SENTINEL_R13"',
      '"PROMPT_SENTINEL_R13 HISTORY_SENTINEL_R13 REQUEST_SENTINEL_R13',
    ]
    const dir = await ensureDir("r15-nearby-failclosed")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    for (const body of unparseable) logger.log({ type: "provider.error", error: host(body) })
    await logger.flush()
    const events = await allLines(dir)
    assert.equal(events.length, unparseable.length)
    for (const event of events) {
      assert.equal(event.error.details.withheld, true, JSON.stringify(event.error.details))
      assert.equal(event.error.details.text, undefined)
    }
  })
  it("R15 nearby: BOM-normalized valid envelopes reduce with code evidence", async () => {
    const dir = await ensureDir("r15-nearby-bom-valid")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({ type: "provider.error", error: host("\uFEFF \n" + JSON.stringify(envelope)) })
    logger.log({ type: "provider.error", error: host("\uFEFF\uFEFF" + JSON.stringify(envelope)) })
    await logger.flush()
    await assertNoMarkers(dir)
    for (const event of await allLines(dir)) {
      assert.equal(event.error.code, "BadRequest")
      assert.equal(event.error.details.error.code, "BadRequest")
    }
  })
  it("R15: plain-text and scalar-JSON channels keep bounded redacted text", async () => {
    const dir = await ensureDir("r15-text-channels")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({ type: "provider.error", error: host("upstream said Bearer abc123SECRET then failed") })
    logger.log({ type: "provider.error", error: host('"plain diagnostic text"') })
    logger.log({ type: "provider.error", error: host("42") })
    logger.log({ type: "provider.error", error: host("null") })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("abc123SECRET"))
    const [prose, str, num, nul] = await allLines(dir)
    assert.ok(prose.error.details.text.includes("[redacted]"))
    assert.equal(str.error.details.text, '"plain diagnostic text"')
    assert.equal(num.error.details.text, "42")
    assert.equal(nul.error.details.text, "null")
  })
  it("R15: parse bound holds for truncated/BOM bodies (actual parser invocations)", async () => {
    // Observe JSON.parse during the synchronous log() call: the bound must
    // hold before parseBody/bodyDetails for truncated and BOM-prefixed
    // structured bodies, with capture on AND off (preserves R11-04).
    for (const capture of [false, true]) {
      for (const size of [65_535, 65_536, 65_537, 200_000]) {
        const full = JSON.stringify({ ...envelope, padding: "x".repeat(size) })
        const bodies = [full.slice(0, size), "\uFEFF" + full.slice(0, size - 1)]
        for (const [i, body] of bodies.entries()) {
          const dir = await ensureDir(`r15-parse-bound-${capture ? "on" : "off"}-${size}-${i}`)
          const logger = makeLogger(dir, { captureErrorDetails: capture })
          const originalParse = JSON.parse
          const seen: number[] = []
          JSON.parse = (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
            seen.push(text.length)
            return originalParse(text, reviver)
          }
          try {
            logger.log({ type: "provider.error", error: host(body) })
          } finally {
            JSON.parse = originalParse
          }
          await logger.flush()
          assert.ok(seen.every((n) => n <= 65_536), `JSON.parse saw ${Math.max(...seen)} (capture=${capture}, size=${size})`)
          await assertNoMarkers(dir)
          const [event] = await allLines(dir)
          if (capture && body.length > 65_536) {
            assert.equal(event.error.details.withheld, true)
            assert.equal(event.error.details.text, undefined)
          }
        }
      }
    }
  })
})

describe("R11 regressions: default structural-only withholding", () => {
  it("R11-02: unknown arrays are withheld by default, bounded with opt-in", async () => {
    const dir = await ensureDir("r11-02-array-off")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error", error: ["FREE_TEXT_R11"] })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("FREE_TEXT_R11"))
    assert.ok(String((await allLines(dir))[0].error).includes("[withheld"))

    const dir2 = await ensureDir("r11-02-array-on")
    const logger2 = makeLogger(dir2, { captureErrorDetails: true })
    logger2.log({ type: "provider.error", error: ["FREE_TEXT_R11", 42] })
    await logger2.flush()
    const [event2] = await allLines(dir2)
    assert.deepEqual(event2.error, ["FREE_TEXT_R11", 42]) // explicit opt-in, still bounded
  })
  it("R11-02: free-text and credential-shaped body codes are never logged as code", async () => {
    for (const capture of [false, true]) {
      const dir = await ensureDir(`r11-02-code-${capture ? "on" : "off"}`)
      const logger = makeLogger(dir, { captureErrorDetails: capture })
      logger.log({ type: "provider.error", error: { type: "x", status: 400, response: { body: '{"code":"FREE TEXT FROM PROVIDER_R11"}' } } })
      logger.log({ type: "provider.error", error: { type: "x", status: 400, response: { body: '{"code":"sk-abcdefgh12345678"}' } } })
      logger.log({ type: "provider.error", error: { type: "x", status: 400, response: { body: '{"code":"Throttling.RateQuota"}' } } })
      await logger.flush()
      const text = await rawText(dir)
      assert.ok(!text.includes("FREE TEXT FROM PROVIDER_R11"))
      assert.ok(!text.includes("sk-abcdefgh12345678"))
      const events = await allLines(dir)
      assert.equal(events[0].error.code, undefined)
      assert.equal(events[1].error.code, undefined)
      assert.equal(events[2].error.code, "Throttling.RateQuota") // vetted codes survive
      if (capture) {
        assert.equal(events[0].error.details.code, undefined)
        assert.equal(events[1].error.details.code, undefined)
      }
    }
  })
  it("R11-02: free-text host type is withheld; structural allowlist keeps vetted fields", async () => {
    const dir = await ensureDir("r11-02-allowlist")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error", error: { type: "free text type", status: 400 } })
    logger.log({
      type: "provider.error",
      error: {
        code: "SomeCode",
        requestId: "req-123",
        retryAfterMs: 5000,
        error: { code: "InnerCode", status: 400, message: "SECRET" },
        description: "SECRET",
        details: ["SECRET"],
        request: { data: { input: "SECRET" } },
      },
    })
    const err = new Error("SECRET message") as Error & { code?: string }
    err.code = "SomeCode"
    logger.log({ type: "provider.error", error: err })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("SECRET"))
    assert.ok(!text.includes("free text type"))
    const [first, second, third] = await allLines(dir)
    assert.equal(first.error.type, undefined)
    assert.equal(first.error.status, 400)
    assert.equal(second.error.code, "SomeCode")
    assert.equal(second.error.requestId, "req-123")
    assert.equal(second.error.retryAfterMs, 5000)
    assert.equal(second.error.error.code, "InnerCode")
    assert.equal(second.error.error.status, 400)
    assert.equal(second.error.error.message, undefined)
    assert.equal(second.error.description, undefined)
    assert.equal(second.error.details, undefined)
    assert.equal(second.error.request, undefined)
    assert.equal(third.error.name, "Error")
    assert.equal(third.error.code, "SomeCode")
    assert.equal(third.error.message, undefined)
  })
})

describe("R11 regressions: redaction robustness", () => {
  it("R11-03: serialized header secrets (x-api-key, set-cookie) are redacted in captured text", async () => {
    const dir = await ensureDir("r11-03-headers")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({
      type: "provider.error",
      error: {
        type: "x",
        message: 'headers were {"x-api-key":"HEADER_SECRET_R11"} and {"set-cookie":"sid=COOKIE_SECRET_R11"}',
      },
    })
    logger.log({ type: "plugin.error", message: "x-api-key: HEADER_SECRET_R11\r\nSet-Cookie: sid=COOKIE_SECRET_R11" })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("HEADER_SECRET_R11"))
    assert.ok(!text.includes("COOKIE_SECRET_R11"))
  })
  it("R11-03: truncation never reveals a quoted credential prefix (1024 and 64KiB cuts)", async () => {
    const dir = await ensureDir("r11-03-cut")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    // Cut by the 1024-char text fallback (closing quote removed by the slice).
    logger.log({ type: "provider.error", error: { type: "x", response: { body: `api_key="${"LONG_CREDENTIAL_R11".repeat(100)}"` } } })
    // Cut by the 64KiB redaction window mid-value (no whitespace at all).
    logger.log({ type: "provider.error", error: { type: "x", response: { body: `api_key="${"A".repeat(70_000)}" tail` } } })
    // Key token straddling the 64KiB window boundary after whitespace.
    logger.log({ type: "provider.error", error: { type: "x", response: { body: `${"p ".repeat(32_765)}api_key="${"BOUNDARY_SECRET_R11".repeat(20)}"` } } })
    // Unterminated quoted value at end of input (no truncation involved).
    logger.log({ type: "provider.error", error: { type: "x", response: { body: 'api_key="UNTERMINATED_SECRET_R11' } } })
    // JSON form cut inside a captured message.
    logger.log({ type: "provider.error", error: { type: "x", message: `{"x-api-key":"${"M".repeat(3_000)}` } })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("LONG_CREDENTIAL_R11"))
    assert.ok(!text.includes("AAAAAAAAAAAAAAAA"))
    assert.ok(!text.includes("BOUNDARY_SECRET_R11"))
    assert.ok(!text.includes("UNTERMINATED_SECRET_R11"))
    assert.ok(!text.includes("MMMMMMMMMMMMMMMM"))
    const events = await allLines(dir)
    assert.ok(events[0].error.details.text.includes("[redacted]"))
    assert.ok(events[1].error.details.text.includes("[redacted]"))
  })
})

describe("R11 regressions: output key sanitization", () => {
  it("R11-05: credential-bearing object keys are redacted (URL userinfo/query, bearer, sk-)", async () => {
    const dir = await ensureDir("r11-05-keys")
    const logger = makeLogger(dir)
    logger.log({
      type: "plugin.error",
      error: {
        "https://user:PASSWORD_R11@example.test/p?q=QUERY_R11": 1,
        "Bearer abcSECRET123": "v",
        "sk-abcdefgh12345678": 2,
      },
    })
    await logger.flush()
    const text = await rawText(dir)
    for (const marker of ["PASSWORD_R11", "QUERY_R11", "abcSECRET123", "sk-abcdefgh12345678"]) {
      assert.ok(!text.includes(marker), marker)
    }
    const [event] = await allLines(dir)
    const keys = Object.keys(event.error)
    assert.ok(keys.some((key) => key.includes("[redacted]@example.test")))
    assert.ok(keys.includes("[redacted-key]"))
    assert.equal(event.error["[redacted-key]"], 2)
  })
  it("R11-03: no-whitespace hard cuts never leak URL/JWT/sk- prefixes", async () => {
    const dir = await ensureDir("r11-03-hardcut")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    // Delimiters that trigger redaction (@, dots) lie beyond the 64KiB window.
    logger.log({ type: "provider.error", error: { type: "x", message: `https://u:${"U".repeat(70_000)}@h/p` } })
    logger.log({ type: "provider.error", error: { type: "x", message: `eyJ${"B".repeat(70_000)}` } })
    logger.log({ type: "provider.error", error: { type: "x", message: `sk-${"S".repeat(70_000)}` } })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("U".repeat(64)))
    assert.ok(!text.includes("B".repeat(64)))
    assert.ok(!text.includes("S".repeat(64)))
  })
  it("R11-05: oversized credential keys are redacted and bounded", async () => {
    const dir = await ensureDir("r11-05-bigkey")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", error: { [`https://u:${"P".repeat(100_000)}@h/q`]: 1 } })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("P".repeat(64)))
    const [event] = await allLines(dir)
    const keys = Object.keys(event.error)
    assert.equal(keys.length, 1)
    assert.ok(keys[0]!.length <= 256 + "...[truncated]".length + 3)
  })
  it("R11-05: sanitized key collisions stay distinct; prototype/empty keys are safe", async () => {
    const dir = await ensureDir("r11-05-collisions")
    const logger = makeLogger(dir)
    logger.log({
      type: "plugin.error",
      error: {
        "https://u:USERINFO_ONE_R11@h/q?a=1": 1,
        "https://u:USERINFO_TWO_R11@h/q?a=2": 2,
        "": 3,
        ["k".repeat(5_000)]: 4,
      },
    })
    logger.log({ type: "plugin.error", error: { ["__proto__"]: { polluted: "yes" }, constructor: "x", prototype: "y" } })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("USERINFO_ONE_R11"))
    assert.ok(!text.includes("USERINFO_TWO_R11"))
    assert.equal(logger.state.failed, false)
    const [first, second] = await allLines(dir)
    const keys = Object.keys(first.error)
    assert.equal(keys.length, 4)
    assert.equal(new Set(keys).size, 4) // collision suffix keeps entries distinct
    assert.ok(keys.some((key) => key.endsWith("~2")))
    assert.ok(keys.includes("[empty-key]"))
    assert.ok(keys.every((key) => key.length <= 256 + "...[truncated]".length + 3))
    assert.equal(first.error["[empty-key]"], 3)
    // JSON-origin __proto__ is a plain own property: no prototype pollution.
    assert.equal(Object.prototype.hasOwnProperty.call(second.error, "__proto__"), true)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
    assert.equal(second.error.constructor, "x")
  })
})

describe("privacy: redaction forms", () => {
  it("redacts credential keys recursively at any depth", async () => {
    const dir = await ensureDir("redact-keys")
    const logger = makeLogger(dir)
    logger.log({
      type: "plugin.error",
      error: {
        apiKey: "S1",
        api_key: "S2",
        "API-KEY": "S3",
        "x-api-key": "S4",
        Authorization: "S5",
        token: "S6",
        access_token: "S7",
        refreshToken: "S8",
        password: "S9",
        passwd: "S10",
        cookie: "S11",
        "set-cookie": "S12",
        secret: "S13",
        client_secret: "S14",
        accessKey: "S15",
        secretKey: "S16",
        privateKey: "S17",
        nested: { deep: { authorization: "S18", harmless: "kept" } },
      },
    })
    await logger.flush()
    const text = await rawText(dir)
    for (let i = 1; i <= 18; i++) assert.ok(!text.includes(`"S${i}"`), `S${i} leaked`)
    assert.ok(text.includes("[redacted]"))
    const [event] = await allLines(dir)
    assert.equal(event.error.nested.deep.harmless, "kept")
  })
  it("redacts bearer and basic tokens in text", async () => {
    const dir = await ensureDir("redact-bearer")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", message: "Authorization: Bearer abcDEF123+/= and Basic dXNlcjpwYXNzSECRET" })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("abcDEF123"))
    assert.ok(!text.includes("dXNlcjpwYXNzSECRET"))
  })
  it("redacts key=value and JSON secret forms in text", async () => {
    const dir = await ensureDir("redact-kv")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", message: 'api_key=SECRET1 {"api_key": "SECRET2"} password: SECRET3 token=SECRET4' })
    await logger.flush()
    const text = await rawText(dir)
    for (const secret of ["SECRET1", "SECRET2", "SECRET3", "SECRET4"]) assert.ok(!text.includes(secret))
  })
  it("redacts cookie headers", async () => {
    const dir = await ensureDir("redact-cookie")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", message: "Cookie: sid=SECRET1; other=SECRET2\r\nSet-Cookie: a=SECRET3" })
    await logger.flush()
    const text = await rawText(dir)
    for (const secret of ["SECRET1", "SECRET2", "SECRET3"]) assert.ok(!text.includes(secret))
  })
  it("redacts common API key formats and JWTs", async () => {
    const dir = await ensureDir("redact-formats")
    const logger = makeLogger(dir)
    logger.log({
      type: "plugin.error",
      message: "sk-abcdefgh12345678 AKIA1234567890ABCDEF eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature",
    })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("sk-abcdefgh12345678"))
    assert.ok(!text.includes("AKIA1234567890ABCDEF"))
    assert.ok(!text.includes("eyJhbGciOiJIUzI1NiJ9"))
    assert.ok(text.includes("[redacted-key]"))
    assert.ok(text.includes("[redacted-jwt]"))
  })
  it("redacts URL userinfo, query and fragment but keeps host/path", async () => {
    const dir = await ensureDir("redact-url")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", message: "see https://user:pass@example.com/path?token=SECRET&x=1#frag now" })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("user:pass"))
    assert.ok(!text.includes("SECRET"))
    assert.ok(!text.includes("#frag"))
    assert.ok(text.includes("example.com/path"))
    assert.ok(text.includes("[redacted]@"))
  })
  it("redacts URLs inside opt-in body details", async () => {
    const dir = await ensureDir("redact-url-body")
    const logger = makeLogger(dir, { captureErrorDetails: true })
    logger.log({
      type: "provider.error",
      error: { type: "x", response: { body: '{"message":"visit https://u:p@h/p?k=SECRET"}' } },
    })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("SECRET"))
    assert.ok(!text.includes("u:p@"))
  })
  it("redacts header-shaped objects", async () => {
    const dir = await ensureDir("redact-headers")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", error: { headers: { authorization: "Bearer SECRET1", "x-api-key": "SECRET2" } } })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(!text.includes("SECRET1"))
    assert.ok(!text.includes("SECRET2"))
  })
})

describe("bounds and malformed input", () => {
  it("truncates long strings with a marker", async () => {
    const dir = await ensureDir("bound-string")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", message: "z".repeat(100_000) })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.ok(event.message.length <= MAX_STRING_CHARS + "...[truncated]".length)
    assert.ok(event.message.endsWith("...[truncated]"))
  })
  it("caps nesting depth", async () => {
    const dir = await ensureDir("bound-depth")
    const logger = makeLogger(dir)
    let deep: any = { leaf: true }
    for (let i = 0; i < 50; i++) deep = { next: deep }
    logger.log({ type: "plugin.error", error: deep })
    await logger.flush()
    assert.ok((await rawText(dir)).includes("[max-depth]"))
  })
  it("caps array length with a marker", async () => {
    const dir = await ensureDir("bound-array")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", error: { items: Array.from({ length: 1000 }, (_v, i) => i) } })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error.items.length, 33)
    assert.match(event.error.items[32], /\+968 more/)
  })
  it("caps object key count with a marker", async () => {
    const dir = await ensureDir("bound-keys")
    const logger = makeLogger(dir)
    const wide: Record<string, number> = {}
    for (let i = 0; i < 200; i++) wide[`key${i}`] = i
    logger.log({ type: "plugin.error", error: wide })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(Object.keys(event.error).length, 33)
    assert.match(event.error["[truncated]"], /168 more keys/)
  })
  it("keeps a literal [truncated] key distinct from the overflow marker", async () => {
    const dir = await ensureDir("bound-marker-collision")
    const logger = makeLogger(dir)
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 31; i++) wide[`k${i}`] = i
    wide["[truncated]"] = "literal"
    wide.last = 1
    logger.log({ type: "plugin.error", error: wide })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error["[truncated]"], "literal")
    assert.equal(event.error["[truncated]~2"], "1 more keys")
    assert.equal(new Set(Object.keys(event.error)).size, Object.keys(event.error).length)
  })
  it("handles cyclic structures", async () => {
    const dir = await ensureDir("bound-cycle")
    const logger = makeLogger(dir)
    const cyclic: any = { name: "loop" }
    cyclic.self = cyclic
    cyclic.list = [cyclic]
    logger.log({ type: "plugin.error", error: cyclic })
    await logger.flush()
    const text = await rawText(dir)
    assert.ok(text.includes("[circular]"))
  })
  it("handles throwing getters and hostile proxies", async () => {
    const dir = await ensureDir("bound-hostile")
    const logger = makeLogger(dir)
    const hostile = {
      get boom(): string {
        throw new Error("getter trap")
      },
      ok: 1,
    }
    const proxy = new Proxy({}, { ownKeys() { throw new Error("ownKeys trap") } })
    logger.log({ type: "plugin.error", error: { hostile, proxy } })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error.hostile.ok, 1)
    assert.equal(event.error.hostile.boom, "[unreadable]")
    assert.equal(event.error.proxy, "[unreadable]")
    assert.equal(logger.state.failed, false)
  })
  it("handles bigint, symbol, function and undefined values", async () => {
    const dir = await ensureDir("bound-exotic")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", error: { big: 10n, sym: Symbol("s"), fn: () => {}, un: undefined, ok: true } })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error.big, "10")
    assert.equal(event.error.ok, true)
    assert.equal(event.error.sym, undefined)
    assert.equal(event.error.fn, undefined)
    assert.equal(event.error.un, undefined)
  })
  it("stringifies non-finite numbers safely", async () => {
    const dir = await ensureDir("bound-nonfinite")
    const logger = makeLogger(dir)
    logger.log({ type: "plugin.error", error: { n: Number.NaN, i: Number.POSITIVE_INFINITY } })
    await logger.flush()
    const [event] = await allLines(dir)
    assert.equal(event.error.n, "NaN")
    assert.equal(event.error.i, "Infinity")
  })
  it("enforces the event byte cap by dropping optional fields", async () => {
    const dir = await ensureDir("bound-event-bytes")
    const logger = makeLogger(dir)
    const big: Record<string, string> = {}
    for (let i = 0; i < 32; i++) big[`key${i}`] = "q".repeat(MAX_STRING_CHARS)
    logger.log({ type: "plugin.error", message: "m".repeat(MAX_STRING_CHARS), reason: "r".repeat(MAX_STRING_CHARS), error: big })
    await logger.flush()
    const files = await ownedFiles(dir)
    assert.equal(files.length, 1)
    const text = await readFile(join(dir, files[0]!), "utf8")
    const line = text.trim()
    assert.ok(Buffer.byteLength(line) <= MAX_EVENT_BYTES)
    const event = JSON.parse(line)
    assert.equal(event.truncated, true)
    assert.match(event.id, UUID_RE)
    assert.match(event.ts, ISO_RE)
  })
  it("terminates on explosive shared-subtree (DAG) input", async () => {
    const dir = await ensureDir("bound-dag")
    const logger = makeLogger(dir)
    let layer: any = { v: 1 }
    for (let d = 0; d < 6; d++) {
      const next: Record<string, unknown> = {}
      for (let k = 0; k < 32; k++) next[`k${k}`] = layer
      layer = next
    }
    logger.log({ type: "plugin.error", error: layer })
    await logger.flush()
    const files = await ownedFiles(dir)
    const text = await readFile(join(dir, files[0]!), "utf8")
    assert.ok(Buffer.byteLength(text.trim()) <= MAX_EVENT_BYTES)
    assert.equal(logger.state.failed, false)
  })
  it("never throws on malformed event inputs", async () => {
    const dir = await ensureDir("bound-malformed-events")
    const logger = makeLogger(dir)
    for (const input of [null, undefined, 42, "text", [], true]) logger.log(input as any)
    await logger.flush()
    assert.equal(logger.state.failed, false)
    const events = await allLines(dir)
    assert.equal(events.length, 6)
    for (const event of events) assert.equal(event.type, "plugin.error")
  })
})

describe("sink: directories, permissions, rotation", () => {
  it("creates nested directories 0700 and files 0600 where supported", async () => {
    if (process.platform === "win32") return
    const dir = dirPath("perm/nested/deep")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error" })
    await logger.flush()
    const dirStat = await stat(dir)
    assert.equal(dirStat.mode & 0o777, 0o700)
    const fileStat = await stat(logger.state.filePath!)
    assert.equal(fileStat.mode & 0o777, 0o600)
  })
  it("rotates within maxFiles and discards the oldest events", async () => {
    const dir = await ensureDir("rotate")
    const logger = makeLogger(dir, { rotation: { maxSizeBytes: 400, maxFiles: 3 } })
    for (let i = 0; i < 30; i++) logger.log({ type: "provider.error", context: { attempt: i } })
    await logger.flush()
    const files = await ownedFiles(dir)
    assert.ok(files.length <= 3, `expected <= 3 files, got ${files.length}`)
    assert.ok(files.length >= 2)
    const events = await allLines(dir)
    assert.ok(events.length < 30)
    assert.ok(!events.some((event) => event.context?.attempt === 0))
    // The newest events live in the active file (rotated names sort after it).
    const active = await lines(logger.state.filePath!)
    assert.equal(active[active.length - 1].context.attempt, 29)
    for (const name of files) {
      const fileStat = await stat(join(dir, name))
      assert.ok(fileStat.size <= 400 + MAX_EVENT_BYTES)
      for (const event of await lines(join(dir, name))) assert.match(event.id, UUID_RE)
    }
  })
  it("supports maxFiles:1 (single bounded file)", async () => {
    const dir = await ensureDir("rotate-one")
    const logger = makeLogger(dir, { rotation: { maxSizeBytes: 300, maxFiles: 1 } })
    for (let i = 0; i < 10; i++) logger.log({ type: "provider.error", context: { attempt: i } })
    await logger.flush()
    const files = await ownedFiles(dir)
    assert.equal(files.length, 1)
    const events = await allLines(dir)
    assert.ok(events.length >= 1 && events.length <= 2)
    const active = await lines(logger.state.filePath!)
    assert.equal(active[active.length - 1].context.attempt, 9)
  })
  it("handles maxSizeBytes:1 without corruption", async () => {
    const dir = await ensureDir("rotate-tiny")
    const logger = makeLogger(dir, { rotation: { maxSizeBytes: 1, maxFiles: 3 } })
    for (let i = 0; i < 8; i++) logger.log({ type: "provider.error", context: { attempt: i } })
    await logger.flush()
    const files = await ownedFiles(dir)
    assert.ok(files.length <= 3)
    const events = await allLines(dir)
    const active = await lines(logger.state.filePath!)
    assert.equal(active[active.length - 1].context.attempt, 7)
    for (const event of events) assert.match(event.id, UUID_RE)
  })
  it("never touches unrelated files during rotation", async () => {
    const dir = await ensureDir("rotate-unrelated")
    await writeFile(join(dir, "unrelated.jsonl"), "keep me\n")
    await writeFile(join(dir, "notes.txt"), "keep me too")
    const logger = makeLogger(dir, { rotation: { maxSizeBytes: 1, maxFiles: 2 } })
    for (let i = 0; i < 5; i++) logger.log({ type: "provider.error" })
    await logger.flush()
    assert.equal(await readFile(join(dir, "unrelated.jsonl"), "utf8"), "keep me\n")
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "keep me too")
  })
  it("refuses a pre-planted symlink at the log file path", async () => {
    const dir = await ensureDir("symlink-file")
    const logger = makeLogger(dir)
    const victim = join(dir, "victim.txt")
    await writeFile(victim, "original content")
    await symlink(victim, logger.state.filePath!)
    logger.log({ type: "provider.error" })
    await logger.flush()
    assert.equal(logger.state.failed, true)
    assert.equal(logger.state.written, 0)
    assert.equal(await readFile(victim, "utf8"), "original content")
    assert.ok((await lstat(logger.state.filePath!)).isSymbolicLink())
  })
  it("refuses a symlinked log directory", async () => {
    const real = await ensureDir("symlink-dir-real")
    const link = dirPath("symlink-dir-link")
    await symlink(real, link)
    const logger = makeLogger(link)
    logger.log({ type: "provider.error" })
    await logger.flush()
    assert.equal(logger.state.failed, true)
    assert.deepEqual(await readdir(real), [])
  })
})

describe("sink: instances, processes, lifecycle", () => {
  it("two instances in one directory own separate complete files", async () => {
    const dir = await ensureDir("two-instances")
    const a = makeLogger(dir)
    const b = makeLogger(dir)
    assert.notEqual(a.state.filePath, b.state.filePath)
    for (let i = 0; i < 10; i++) {
      a.log({ type: "provider.error", context: { sessionID: "a", attempt: i } })
      b.log({ type: "provider.error", context: { sessionID: "b", attempt: i } })
    }
    await a.flush()
    await b.flush()
    assert.equal((await lines(a.state.filePath!)).length, 10)
    assert.equal((await lines(b.state.filePath!)).length, 10)
    const events = await allLines(dir)
    assert.equal(new Set(events.map((event) => event.id)).size, 20)
  })
  it("concurrent processes do not corrupt each other's logs", async () => {
    const dir = await ensureDir("two-processes")
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
    const href = pathToFileURL(join(repoRoot, "dist-test", "src", "logging.js")).href
    const script = `
import { createLogger } from ${JSON.stringify(href)}
const logger = createLogger({ enabled: true, level: "debug", captureErrorDetails: false, rotation: { maxSizeBytes: 1048576, maxFiles: 5 }, directory: ${JSON.stringify(dir)} })
for (let i = 0; i < 20; i++) logger.log({ type: "provider.error", context: { sessionID: "child", attempt: i } })
await logger.flush()
await logger.close()
`
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
    assert.equal(child.status, 0, child.stderr)
    const parent = makeLogger(dir)
    for (let i = 0; i < 20; i++) parent.log({ type: "provider.error", context: { sessionID: "parent", attempt: i } })
    await parent.flush()
    const events = await allLines(dir)
    assert.equal(events.length, 40)
    assert.equal(new Set(events.map((event) => event.id)).size, 40)
    assert.equal(events.filter((event) => event.context.sessionID === "child").length, 20)
    assert.equal(events.filter((event) => event.context.sessionID === "parent").length, 20)
    const files = await ownedFiles(dir)
    assert.equal(files.length, 2)
  })
  it("flush is deterministic and close is idempotent", async () => {
    const dir = await ensureDir("lifecycle")
    const logger = makeLogger(dir)
    for (let i = 0; i < 50; i++) logger.log({ type: "provider.error", context: { attempt: i } })
    await logger.flush()
    assert.equal((await allLines(dir)).length, 50)
    await logger.close()
    assert.equal(logger.state.closed, true)
    logger.log({ type: "provider.error" })
    await logger.flush()
    await logger.close()
    assert.equal((await allLines(dir)).length, 50)
    assert.equal(logger.state.written, 50)
  })
  it("interleaved async producers lose no events", async () => {
    const dir = await ensureDir("concurrent-producers")
    const logger = makeLogger(dir)
    await Promise.all(
      Array.from({ length: 10 }, async (_v, task) => {
        for (let i = 0; i < 20; i++) {
          logger.log({ type: "provider.error", context: { sessionID: `task${task}`, attempt: i } })
          await Promise.resolve()
        }
      }),
    )
    await logger.flush()
    const events = await allLines(dir)
    assert.equal(events.length, 200)
    assert.equal(new Set(events.map((event) => event.id)).size, 200)
  })
})

describe("failure isolation and queue bounds", () => {
  it("fails safely when the directory cannot be created", async () => {
    const blocker = dirPath("init-failure-blocker")
    await writeFile(blocker, "not a directory")
    const logger = makeLogger(join(blocker, "sub"))
    logger.log({ type: "provider.error" })
    await logger.flush()
    assert.equal(logger.state.failed, true)
    assert.ok(logger.state.lastError)
    logger.log({ type: "provider.error" })
    await logger.flush()
    assert.equal(logger.state.written, 0)
  })
  it("isolates mid-run failures and ignores later events", async () => {
    const dir = await ensureDir("midrun-failure")
    const logger = makeLogger(dir)
    logger.log({ type: "provider.error", context: { attempt: 0 } })
    await logger.flush()
    const file = logger.state.filePath!
    await rm(file)
    await mkdir(file) // path is now a directory: appends must fail safely
    logger.log({ type: "provider.error", context: { attempt: 1 } })
    await logger.flush()
    assert.equal(logger.state.failed, true)
    assert.match(logger.state.lastError ?? "", /not a regular file/)
    const written = logger.state.written
    logger.log({ type: "provider.error" })
    await logger.flush()
    assert.equal(logger.state.written, written)
    assert.equal(written, 1)
  })
  it("reports a sink failure via plugin.error when still feasible", async () => {
    const dir = await ensureDir("feasible-report")
    const logger = makeLogger(dir, { rotation: { maxSizeBytes: 1000, maxFiles: 3 } })
    logger.log({ type: "provider.error", context: { attempt: 0 } })
    await logger.flush()
    const file = logger.state.filePath!
    // Block rotation: the oldest rotated name is a non-empty directory.
    await mkdir(`${file}.2`)
    await writeFile(join(`${file}.2`, "blocker"), "x")
    const big: Record<string, string> = {}
    // 7 × 2048 chars stays under MAX_EVENT_BYTES (so the event is kept whole)
    // but far exceeds maxSizeBytes, forcing the blocked rotation.
    for (let i = 0; i < 7; i++) big[`key${i}`] = "q".repeat(MAX_STRING_CHARS)
    logger.log({ type: "plugin.error", error: big }) // forces rotation, which fails
    await logger.flush()
    assert.equal(logger.state.failed, true)
    const events = await lines(file)
    assert.equal(events.length, 2)
    assert.equal(events[1].type, "plugin.error")
    assert.match(events[1].message, /logging sink failed/)
  })
  it("drops overflow events and reports once without recursion", async () => {
    const dir = await ensureDir("queue-overflow")
    const logger = makeLogger(dir)
    const burst = MAX_QUEUE_EVENTS + 150
    for (let i = 0; i < burst; i++) logger.log({ type: "provider.error", context: { attempt: i } })
    assert.ok(logger.state.dropped > 0)
    await logger.flush()
    const events = await allLines(dir)
    const overflow = events.filter((event) => typeof event.message === "string" && event.message.includes("queue overflow"))
    assert.equal(overflow.length, 1)
    assert.equal(events.length, logger.state.written)
    assert.ok(events.length < burst)
    for (const event of events) assert.match(event.id, UUID_RE)
    assert.equal(logger.state.dropped, 0)
  })
})

describe("public exports and core integration", () => {
  it("exposes the logger surface from the package entry", () => {
    assert.equal(typeof publicApi.createLogger, "function")
    assert.equal(typeof publicApi.defaultLogDirectory, "function")
    assert.match(publicApi.PLUGIN_VERSION, /^\d+\.\d+\.\d+$/)
    assert.ok(publicApi.MAX_EVENT_BYTES > 0)
    assert.ok(publicApi.MAX_QUEUE_EVENTS > 0)
    assert.ok(publicApi.MAX_STRING_CHARS > 0)
  })
  it("logs a real core evaluation end-to-end", async () => {
    const dir = await ensureDir("core-integration")
    const config = resolveConfig({ logging: { enabled: true, directory: dir } })
    const logger = track(createLogger(config.logging))
    const error = {
      type: "provider.quota",
      message: "429 Too Many Requests",
      status: 429,
      response: { body: '{"error":{"message":"week allocated quota exceeded"}}' },
    }
    const now = Date.now()
    const decision = publicApi.evaluateQuota(
      { provider: "alibaba", model: "qwen3-max", error, attempt: 1, decision: { retry: false }, now },
      config,
    )
    const classification = publicApi.classifyError(publicApi.normalizeError("alibaba", "qwen3-max", error), config)
    const context = { sessionID: "ses_x", provider: "alibaba", model: "qwen3-max", attempt: 1, source: "session.retry", correlationId: "ses_x:1" }
    logger.log({ type: "provider.error", context, error, category: classification.category, rule: classification.ruleId, matched: classification.provider })
    logger.log({
      type: "retry.decision",
      context,
      category: decision.category,
      original: { retry: false },
      final: decision.action === "retry" ? { retry: true, delay: decision.delayMs } : { retry: false },
      policy: decision.policy,
      delay: decision.action === "retry" ? decision.delayMs : undefined,
      reason: decision.reason,
    })
    await logger.flush()
    const [providerEvent, decisionEvent] = await allLines(dir)
    assert.equal(providerEvent.category, "quota_weekly")
    assert.equal(providerEvent.rule, "alibaba.quota_weekly")
    assert.equal(providerEvent.matched, "alibaba")
    assert.equal(providerEvent.error.code, undefined)
    assert.equal(providerEvent.error.type, "provider.quota")
    assert.equal(decisionEvent.final.retry, true)
    assert.equal(decisionEvent.override, true)
    assert.ok(decisionEvent.delay > 0)
    assert.match(decisionEvent.nextRetryAt, ISO_RE)
    assert.equal(decisionEvent.correlationId, "ses_x:1")
  })
})
