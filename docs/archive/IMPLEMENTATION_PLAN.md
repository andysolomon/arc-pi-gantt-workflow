# ARC Pi Gantt Workflow — Implementation Plan

**Status:** Phases 0–9 (release-ready handoff) complete locally. Protected-CI evidence for the M1 live integration test remains unavailable; the operator recorded a local-green override for Phase 6.
**Source artifact:** `docs/gantt-workflow/plan.md` (Plan worker, 2026-09-03). This file is the human-facing promotion of that artifact, with truncated/redacted lines restored from the Decision Ledger and parent-confirmed sibling seams.
**Task slug:** `gantt-workflow`
**Planning mode:** Hybrid greenfield + integration gap
**Suggested branch:** `feat/gantt-workflow-core-adapter` (PROPOSAL)
**Repositories:** `arc-pi-gantt-workflow` (this repo: generic library + thin Pi adapter). Read-only siblings: `arc-pi`, `arc-orchestrator`. Do not vendor into ARC Pi or change runner behavior.

Settled product decisions live in the ARC Decision Ledger (`semanticKey` prefix `arc-workflow.*`). This plan does not reopen them. Numeric bounds, package names, branch naming, and envelope field lists below are tagged **PROPOSAL** unless marked settled.

This plan is not Implement, merge, release, or Deploy authorization.

## 1. Product goal and scope boundaries

Build an interactive Gantt and progress-driven workflow controller for ARC Pi that can execute a large plan without stuffing every leaf into one session:

1. Import a phased plan or a flat story list into one validated DAG.
2. Persist authoritative workflow YAML under `.arc/workflows/<slug>/`.
3. Generate `docs/progress.txt` and Gantt projections, warning on drift.
4. Run each executable leaf in its own persisted in-process Pi `AgentSession`.
5. Ask material questions only through `arc_ask_operator`.
6. Delegate worker execution to `arc-orchestrator`.
7. Isolate writes in worktrees, then locally commit, ask, and cherry-pick.
8. Mark a leaf complete only after verification, optional risk-based review, integration, and an atomic progress update.

### Scope boundaries (settled)

- The controller may schedule, question, isolate, and locally integrate. It must not auto-push, open PRs, mutate GitHub, or deploy.
- `arc_ask_operator` is the only material-question system. A dashboard/widget shows status; it does not invent a second decision ledger.
- Children never load this workflow extension or nested subagents.
- Analyze stays parent-local in the child session. Implement still requires an exact contract and `implement_authorized: true`. Deploy is out of v1 child profiles.
- One writable repository in v1; schema fields may reserve later multi-repo IDs.
- No aggregate workflow cost budget. Conservative structural bounds are required.
- Print/JSON modes fail closed. TUI and RPC are required.

## 2. Settled design (Decision Ledger)

| Topic | Decision |
| --- | --- |
| Repo architecture | Generic library + thin ARC Pi adapter. Install later as a Pi package; do not vendor into `arc-pi`. |
| Source of truth | JSON-Schema-validated YAML under `.arc/workflows/<slug>/`. Generated progress/Gantt under `docs/`. One-time import + drift warning. |
| Internal model | One DAG. Phases are groups. Only executable leaves launch sessions. |
| Activation | Outcome, bounded scope, acceptance criteria, dependencies, preserved behavior. Exact ARC contract + workload class generated just in time. |
| Session boundary | One persisted in-process Pi `AgentSession` per executable leaf. Controller session stays put. |
| Child profiles | Four: Explore/Research, Plan/Analyze, Implement, Verify/Review. Every profile excludes this extension and nested subagents. No Deploy profile in v1. |
| Parent model | Profile-based. Child Analyze model is independent of orchestrator worker routes. |
| Concurrency | Default 4 (settled). Configurable. |
| Ownership | ARC Pi owns UI, questions, session/workflow control, private runtime journal. `arc-orchestrator` owns worker routing/execution. |
| Questions | Only `arc_ask_operator`. Children emit versioned bounded event envelopes; controller brokers and copies answers with provenance. |
| Question timing | Two-stage: structure at import; contracts/recovery/review/release when evidence exists. |
| Supervision | Configurable; default per-item. |
| Waiting policy | Configurable; default continue independent authorized branches. Hybrid question-queue priority. |
| Timeouts | Configured defaults may answer ordinary (`gate=none`) questions. Implement, integration, release, and Deploy gates fail closed on timeout and never auto-approve. |
| Isolation | Configurable; default worktree for every writing item. |
| Integration | After verification: local commit → ask → cherry-pick. Automatic conflict resolution allowed, then full workflow checks rerun. |
| Completion | Verified + optional risk-based independent review + integrated + atomic progress update. |
| Tracked state | YAML stores only planned, ready, completed, blocked, cancelled, needs-replan. Live/sensitive state stays in the private journal. |
| Recovery | Diagnose and propose, then a new Implement approval. Restart: reconcile then ask. Cancel: stop first, then ask what to preserve. Sessions retained through archival. |
| Control surface | One `/arc-workflow` namespace (`import\|open\|start\|pause\|resume\|status\|answer\|replan\|cancel\|archive`) plus dashboard and passive widget. |
| Modes | TUI and RPC. Print/JSON fail closed. |
| Tests | Live ARC integration by default locally and in protected CI; writes only in disposable temp repos/worktrees; no push/deploy. Fakes for forks/untrusted CI. |
| Budgets | No aggregate cost budget; conservative structural bounds required. |
| Shipping | Release-ready handoff + archival only; no automatic remote push/deploy. |
| Import | Deterministic extraction + model proposals; dependencies and parallel-safety must be confirmed. Live YAML edits use impact-based revalidation. |
| First milestone | One sequential end-to-end vertical slice (Phase 5) before parallel Gantt execution. |

