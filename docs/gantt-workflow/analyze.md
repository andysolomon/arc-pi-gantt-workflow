# Analyze

## Evidence

- Status: completed
- Summary: Analyze for parallel Wave-01 Implement of 1.1 (DAG model + checkpoint enum in workflow-core) and 3.1 (four child profiles in arc-pi-adapter). File ownership is disjoint so parallel Implement is allowed under the Gantt Wave 01. Both contracts drafted; workload classes proposed; one assumption recorded for the workflow extension identifier.
- Changes:
  - Drafted 1.1 contract: workflow-core/src/model exports DAG types and the six-state checkpoint enum, no other checkpoints exist.
  - Drafted 3.1 contract: arc-pi-adapter/src/sessions exports four profiles (Explore/Research, Plan/Analyze, Implement, Verify/Review); each excludes this workflow extension and any subagent_* tool.
  - Recorded arc-workflow.assumption.extension-id pinning the workflow extension id to @arc/pi-workflow pending actual registration.
- Verification:
  - Both Implement contracts satisfy the leaf acceptance criteria from IMPLEMENTATION_PLAN §7 (1.1 and 3.1).
  - Both file-ownership scopes are disjoint (workflow-core/src/model vs arc-pi-adapter/src/sessions).
  - Workload classes: easy-medium for 1.1 (foundation types + tests), easy-medium for 3.1 (four profiles + tests).
- Risks:
  - 3.1 depends on assumption arc-workflow.assumption.extension-id; if extension id changes later, profiles must be updated to match.
  - Tests rely on the existing tsconfig strictness (exactOptionalPropertyTypes, noUncheckedIndexedAccess) which can affect how optional fields are modeled.
- Next actions:
  - Show contracts to operator and request Implement approval.
  - Delegate both Implement calls in parallel via arc_delegate with implement_authorized=true, task_slug=gantt-workflow, assumption_refs referencing arc-workflow.assumption.extension-id.
  - Run Verify on both completed Implement results.

## Evidence

- Status: completed
- Summary: Phase 4.2 analyze: verify → local commit → ask → cherry-pick, owns integrate + adapter glue. 4.1 WorktreeManager (port-based) and 3.3 question broker (mandatory gates never auto-approve) shipped on main. Plan: add a pure workflow-core/src/integrate/integrate.ts with injected git ports (verify/commit/cherry-pick) and arc-pi-adapter/src/integrate/ wiring the real git CLI plus the broker. gate=integration mandatory; timeout fails closed. Proposing medium-heavy workload.
- Changes:
  - Confirmed 4.1 WorktreeManager API and 3.3 broker API on main
  - Proposed pure workflow-core/src/integrate/integrate.ts with verify/commit/cherry-pick ports
  - Proposed arc-pi-adapter/src/integrate/ wiring child_process git + broker
  - Proposed unit tests: verify-fail-no-commit, verify-ok-commit, timeout-no-cherry-pick, deny-no-cherry-pick, affirmative-cherry-pick
  - Proposed file ownership: integrate/ (workflow-core) + arc-pi-adapter/src/integrate/ + matching tests only
- Verification:
  - npm test -w @arc/workflow-core and npm test -w @arc/pi-workflow pass
  - npm run typecheck and npm run lint clean
  - git diff --check clean
- Risks:
  - Must reuse WorktreeManager.acquire result, not parallel paths
  - Cherry-pick question must build valid v1 QuestionEventEnvelope with EVENT_ENVELOPE_VERSION
  - Journal must record the integration answer with provenance
- Next actions:
  - Show operator exact Implement contract + workload_class=medium-heavy
  - After approval create worktree feat/wf-4-2-verify-commit-cherry-pick off origin/main
  - Delegate Implement via arc_delegate

## Evidence

- Status: completed
- Summary: Phase 4.3 analyze: automatic conflict resolution then full workflow checks. Contract drafted for workflow-core/src/integrate + adapter integrate. New ports (GitAutoResolvePort, GitResetPort), new phases (auto_resolve, verify_integration), needsReplan/reverted booleans. Operator approval recorded on Decision Ledger (942df2a0). Branch feat/wf-4-3-conflict-policy.
- Changes:
  - Drafted exact contract: outcome, scope (file ownership), preserved_behavior, verification (10 scenarios), prohibitions, workload_class=medium-heavy.
  - Drafted new types: IntegrationAutoResolveStrategy, IntegrationAutoResolveOptions, GitAutoResolvePort, GitResetPort, extended IntegrateResult.
  - Drafted new IntegratePhase values (auto_resolve, verify_integration) and new failure shapes (auto_resolve exhaustion, verify_integration checks_failed, reset_failed).
  - Recorded operator approval on Decision Ledger (942df2a0-0a6f-40b0-ab4b-c21ad4e72a18).
- Verification:
  - File ownership disjoint from any in-flight worktree.
  - 4.2 happy path test (no conflict) byte-stable.
  - Existing 4.2 cherry-pick conflict test updated to phase="auto_resolve", needsReplan=true.
  - Default settings (theirs, maxAttempts=2) match IMPLEMENTATION_PLAN §9.
- Risks:
  - Changing 4.2 cherry-pick conflict test is a deliberate contract change; downstream assertions must update in the same PR.
  - Auto-resolve (theirs/ours) silently overwrites operator-reviewed semantics; bounded by attempts and surfaced via needsReplan on failure.
  - git reset --hard HEAD~1 destroys the integration commit; quarantine vs revert is a separate decision.
- Next actions:
  - Delegate Implement via arc_delegate, phase=implement, implement_authorized=true, workload_class=medium-heavy, task_slug=gantt-workflow.
  - Run Verify on completed Implement; surface PR; operator decides on merge.

## Evidence

- Status: completed
- Summary: Phase 7 Analyze: main at c3f7e57 has Phase 6 done. Phase 7 needs 7.1 Recovery (pure diagnose), 7.2 Restart (reconcile+ask), 7.3 Cancel (stop+ask). Precedent: Phase 6 shipped as one PR; plan file defines exact acceptance for each leaf. gh CLI authenticated. No stale local worktrees; two remote stale branches to delete.
- Changes:
  - workflow-core/integrate/worktree-manager.ts exposes WorktreeManager.cancel(preserve|delete) usable by 7.3.
  - arc-pi-adapter/sessions/lifecycle.ts exposes retain-only SessionLifecycle.archive usable by 7.3.
  - arc-pi-adapter/questions/broker.ts is the only arc_ask_operator path; mandatory gates fail closed. 7.2 and 7.3 must route through it.
- Verification:
  - git log shows Phase 6 merge + feat commit; no Phase 7 work present.
  - git worktree list shows only main; remote stale branches are merged.
  - gh auth status confirms repo+workflow scopes.
  - npm test currently 113/113 passing.
- Risks:
  - Eco-mode routes to composer-implement; failing the ask-first ordering for cancel/restart breaks the settled design.
  - Any path that bypasses the broker violates the only-questioning-system rule.
- Next actions:
  - Worktree feat/wf-7-recovery-restart-cancel created at .arc/worktrees/feat-wf-7.
  - Delegate Implement in eco-mode with task_slug=gantt-workflow, background=true.
  - After settle: npm test + typecheck, commit, push, open PR, merge.
