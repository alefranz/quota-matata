# Quota Matata publishing — npm release automation spec

Slice: add the required GitHub Actions npm publishing workflow with a safe
explicit release trigger, package/version and verification gates, and
matching README setup instructions. Status: implemented
(`.github/workflows/publish.yml`, README "Publishing (maintainers)").
**Nothing in this slice publishes, stages, or writes to any registry**; all
verification is offline or read-only. Runtime/package identity is unchanged
(`package.json` untouched: name `quota-matata`, version `0.1.0`, exports,
`files`, `engines >= 20`, SDK pin `@opencode/plugin@2.3.0`).

The accepted boundaries remain authoritative: `specs/core.md`,
`specs/logging.md`, `specs/integration.md`. This document covers only the
publication path and its credential model.

## Decision: staged publishing with a stage-only granular token

The workflow stages releases with `npm stage publish`, authenticated by the
GitHub repository secret **`NPM_TOKEN`** (a granular access token with
**Read and write (stage only)**, **Bypass 2FA disabled**). A maintainer must
approve each staged version with 2FA (npmjs.com Staged Packages tab or
`npm stage approve <stage-id>`) before it becomes public. CI never runs
`npm publish` and never approves.

Why this path (evidence below):

- npm removes **direct publishing with granular access tokens in January
  2027**; legacy/classic tokens were already removed in November 2025. A
  direct-`npm publish` workflow built today would be obsolete within weeks
  and would require a Bypass-2FA token (weaker posture).
- npm explicitly recommends stage-only tokens for CI/CD: a leaked or misused
  token cannot put a new version on the registry without maintainer 2FA
  approval. `npm stage publish` never prompts for 2FA (any token type),
  which is what makes it automatable; approval always requires 2FA.
- The user expects a GitHub-secret-based path; staging satisfies that while
  keeping proof-of-presence on every release. Trusted publishing (OIDC) is
  the secret-free alternative and is documented as a future migration, not
  implemented here (see "Alternatives").

## Evidence (fetched/verified 2026-11-15, read-only)

npm public docs:

- `docs.npmjs.com/about-access-tokens` — only granular tokens since Nov
  2025; permissions Read-only / Read-and-write (publish and stage) /
  Read-and-write (stage only); Bypass 2FA defaults false and overrides
  account/package 2FA for publishing when enabled; expiration ≥ 1 day;
  optional CIDR IP allowlists; ≤ 50 packages/scopes per token; org access
  never grants publish rights; **direct token publishing removed January
  2027**; since August 2026 bypass tokens cannot perform account-identity/
  governance actions (token creation, maintainer management, etc.).
- `docs.npmjs.com/creating-and-viewing-access-tokens` — granular tokens are
  created **on the website only** (profile → Access Tokens → Generate New
  Token); exact field list used in the README; full token shown only once.
- `docs.npmjs.com/about-two-factor-authentication` — publishing requires
  account 2FA **or** a bypass-2FA granular token; 2FA uses security keys.
- `docs.npmjs.com/staged-publishing` — works for **new and existing**
  packages; staging a new package publishes a **public placeholder
  `0.0.0-stage`** while staged contents stay private until approval;
  requires **npm CLI ≥ 11.15.0 and Node ≥ 22.14.0**; prerequisites: publish
  access + account 2FA; `npm stage publish` does not require 2FA; approval
  (CLI or website) always prompts 2FA.
- `docs.npmjs.com/cli/v12/commands/npm-stage` (v11 doc agrees) — staged
  versions share the semver unique index with published versions (no
  duplicate version, staged or published); `npm stage publish` respects
  `private: true`; `--tag` defaults to `latest` (prereleases need an explicit
  tag); `--dry-run` supported; token-behavior table: GAT without bypass
  **can stage**; best practices: delete bypass tokens, use stage-only GAT or
  trust relationships, and set package publishing access to "Require
  two-factor authentication and disallow tokens (recommended)".
- `docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification`
  — package-level "Require two-factor authentication and disallow tokens
  (Recommended)" blocks granular tokens for **publishing** regardless of
  bypass setting; default option is "Require 2FA or a bypass-2FA granular
  token". Staging is not publishing: `npm stage publish` never prompts for
  2FA, and approval is an interactive 2FA action (npm-stage docs above).