## 3. Current baseline

### This repository

Scaffold only: `README.md`, `.gitignore`, git `main`, and the Plan artifact. No `package.json` workspace, schema modules, TypeScript, or tests.

### `arc-pi`

An upstream Pi package, not a fork. Registered extensions today:

- `extensions/arc-orchestrator/index.ts` — `arc_delegate`, Decision Ledger, `arc_ask_operator` (`decision-tools.ts`, `decision-ledger.ts`)
- `extensions/arc-subagents/index.ts` — `createIsolatedChildSession()` uses `SessionManager.inMemory()`; four-child cap; no ARC tools
- `extensions/arc-background-terminals/` — local `/bin/sh` jobs, not Pi sessions
- `extensions/arc-session-monitor/` — runner-session monitor, not workflow-child registry

No component parses or executes a Gantt / `progress.txt` DAG.

### `arc-orchestrator`

Worker routing, sandboxing, write locks, live-activity stderr events (`plugins/arc-orchestrator/lib/live-activity.ts`), and result envelopes. No Pi-session spawn/resume. The caller must create worktrees. Different checkout paths may write concurrently.

## 4. Missing capabilities

1. Validated workflow YAML schema and DAG types.
2. Deterministic importers for checkbox plans and flat stories, plus a confirm-only proposal hook.
3. Private journal + versioned child↔controller event envelopes.
4. Scheduler with settled concurrency, waiting policy, and hybrid question queue.
5. Persisted child `AgentSession` factory with four least-privilege profiles.
6. Question broker that is the only path to `arc_ask_operator`.
7. Worktree + local-commit + gated cherry-pick + post-conflict full checks.
8. `/arc-workflow` command namespace, TUI dashboard, and passive widget.
9. Sequential M1 slice, then parallel execution, recovery, live-edit, archival.

## 5. Architecture

```text
packages/workflow-core          DAG, validate, import, schedule, journal, render, integrate ports
packages/arc-pi-adapter         /arc-workflow, sessions, question broker, UI, orchestrator client

Pi operator ──► /arc-workflow ──► core scheduler
                     │
                     ├── arc_ask_operator (only questioning path)
                     ├── persisted child AgentSession per leaf
                     └── arc-orchestrator workers
```

`workflow-core` must not import Pi, ARC Pi, or orchestrator packages. Git and filesystem are injected ports. `arc-pi-adapter` contains no scheduling or validation logic.

### Proposed layout (names are PROPOSAL; split is settled)

