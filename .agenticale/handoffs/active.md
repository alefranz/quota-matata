## GOAL
CLOSED: add npm publishing workflow and exact npm/GitHub setup; no publication.
## ESTABLISHED
Strict; working-tree policy due recorded Git restriction. No commits/pushes/branches/releases/publication or credential use. Baseline main d620251; no submodules.
OpenCode profiles: implement-hard alibaba-token-plan/qwen4-max-preview#xhigh, review openai/gpt-6.1-sol#high, review-deep openai/gpt-6-astra#high; effective unknown.
Full records: archive/2026-11.md, T4 — npm publishing — Session-close npm-publish-20261115 — 2026-11-15.
## CURRENT STATE
Run npm-publish-20261115 ceiling6 consumed3; T4 allowance12 consumed3. Only R1/R3/R6 charged. Slice fix1/2/review2/3; deep escalation1/1,fix1/2,re-audit1/2; no pending rounds/extensions.
R1 work done; R2 findings; R3 fix done; R4 clean; R5 deep findings; R6 fix done; R7 deep clean. No open findings/nits for T4.
README + new .github/workflows/publish.yml and specs/publishing.md accepted. Working-tree persistence verified; HEAD unchanged, no runtime/package version changes. Account/secret setup and live stage/approval remain user actions, intentionally untested.
Independent real0.1.0 and scratch0.1.1: typecheck,540tests,build,smoke5 pass; workflow lint/gate probes and offline stage dry-run pass. Hosted execution untested. No surviving services.
## ACCEPTANCE
Safe release-triggered npm staging, identity/check gates, exact token/secret/2FA/first-publication instructions and release-version synchronization independently accepted. Working-tree finalization complete; nothing published.
## NEXT
User configures npm stage-only token and GitHub NPM_TOKEN per README; separately review/commit changes before triggering a release and approving its npm stage with2FA.
