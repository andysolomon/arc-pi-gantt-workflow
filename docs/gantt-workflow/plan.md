# ARC Pi Gantt Workflow — Version-One Plan Artifact

ARC phase: plan (analyze mode). Worker-authored artifact.

Promoted 2026-09-03: the human-facing files are
`docs/IMPLEMENTATION_PLAN.md` and `docs/progress.txt`. The parent restored
truncated/redacted leaves and sibling seam paths. Prefer those two files
over this artifact.

This file originally held two documents for the parent to promote:

- Section A → `docs/IMPLEMENTATION_PLAN.md`
- Section B → `docs/progress.txt`

Both sections are written against the settled version-one design in the
task brief. Every "PROPOSAL" tag below marks an implementation detail
(numeric bound, name, schema field) that is not a product decision and may
be changed by the implementer without reopening the Decision Ledger.
Everything not tagged PROPOSAL restates a settled answer and must not be
reverted.

Provenance note: the planning worker was denied read access to
`arc-prompt-optimizer/docs/*`, `arc-pi/`, and `arc-orchestrator/` in this
run. Structure was emulated from the brief's description of those files,
and every sibling-repo file path cited below is an integration seam name
that the implementer must confirm against the sibling checkout before
Phase 0 exits (see Phase 0.3).

---

## Section A — `docs/IMPLEMENTATION_PLAN.md`

# ARC Pi Gantt Workflow — Implementation Plan (v1)

Status: planning only. Nothing in this document authorizes Implement,
integration, release, or Deploy. Each phase below still requires its own
per-item Implement approval through the existing `arc_delegate` gates.

## 1. Goal

Turn phased plans and flat story lists into one validated DAG, run each
executable leaf in its own persisted in-process Pi `AgentSession`, broker
every material question through the existing `arc_ask_operator`, and
integrate verified work locally with explicit operator approval. Deliver a
generic workflow library plus a thin ARC Pi adapter, installed later as a
Pi package (never vendored into `arc-pi`).

First milestone (M1): one sequential end-to-end vertical slice — import →
validate → activate one leaf → run one child session → verify → local
commit → ask → cherry-pick → atomic progress update — before any parallel
Gantt execution exists.

## 2. Settled design (restated, not reopened)

| Area | Settled answer |
| --- | --- |
| Repo shape | This repo: generic library + ARC Pi adapter; consumed by arc-pi as a Pi package. |
| Source of truth | JSON-Schema-validated YAML under `.arc/workflows/<slug>/`. Generated progress/Gantt live under `docs/`; one-time import plus drift warning. |
| Normalization | Phased plans and flat stories → one DAG. Phases are groups; only executable leaves launch sessions. |
| Activation gate | Leaf needs outcome, bounded scope, acceptance criteria, dependencies, preserved behavior. Exact ARC contracts + workload class generated just in time. |
| Sessions | One persisted in-process Pi `AgentSession` per executable leaf. |
| Child profiles | Explore/Research, Plan/Analyze, Implement, Verify/Review. All exclude this extension and nested subagents. Parent model is profile-based. |
| Concurrency | Default 4. |
| Ownership | ARC Pi owns UI, questions, session/workflow control, private runtime journal. `arc-orchestrator` owns worker routing/execution. |
| Questions | Only `arc_ask_operator`. Children emit versioned bounded event envelopes; controller brokers and copies answers with provenance. No second questioning system. |
| Supervision | Configurable; default per-item. |
| Waiting policy | Configurable; default continue independent authorized branches. Hybrid question-queue priority. |
[absolute path redacted]
| Isolation | Configurable; default worktree per writing item. |
| Integration | After verification: local commit → ask → cherry-pick. Automatic conflict resolution allowed, then full workflow checks rerun. |
| Completion | verified + optional risk-based independent review + integrated + atomic progress update. |
| Tracked state | YAML stores stable checkpoints only: planned, ready, completed, blocked, cancelled, needs-replan. Live/sensitive state in private journal. |
| Recovery | Diagnose and propose, then require a new Implement approval. Restart: reconcile then ask. Cancel: stop first, then ask what to preserve. Sessions retained through archival. |
[absolute path redacted]
| Tests | Live ARC integration by default locally and in protected CI; writes only in disposable temp repos/worktrees; no push/deploy. |
| Budgets | No aggregate cost budget; conservative structural bounds required. |
| Shipping | Release-ready handoff + archival only; no automatic remote push/deploy. Single writable repo first, schema-ready for multi-repo. |
| Import | Deterministic extraction + model proposals; dependencies/parallel-safety must be confirmed. Live YAML edits use impact-based revalidation. |