```text
arc-pi-gantt-workflow/
├── package.json                          # workspace root
├── packages/
│   ├── workflow-core/                    # PROPOSAL: @arc/workflow-core
│   │   ├── schema/
│   │   │   ├── workflow.schema.json
│   │   │   ├── event-envelope.schema.json
│   │   │   └── checkpoint.schema.json
│   │   └── src/
│   │       ├── model/
│   │       ├── normalize/
│   │       ├── validate/
│   │       ├── import/
│   │       ├── schedule/
│   │       ├── events/
│   │       ├── journal/
│   │       ├── render/
│   │       └── integrate/
│   └── arc-pi-adapter/                   # PROPOSAL: @arc/pi-workflow
│       └── src/
│           ├── index.ts                  # ExtensionAPI factory
│           ├── commands/                 # /arc-workflow namespace
│           ├── sessions/                 # AgentSession factory + profiles
│           ├── questions/                # arc_ask_operator broker
│           ├── ui/                       # dashboard + widget
│           └── orchestrator/             # runner client
├── docs/
│   ├── IMPLEMENTATION_PLAN.md
│   ├── progress.txt
│   └── gantt-workflow/
├── examples/
└── test/
    ├── unit/
    ├── integration/
    └── fixtures/
```

## 6. Integration seams (parent-confirmed paths; Phase 0.3 still records signatures)

| Seam | Confirmed path | What Phase 0.3 must still record |
| --- | --- | --- |
| `arc_ask_operator` | `arc-pi/extensions/arc-orchestrator/decision-tools.ts` | Call signature, timeout/default-answer semantics, provenance fields |
| Decision Ledger | `arc-pi/extensions/arc-orchestrator/decision-ledger.ts` | Read-only citation format; this extension does not write ledger records except through `arc_ask_operator` |
| `arc_delegate` | `arc-pi/extensions/arc-orchestrator/index.ts`, `contract.ts` | How Implement approval is requested so the controller reuses it |
| Isolated child session | `arc-pi/extensions/arc-subagents/index.ts` (`createIsolatedChildSession`) | How to inject `SessionManager.create()` instead of `inMemory()` |
| Child manager / UI | `arc-pi/extensions/arc-subagents/manager.ts`, `ui.ts` | Subscribe/abort/steer patterns to reuse, not copy blindly |
| Background terminals | `arc-pi/extensions/arc-background-terminals/` | Per-item test/dev-server jobs only; not the session engine |
| Session monitor | `arc-pi/extensions/arc-session-monitor/` | Workflow registry vs runner-session IDs |
| Runner live activity | `arc-orchestrator/plugins/arc-orchestrator/lib/live-activity.ts` | Wrap v1/v2 stderr events into bounded envelopes |
| Runner CLI | `arc-orchestrator/plugins/arc-orchestrator/bin/arc-orchestrator` | Invoke via existing Pi wrapper; do not reimplement routing |
| Session replacement (do not use for children) | Pi `ctx.newSession()` / `examples/extensions/handoff.ts` | Command-only; replaces the visible controller |

Write confirmed signatures into `docs/gantt-workflow/seams.md` during 0.3. No TBD rows after that leaf.

## 7. Milestones / implementation slices

Every numbered item is an executable leaf. Groups do not launch sessions. Each leaf still needs its own Implement approval. File ownership is the only tree that leaf may write.

### Phase 0 — Scaffold and seams

**Goal:** Empty workspace that can test schemas and record sibling seams.

- **0.1 Workspace scaffold** — owns `package.json`, `packages/*/package.json`, `tsconfig*`, lint/test config. Outcome: `npm test` runs an empty suite in both packages. Preserved: README positioning-only. depends: [].
- **0.2 Schema drafts** — owns `packages/workflow-core/schema/*.schema.json`. Outcome: workflow, checkpoint, and event-envelope schemas validate `examples/` fixtures. Acceptance: schema tests pass; reserved `multi_repo` fields exist but v1 writes a single repository. depends: [0.1].
- **0.3 Seam confirmation** — owns `docs/gantt-workflow/seams.md`. Outcome: every §6 row has a confirmed path and signature. Acceptance: no TBD rows. Read-only in sibling repos. depends: [0.1].

**Risks:** Package-name churn; sibling APIs drift. **Acceptance:** empty tests pass; schemas reject unbounded/malformed fixtures.

### Phase 1 — Core model, normalization, validation

**Goal:** A DAG the scheduler can trust without Pi.

