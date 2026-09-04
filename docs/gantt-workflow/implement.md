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

## Evidence

- Status: completed
- Summary: Added a pure, side-effect-free v1 event-envelope module to workflow-core: types/constants, validateEventEnvelope with deterministic sorted diagnostics, assertEventEnvelope, gate helpers, and a UTF-8 32768-byte payload bound stricter than the schema's code-point maxLength. 17 new tests; full suite, typecheck, lint, and diff --check pass. Schema unchanged (no mismatch required one).
- Changes:
  - packages/workflow-core/src/events/types.ts (new): EVENT_ENVELOPE_VERSION 1.0.0, EVENT_KINDS, EVENT_GATES, MANDATORY_EVENT_GATES, MAX_EVENT_PAYLOAD_BYTES=32768, EventEnvelope/QuestionEventEnvelope/diagnostic/result types
  - [absolute path redacted]
  - packages/workflow-core/src/events/index.ts (new): explicit barrel with a docblock stating the module does no fs, journal, question, or session work
  - packages/workflow-core/test/events.test.ts (new): 17 tests incl. two ajv parity tests against schema/event-envelope.schema.json
  - packages/workflow-core/src/index.ts: added one line, export * from "./events/index.ts"
  - packages/workflow-core/schema/event-envelope.schema.json: unchanged (git status on schema/ is empty)
- Verification:
  - Focused: node --test test/events.test.ts -> 17/17 pass
  - Full: npm test (root) -> workflow-core 96/96 pass, arc-pi-adapter 13/13 pass, 0 fail
  - npm run typecheck -> exit 0; npm run lint -> exit 0; git diff --check -> exit 0
  - Valid examples accept: examples/event-envelope/valid-question.json and valid-progress.json, payload_bytes matches Buffer.byteLength of JSON payload
  - Unknown versions reject (2.0.0, 1.0.1, 1, non-strings) with a single unsupported_version diagnostic; missing version -> missing_field; non-objects -> invalid_envelope
  - Oversized rejects by UTF-8 bytes: 20000 multi-byte chars reject while 20000 ASCII chars accept (schema maxLength alone would allow both)
  - Extra fields reject at $, $.payload, $.provenance, $.payload.options[i]; question requires question_id/text/options/gate; default_on_timeout rejected for all 4 mandatory gates, accepted for gate=none
  - Ad-hoc 75-case ajv sweep (temp script, deleted): only 4 divergences remain, all impl-stricter-than-schema (byte bound x2, space separator, colon-less offset); a test locks that everything the module accepts the schema also accepts
- Risks:
  - Date-time validation is intentionally stricter than ajv-formats: it rejects space separators, colon-less offsets, and leap seconds (23:59:60). Emitters using Date#toISOString are unaffected.
  - Payload byte bound counts JSON.stringify(payload) including keys/punctuation, so a summary near 32768 chars can exceed the bound; this is the intended stricter check but is tighter than a raw text-only measure.
  - default_on_timeout with no gate at all is accepted, matching the schema's conditional; Phase 3.3 may want to require an explicit gate.
  - validateEventEnvelope returns the caller's object rather than a frozen copy, so callers must not mutate a validated envelope and assume it stays valid.
- Next actions:
  - Verify phase: re-run npm test, typecheck, lint, and review the diff; only then update docs/IMPLEMENTATION_PLAN.md and docs/progress.txt for 2.2
  - Phase 3.3 question broker can consume isQuestionEventEnvelope + isMandatoryEventGate for fail-closed gate handling
  - Consider whether default_on_timeout should be required to match one of the option labels; that is a schema-level decision, not made here

## Evidence

- Status: completed
- Summary: Implemented the pure workflow-core scheduler with fail-closed ready-set computation, bounded concurrency, configurable wait behavior, deterministic critical-path calculation, hybrid question prioritization, and UI override.
- Changes:
  - packages/workflow-core/src/schedule/types.ts: added scheduler, wait-policy, and queue types.
  - packages/workflow-core/src/schedule/schedule.ts: added readiness, concurrency, waiting, critical-path, and question-priority logic.
  - packages/workflow-core/src/schedule/index.ts: added scheduler public barrel.
  - packages/workflow-core/src/index.ts: added the minimal scheduler export while preserving existing exports.
  - packages/workflow-core/test/schedule.test.ts: added 6 focused scheduler and purity tests.
- Verification:
  - Focused scheduler tests passed: 6/6.
  - All repository tests passed: workflow-core 105/105; adapter 13/13.
  - npm run typecheck passed.
  - npm run lint passed.
  - git diff --check passed from repository root.
  - Purity scan found no filesystem, Pi/adapter, session, delegate, or model-call imports in schedule source.
  - Final status inspection confirmed no scheduler changes outside the allowed files.
- Risks:
  - The worktree contained unrelated pre-existing modifications and untracked files; they were preserved untouched.
- Next actions:
  - Parent can perform the formal Verify phase and update status/checkbox documentation afterward.

## Evidence

- Status: completed
- Summary: Implemented Phase 4.2 verify→commit→ask→cherry-pick. Pure workflow-core/src/integrate/integrate.ts with injected ports + arc-pi-adapter/src/integrate/ wiring real git CLI and shipped broker. Mandatory gate=integration fails closed (no cherry-pick on timeout or denial; no cherry-pick if verify fails). 33 new tests pass (20 workflow-core + 13 adapter). typecheck/lint clean; git diff --check clean.
- Changes:
  - packages/workflow-core/src/integrate/types.ts (new): IntegrateOptions, IntegrateResult, IntegrateAskerOutcome, Git* ports, AFFIRMATIVE_INTEGRATION_LABEL
  - packages/workflow-core/src/integrate/integrate.ts (new): createIntegrator pure module; verify → commit → build v1 QuestionEventEnvelope with gate=integration → broker ask → cherry-pick on approval only
  - packages/workflow-core/src/integrate/index.ts: preserved worktree-manager export; added integrate exports
  - packages/workflow-core/test/integrate.test.ts (new): 20 tests covering all failure modes and the affirmative path
  - packages/arc-pi-adapter/src/integrate/index.ts (new): createIntegratorAdapter wiring spawnSync-based git ports and shipped createQuestionBroker; maps BrokerResult→IntegrateAskerOutcome
  - packages/arc-pi-adapter/test/integrate.test.ts (new): 13 tests covering process invoker, broker adapter, and full happy/decline paths
- Verification:
  - workflow-core tests: 125/125 pass (was 105 before 4.2)
  - arc-pi-adapter tests: 78/78 pass
  - npm run typecheck: exit 0
  - npm run lint: 2 pre-existing errors in shipped files (#9, #10); 0 in new code
  - git diff --check: clean
  - File scope: only the 6 files listed; no shipped module touched
- Risks:
  - Lint errors in shipped live-activity.ts and broker.ts pre-exist (PR #9, #10); not introduced by 4.2
  - Cherry-pick port uses git --no-commit then commit; if a pre-commit hook fails the follow-up commit surfaces as cherry-pick failure
