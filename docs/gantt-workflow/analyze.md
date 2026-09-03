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