- **1.1 DAG model + checkpoint enum** — owns `workflow-core/src/model`. Acceptance: only the six settled checkpoints exist. depends: [0.2].
- **1.2 Normalizer (phased + flat)** — owns `src/normalize`. Acceptance: fixture plans and story lists normalize to the same DAG shape; groups never become leaves. depends: [1.1].
- **1.3 Validator + activation gate** — owns `src/validate`. Acceptance: a leaf missing any of the five activation fields stays `planned`, never `ready`; cycles fail; structural bounds (§9) enforced. depends: [1.2].
- **1.4 Deterministic importer** — owns `src/import`. Acceptance: headings/checkboxes extract deterministically; model-proposal hook is an interface only (no model calls in core). depends: [1.2].
- **1.5 Renderers + drift check** — owns `src/render`. Acceptance: `progress.txt` and Gantt regenerate byte-stable; editing generated docs after import produces a drift warning, never a silent overwrite. depends: [1.1].

**Risks:** Overfitting the importer to one markdown dialect. **Acceptance:** unit tests only; no ARC workers.

### Phase 2 — Journal, events, scheduling

**Goal:** Durable runtime state and a ready-set that honors settled policy.

- **2.1 Private runtime journal** — owns `src/journal`. Acceptance: append-only; local path outside tracked YAML; secrets/transcripts redacted at write time. depends: [1.1].
- **2.2 Event envelope** — owns `src/events` and the envelope schema. Acceptance: versioned, size-bounded, schema-validated; unknown versions rejected. depends: [0.2, 2.1].
- **2.3 Scheduler** — owns `src/schedule`. Acceptance: ready-set = leaves whose deps are `completed` and that pass activation; default concurrency 4; default wait policy continues independent authorized branches; hybrid question queue (mandatory gates → critical path → FIFO, with UI pick). depends: [1.3, 2.2].

**Risks:** Treating Gantt overlap as proof of disjoint writes. **Acceptance:** fixture DAGs only; no sessions yet.

### Phase 3 — Sessions, questions, orchestrator bridge

**Goal:** Isolated leaf execution that can ask the operator and call the runner.

- **3.1 Child profiles** — owns `arc-pi-adapter/src/sessions`. Acceptance: four profiles; each excludes this extension and nested-subagent tools; parent model is profile-based. depends: [0.3].
- **3.2 Session lifecycle** — owns `src/sessions`. Acceptance: one persisted in-process `AgentSession` per leaf; reopen after process restart; retain through archival. depends: [3.1, 2.1].
- **3.3 Question broker** — owns `src/questions`. Acceptance: only `arc_ask_operator` is called; answers copied to the journal with provenance (who, when, source, envelope id); ordinary questions may use configured timeout defaults; Implement/integration/release/Deploy gates fail closed and never auto-approve. depends: [2.2, 0.3].
- **3.4 Orchestrator bridge** — owns `src/orchestrator`. Acceptance: worker runs go through `arc-orchestrator`; runner behavior unchanged; live-activity events wrapped into envelopes. depends: [2.2, 0.3].

**Risks:** Recursive workflow loading; leaking transcripts into envelopes. **Acceptance:** credential-free unit tests plus a disposable-repo live check only after M1 wiring.

### Phase 4 — Isolation and integration

**Goal:** Verified work leaves a local commit and enters the integration branch only after approval.

- **4.1 Worktree manager** — owns `workflow-core/src/integrate`. Acceptance: default worktree per writing item; configurable off; cleanup on cancel only after the preserve/delete answer. depends: [2.1].
- **4.2 Verify → local commit → ask → cherry-pick** — owns integrate + adapter glue. Acceptance: no cherry-pick without an affirmative integration answer; timeout fails closed. depends: [4.1, 3.3].
- **4.3 Conflict policy + full rerun** — owns `src/integrate`. Acceptance: automatic resolution is followed by full workflow checks; failure returns the item to `needs-replan`. depends: [4.2].
- **4.4 Completion + atomic progress update** — owns render + integrate. Acceptance: YAML checkpoint, `progress.txt`, and Gantt update in one atomic write; optional risk-based independent review hook. depends: [4.3, 1.5].

**Risks:** Cherry-pick identity vs dependent branches; automatic conflict resolution changing reviewed semantics. Full rerun is mandatory after auto-resolve.

### Phase 5 — M1 sequential vertical slice (first milestone)

**Goal:** Prove the trust boundary end to end before any parallel Gantt work.

