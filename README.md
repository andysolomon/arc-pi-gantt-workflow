# ARC Pi Gantt Workflow

Interactive Gantt and progress-driven workflow control for ARC Pi.

This repository will ship a generic workflow library plus a thin ARC Pi
adapter. Version one turns phased plans and flat story lists into a
validated DAG, runs each executable leaf in its own persisted Pi session,
and uses `arc_ask_operator` for material decisions.

**Status:** Phase 1 is complete (model, normalizer, validator, importer,
renderers + drift check); Phase 2 runtime work has not started. See
`docs/IMPLEMENTATION_PLAN.md` and
`docs/progress.txt`.

## Version-one shape

```text
ARC Pi controller
  ├── /arc-workflow dashboard + widget
  ├── question broker (arc_ask_operator)
  ├── durable YAML + private runtime journal
  └── persisted child AgentSession per work item
        └── arc-orchestrator workers
```

The workflow controller owns sessions, questions, scheduling, worktrees,
and local integration. `arc-orchestrator` remains the worker execution
engine. Children never load this workflow extension.

## Out of scope for version one

- Automatic remote push, GitHub mutation, or deployment
- Multi-repository writes
- Aggregate workflow cost budgets
- Nested workflow or nested subagent spawning