## 3. Repository layout (PROPOSAL: names; settled: library + thin adapter split)

```text
arc-pi-gantt-workflow/
├── package.json # PROPOSAL: workspace root, npm workspaces
├── packages/
│ ├── workflow-core/ # PROPOSAL name: @arc/workflow-core (generic, no Pi imports)
│ │ ├── schema/
│ │ │ ├── workflow.schema.json # authoritative YAML schema (JSON Schema draft 2020-12)
│ │ │ ├── event-envelope.schema.json
│ │ │ └── checkpoint.schema.json
│ │ └── src/
│ │ ├── model/ # DAG types, item kinds (group|leaf), checkpoint enum
│ │ ├── normalize/ # phased-plan + flat-story → DAG
│ │ ├── validate/ # schema + structural bounds + activation gate
│ │ ├── import/ # deterministic extractors (markdown plan, checkbox tracker)
│ │ ├── schedule/ # ready-set computation, concurrency, waiting policy
│ │ ├── events/ # envelope types, versioning, redaction
│ │ ├── journal/ # private runtime journal (append-only, local only)
│ │ ├── render/ # progress.txt + Gantt (mermaid/text) generators, drift check
│ │ └── integrate/ # worktree, local commit, cherry-pick, conflict policy (git via injected port)
│ └── arc-pi-adapter/ # PROPOSAL name: @arc/pi-workflow (thin; Pi extension entry)
│ └── src/
[absolute path redacted]
│ ├── sessions/ # AgentSession factory + child profile definitions
│ ├── questions/ # arc_ask_operator broker (single questioning path)
[absolute path redacted]
│ ├── ui/ # dashboard + passive widget (TUI + RPC)
│ └── orchestrator/ # arc-orchestrator client for worker routing
├── docs/
│ ├── IMPLEMENTATION_PLAN.md
│ ├── progress.txt
│ └── gantt-workflow/ # ARC phase artifacts
├── examples/ # sample .arc/workflows/<slug>/ fixtures used by tests
└── test/
├── unit/ # core-only, no ARC
├── integration/ # live ARC, disposable temp repos
└── fixtures/
```

Rules:
- `workflow-core` must not import `@mariozechner/pi-*`, `arc-pi`, or
`arc-orchestrator`. Git and filesystem are injected ports.
- `arc-pi-adapter` contains no scheduling or validation logic; it wires
core to Pi sessions, questions, UI, and orchestrator.
- Product TypeScript is not created in this planning phase.

## 4. Integration seams to confirm (Phase 0)

The implementer must locate and record the exact file paths for these
seams in `docs/gantt-workflow/seams.md` (PROPOSAL) before Phase 1:

| Seam | Owner repo | What is needed |
| --- | --- | --- |
| `arc_ask_operator` tool | arc-pi | Call signature, timeout/default-answer semantics, provenance fields. |
[absolute path redacted]
[absolute path redacted]
| Decision Ledger | arc-pi | Read-only reference format for citing recorded answers; no writes from this extension. |
| `arc_delegate` gates | arc-pi | How Implement approval is requested so the controller reuses it rather than reimplementing. |
[absolute path redacted]
| Runner event stream | arc-orchestrator | Event shape to wrap into the bounded envelope. |

## 5. Phases and subphases

Dependencies are listed as `depends: [...]`. File ownership names the
package/directory an item may write. Every phase is a group; only its
numbered leaves are executable. Each leaf carries the five activation
fields (outcome, scope, acceptance, dependencies, preserved behavior) in
compressed form.

### Phase 0 — Scaffold and seams (group)

- **0.1 Workspace scaffold** — owns `package.json`, `packages/*/package.json`, `tsconfig*`, `.gitignore`, lint/test config. Outcome: `npm test` runs an empty suite in both packages. Preserved: README positioning-only. depends: [].
- **0.2 Schema drafts** — owns `packages/workflow-core/schema/*.schema.json`. Outcome: workflow, checkpoint, and event-envelope schemas validate the `examples/` fixtures. Acceptance: schema tests pass; `multi_repo` fields present but singl…
- **0.3 Seam confirmation** — owns `docs/gantt-workflow/seams.md`. Outcome: every row of §4 has a confirmed path and signature. Acceptance: no "TBD" rows. depends: [0.1]. (Read-only in sibling repos.)

### Phase 1 — Core model, normalization, validation (group)

