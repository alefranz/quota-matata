# Quota Matata

MIT • `quota-matata` • No worries, just retries.

## Completed milestone — 2026-11-14
Standalone OpenCode v2 retry plugin implemented and independently accepted.
- Supported `@opencode/plugin@2.3.0` entry/options, retry and error-observation hooks.
- Generic policy/classification engine, Alibaba Coding Plan rules, bounded quota waits.
- Safe bounded JSONL diagnostics, configuration, README and design specs.
- R31 integrated audit clean: 540 tests, typecheck/build, package smoke5/5, four timezones; real-SDK installed-package checks.

Delivery closed on 2026-11-15: commit `de23ee554d12ef38501db1c75f5be93529659eff` is on local `main` and remote `refs/heads/main` (verified with `git ls-remote`). Prior commit-and-push authorization fulfilled; no new Git actions authorized. No processes/services left running.

## Next action
Wait for new user direction; revisit Token Plan handling only with confirmed product/route/provider-ID mapping and sanitized existing retry-hook error evidence (no live testing).

## Completed milestone — provider-agnostic positioning
Preserve the generic engine and existing Alibaba-specific handling. Make the README clearly introduce a generic, provider-agnostic plugin rather than imply a single-provider product.
Closed run `provider-positioning-20261115`: strict mode, ceiling 6 consumed 2 workers; T1/T2 each allowance 12 consumed 1; T3 allowance 12 consumed 0. Review clean; consult 1/2 session, 1/1 decision recommends no runtime change (high confidence). Working-tree persistence verified; no commits, pushes, branch changes, or publishing without new authorization.

- [x] **T1 — Establish provider evidence and gaps.** 2026-11-15, allowance 12 consumed 1. Research finds docs gaps and candidate Token Plan handling, with identity/wire uncertainty; OpenAI runtime change not justified. No product edits; working-tree findings in `.agenticale/handoffs/archive/2026-11.md`, **T1 — Provider evidence**. Sources retained for independent checking in T2.
- [x] **T2 — Lead with generic support in README/specs.** 2026-11-15, allowance 12 consumed 1. README + specs/{core,integration,logging}.md; review clean, worker full 540 tests + typecheck, reviewer targeted 537 + 16 assertions. Working-tree persistence; archive **T2 — Generic-first docs**.
- [x] **T3 — Conditional handling: no justified change on current evidence.** 2026-11-15, allowance 12 consumed 0. Adopt R4 high-confidence advice: retain generic fallback pending confirmed plan/route/provider mapping and sanitized retry-hook exhaustion signal. Reset parsing also needs documented unambiguous instant format. No invented schedules; no runtime changes. Archive **T3 — Conditional handling decision**.

**Hard constraint for all items:** do not test providers, send live API/inference/auth requests, use credentials, or deliberately trigger errors/quotas. Read public documentation and use offline tests only. Educated assumptions must be labeled and must not masquerade as documented behavior. If evidence is missing, leave generic handling and record the gap for future sanitized logs.

## Nonblocking follow-ups
- [ ] R3-N1: README.md:426-427 broaden “Coding Plan phrases” to reflect shipped Alibaba billing/auth/throttling rules.
- [ ] R3-N2: specs/logging.md:292-294 qualify unknown records as structure-only **by default**.
- [ ] R11-N1: Clarify `state.dropped` semantics or separate cumulative drops from pending overflow; reports reset it and failed in-flight events are not counted.
- [ ] R11-N2: Make the multi-process logger test actually overlap writers/rotation, or rename it; independent simultaneous-process probes did pass.

## Audit
Full round ledger, accepted-slice records, original findings, verification, allowance grant/usage and final SHA256s: `.agenticale/handoffs/archive/2026-11.md`, **Final session-close delivery — 2026-11-14**.
Prior delivery closure and preserved handoff: same archive, **Delivery closure and backlog-only session — 2026-11-15**.
Current state: `.agenticale/handoffs/active.md` (run closed); archive **Session-close — provider-positioning-20261115 — 2026-11-15**.
Prior run finished at 18/20 worker rounds after explicit user doubling; all blockers closed. Provider-positioning milestone closed at 2/6 workers.