- **5.1 M1 fixture workflow** — owns `examples/m1-vertical-slice/` and matching `test/fixtures/`. Outcome: a single-leaf fixture with activation-ready YAML, expected question/commit/cherry-pick evidence, and a disposable-repo recipe. depends: [4.4].
- **5.2 Sequential runner** — owns adapter `src/run-sequential.ts` (PROPOSAL). Acceptance: concurrency forced to 1; exercises 1.x–4.4 on a temp-dir fixture repo. depends: [2.3, 3.3, 3.4, 4.4, 5.1].
- **5.3 Live ARC integration test for M1** — owns `test/integration/m1-vertical-slice.test.ts`. Acceptance: passes locally and in protected CI; writes only in a temp repo/worktree; no push. depends: [5.2].

**Gate:** Nothing in Phases 6–9 starts until 5.3 is green in protected CI.

### Phase 6 — Parallel Gantt execution

- **6.1 Parallel scheduler activation** — default concurrency 4, per-item supervision, dependency-aware waves, single-flight protection, and serialized integration/completion boundaries. Acceptance: a 4-leaf fixture reaches the expected terminal states without duplicate completion targeting. depends: [5.3].
- **6.2 Question queue under parallelism** — hybrid priority verified with ≥2 concurrent waiting items. Acceptance: one shared bounded queue serializes `arc_ask_operator`, prioritizes UI pick → mandatory gate → critical path → FIFO, preserves item/question provenance, and enforces total/per-item bounds. depends: [6.1, 3.3].
- **6.3 Dashboard + passive widget** — owns `adapter/src/ui`; TUI and RPC. Acceptance: deterministic checkpoint/runtime/question snapshots render through TUI and a passive widget, while bounded JSON-safe RPC exposes status, widget, and question selection without a second prompt path. depends: [6.1].

### Phase 7 — Recovery, restart, cancel

- **7.1 Recovery** — diagnose + propose, then a new Implement approval. depends: [6.1].
- **7.2 Restart** — reconcile journal vs YAML vs worktrees, then ask. depends: [7.1].
- **7.3 Cancel** — stop sessions first, then ask what to preserve. depends: [7.1].

### Phase 8 — Live edits and import proposals (8.0 complete)

- [x] **8.1 Impact-based revalidation** on live YAML edits. depends: [1.3, 6.1].
- [x] **8.2 Model-proposal importer** (adapter) — dependencies and parallel-safety must be confirmed via `arc_ask_operator` before any leaf becomes `ready`. depends: [1.4, 3.3].

### Phase 9 — Release-ready handoff (9.0 complete locally)

- [x] **9.1 Archival** — terminal-state and ownership preflight, one brokered `release` keep/delete decision, atomic final YAML/progress/Gantt writes, and injected session/journal retention ports. depends: [7.1, 7.2, 7.3].
- [x] **9.2 Source/Git Pi package readiness** — root `pi.extensions` manifest, strict package allowlist, loadable `/arc-workflow` entrypoint, and tarball/install smoke checks; no remote push/deploy automation. depends: [9.1].
- [x] **9.3 Operator and user docs** — README and `docs/USER_GUIDE.md` cover isolated-profile installation, `/arc-workflow` commands, six-state status interpretation, decision gates, and the Pi-parent/ARC-worker boundary. depends: [9.2].

## 8. Acceptance criteria for v1

1. A fixture repo with a phased markdown plan imports to `.arc/workflows/<slug>/workflow.yaml` that validates against the schema.
2. Generated `docs/progress.txt` and Gantt reflect only checkpoint states; a drift warning appears on manual edit.
3. M1 runs one leaf to `completed` with: persisted child session, at least one brokered question with provenance, local commit, integration approval, cherry-pick, atomic progress update.
4. A 4-leaf fixture respects concurrency 4 and per-item supervision.
5. Timeout on an Implement or integration question leaves the item blocked; no auto-approval path exists in code.
6. Recovery, restart, and cancel each follow the settled ask-first ordering.
7. Live integration tests write only in temp repos/worktrees; CI proves no push.

## 9. Structural bounds (PROPOSAL — tune later; stay conservative)

