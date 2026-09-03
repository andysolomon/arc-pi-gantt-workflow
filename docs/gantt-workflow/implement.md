# Implement

## Evidence

- Status: completed
- Summary: Implemented the Phase 1.1 pure TypeScript DAG model with strict group/leaf discrimination, repository/workflow/checkpoint shapes, and exactly six runtime checkpoint states. No later-phase behavior was added.
- Changes:
  - packages/workflow-core/src/model/checkpoint.ts: checkpoint state representation and Checkpoint type.
  - packages/workflow-core/src/model/workflow.ts: Repository, Group, Leaf, WorkflowItem, and Workflow types.
  - packages/workflow-core/src/model/index.ts and model/*.js: model exports and ESM source entrypoints.
  - packages/workflow-core/src/index.ts: public model re-export.
  - packages/workflow-core/test/model.test.ts: focused runtime and type-shape tests.
- Verification:
  - Focused model tests: 2 passed.
  - npm test -w @arc/workflow-core: 13 passed.
  - npm run typecheck -w @arc/workflow-core: passed.
  - npm run typecheck: passed.
  - npm test: workflow-core 13 passed; adapter 1 passed.
  - npm run lint: passed.
  - git diff --check: passed.
- Risks:
  - Normalization, validation, cycle checks, and scheduling remain intentionally out of scope.
  - Pre-existing docs/progress.txt and docs/gantt-workflow/analyze.md changes were preserved untouched.

## Evidence

- Status: completed
- Summary: Repaired workflow-core direct TypeScript execution and v1 model typing. Public imports and all tests now pass; no commit, push, or deployment performed.
- Changes:
  - packages/workflow-core/src/index.ts — public model export now uses explicit .ts.
  - packages/workflow-core/src/model/index.ts — re-exports now use explicit .ts paths.
  - packages/workflow-core/src/model/workflow.ts — checkpoint import uses .ts; multi_repo is omitted-or-empty-tuple only.
  - packages/workflow-core/tsconfig.json — enabled allowImportingTsExtensions with noEmit.
  - packages/workflow-core/src/model/checkpoint.ts — pre-existing in-scope file, untouched.
  - packages/workflow-core/test/model.test.ts — pre-existing in-scope file, untouched.
  - docs/progress.txt — pre-existing out-of-scope modification, untouched.
  - docs/gantt-workflow/analyze.md and docs/gantt-workflow/implement.md — pre-existing untracked files, untouched.
- Verification:
  - npm test passed: 13/13 tests, including all workflow-core tests.
  - npm run typecheck passed.
  - npm run lint passed.
  - git diff --check passed.
  - Direct public @arc/workflow-core import passed and exposed exactly 6 checkpoint states.
  - Source scan confirms workflow-core imports/exports use explicit .ts extensions.
- Risks:
  - Pre-existing documentation changes outside the approved repair scope remain in the working tree.

## Evidence

- Status: completed
- Summary: Wave 01 parallel Implement of 1.1 and 3.1 complete. 1.1 added CheckpointState (exactly six) and Group/Leaf/Workflow DAG types to workflow-core. 3.1 added four profiles (explore-research, plan-analyze, implement, verify-review) to arc-pi-adapter; every profile excludes WORKFLOW_EXTENSION_ID and every arc_*/subagent_* tool. 13+13 tests pass; typecheck and lint clean.
- Changes:
  - packages/workflow-core/src/model/{checkpoint,workflow,index}.ts: CheckpointState enum (six values) and discriminated DAG types; multi_repo narrowed to [].
  - packages/workflow-core/{src/index.ts,tsconfig.json}: re-exports and allowImportingTsExtensions.
  - packages/workflow-core/test/model.test.ts: 2 tests covering checkpoint invariant and DAG shape.
  - packages/arc-pi-adapter/src/sessions/profiles.ts: WORKFLOW_EXTENSION_ID, CHILD_PROFILE_IDS, CHILD_PROFILES, getChildProfile, ParentModelSelection.
  - packages/arc-pi-adapter/src/sessions/index.ts and src/index.ts: re-exports.
  - packages/arc-pi-adapter/tsconfig.json: allowImportingTsExtensions.
  - packages/arc-pi-adapter/test/profiles.test.ts: 12 tests covering count, ids, exclusions, allowlist purity, and runtime guard.
