# Quota Matata logging — design spec

Slice: privacy-safe, bounded, reusable JSONL diagnostics module
(`src/logging.ts`), integrated with the core's exports and validated
`logging` config only. Status: implemented. **No OpenCode hook registration
yet** — the adapter slice wires this module to host hooks; nothing here
inspects HTTP requests/responses or registers anything with the host.

The core spec (`specs/core.md`) remains the accepted boundary for the pure
engine; its "logging is shape-only" deferred note is superseded by this
document. The core engine files are unchanged by this slice; the only core
edit is the export surface in `src/index.ts`.

## Goals and non-goals

Goals:

1. Durable-enough, bounded, privacy-safe diagnostic events for quota retries:
   `provider.error`, `retry.decision`, `plugin.error` (unknown errors too).
2. Best effort: logging can never throw into, delay, or fail a request.
3. Safe under concurrency: multiple plugin instances and processes must not
   corrupt each other's logs; bounded memory and disk.
4. Zero new runtime dependencies; Node builtins only; no timers, services,
   databases, or background handles beyond the pending write queue.

Non-goals (later slices / explicitly out): hook registration and adapter
dedup logic (this module only provides the correlation fields), HTTP
body/request inspection, log shipping/aggregation, cleanup of other
processes' old files, guaranteed delivery (events may be dropped).

## Public surface

```ts
createLogger(logging: ResolvedLogging, options?: { pluginVersion?: string }): DiagnosticLogger
defaultLogDirectory(env?, platform?, home?): string   // pure, injectable
PLUGIN_VERSION, MAX_EVENT_BYTES, MAX_QUEUE_EVENTS, MAX_STRING_CHARS

interface DiagnosticLogger {
  log(event: DiagnosticEventInput): void  // never throws
  flush(): Promise<void>                  // drains pending writes
  close(): Promise<void>                  // flush + ignore future events
  readonly state: LoggerState             // enabled/closed/failed/written/dropped/filePath/lastError
}
```

