# ARC Pi Gantt Workflow — Operator Guide

This guide describes the release-ready source package in this repository. It
is intentionally limited to the workflow controller boundary: the package
coordinates local workflow state and asks for decisions, while
`arc-orchestrator` executes separately authorized worker contracts.

## 1. Prerequisites and installation

Use Node.js `22.19.0` or newer, Pi `0.80` or newer, Git, and an installed ARC
orchestrator when a workflow needs live workers. Pi packages execute trusted
local TypeScript, so inspect the source and pin a reviewed ref before loading
it.

### Local checkout

```sh
pi install /absolute/path/to/arc-pi-gantt-workflow
```

A relative path is also supported when it is resolved from the Pi settings
file's directory:

```sh
pi install ./arc-pi-gantt-workflow
```

### Reviewed Git ref

This project does not publish an npm package. Install a reviewed Git commit or
tag instead of using an unpinned moving branch:

```sh
pi install git:github.com/andysolomon/arc-pi-gantt-workflow@<reviewed-ref>
```

### Isolated ARC-Pi profile

Pi's package settings follow `PI_CODING_AGENT_DIR`. Install into the same
isolated profile used by ARC Pi, or let the ARC-Pi launcher set this variable:

```sh
PI_CODING_AGENT_DIR="$HOME/.arc-pi" \
  pi install /absolute/path/to/arc-pi-gantt-workflow
```

The package manifest points Pi at
`packages/arc-pi-adapter/src/extension.ts`. Pi loads that TypeScript source
directly. There is no `postinstall` setup, credential migration, or home
directory mutation.

Update a pinned Git installation explicitly:

```sh
pi update --extension git:github.com/andysolomon/arc-pi-gantt-workflow@<reviewed-ref>
```

`pi update --extensions` updates all registered packages. Inspect the package
source again after an update.

## 2. Workflow files and import

A workflow's source of truth is:

```text
.arc/workflows/<slug>/workflow.yaml
```

The generated progress and Gantt documents are projections. Runtime journal
records belong under ignored `.arc/runtime/` paths and are redacted before
persistence; do not put credentials or transcripts in workflow YAML or docs.

Import a markdown plan in TUI or RPC mode:

```text
/arc-workflow import plan.md my-workflow
```

H1–H3 headings become groups and checkboxes become executable leaves. A flat
checkbox list is accepted as a flat workflow. Imported leaves intentionally
start as `planned` when their activation fields are not present; import does
not invent acceptance criteria or authorize work.

Open or inspect an existing workflow:

```text
/arc-workflow open my-workflow
/arc-workflow status my-workflow
```

Malformed YAML, invalid DAG references, cycles, and unsupported checkpoint
states fail closed with a diagnostic. Existing generated documents must not be
silently overwritten after a manual edit; use the workflow source and the
renderer to regenerate them.

## 3. Command reference

The extension registers only the `/arc-workflow` namespace:

| Command | Purpose |
| --- | --- |
| `help` | Show the command syntax. |
| `import <plan.md> [slug]` | Extract and persist a workflow source. |
| `open <slug>` | Load a validated workflow and publish its dashboard/widget. |
| `status [slug]` | Show the current or named workflow dashboard. |
| `start [slug]` | Start executable leaves through an embedding controller. |
| `pause [slug]` | Pause scheduling through an embedding controller. |
| `resume [slug]` | Resume scheduling through an embedding controller. |
| `answer <question-id> <answer>` | Submit a queued answer through the controller. |
| `replan <item-id>` | Mark a failed contract for replanning through the controller. |
| `cancel <item-id>` | Stop first, then ask what to preserve. |
| `archive [slug]` | Finalize terminal checkpoints, ask keep/delete, and archive resources. |

The source-loaded entrypoint implements deterministic import/open/status and
help. In a bare package load, lifecycle operations that need sessions, a
scheduler, a question broker, or owned resources fail closed without changing
files. An embedding ARC-Pi controller supplies those ports; the package never
uses a second UI prompt to bypass `arc_ask_operator`.

TUI and RPC are the supported execution modes. Print and JSON modes fail
closed because they cannot safely provide the required interactive decision
boundary.