- `docs.npmjs.com/trusted-publishers` — OIDC alternative: npm ≥ 11.5.1,
  Node ≥ 22.14.0, GitHub-hosted runners only; configured per existing
  package (owner/repo/workflow filename, exact match); `repository.url` in
  package.json must exactly match the GitHub repo; new configurations
  expire unless the first successful publish happens within 2 days;
  automatic provenance only for public repos + public packages.

GitHub public docs:

- `docs.github.com/.../publishing-nodejs-packages` — canonical pattern:
  `release: types: [published]`, secret `NPM_TOKEN` → `NODE_AUTH_TOKEN`,
  `setup-node` `registry-url: https://registry.npmjs.org` writes the
  `.npmrc` auth placeholder; current action majors checkout v6 /
  setup-node v7.

Live read-only checks (2026-11-15):

- `npm view quota-matata version` → **E404**: the name is unclaimed on the
  public registry. First publication will create it; no ownership is
  assumed. A 404 is not a reservation — the name must still be free at
  first staging (which creates the package via the public placeholder).
- Unauthenticated `GET api.github.com/repos/alefranz/quota-matata` → **404**:
  the repository is private or not yet created. Consequence: provenance
  (which requires a public source repo) is **not enabled**; documented as a
  future option.
- Action pins resolved via the GitHub API: `actions/checkout` v6 →
  `d23441a48e516b6c34aea4fa41551a30e30af803`; `actions/setup-node` v7 →
  `949feb2413d6458794dcd2491c4babbbce0c15c1`. Both are commit SHAs, pinned
  in the workflow with tag comments.

## Workflow design (`.github/workflows/publish.yml`)

- **Trigger:** `release: types: [published]` only — an explicit human
  action. No push/tag auto-trigger, no `workflow_dispatch`. Drafts do not
  fire `published`; prereleases fire it but are skipped by the job gate
  `if: github.event.release.prerelease == false` (protects the `latest`
  dist-tag; the default tag for stable versions).
- **Checkout:** on a release event `actions/checkout` checks out the release
  tag's commit — exactly the released source.
- **Permissions:** workflow-level `contents: read` only. No `id-token`
  (no OIDC/provenance), no write scopes.
- **Concurrency:** `group: publish-npm`, `cancel-in-progress: false` —
  serialize runs; never cancel mid-staging.
- **Toolchain:** Node 24 (≥ 22.14.0 required), npm pinned via
  `npm install --global npm@11`, then an explicit gate asserting
  Node ≥ 22.14.0 and npm ≥ 11.15.0 (staged-publishing minimums).
  `package-manager-cache: false` — no dependency cache restoration in a
  release build (cache-poisoning hardening per npm docs). The package's own
  `engines: >= 20` is unchanged; CI toolchain is a build-time choice.
- **Gates, in order:** `npm ci` (lockfile-exact) → identity gate (name must
  be `quota-matata`, not `private`, version canonical stable semver `X.Y.Z`
  — each component `0|[1-9]\d*`, no leading zeros, because npm normalizes
  e.g. `00.1.0` to `0.1.0` and would stage a version different from the one
  the release tag names; release tag equals version with optional `v`
  prefix) → registry gate (`npm view` fails the run if the version already
  exists; E404 proceeds; any other error fails closed) → `npm run typecheck`
  → `npm test` → `npm run build` → `npm run smoke` (pack → install → import;
  nothing published) → `npm stage publish --dry-run` (preflight, no writes).
- **Credential handling:** `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` is
  set **only on the staging step**; `setup-node`'s `.npmrc` references the
  env placeholder, so no other step (including `npm ci` — all deps are
  public) receives the token. The step fails with a clear message if the
  secret is unset. The token is never echoed; GitHub masks secrets in logs.
- **Staging:** `npm stage publish --access public` (explicit public access;
  unscoped packages are public by default). A step summary then prints the
  2FA approval instructions. Approval is out-of-band by design.

## Release version synchronization (R5-01 fix, R6)

The README "Cutting a release" checklist bumps **every version site**, not
just `package.json`/lockfile. The sites that must agree (current line numbers
as of the R6 working tree):