| Bound | Proposed default | Configurable |
| --- | --- | --- |
| Max leaves per workflow | 200 | yes |
| Max DAG depth (group nesting) | 6 | yes |
| Max dependencies per leaf | 20 | yes |
| Concurrency | 4 (settled) | yes |
| Max live worktrees | = concurrency | derived |
| Event envelope max payload | 32 KiB | yes |
| Max pending questions per item | 3 | yes |
| Max queued questions total | 32 | yes |
| Ordinary question timeout | 30 min | yes |
| Mandatory gate timeout | 24 h → fail closed (never auto-approve; settled) | duration only |
| Max automatic recovery attempts per item | 1 (then new Implement approval; settled ordering) | count only |
| Max integration conflict auto-resolve retries | 2 | yes |
| Journal file size before rotation | 50 MiB | yes |

## 10. Naming and schema proposals (PROPOSAL)

- Package names: `@arc/workflow-core`, `@arc/pi-workflow`.
- Worktree/branch: `arc/wf/<slug>/<item-id>`; worktree dir `.arc/worktrees/<slug>/<item-id>/`.
- Local commit: `arc(wf:<slug>): <item-id> <title>`; cherry-pick keeps the subject plus an `Integrated-From:` trailer.
- Workflow file: `.arc/workflows/<slug>/workflow.yaml`; config `config.yaml`; journal `.arc/workflows/<slug>/.journal/` (gitignored; also covered by `.arc/runtime/`).
- Event envelope fields: `envelope_version` (semver), `event_id` (ulid), `workflow_slug`, `item_id`, `session_id`, `emitted_at`, `kind` (`question\|progress\|artifact\|verify\|error\|done`), bounded `payload`, `provenance`.
- Question payload: `question_id`, `text`, `options[]`, `gate` (`none\|implement\|integration\|release\|deploy`), `default_on_timeout` only when `gate=none`.
- Checkpoint on each item: `state` ∈ the six settled values; `updated_at`; `evidence_ref` (journal id, never transcript text).

## 11. Out of scope for version one

- Automatic remote push, PR creation, GitHub mutation, or deploy.
- Multi-repo writes (schema fields reserved only).
- Aggregate cost budgets.
- Nested workflows or nested subagents.
- A second questioning mechanism; auto-approval of mandatory gates.
- Vendoring into `arc-pi`; changing `arc-orchestrator` runner behavior.
- Print/JSON execution mode.
- Secrets or raw transcripts in YAML, docs, or events.
- Prebundling into the ARC Pi distribution.

## 12. Acceptance-criteria mapping

| Product criterion | Phase(s) | Verification |
| --- | --- | --- |
| DAG from phased or flat input | 1 | Unit fixtures |
| Activation fields before `ready` | 1.3 | Validator tests |
| Drift-safe projections | 1.5 | Renderer tests |
| Persisted child session per leaf | 3.2, 5 | M1 live test |
| `arc_ask_operator` only | 3.3 | Broker tests; no other prompt path |
| Fail-closed mandatory gates | 3.3, 4.2 | Timeout tests |
| Worktree + gated cherry-pick | 4 | Integration + M1 |
| Sequential vertical slice | 5 | Live ARC, temp repo only |
| Parallel Gantt | 6 | 4-leaf fixture |
| Recovery / restart / cancel | 7 | Journal + ask-order tests |
| Release-ready handoff | 9 | Docs + package install; no push |

## 13. Recommended implementation sequence

```text
0.1 → 0.2 → 0.3 → 1.1 → 1.2 → 1.3 → 1.5 → 1.4 →
2.1 → 2.2 → 2.3 → 3.1 → 3.2 → 3.3 → 3.4 →
4.1 → 4.2 → 4.3 → 4.4 → 5.1 → 5.2 → 5.3 (M1 gate) →
6.1 → 6.2 → 6.3 → 7.1 → 7.2 → 7.3 →
8.1 → 8.2 → 9.1 → 9.2 → 9.3
```

Each arrow is a separate Implement approval. Nothing after 5.3 starts until the M1 live test is green in protected CI.

## 14. Immediate next steps

1. Review this plan and `docs/progress.txt` against the Decision Ledger.
2. Do not start product TypeScript until an exact Phase 0.1 Implement contract is approved.
3. Keep this plan and `docs/progress.txt` synchronized as leaves complete.
4. Completed in this handoff: move both files to `docs/archive/` together and retain the protected-CI evidence caveat.
