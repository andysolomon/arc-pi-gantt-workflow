# M1 vertical slice fixture

This directory contains the canonical fixture for the Phase 5 first-milestone
vertical slice. The fixture is a single-leaf workflow that can complete
sequentially against a disposable repo, exercising every layer of the
controller (1.x–4.4) end to end without ever pushing, deploying, or
mutating GitHub.

## Files

- `workflow.yaml` — the v1-schema workflow with one ready group (`5.0`) and
  one ready leaf (`5.1`). The leaf carries all five activation fields.
- `repo/` — a minimal disposable repo that the integration test clones into
  a temporary directory before running the leaf.
  - `repo/test/greeting.test.mjs` — the verify command target. It imports
    `../src/greeting.ts` and asserts the documented contract.
  - `repo/src/.gitkeep` — placeholder so the directory exists before the
    leaf runs; the leaf's contract is to add `greeting.ts` next to it.

## Disposable-repo recipe

The integration test (`packages/arc-pi-adapter/test/integration/m1-vertical-slice.test.ts`)
copies this `repo/` into `os.tmpdir()/m1-fixture-<rand>/`, runs `git init`,
commits the initial state on the `main` branch, then drives the sequential
runner through the full pipeline. **Nothing in the test path ever pushes
or contacts a remote.** A passing run leaves the operator-visible evidence:

- the workflow YAML updated so leaf `5.1` carries `state: completed` and an
  `evidence_ref` to a journal entry;
- `progress.txt` regenerated to reflect the new checkpoint;
- the Gantt document regenerated to reflect the new checkpoint;
- a journal record per orchestration step;
- the leaf worktree preserved at `os.tmpdir()/m1-fixture-<rand>/worktrees/5.1`.

## Running locally

```sh
npm test -w @arc/pi-workflow
```

The integration test runs in the same suite as the unit tests. It does not
require a real Pi session, ARC orchestrator, or remote — everything is
faked through ports.

## Out of scope (per the implementation plan)

- Multi-repo writes (schema field `multi_repo` is reserved only).
- Remote push, GitHub mutation, deploy.
- Aggregate cost budgets.
- A second questioning mechanism.
- Auto-approval of mandatory gates (`integration`).