- `package.json` `version` — the packed/staged version identity.
- `package-lock.json` `version` (root and `packages[""]`) — lockfile-exact
  `npm ci`; `npm version <v> --no-git-tag-version` updates both files.
- `src/logging.ts` `PLUGIN_VERSION` (line 48) — exported runtime constant
  (re-exported by `core`, stamped as `pluginVersion` into every diagnostic
  event). `scripts/package-smoke.mjs` (line 129) asserts it equals the packed
  version, so a stale constant fails the smoke gate even when build passes.
- `test/entry.test.ts` (line 54, `core.PLUGIN_VERSION`) and
  `test/adapter.test.ts` (line 480, `event.pluginVersion`) — literal
  version assertions that must be bumped with the constant.

`test/logging.test.ts` compares against the imported `PLUGIN_VERSION`
constant (plus a semver-shape regex), so it follows automatically; only the
two files above pin the literal. `specs/logging.md` already records the
"kept in sync with package.json" invariant; no runtime change is involved.

Failure mode that motivated the fix (R5-01, reproduced offline in scratch):
bumping only `package.json`/lockfile to `0.1.1` leaves `PLUGIN_VERSION` at
`0.1.0` — a fresh build passes (and `npm test` still passes, because the
literal assertions match the unchanged constant), but `npm run smoke` fails
with `0.1.0 !== 0.1.1`. Bumping the constant without the two test assertions
fails `npm test` instead. The corrected checklist therefore synchronizes all
five sites and runs `typecheck && test && build && smoke` locally **before**
commit/tag; the workflow gates then re-verify the tagged source.

## Security analysis

- **Leaked `NPM_TOKEN`:** attacker can stage versions (which still require
  maintainer 2FA approval to go live), deprecate versions, and move
  dist-tags. They **cannot** publish directly (`E_STAGE_REQUIRED`), cannot
  bypass 2FA (option disabled), and cannot manage the account or tokens
  (granular tokens never grant account governance; bypass tokens lost even
  that in August 2026). Blast radius is bounded by package scoping
  (`quota-matata` only, after the first-release bootstrap) and expiration.
- **Malicious/compromised release:** anyone with rights to publish a GitHub
  release can trigger staging, but nothing becomes public without a
  maintainer's 2FA approval after reviewing name/version/shasum/tarball.
  Repo-side release/tag permissions are the first line; the README
  recommends restricting them.
- **Compromised dependency/build:** gates run typecheck/tests/build/smoke on
  the tagged source before staging; the tarball contents are additionally
  constrained by `files` (dist + LICENSE + README only, asserted by the
  smoke test). Residual risk: a compromised dev dependency could still
  tamper with the build — mitigated by lockfile-exact `npm ci`, no cache
  restoration, SHA-pinned actions, and human tarball review at approval.
- **Registry-side:** duplicate versions are impossible (shared semver
  unique index); the workflow also fails fast on already-published versions
  and fails closed on unverifiable registry state.
- **Package publishing access:** per npm-stage Best Practices (v11/v12),
  the README instructs "Require two-factor authentication and disallow
  tokens (recommended)" once the package exists. Direct token publishing is
  then blocked outright (bypass or not); `npm stage publish` (never prompts
  for 2FA) and the maintainer's interactive 2FA approval are unaffected.

## First publication

The name `quota-matata` is unclaimed (verified 404, 2026-11-15). The first
`npm stage publish` creates the package under the token's npm account by
publishing the public placeholder `0.0.0-stage`; approval then publishes the
staged version to the package page. Because the token's package selector
lists packages the account already has access to, the README instructs a
temporary **All Packages** scope for the first release, then replacement
with a `quota-matata`-only token once the package exists (after the first
staging) and revocation of the broad one. This bootstrap is an inference
from the documented selector behavior (labeled as such in the README), not
a verified UI walkthrough.

## Alternatives considered

- **Direct `npm publish` + bypass-2FA granular token:** supported today but
  removed January 2027; requires disabling 2FA enforcement for the token.
  Rejected: near-term obsolescence and weaker security.
- **Trusted publishing (OIDC, no secret):** npm's preferred direction and
  compatible with staging, but requires an existing package to configure,
  an exact `repository.url` match (absent from this package.json),
  GitHub-hosted runners, and a first publish within 2 days of configuration;
  provenance needs a public repo (repo not publicly visible). Documented in
  the README as the future migration; not implemented (user expects the
  secret-based path; package identity untouched).
