# Integration seams

Confirmed 2026-09-03 against sibling checkouts `arc-pi` and `arc-orchestrator`, plus the installed Pi package types. This file records paths and call signatures only. It does not change sibling repos.

Every IMPLEMENTATION_PLAN §6 row has a confirmed path and signature; placeholder rows are unused. Timeout and default-answer behavior that the current `arc_ask_operator` tool does not expose is recorded as a confirmed absence: the workflow controller owns that policy later.

## Summary

| Seam | Confirmed path | Signature |
| --- | --- | --- |
| `arc_ask_operator` | `arc-pi/extensions/arc-orchestrator/decision-tools.ts` | `createArcAskOperatorTool(appendEntry, events?)` registers tool `arc_ask_operator`. Input is `AskOperatorInput`. |
| Decision Ledger | `arc-pi/extensions/arc-orchestrator/decision-ledger.ts` | Custom session entry `arc-decision-ledger` / `schemaVersion: 1`. Cite with `lookupDecisions(records, { ids?, refs?, semanticKey? })`. |
| `arc_delegate` | `arc-pi/extensions/arc-orchestrator/contract.ts` and `index.ts` | `validateDelegateInput(input): DelegateInput`. Implement requires `phase: "implement"`, `implement_authorized: true`, and a canonical `workload_class`. |
| Isolated child session | `arc-pi/extensions/arc-subagents/index.ts` | `createIsolatedChildSession(input, createSession?): Promise<ArcChildSession>` currently injects `SessionManager.inMemory(cwd)`. |
| Child manager / UI | `arc-pi/extensions/arc-subagents/manager.ts`, `ui.ts` | `ArcSubagentManager` `start/get/list/subscribe/steer/wait/cancel/open/shutdown`. Dashboard: `showSubagentDashboard(ctx, manager, sessionId, initialSubagentId?)`. |
| Background terminals | `arc-pi/extensions/arc-background-terminals/` | `ArcTerminalManager.start/get/list/kill/open/shutdown`. Unix `/bin/sh` only; not a Pi session engine. |
| Session monitor | `arc-pi/extensions/arc-session-monitor/` | `getSessionMonitorState(sessionRef, options?): Promise<SessionMonitorState>`. IDs are runner-session IDs, not workflow item IDs. |
| Runner live activity | `arc-orchestrator/plugins/arc-orchestrator/lib/live-activity.ts` | Stderr line `arc-orchestrator: event: {v,kind,seq,at,data}`. v1 kinds `activity\|phase\|files`; additive v2 `kind: "diff"`. |
| Runner CLI | `arc-orchestrator/plugins/arc-orchestrator/bin/arc-orchestrator` | `arc-orchestrator run --mode … --phase …`. ARC Pi wrapper: `arc-pi/bin/arc-orchestrator`. |
| Session replacement | Pi `ExtensionCommandContext` in `@earendil-works/pi-coding-agent` | `ctx.newSession / fork / switchSession` are command-only and replace the visible controller. Do not use for workflow children. |

## `arc_ask_operator`

**Path:** `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-orchestrator/decision-tools.ts`

Factory:

```ts
createArcAskOperatorTool(
  appendEntry: AppendDecisionEntry,
  events?: ExtensionAPI["events"],
): ToolDefinition
```

Tool name: `arc_ask_operator`. Execution mode: `sequential`. An answer is recorded only after the operator responds. The tool never authorizes `arc_delegate` work.

```ts
interface AskOperatorInput {
  question: string;
  question_type: "single_select" | "multi_select" | "yes_no" | "freeform";
  context: Record<string, string | string[]>; // default {}
  options?: DecisionOption[];
  recommendation?: { option: string; rationale?: string };
  tradeoffs?: string[];
  blocking: boolean; // default false
  request_rationale?: boolean; // default false
  semantic_key?: string;
  rationale?: string;
  sensitive?: boolean;
}
```

`DecisionOption` is `{ label: string; description?: string; tradeoffs: string[] }`.

### Timeout / default-answer

Confirmed absence: `AskOperatorInput` and `askOperatorParams` have no `timeout`, `default_on_timeout`, or gate field. The tool blocks the calling turn until the operator answers or the prompt is cancelled. There is no auto-answer path in this tool.

Workflow ordinary-question timeouts and fail-closed mandatory gates (`implement`, `integration`, `release`, `deploy`) must be implemented by the controller/broker in Phase 3.3, not by calling a missing runner parameter.