## 4. Reading status

The dashboard is a projection, not a quality score. Read it in this order:

1. **Completed / leaves** — terminal success count over executable leaves.
2. **Active / capacity** — currently executing leaves and available scheduler
   slots. The default concurrency limit is four.
3. **Waiting / questions** — leaves paused for a brokered operator decision.
4. **Checkpoint counts** — authoritative persisted state distribution.
5. **Live progress** — bounded, ephemeral labels; it is not journal evidence.

The six checkpoint states are closed and have these meanings:

| State | Interpretation | Next action |
| --- | --- | --- |
| `planned` | The leaf is not activated or a dependency is incomplete. | Complete the contract or dependency. |
| `ready` | The leaf passes activation and completed-dependency checks. | Start only after Implement approval. |
| `completed` | Verification, integration, and atomic completion persistence passed. | No further execution for this leaf. |
| `blocked` | A required decision or safety condition stopped the leaf. | Resolve the decision or replan. |
| `cancelled` | Stop intent was recorded and the preservation answer was applied. | Keep the retained evidence or create new work. |
| `needs-replan` | Current evidence invalidated the implementation contract. | Diagnose, propose, and obtain a new Implement approval. |

Integration results also carry `low`, `medium`, or `high` risk. A clean
integration is low risk; conflict resolution raises risk, and failed or
uncertain integration checks are high risk. Risk review is separate from
operator authorization. There is no aggregate cost score or automatic
approval of a mandatory gate.

## 5. Decision and safety boundaries

Only `arc_ask_operator` is allowed to ask a material question. The broker
copies bounded provenance into the private journal. The `implement`,
`integration`, `release`, and `deploy` gates fail closed and never accept a
timeout default.

The Pi parent/controller owns:

- workflow import, YAML validation, DAG scheduling, and live-edit impact;
- persisted child session records and the private runtime journal;
- worktree isolation, local verification, commit/cherry-pick integration;
- recovery, restart, cancellation, dashboard, and archive decisions.

`arc-orchestrator` owns worker routing and execution after the parent supplies
an exact outcome, scope, verification, preserved behavior, prohibitions, and
approved workload class. The worker route is not the parent model. Children do
not load this workflow extension or nested decision/subagent tools.

The v1 controller does not automatically push, create or merge pull requests,
mutate GitHub, deploy, write multiple repositories, or install provider CLIs.
Those are explicit operator-owned delivery actions outside this package.

## 6. Archival

Archival is allowed only after every executable leaf has a terminal checkpoint:
`completed`, `blocked`, `cancelled`, or `needs-replan`. Groups do not make an
unfinished leaf archival-safe.

The archive controller:

1. preflights workflow validity and ownership of each session and the journal;
2. asks one mandatory `release` question with `keep` and `delete` options;
3. writes the final YAML, progress projection, and Gantt projection atomically;
4. only after a successful write, archives or deletes the owned resources named
   by the answer.

A failed, timed-out, invalid, or unavailable decision leaves resources and final
projections untouched. Deletion is never an arbitrary path operation. Retained
sessions remain available for inspection; cancellation's existing retain-only
session behavior is unchanged.

The plan and progress tracker are internal handoff artifacts. At completion
they move together into `docs/archive/`, so `docs/` contains only active
operator documentation and source-specific notes.

## 7. Troubleshooting

- **No workflow is open:** run `/arc-workflow open <slug>` or import a plan.
- **Lifecycle command says host controller is required:** the bare package has
  no session/scheduler/resource ports; load it through the embedding ARC-Pi
  controller rather than bypassing the command boundary.
- **A leaf is still `planned`:** check all five activation fields and its
  dependencies; readiness is never inferred from a checkbox alone.
- **A leaf is `needs-replan`:** inspect bounded journal evidence, revise the
  contract, and request a new Implement approval.
- **A question is unavailable:** retry only through the broker after the
  operator can answer; mandatory gates do not use defaults.
- **M1 protected-CI evidence:** the local M1 integration test is green, but
  protected-CI evidence is not available in this handoff and must not be
  represented as green.