- **1.1 DAG model + checkpoint enum** — owns `workflow-core/src/model`. Acceptance: type-level tests; only the six settled checkpoints exist. depends: [0.2].
- **1.2 Normalizer (phased + flat)** — owns `src/normalize`. Acceptance: fixture plans and story lists normalize to identical DAG shape; groups never become leaves. depends: [1.1].
- **1.3 Validator + activation gate** — owns `src/validate`. Acceptance: leaf lacking any of the five fields is `planned`, never `ready`; cycle detection; structural bounds (§7) enforced. depends: [1.2].
- **1.4 Deterministic importer** — owns `src/import`. Acceptance: markdown headings/checkboxes extract deterministically; model-proposal hook is an interface only (no model calls in core). depends: [1.2].
- **1.5 Renderers + drift check** — owns `src/render`. Acceptance: `progress.txt` and Gantt regenerate byte-stable; editing generated docs after import produces a drift warning, never a silent overwrite. depends: [1.1].

### Phase 2 — Journal, events, scheduling (group)

- **2.1 Private runtime journal** — owns `src/journal`. Acceptance: append-only, local path outside tracked YAML, redaction of secrets/transcripts at write time. depends: [1.1].
- **2.2 Event envelope** — owns `src/events`, `schema/event-envelope.schema.json`. Acceptance: versioned, size-bounded, schema-validated; unknown versions rejected. depends: [0.2, 2.1].
- **2.3 Scheduler** — owns `src/schedule`. Acceptance: ready-set = leaves whose deps are `completed` and that pass activation; concurrency cap honored (default 4); waiting policy default "continue independent authorized branches"; hybrid q…

### Phase 3 — Sessions, questions, orchestrator bridge (group)

- **3.1 Child profiles** — owns `arc-pi-adapter/src/sessions`. Acceptance: four profiles; each excludes this extension and any subagent tool; parent model profile-based. depends: [0.3].
- **3.2 Session lifecycle** — owns `src/sessions`. Acceptance: one persisted in-process `AgentSession` per leaf; resume after process restart; retained through archival. depends: [3.1, 2.1].
- **3.3 Question broker** — owns `src/questions`. Acceptance: only `arc_ask_operator` is called; answers copied to journal with provenance (who, when, source, envelope id); ordinary questions may use configured timeout defaults; Implement/…
- **3.4 Orchestrator bridge** — owns `src/orchestrator`. Acceptance: worker runs routed through arc-orchestrator; runner behavior unchanged; events wrapped into envelopes. depends: [2.2, 0.3].

### Phase 4 — Isolation and integration (group)

- **4.1 Worktree manager** — owns `workflow-core/src/integrate`. Acceptance: default worktree per writing item; configurable off; cleanup on cancel only after "what to preserve" answer. depends: [2.1].
- **4.2 Verify → local commit → ask → cherry-pick** — owns `src/integrate`, adapter glue. Acceptance: no cherry-pick without an affirmative integration answer; timeout = fail closed. depends: [4.1, 3.3].
- **4.3 Conflict policy + full rerun** — owns `src/integrate`. Acceptance: automatic resolution is followed by full workflow checks; failure returns item to `needs-replan`. depends: [4.2].
- **4.4 Completion + atomic progress update** — owns `src/render`, `src/integrate`. Acceptance: YAML checkpoint, `progress.txt`, and Gantt update in one atomic write; optional risk-based independent review hook. depends: [4.3, 1.5].

### Phase 5 — M1 sequential vertical slice (group) ← FIRST MILESTONE

[absolute path redacted]
- **5.2 Sequential runner** — owns adapter `src/run-sequential.ts` (PROPOSAL). Acceptance: concurrency forced to 1; exercises 1.x–4.4 end to end on a fixture repo in a temp dir. depends: [2.3, 3.3, 3.4, 4.4, 5.1].
- **5.3 Live ARC integration test for M1** — owns `test/integration/m1-vertical-slice.test.ts`. Acceptance: passes locally and in protected CI; writes only in temp repo/worktree; no push. depends: [5.2].

### Phase 6 — Parallel Gantt execution (group)

- **6.1 Parallel scheduler activation** — concurrency default 4, per-item supervision default. depends: [5.3].
- **6.2 Question queue under parallelism** — hybrid priority verified with ≥2 concurrent waiting items. depends: [6.1, 3.3].
- **6.3 Dashboard + passive widget** — owns `adapter/src/ui`; TUI and RPC. depends: [6.1].

### Phase 7 — Recovery, restart, cancel (group)

- **7.1 Recovery** — diagnose + propose, then new Implement approval required. depends: [6.1].
- **7.2 Restart** — reconcile journal vs YAML vs worktrees, then ask. depends: [7.1].
- **7.3 Cancel** — stop sessions first, then ask what to preserve. depends: [7.1].