### Provenance

After an answer, the tool appends a `DecisionLedgerRecord` through `appendEntry`. Provenance for a brokered child question is therefore:

- ledger `id` (opaque UUID from `makeOpaqueDecisionId()`)
- optional `semanticKey`
- `createdAt`
- `kind: "decision"`
- `question` / `answer` / `questionType` / `context`

Copy those fields onto the child event envelope `provenance` object. Do not invent a second ledger.

## Decision Ledger

**Path:** `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-orchestrator/decision-ledger.ts`

```ts
decisionLedgerEntryType = "arc-decision-ledger"
decisionLedgerSchemaVersion = 1
```

Read-only citation for this extension:

```ts
lookupDecisions(records, {
  ids?: string[];          // opaque record ids
  refs?: string[];         // opaque ids or semantic keys
  semanticKey?: string;
  includeHistory?: boolean;
  includeAssumptions?: boolean;
  redactSensitive?: boolean; // default true
}): { effective: DecisionProjection[]; history?: DecisionProjection[] }
```

`DecisionProjection` is `DecisionLedgerRecord & { effective: boolean }`.

This workflow package must not write ledger records except by calling `arc_ask_operator` (or `arc_record_assumption` if a child question is actually an assumption). Use `assessDelegateReadiness` / `resolveDecisionReferences` when constructing Implement contracts so existing gates are reused.

## `arc_delegate`

**Paths:**

- `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-orchestrator/contract.ts`
- `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-orchestrator/index.ts`

```ts
interface DelegateInput {
  outcome: string;
  scope: string;
  verification: string;
  preserved_behavior: string;
  prohibitions: string;
  label: string;
  mode?: ArcMode;
  phase?: ArcPhase;
  route?: string;
  context?: string;
  cwd?: string;
  task_class?: string;
  workload_class?: string;
  orchestrator?: "eco";
  implement_authorized?: boolean;
  deploy_authorized?: boolean;
  decision_refs?: string[];
  assumption_refs?: string[];
  readiness_acknowledged?: boolean;
  task_slug?: string;
  background?: boolean;
}

validateDelegateInput(input: unknown): DelegateInput
buildContract(input, mode, plan, label, orchestrator?): string
buildDelegateArgs(plan, label, contract, cwd, taskClass?, routeRationale?, workloadClass?, orchestrator?, taskSlug?): string[]
```

Controller reuse rule: generate the exact contract fields, then request Implement through the existing tool with `implement_authorized: true` and a canonical nine-cell `workload_class`. Do not reimplement route selection, sandboxing, or authorization gates. Analyze stays parent-local. Deploy remains out of v1 child profiles.

## Isolated child session

**Path:** `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-subagents/index.ts`

```ts
createIsolatedChildSession(
  input: ArcChildSessionInput,
  createSession?: CreateSession,
): Promise<ArcChildSession>

interface ArcChildSessionInput {
  cwd: string;
  model: unknown;
  modelRegistry: unknown;
  systemPrompt: string;
}
```

Today the factory hard-codes:

```ts
sessionManager: SessionManager.inMemory(input.cwd)
```

Persisted workflow children must inject `SessionManager.create(cwd, sessionDir?)` instead. Pi signature:

```ts
SessionManager.create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager
SessionManager.open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager
SessionManager.inMemory(cwd?: string, options?: NewSessionOptions): SessionManager
```

Declared in `@earendil-works/pi-coding-agent` `dist/core/session-manager.d.ts`.

Current allowlist: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Current excludes include `arc_delegate*`, `arc_ask_operator`, `arc_terminal_*`, `arc_monitor_status`, and nested `subagent_*`. Workflow child profiles will widen or narrow this list, but must keep this workflow extension and nested subagents excluded.

Returned session:

```ts
interface ArcChildSession {
  prompt(task: string): Promise<void>;
  abort(): Promise<void>;
  steer?(message: string): Promise<void>;
  subscribe?(listener: (event: ArcChildActivityEvent) => void): () => void;
  dispose(): void;
  readonly messages: readonly unknown[];
  readonly activeTools: readonly string[];
}
```

## Child manager / UI

**Paths:**

- `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-subagents/manager.ts`
- `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-subagents/ui.ts`

Reuse patterns, do not copy blindly:

```ts
class ArcSubagentManager {
  start(input: StartArcSubagentInput): ArcSubagentSnapshot
  get(sessionId: string, subagentId: string): ArcSubagentSnapshot | undefined
  list(sessionId: string): ArcSubagentSummary[]
  subscribe(sessionId: string, listener: ArcSubagentManagerListener): () => void
  steer(sessionId: string, subagentId: string, message: string): Promise<SteerArcSubagentResult>
  runningCount(sessionId: string): number
  wait(sessionId: string, subagentIds: string[]): Promise<...>
  cancel(sessionId: string, subagentId: string): CancelArcSubagentResult
  open(sessionId: string): void
  shutdown(sessionId: string): Promise<void>
}

showSubagentDashboard(
  ctx: ExtensionCommandContext,
  manager: ArcSubagentManager,
  sessionId: string,
  initialSubagentId?: string,
): Promise<boolean>
```

Default `maxConcurrent` is 4. Runtime is in-memory and forgotten on parent shutdown; workflow persistence must live in `SessionManager.create` plus the private journal.

## Background terminals

**Path:** `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-background-terminals/`

```ts
class ArcTerminalManager {
  start(input: StartArcTerminalInput): Promise<ArcTerminalSnapshot>
  get(sessionId: string, terminalId: string): ArcTerminalSnapshot | undefined
  list(sessionId: string): ArcTerminalSummary[]
  runningCount(sessionId: string): number
  kill(sessionId: string, terminalId: string): KillArcTerminalResult
  open(sessionId: string): void
  shutdown(sessionId: string): Promise<void>
}

interface StartArcTerminalInput {
  sessionId: string;
  command: string;
  cwd: string;
  label?: string;
  usage?: ArcTerminalUsage;
  onChanged?: () => void;
  onSettled?: (snapshot: ArcTerminalSnapshot) => void;
}
```

Use only for per-item local test/dev-server jobs. Commands are detached `/bin/sh` process groups with closed stdin. Cwd must stay inside the project. This is not the work-item session engine.

## Session monitor

**Path:** `/home/andysolomon/Documents/Github/arc-pi/extensions/arc-session-monitor/`

```ts
getSessionMonitorState(
  sessionRef: { sessionFile?: string; sessionId?: string },
  options?: GetSessionMonitorStateOptions,
): Promise<SessionMonitorState>
```

`SessionMonitorState` uses runner `runId` / `sessionId` / `jobId`. Workflow registry IDs (`workflow_slug`, `item_id`, child `session_id`) are a separate namespace. Correlate later through labels and stored session file paths; do not reuse monitor IDs as item IDs.

## Runner live activity

**Path:** `/home/andysolomon/Documents/Github/arc-orchestrator/plugins/arc-orchestrator/lib/live-activity.ts`

```text
arc-orchestrator: event: {"v":1,"kind":"phase|activity|files","seq":n,"at":ms,"data":{...}}
arc-orchestrator: event: {"v":2,"kind":"diff",...}
```

Constants: `LIVE_ACTIVITY_EVENT_PREFIX`, `LIVE_ACTIVITY_PROTOCOL_VERSION = 1`. Unknown `v` or `kind` values are additive and must be ignored or marked unsupported, not treated as fatal. Wrap these bounded stderr events into workflow envelopes; do not scrape raw provider stdout.

## Runner CLI

**Paths:**

- Canonical: `/home/andysolomon/Documents/Github/arc-orchestrator/plugins/arc-orchestrator/bin/arc-orchestrator` (`bun` → `lib/cli.ts`)
- ARC Pi wrapper: `/home/andysolomon/Documents/Github/arc-pi/bin/arc-orchestrator`

Wrapper resolution: `ARC_ORCHESTRATOR_BIN`, then a different `arc-orchestrator` on `PATH`, then the sibling checkout. Invoke the existing wrapper. Do not reimplement routing, sandboxing, or fallback.

Public subcommands: `run`, `routes --json`, `doctor`, `runs`, `observability`, `report`, `annotate`, `shadow-replay`.

## Session replacement (do not use for children)

**Path:** `@earendil-works/pi-coding-agent` `ExtensionCommandContext`

```ts
ctx.newSession({
  parentSession?: string;
  setup?: (sessionManager: SessionManager) => Promise<void>;
  withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}): Promise<{ cancelled: boolean }>

ctx.fork(entryId, { position?, withSession? })
ctx.switchSession(sessionPath, { withSession? })
```

These methods exist only on user-invoked command handlers. They replace the visible controller session. Workflow children must use in-process `createAgentSession` plus a persisted `SessionManager`, not `ctx.newSession()`.