- Verification:
  - npm test: 13/13 workflow-core, 13/13 arc-pi-adapter.
  - npm run typecheck and npm run lint: pass.
  - Six checkpoint values enforced by frozen CHECKPOINT_STATES + test deepEqual.
  - Every profile excludes WORKFLOW_EXTENSION_ID and at least one subagent_* tool.
- Risks:
  - Parent-model defaults to inherit for all four profiles; future leaf must wire explicit IDs before scheduling.
  - Forbidden tool list is closed at v1; new ARC tools later must extend FORBIDDEN_TOOLS.
- Next actions:
  - Wave 02 (1.2, 1.5, 2.1) is unblocked by 1.1; 3.2 is unblocked by 3.1.
  - Add packages/*/src/*.js to .gitignore to absorb future noEmit accidents.

## Evidence

- Status: completed
- Summary: Implemented the Phase 1.3 pure workflow validator with deterministic structural diagnostics, configurable conservative bounds, cycle/reference checks, and separate non-mutating activation readiness per leaf.
- Changes:
  - packages/workflow-core/src/validate/validate.ts: added validateWorkflow, structural checks, cycle detection, bounds, deterministic diagnostics, and readiness evaluation.
  - packages/workflow-core/src/validate/types.ts: added public validator, diagnostic, bounds, and readiness contracts.
  - packages/workflow-core/src/validate/index.ts: exported validator API and types.
  - packages/workflow-core/test/validate.test.ts: added 8 focused tests covering all requested validation and activation cases.
  - packages/workflow-core/src/index.ts: re-exported normalize and validate APIs; normalize export preserves the verified Phase 1.2 package interface.
- Verification:
  - Focused validator tests: 8 passed, 0 failed.
  - All repository tests: workflow-core 49 passed; arc-pi-adapter 13 passed.
  - npm run typecheck passed.
  - npm run lint passed.
  - git diff --check passed from repository root.
  - Final status and scoped diff inspected; validator contains no Pi, filesystem, YAML, AJV, or orchestrator imports.
- Risks:
  - The worktree contains pre-existing unrelated modified/untracked files; they were preserved untouched.

## Evidence

- Status: completed
- Summary: Implemented Phase 1.4 importer: extractPhased (H1/H2/H3 headings as groups, indented checkboxes as leaves), extractFlat (top-level checkboxes only), extractPlan (auto-detect), and ModelProposalHook type-only interface. All produce NormalizeInput with empty activation fields. Deterministic: same markdown always yields identical output. No external calls or model invocations.
- Changes:
  - packages/workflow-core/src/import/extract.ts — extractPhased, extractFlat, extractPlan functions
  - packages/workflow-core/src/import/types.ts — ModelProposalHook interface (type-only)
  - packages/workflow-core/src/import/index.ts — barrel re-exports
  - packages/workflow-core/src/index.ts — added import/index.ts re-export
  - packages/workflow-core/test/import.test.ts — 12 focused tests across 5 suites
- Verification:
  - npm test (workflow-core): 69/69 pass including 12 new import tests
  - npm run typecheck: clean, zero errors
  - npm run lint: clean
  - git diff --check: no whitespace issues
  - Phased plans: H1/H2/H3 nesting, leaf placement, unknown-line ignoring verified
  - Flat plans: top-level-only checkbox extraction, indented lines ignored
  - Determinism: repeated calls produce deepStrictEqual output
  - ModelProposalHook: type-only, compilable, no runtime model calls
- Risks:
  - extractPlan auto-detect keys on any heading presence; edge-case markdown with accidental # lines may mis-classify
  - Leaf IDs are positional (leaf-N); reordering source lines changes IDs
- Next actions:
  - Phase 1.5: wire importer output into normalize pipeline
  - Phase 8.2 (adapter-side): implement actual ModelProposalHook with model calls
