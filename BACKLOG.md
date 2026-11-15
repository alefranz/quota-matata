# Quota Matata

MIT • `quota-matata` • No worries, just retries.

## Completed milestone — 2026-11-14
Standalone OpenCode v2 retry plugin implemented and independently accepted.
- Supported `@opencode/plugin@2.3.0` entry/options, retry and error-observation hooks.
- Generic policy/classification engine, Alibaba Coding Plan rules, bounded quota waits.
- Safe bounded JSONL diagnostics, configuration, README and design specs.
- R31 integrated audit clean: 540 tests, typecheck/build, package smoke5/5, four timezones; real-SDK installed-package checks.

Delivery closed on 2026-11-15: commit `de23ee554d12ef38501db1c75f5be93529659eff` is on local `main` and remote `refs/heads/main` (verified with `git ls-remote`). No processes/services left running. Historical delivery permissions are superseded for the current run by the explicit 2026-11-15 commit-and-push request.

## Next action
No active requested work; release/publication requires separate user approval.

## Completed milestone — security and Actions repair
Run `security-actions-20261115`: strict; commit and push explicitly authorized by user; ceiling6 consumed2. R1/R4 work done; R2/R3/R5 clean; no blockers. Full ledger: archive **Session-close security-actions-20261115**.
- [x] **T5 — Fix Dependabot vulnerabilities.** 2026-11-15; allowance12 consumed1; e761bbd and state eda260b confirmed origin/main; alerts1/2 fixed, audit0,544tests/build/smoke pass, R2/R3 clean. Archive: `.agenticale/handoffs/archive/2026-11.md`, **T5 — Dependency remediation**.
- [x] **T6 — Resolve observed Actions failure.** 2026-11-15; allowance12 consumed1; independent R5 confirms four failed pre-fix Dependabot jobs resolved by e761bbd on origin/main. No product change required; publishing workflow never ran, token uninvolved. Historical runs remain failed; hosted publishing/auth untested. Archive: **T6 — Actions failure diagnosis**.
- [x] Inspect and remove operative repository commit/push restrictions conflicting with this explicit invocation; no AGENTS.md or other operative restriction found; obsolete operational backlog restrictions superseded, historical audit preserved.
User explicitly approved ordinary pushes to `origin/main` on resume. Priority checkpoint31e4b6e push confirmed by ls-remote; GitHub now marks both alerts fixed. Mutable surfaces: local checkout/state and remote branch/Actions/Dependabot may change concurrently; revalidate before work and every push. Never expose token values or trigger publication without separate authorization.
Session-close pointer: `.agenticale/handoffs/archive/2026-11.md`, **Session-close security-actions-20261115**.

## Completed milestone — npm publishing
Run `npm-publish-20261115`: strict, working-tree policy (recorded repository restriction: no new Git actions); ceiling 6 consumed 3.
- [x] **T4 — npm publishing automation and setup.** 2026-11-15; allowance12 consumed3. README + new workflow/spec accepted; R4/R7 clean, real0.1.0 and scratch0.1.1 typecheck/540tests/build/smoke5 pass. Working-tree persistence finalized, no commits/pushes/publication. Archive: `.agenticale/handoffs/archive/2026-11.md`, **T4 — npm publishing — Session-close npm-publish-20261115 — 2026-11-15**.

## Completed milestone — provider-agnostic positioning
Preserve the generic engine and existing Alibaba-specific handling. Make the README clearly introduce a generic, provider-agnostic plugin rather than imply a single-provider product.
Closed run `provider-positioning-20261115`: strict mode, ceiling 6 consumed 2 workers; T1/T2 each allowance 12 consumed 1; T3 allowance 12 consumed 0. Review clean; consult 1/2 session, 1/1 decision recommends no runtime change (high confidence). Historical working-tree delivery verified; current Git permissions are defined by the current milestone.

- [x] **T1 — Establish provider evidence and gaps.** 2026-11-15, allowance 12 consumed 1. Research finds docs gaps and candidate Token Plan handling, with identity/wire uncertainty; OpenAI runtime change not justified. No product edits; working-tree findings in `.agenticale/handoffs/archive/2026-11.md`, **T1 — Provider evidence**. Sources retained for independent checking in T2.
- [x] **T2 — Lead with generic support in README/specs.** 2026-11-15, allowance 12 consumed 1. README + specs/{core,integration,logging}.md; review clean, worker full 540 tests + typecheck, reviewer targeted 537 + 16 assertions. Working-tree persistence; archive **T2 — Generic-first docs**.
- [x] **T3 — Conditional handling: no justified change on current evidence.** 2026-11-15, allowance 12 consumed 0. Adopt R4 high-confidence advice: retain generic fallback pending confirmed plan/route/provider mapping and sanitized retry-hook exhaustion signal. Reset parsing also needs documented unambiguous instant format. No invented schedules; no runtime changes. Archive **T3 — Conditional handling decision**.

**Hard constraint for all items:** do not test providers, send live API/inference/auth requests, use credentials, or deliberately trigger errors/quotas. Read public documentation and use offline tests only. Educated assumptions must be labeled and must not masquerade as documented behavior. If evidence is missing, leave generic handling and record the gap for future sanitized logs.

## Nonblocking follow-ups
- [ ] T5-R3-N1: specs/integration.md:359–368 correct minimatch engine range and distinguish unoverridden consumer smoke, all-copy lock guards, and top-level installed guards.
- [ ] R3-N1: README.md:426-427 broaden “Coding Plan phrases” to reflect shipped Alibaba billing/auth/throttling rules.
- [ ] R3-N2: specs/logging.md:292-294 qualify unknown records as structure-only **by default**.
- [ ] R11-N1: Clarify `state.dropped` semantics or separate cumulative drops from pending overflow; reports reset it and failed in-flight events are not counted.
- [ ] R11-N2: Make the multi-process logger test actually overlap writers/rotation, or rename it; independent simultaneous-process probes did pass.

## Audit
Full round ledger, accepted-slice records, original findings, verification, allowance grant/usage and final SHA256s: `.agenticale/handoffs/archive/2026-11.md`, **Final session-close delivery — 2026-11-14**.
Prior delivery closure and preserved handoff: same archive, **Delivery closure and backlog-only session — 2026-11-15**.
Current state: `.agenticale/handoffs/active.md` (security/Actions run closed, origin/main approved); prior npm archive **T4 — npm publishing — Session-close npm-publish-20261115 — 2026-11-15**.
Prior run finished at 18/20 worker rounds after explicit user doubling; all blockers closed. Provider-positioning milestone closed at 2/6 workers.