`createLogger` consumes the **existing** resolved config shape unchanged
(`enabled`, `level`, `directory`, `captureErrorDetails`,
`rotation.maxSizeBytes`, `rotation.maxFiles`); no config keys were added.
Creation performs no I/O and never throws; invalid input yields an inert
logger. `enabled: false` (the default) is fully inert: no directory is
created, nothing touches the disk. `flush`/`close` give the later adapter
deterministic cleanup (e.g. in the plugin's returned cleanup function).

`PLUGIN_VERSION` is a constant kept in sync with `package.json` (no runtime
package.json read). `hostVersion` is optional context supplied by the
adapter; no metadata is ever required.

## Event schema (one JSON object per line)

Envelope (always): `id` (random UUID v4, unique per emitted event), `ts`
(UTC ISO-8601, `Date.now()` at construction — the logger is the I/O layer;
core purity is unaffected), `type`, `level`, `pluginVersion`.

Optional top-level: `hostVersion`, `source`, `correlationId` (from context),
`context` `{sessionID?, agent?, provider?, model?, attempt?}`, `error`,
`category`, `rule`, `matched`, `original` `{retry, delay?}`, `final`
`{retry, delay?}`, `override`, `policy`, `delay`, `nextRetryAt`, `reason`,
`message` (plugin.error only), `truncated` (when the byte cap dropped fields).

- `provider.error` (default level `warn`): a provider failure was observed.
- `retry.decision` (default `info`): the engine's decision for a failure.
  `override` is taken from the caller when boolean, otherwise computed from
  `original` vs `final`. `nextRetryAt` = `ts + delay` (or `final.delay`) as
  UTC ISO, only when `final.retry` is true and the instant is inside the
  JavaScript Date range; never formatted otherwise.
- `plugin.error` (default `error`): plugin-owned failures (sink failure,
  queue overflow, adapter errors). Its `error` payload is sanitized and
  bounded, **not** gated by `captureErrorDetails`, but keeps **stable
  structural diagnostics only**: the Error class `name` is kept; arbitrary
  Error `message`/`stack` are withheld in **both** capture modes (exception
  text may embed request payloads); host wire wrappers (`response` records)
  reduce to the structural host allowlist wherever they appear, including
  `cause` chains and Error attachments. Other plugin-supplied values still
  pass the bounded redacting walker. The event's top-level `message` string
  is the **explicit plugin-owned diagnostic text channel** (sanitized,
  bounded) — plugin-authored diagnostics belong there, not in dumped
  exception text. The recursive request-data exclusion applies to every
  nested property (a plugin error may wrap provider/request data).

Correlation for the later adapter: `id` is unique per event; `source`
identifies the host surface (e.g. `session.retry` vs an event-stream
notification) and `correlationId` is a caller-chosen key (e.g.
`sessionID:attempt`) so the adapter can deduplicate the same failure seen
through multiple surfaces. The logger itself never deduplicates.

Levels: `debug < info < warn < error`; events below `logging.level` are
dropped before construction. Unknown event types coerce to `plugin.error`;
invalid levels fall back to the type default. Invalid optional fields are
omitted, never repaired; events with no context/error/metadata are valid.

## Privacy model

Threat model: provider error payloads and host strings are untrusted and may
contain credentials, conversation content, or hostile object shapes. Logs
are local user data, but must not become a credential/conversation store.
The design prefers **conservative allowlists and withholding** over
enumerating unknown payload shapes.

1. **No request data path — recursive, universal.** The API accepts only
   diagnostic events. Request-data keys (`prompt`, `prompts`, `messages`,
   `conversation(s)`, `history`, `chatHistory`, `input(s)`, `request(s)`,
   `requestBody`, `requestData` — normalized case/separator-insensitively)
   are stripped at **every depth, for every event type, regardless of
   `captureErrorDetails`**; they are never even read (hostile-getter safe).
   This covers nested provider envelopes, unknown captured objects, and
   plugin-owned errors/Error attachments alike. The queue holds only
   sanitized serialized strings — never references to caller objects.
2. **Default withhold = structural allowlist.** For
   `provider.error`/`retry.decision` with `captureErrorDetails: false`:
   - Host wire shapes keep only `type`, `status` (100..599), `retryAfterMs`,
     and the provider `code` parsed from the body via the core's `parseBody`
     — and only when the body is within the parse bound (see below).
   - `code`/`type` (and unknown-shape `code`/`type`/`requestId`) must be
     **vetted structural strings**: enum-like tokens
     (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, no whitespace/prose) that are
     stable under redaction. Arbitrary free-text or credential-shaped
     "codes" are withheld, never truncated into the log.
   - Unknown error shapes (no host type/response markers, including Error
     instances) are reduced to the same allowlist: `code`, `type`, `status`,
     `retryAfterMs`, `requestId`, Error class `name`, and recognized `error`
     envelopes reduced recursively with the same allowlist. Every other key
     is withheld without being read. Arrays and bare strings become a
     `[withheld…]` marker. Unknown errors are still logged (structure only).
3. **Opt-in is still sanitized, bounded, and request-data-free.** With
   `captureErrorDetails: true`, the host `message` is redacted/truncated;
   JSON bodies are reduced **recursively** (depth ≤ 4) to a whitelisted error
   envelope (`code`, `message`, `type`, `status`, `error`, `request_id`,
   `requestId`): `code`/`type`/request ids must be vetted structural tokens,
   `message` is redacted bounded free text, nested `error` records recurse
   with the same whitelist, and every other field (prompt, messages,
   request, choices, arbitrary prose) is dropped — never walked. The result
   is capped at 8 KiB serialized. **Response bodies are classified before any
   excerpting, and unsupported structured bodies fail closed** — they are
   withheld, never stringified-then-redacted. After leading whitespace/BOM
   normalization, a body whose first significant character opens a JSON
   object, array, or string (`{`, `[`, `"`) is *structured input*: a parsed
   record is allowlist-reduced; a cleanly parsed JSON string scalar is free
   text; and anything else — parsed arrays, oversized bodies, or bodies that
   cannot be parsed (truncated/malformed, e.g. a JSON envelope missing its
   closing brace) — becomes a `{withheld: true, note}` marker, because a raw
   excerpt could echo prompt/conversation/request data. The BOM is normalized
   **before** bounded parsing so a valid BOM-prefixed envelope still reduces
   (and still yields its vetted code) instead of leaking as text.
   Non-structured plain-text
   bodies (and oversized plain text) keep a redacted excerpt capped at
   1024 chars. Unknown opt-in shapes go through the bounded walker
   (request-data exclusion still applies); host wire wrappers found anywhere
   inside it are reduced through the host allowlist (with opt-in details),
   never walked raw. Opt-in text is never silently unbounded.

   **Free-text diagnostics are a bounded, opt-in feature with a precise
   boundary:** supported only for provider error `message` strings,
   non-JSON plain-text response bodies, and cleanly parsed JSON string
   scalars — never for arbitrary nested payloads. Structured bodies are
   allowlist-reduced or fail closed; a body that merely *looks* structured
   (object/array/string prefix) but cannot be parsed is withheld, not
   excerpted — including prose that happens to start with a double quote.
   Plugin error payloads keep structural diagnostics only (see above).
4. **Parse bound before any JSON work.** Bodies larger than 64 KiB are
   **never** passed to `JSON.parse` — on every path, including capture-off
   code extraction (`parseBody`) and the opt-in envelope/text fallback.
   Leading whitespace/BOM is normalized before classification and before any
   bounded parse (it never widens the bound). Oversized bodies keep only host
   structural fields (capture off); with capture on, structured oversized
   bodies fail closed to a withheld marker and only plain free text keeps a
   bounded redacted excerpt. The accepted core is unchanged; the guard lives
   in the logger.
5. **Redaction (defense-in-depth, not a guarantee).** Recursive credential
   key redaction at any depth (normalized keys containing apikey, token,
   secret, password/passwd, authorization, cookie, credential, privatekey,
   accesskey, … — covers `x-api-key`, `set-cookie`, camelCase, etc.). Text
   redaction: URL userinfo/query/fragment (host/path preserved),
   Bearer/Basic tokens, Cookie/Set-Cookie headers, `key=value` and JSON
   `"key": "value"` secret forms with separator-terminated header prefixes
   (`x-api-key`, `set-cookie`, `x-amz-security-token`, …), `sk-…` keys,
   `AKIA…` keys, JWTs. **Truncation never reveals a secret prefix:** quoted
   secret forms also match unterminated values (a cut closing quote still
   redacts to end of input); redaction always runs before truncation; the
   64 KiB redaction pre-slice cuts at the last whitespace (dropping partial
   tokens) and, for unbroken text, conservatively redacts trailing partial
   URL/JWT/sk-/AKIA fragments whose redaction delimiter lies beyond the
   window. Unknown secret formats can survive redaction — that is why free
   text is withheld by default, bounded, and opt-in.
6. **Never dump raw objects — values or keys.** All values pass the bounded
   walker before serialization; `JSON.stringify` only ever sees walker
   output. **Output object keys are sanitized too** (keys can carry URL
   userinfo/query secrets, bearer/sk- tokens): each key is redacted and
   capped at 256 chars, sensitivity is detected against the *original* key
   name, sanitized-key collisions get a `~2`, `~3`, … suffix, and outputs
   are null-prototype so JSON-origin `__proto__`/`constructor` keys are plain
   own properties, never prototype traps. Hostile getters/proxies degrade to
   `[unreadable]`, cycles to `[circular]`, depth/width overflow to markers;
   functions/symbols/undefined are omitted, bigint/non-finite numbers become
   strings.

### Bounds (fixed constants)

| Bound | Value |
| --- | --- |
| Event line | 16 KiB (`MAX_EVENT_BYTES`); progressive drop: `error.details` → `error.message` → `error` → `reason` → `message` → `context`, then a minimal stub (`truncated: true`) |
| Queue | 256 lines (`MAX_QUEUE_EVENTS`); overflow dropped and reported once via `plugin.error` |
| String value | 2048 chars (`MAX_STRING_CHARS`) + marker; redaction pre-truncates input at 64 KiB (CPU bound, truncation-safe) |
| Object key | 256 chars + marker + collision suffix (`~2`, …); keys redacted like values |
| Walker | depth 6, 32 array items, 32 object keys, 2000 visited nodes per call (DAG/explosion guard) |
| Opt-in payload | 8 KiB envelope; envelope recursion depth 4; 64 KiB parse limit on **every** path (incl. capture-off code extraction); 1024-char text fallback for plain text and parsed JSON string scalars only; array/oversized/truncated/malformed structured bodies fail closed to a withheld marker |
| Context strings | 256 chars (hostVersion 64, source 128) |
| Disk per instance | ≤ `maxFiles` files × (`maxSizeBytes` + one event) |
| Memory | ≤ queue cap × event cap ≈ 4 MiB worst case, plus one in-flight line |

## Sink: files, rotation, permissions, symlinks

- **Directory**: `logging.directory` with leading `~`/`~/` expanded and
  resolved absolute; default `defaultLogDirectory()`: `$XDG_DATA_HOME` when
  set, else platform-normal user data (darwin `~/Library/Application Support`,
  win32 `%LOCALAPPDATA%` → `%APPDATA%` → `~/AppData/Local`, else
  `~/.local/share`) + `quota-matata/logs`. Created lazily on first write,
  recursively, mode **0700**; files created mode **0600** (POSIX; modes are
  best-effort on Windows). Existing directories/files are never chmod'ed.
- **Per-instance ownership**: file name
  `quota-matata-<pid>-<instanceCounter>-<random8>.jsonl`. Live instances and
  processes never share a write target, so appends and rotation cannot
  interleave across owners. Rotation renames only this instance's exact
  names: active → `.1` → … → `.<maxFiles-1>` (oldest unlinked);
  `maxFiles: 1` unlinks the active file and starts fresh. A single event may
  exceed `maxSizeBytes` (rotation happens before the next append), so the
  per-file bound is `maxSizeBytes + one event`.
- **Retention scope**: per instance only. Files of dead processes/previous
  runs are never scanned, rotated, or deleted — they accumulate until the
  user removes them (documented limitation; avoids deleting unrelated data
  and any cross-process coordination). Total disk is bounded per live
  instance, not globally.
- **Symlink protection (best effort)**: the log directory must be a real
  directory (`lstat`, symlink refused); before every append the file path
  must be a regular file or absent (`lstat`, symlink/non-regular refused).
  Refusal fails the sink safely. This defeats pre-planted symlinks; a
  TOCTOU swap between check and write remains theoretically possible and is
  an accepted limitation (the directory is user-owned 0700).
- **No arbitrary file effects**: only the instance's own exact file names
  are ever created, appended, renamed, or unlinked.

## Concurrency and failure model

- `log()` sanitizes + serializes synchronously (bounded CPU), enqueues the
  string, and starts a single serial drain if none is active. One drain at a
  time; appends are awaited sequentially — no write races, no unbounded
  memory, no timers.
- Queue overflow drops the newest events and counts them; the drain writes
  exactly one `plugin.error` overflow report (generated inside the drain, so
  reporting cannot recurse or re-overflow).
- Any I/O failure (mkdir/lstat/append/rename/unlink) permanently disables the
  sink: pending lines are discarded (counted in `dropped`), `lastError` is
  recorded, and exactly one `plugin.error` sink-failure report is attempted
  when still feasible. No retry loops, no recursive logging, no unhandled
  rejections; `log()`/`flush()`/`close()` never throw.
- `flush()` resolves when the queue is drained (or the sink failed);
  `close()` flushes and ignores later events; both are idempotent.
- The core engine stays pure: the logger is a separate module with its own
  clock (`Date.now()` for `ts`) and state; nothing in classify/policy/config
  changed.

## Extension points for the adapter slice

- Pass `context.source` + `context.correlationId` per host surface and dedup
  on them; `id` distinguishes emitted events.
- Supply `hostVersion` when known; `pluginVersion` defaults to the package
  constant.
- Call `flush()`/`close()` from the plugin cleanup; `state` exposes
  failure/drop counters for diagnostics without reading files.
- `captureErrorDetails` remains the user's explicit privacy opt-in.

## Verification

The `test/logging.test.ts` suite covers directory resolution
(XDG/platform/`~`), disabled-no-disk, event schema/correlation/`nextRetryAt`,
level filtering, gating opt-in/out, structural allowlist and vetted-code
withholding, recursive envelope reduction, recursive request-data exclusion
(capture on/off, provider/plugin/unknown shapes, hostile getters), the five
R13 real-file cases in both capture modes (host envelope, oversized JSON,
array JSON, plugin/provider wrapped host errors) with fail-closed markers
and surviving structural evidence, the R15 real-file regressions (all 12
capture=true truncated/BOM cases across provider.error/retry.decision and
direct/cause-wrapped paths; truncated bodies fail closed with a marker;
BOM-normalized envelopes keep vetted code; capture-off/plugin controls;
nearby truncation/BOM variants incl. truncated JSON strings; plain-text and
scalar-JSON channel preservation; the actual parse bound for truncated/BOM
bodies at 65535/65536/65537/200000 in both capture modes), plugin Error
message/stack withholding,
Error cause/response attachments, nested/array-wrapped host reduction,
oversized plain-text excerpt preservation, redaction
forms (keys/bearer/basic/cookies/kv/JSON/header-prefixed/sk-/AKIA/JWT/URLs),
truncation-safe redaction (1024/64 KiB cuts, unterminated quotes, no-whitespace
hard cuts), output-key sanitization (URL/bearer/sk- keys, collisions,
prototype/empty/oversized keys), bounds (strings/depth/arrays/keys/event
bytes/DAG), the actual `JSON.parse` invocation bound (capture on/off, valid
and malformed oversized bodies), malformed/cyclic/hostile getters/proxies/exotic
types, rotation (incl. `maxFiles: 1`, `maxSizeBytes: 1`, unrelated-file
safety), 0700/0600 creation modes, symlinked file/dir refusal, two instances
and two processes in one directory, deterministic flush/close, interleaved
async producers, queue overflow reporting, init/mid-run failure isolation,
feasible failure report, and an end-to-end core `evaluateQuota` → log
integration. Temp dirs live under `/tmp/opencode` and are removed; failures
are injected via filesystem shapes (works as root). Suite passes under
TZ=UTC, America/New_York, Asia/Shanghai, Pacific/Kiritimati.

## Deferred / honest limitations

- No hook registration: nothing calls `createLogger` from host hooks yet.
- Redaction is best-effort pattern matching, not a guarantee; the default
  withhold + bounds are the primary privacy controls.
- Symlink checks are check-then-use (TOCTOU window); directory 0700 is the
  main mitigation. Windows mode bits are best-effort.
- Dead-process files accumulate (per-instance retention scope); no global
  disk quota or cleanup daemon by design.
- Delivery is best effort: overflow/failure drops events (counted in
  `state`); `fsync` is not used, so a crash can lose the last appends.
- One event may exceed `maxSizeBytes` (bounded by `MAX_EVENT_BYTES`).