### Phase 8 — Live edits and import proposals (group)

- **8.1 Impact-based revalidation** on live YAML edits. depends: [1.3, 6.1].
- **8.2 Model-proposal importer** (adapter side) — dependencies and parallel-safety must be confirmed via `arc_ask_operator` before any leaf becomes `ready`. depends: [1.4, 3.3].

### Phase 9 — Release-ready handoff (group)

- **9.1 Archival** — sessions + journal archived, YAML final checkpoints. depends: [7.*].
- **9.2 Package publish readiness** — installable as a Pi package; no remote push/deploy automation. depends: [9.1].
[absolute path redacted]

## 6. Acceptance criteria for v1 (whole workflow)

1. A fixture repo with a phased markdown plan imports to `.arc/workflows/<slug>/workflow.yaml` that validates against the schema.
2. Generated `docs/progress.txt` and Gantt reflect only checkpoint states; drift warning appears on manual edit.
3. M1 slice runs one leaf to `completed` with: child session persisted, at least one brokered question answered with provenance, local commit made, integration approval asked, cherry-pick applied, atomic progress update.
4. Parallel run of a 4-leaf fixture respects concurrency 4 and per-item supervision.
5. Timeout on an Implement or integration question leaves the item blocked; no auto-approval path exists in code.
6. Recovery/restart/cancel each follow the settled ask-first ordering.
7. All live integration tests write only in temp repos/worktrees; CI proves no push.

## 7. Structural bounds (PROPOSAL — implementer may tune; must stay conservative)

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

## 8. Naming and schema proposals (PROPOSAL)

- Package names: `@arc/workflow-core`, `@arc/pi-workflow`.
- Worktree/branch naming: `arc/wf/<slug>/<item-id>`; worktree dir `.arc/worktrees/<slug>/<item-id>/`.
- Local commit message: `arc(wf:<slug>): <item-id> <title>`; integration cherry-pick keeps the same subject plus `Integrated-From:` trailer.
- Workflow file: `.arc/workflows/<slug>/workflow.yaml`; config `config.yaml`; journal `.arc/workflows/<slug>/.journal/` (gitignored).
- Event envelope fields: `envelope_version` (semver string), `event_id` (ulid), `workflow_slug`, `item_id`, `session_id`, `emitted_at`, `kind` (`question|progress|artifact|verify|error|done`), `payload` (schema per kind, bounded), `provena…
- Question envelope payload: `question_id`, `text`, `options[]`, `gate` (`none|implement|integration|release|deploy`), `default_on_timeout` (only when `gate = none`).
- Checkpoint field on each item: `state` ∈ settled six values; `updated_at`; `evidence_ref` (journal id, never transcript text).

## 9. Explicit exclusions (v1)

- No automatic remote push, PR creation, GitHub mutation, or deploy.
- No multi-repo writes (schema fields reserved only).
- No aggregate cost budget.
- No nested workflows or nested subagents.
- No second questioning mechanism; no auto-approval of mandatory gates.
- No vendoring into `arc-pi`; no changes to `arc-orchestrator` runner behavior.
- No print/JSON execution mode.
- No secrets or raw transcripts in YAML, docs, or events.

## 10. Recommended implementation sequence

0.1 → 0.2 → 0.3 → 1.1 → 1.2 → 1.3 → 1.5 → 1.4 → 2.1 → 2.2 → 2.3 → 3.1 →
3.2 → 3.3 → 3.4 → 4.1 → 4.2 → 4.3 → 4.4 → 5.1 → 5.2 → 5.3 (M1 gate) →
6.1 → 6.2 → 6.3 → 7.1 → 7.2 → 7.3 → 8.1 → 8.2 → 9.1 → 9.2 → 9.3.

Each arrow is a separate Implement approval. Nothing after 5.3 starts until
the M1 live test is green in protected CI.

---

## Section B — `docs/progress.txt`

```text
ARC Pi Gantt Workflow — v1 progress
Legend: [ ] planned [~] in progress [x] completed [!] blocked [-] cancelled [?] needs-replan
Rule: this file is regenerated from .arc/workflows/gantt-workflow/workflow.yaml once
the renderer exists; until then it is hand-maintained and must match
docs/IMPLEMENTATION_PLAN.md phase/subphase ids exactly.

Phase 0 — Scaffold and seams
[ ] 0.1 Workspace scaffold
[ ] 0.2 Schema drafts (workflow, checkpoint, event envelope)
[ ] 0.3 Seam confirmation (docs/gantt-workflow/seams.md)