- **`workflow_dispatch` manual trigger:** adds an unguarded publish surface
  next to the release flow. Rejected; the release event is the single
  explicit trigger.

## Verification (offline / read-only; no publication)

- `actionlint` v1.7.12 on the workflow: **0 findings** (expressions, action
  inputs, event types).
- YAML parse round-trip (`yaml@2` CLI): valid; trigger confirmed as
  `release: [published]`, permissions `contents: read`, prerelease job gate.
- `bash -n` on all 12 embedded run blocks: pass.
- Gate scripts executed locally against the real package: toolchain gate
  passes (node 26.12.0 / npm 11.20.0); identity gate passes for `v0.1.0`
  and `0.1.0`, fails (exit 1) for mismatched `v9.9.9`; registry gate
  proceeds for unpublished `quota-matata@0.1.0` (E404) and fails (exit 1)
  for an already-published version (control: `typescript@5.0.4`).
- R3 canonical-semver regression probes (identity gate extracted verbatim
  from the workflow, run against synthetic package.json/tag pairs): pass
  for `0.1.0`/`v0.1.0`, `0.1.0`/`0.1.0`, `1.2.3`/`v1.2.3`, `10.20.30`,
  `0.0.0`; fail (exit 1) for leading zeros `00.1.0`, `0.01.0`, `0.1.00`
  (matching or mismatched tags), leading-zero tag `v00.1.0` vs canonical
  `0.1.0`, prerelease `1.2.3-alpha.1`, build metadata `1.2.3+b`, `1.2`,
  `1.2.3.4`, empty version/tag, wrong name, `private: true`. Hazard
  confirmed offline: `semver@7.8.6` strict rejects `00.1.0` (loose
  normalizes it), and `npm stage publish --dry-run` on a scratch copy with
  version `00.1.0` warns `"version" was cleaned and set to "0.1.0"` and
  packs `quota-matata-0.1.0.tgz` — exactly the mismatch the gate now blocks.
- `npm stage publish --dry-run` in the repo: exit 0, packs
  `quota-matata-0.1.0.tgz` (19 files), reports staging with tag `latest`,
  **no registry writes, no login required**.
- Full suite (re-run after the R3 fixes): `npm run typecheck` clean,
  `npm test` 540/540 pass, `npm run build` clean, `npm run smoke` 5/5
  (results recorded in the run handoff).
- R6 scratch validation of the corrected release checklist (2026-11-15,
  fully offline incl. smoke consumer install from npm cache; scratch copies
  and logs under `/tmp/opencode/r6-scratch/`): the old recipe
  (package.json/lockfile only → 0.1.1) reproduces R5-01 — fresh build passes
  but `npm run smoke` fails `'0.1.0' !== '0.1.1'`; bumping `PLUGIN_VERSION`
  without the two test literals fails `npm test` at exactly those two
  assertions. The corrected checklist (`npm version 0.1.1
  --no-git-tag-version` verified to update package.json and both lockfile
  version fields; `PLUGIN_VERSION` and both test literals synced) passes
  fresh typecheck, `npm test` 540/540, build, smoke 5/5, and
  `npm stage publish --dry-run` (packs `quota-matata-0.1.1.tgz`, 19 files,
  tag `latest`; no registry writes, no login). Real checkout re-verified
  unchanged at 0.1.0: typecheck clean, 540/540 tests, build clean, smoke 5/5.

## Honest limitations

- No live publish/stage/approve was performed (no credentials, no external
  writes). The approval UX and first-package placeholder behavior are
  documented npm behavior, not exercised here.
- The first-release "All Packages" token bootstrap is a labeled inference
  from the documented package selector; verify in the npm UI.
- The recommended package-level "disallow tokens" setting could not be
  exercised live (no credentials). Its compatibility with staging is npm's
  documented best practice (v11/v12), not a verified live run here; it can
  only be applied after the first staging creates the package.
- Repository visibility on GitHub could not be confirmed (unauthenticated
  API 404); provenance stays off until the repo is public.
- Action SHA pins were resolved on 2026-11-15; future action updates are a
  deliberate, reviewable change (no auto-update mechanism here).
