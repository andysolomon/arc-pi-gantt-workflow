# ARC Pi Gantt Workflow

Interactive Gantt and progress-driven workflow control for ARC Pi.

This repository contains a generic, Pi-free workflow core and a thin
ARC-Pi adapter. It imports phased plans or flat story lists into a validated
DAG, persists workflow YAML, renders progress/Gantt projections, and exposes
bounded controller APIs for sessions, questions, integration, recovery, and
release archival.

## Release-ready handoff

The project is distributed as a **source-loaded Pi package** from a local path
or Git ref. It is not published to npm by this repository. The package does
not push code, open pull requests, mutate GitHub, or deploy applications.
Review the source before installing it: Pi extensions run with the operator's
local permissions.

See [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) for installation, command
reference, status interpretation, and the controller/worker boundary.

## Requirements

- Node.js `>=22.19.0`
- Pi `>=0.80` with a trusted project/profile
- Git for worktree and local integration operations
- An ARC orchestrator installation when live worker execution is enabled

## Install as a Pi package

From a checkout, install the package by absolute or relative path:

```sh
pi install /absolute/path/to/arc-pi-gantt-workflow
# or, from the parent directory:
pi install ./arc-pi-gantt-workflow
```

For a Git ref, pin a reviewed commit or tag:

```sh
pi install git:github.com/andysolomon/arc-pi-gantt-workflow@<reviewed-ref>
```

To keep the package in an isolated ARC-Pi profile, set the profile's
`PI_CODING_AGENT_DIR` before installing or use the ARC-Pi launcher that already
sets it:

```sh
PI_CODING_AGENT_DIR="$HOME/.arc-pi" \
  pi install /absolute/path/to/arc-pi-gantt-workflow
```

Update a Git-installed package with a new reviewed ref, or update all
registered packages:

```sh
pi update --extension git:github.com/andysolomon/arc-pi-gantt-workflow@<reviewed-ref>
pi update --extensions
```

The package manifest loads TypeScript directly through
`packages/arc-pi-adapter/src/extension.ts`; no build artifact or npm lifecycle
script mutates the home directory.

## `/arc-workflow`

The package registers one command namespace:

```text
/arc-workflow help
/arc-workflow import <plan.md> [slug]
/arc-workflow open <slug>
/arc-workflow status [slug]
/arc-workflow start [slug]
/arc-workflow pause [slug]
/arc-workflow resume [slug]
/arc-workflow answer <question-id> <answer>
/arc-workflow replan <item-id>
/arc-workflow cancel <item-id>
/arc-workflow archive [slug]
```

`import` extracts headings and checkboxes and writes a validated workflow to
`.arc/workflows/<slug>/workflow.yaml`. `open` and `status` load that file and
show the deterministic dashboard/widget. A bare package load deliberately
fails closed for lifecycle mutations (`start`, `pause`, `resume`, `answer`,
`replan`, `cancel`, and `archive`) until an embedding controller supplies the
session, question, scheduler, and resource ports. It never falls back to a
second prompt implementation. TUI and RPC are supported; print and JSON modes
fail closed.

## Workflow shape

- `.arc/workflows/<slug>/workflow.yaml` is the authoritative source.
- `docs/progress.txt` and the Gantt projection are generated views.
- Groups organize the DAG; only executable leaves launch sessions.
- Each leaf must carry an outcome, bounded scope, acceptance criteria,
  dependencies, and preserved behavior before it can be ready.
- Runtime journal data stays under ignored `.arc/runtime/` paths and is
  redacted before persistence.

The six persisted checkpoint states are:

| State | Meaning |
| --- | --- |
| `planned` | Authoring or dependency work is incomplete. |
| `ready` | Activation fields and completed dependencies permit execution. |
| `completed` | The leaf passed verification, integration, and completion writes. |
| `blocked` | Work cannot continue without an operator or recovery decision. |
| `cancelled` | Work was stopped and the preservation decision was applied. |
| `needs-replan` | Evidence invalidated the current implementation contract. |

Dashboard status reports completed leaves, active/waiting leaves, questions,
capacity, and per-state counts. It is an operational projection, not a quality
score. Integration risk is classified as `low`, `medium`, or `high`; medium and
high risk can require an independent review, and high-risk defaults fail closed.

## Responsibility boundary

The **Pi parent/controller** owns workflow YAML, validation, scheduling,
questions, persisted child sessions, worktree isolation, local integration,
recovery, dashboards, and archival decisions. Material questions go only
through `arc_ask_operator`; mandatory `implement`, `integration`, `release`,
and `deploy` gates never auto-approve.

The **ARC orchestrator** owns worker routing and execution after the parent
has supplied an exact contract and authorization. A workflow child does not
load this extension or nested subagent/decision tools. Parent model selection
is separate from worker route selection.

Remote push, PR creation/merge, GitHub mutation, deployment, multi-repository
writes, aggregate cost budgets, and print/JSON execution are outside v1.

## Development checks

```sh
npm install
npm test
npm run typecheck
npm run lint
npm pack --dry-run --json
```

The full lint command currently reports one pre-existing `no-useless-assignment`
error in the Phase 6 live-activity parser; focused Phase 9 files are clean.
The M1 live integration test is green locally, while protected-CI evidence is
not available in this handoff.

## License

MIT