Phase 1 — Core model, normalization, validation
[ ] 1.1 DAG model + checkpoint enum
[ ] 1.2 Normalizer (phased + flat)
[ ] 1.3 Validator + activation gate + structural bounds
[ ] 1.4 Deterministic importer
[ ] 1.5 Renderers + drift check

Phase 2 — Journal, events, scheduling
[ ] 2.1 Private runtime journal
[ ] 2.2 Event envelope
[ ] 2.3 Scheduler (ready-set, concurrency, waiting policy, hybrid queue)

Phase 3 — Sessions, questions, orchestrator bridge
[ ] 3.1 Child profiles (Explore/Research, Plan/Analyze, Implement, Verify/Review)
[ ] 3.2 Session lifecycle (persisted AgentSession per leaf)
[ ] 3.3 Question broker (arc_ask_operator only; fail-closed mandatory gates)
[ ] 3.4 Orchestrator bridge

Phase 4 — Isolation and integration
[ ] 4.1 Worktree manager
[ ] 4.2 Verify -> local commit -> ask -> cherry-pick
[ ] 4.3 Conflict policy + full rerun
[ ] 4.4 Completion + atomic progress update

Phase 5 — M1 sequential vertical slice <-- first milestone gate
[absolute path redacted]
[ ] 5.2 Sequential runner (concurrency 1)
[ ] 5.3 Live ARC integration test (local + protected CI, temp repos only)

Phase 6 — Parallel Gantt execution
[ ] 6.1 Parallel scheduler activation (default 4, per-item supervision)
[ ] 6.2 Question queue under parallelism
[ ] 6.3 Dashboard + passive widget (TUI + RPC)

Phase 7 — Recovery, restart, cancel
[ ] 7.1 Recovery (diagnose + propose, new Implement approval)
[ ] 7.2 Restart (reconcile, then ask)
[ ] 7.3 Cancel (stop, then ask what to preserve)

Phase 8 — Live edits and import proposals
[ ] 8.1 Impact-based revalidation
[ ] 8.2 Model-proposal importer (deps/parallel-safety confirmed via arc_ask_operator)

Phase 9 — Release-ready handoff
[ ] 9.1 Archival
[ ] 9.2 Package publish readiness (no push/deploy automation)
[ ] 9.3 Docs

Exclusions (v1): remote push/PR/deploy, multi-repo writes, cost budgets,
nested workflows/subagents, second questioning system, print/JSON mode.
```

## Evidence

- Status: completed
- Summary: Wrote docs/gantt-workflow/plan.md containing Section A (intended docs/IMPLEMENTATION_PLAN.md: settled-design table, repo layout, seams to confirm, 10 phases/33 leaves with ownership+deps, acceptance criteria, structural bounds, naming/event-schema proposals, exclusions, sequence starting with M1 sequential slice at Phase 5) and Section B (matching docs/progress.txt checkbox tracker). No other files touched. Reference docs and sibling repos were permission-denied, so structure was emulated from …
- Changes:
  - docs/gantt-workflow/plan.md (new): Section A implementation plan + Section B progress tracker, ready for parent to promote to docs/IMPLEMENTATION_PLAN.md and docs/progress.txt
- Verification:
  - Glob confirmed repo contained only README.md, .gitignore, .git before write; no product source, tests, or schema modules added
  - Section B checkbox ids (0.1–9.3) match Section A phase/subphase ids one-to-one
  - All settled answers from the brief restated in §2 table; numeric bounds (§7), package/branch names and envelope fields (§8) explicitly tagged PROPOSAL
  - M1 sequential vertical slice is Phase 5 and gates all parallel work (§10); mandatory gates fail closed with no auto-approve path (§5 3.3, §7)
  - README.md left unchanged (status line still accurate: scaffold only)
- Risks:
  - Read access to arc-prompt-optimizer/docs/* was denied, so emulation of its structure is approximate; parent may want to diff format against those files
  - Read access to arc-pi and arc-orchestrator was denied; no sibling file paths cited, only seam names — Phase 0.3 requires confirming them before Phase 1
  - Artifact is a single plan.md; the two required human-facing files (docs/IMPLEMENTATION_PLAN.md, docs/progress.txt) are not yet split out per the 'write only plan.md' worker constraint
- Next actions:
  - Parent: accept plan.md, then promote Section A to docs/IMPLEMENTATION_PLAN.md and Section B to docs/progress.txt (or re-delegate with write permission for those two files)
  - Optionally re-run with read permission on arc-prompt-optimizer/docs and sibling repos to tighten format emulation and cite exact seam paths
  - Do not start Implement; each leaf in §10 sequence needs its own arc_delegate Implement approval
