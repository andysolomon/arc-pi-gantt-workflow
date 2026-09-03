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
