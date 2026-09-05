import type { CheckpointState, Workflow } from "@arc/workflow-core";
import type { QuestionQueueEntry } from "../questions/queue.ts";

export type WorkflowSource = Workflow | (() => Workflow);

export interface DashboardRuntimeState {
  /** Leaves currently executing in a child session or worker. */
  readonly active_item_ids?: readonly string[];
  /** Leaves paused while waiting for an operator question. */
  readonly waiting_item_ids?: readonly string[];
  /** Optional short live progress labels; never persisted by the UI. */
  readonly progress_by_item_id?: Readonly<Record<string, string>>;
  /** Runtime question metadata; a supplied QuestionQueue takes precedence. */
  readonly questions?: readonly QuestionQueueEntry[];
  /** Current scheduler capacity when it differs from the dashboard default. */
  readonly concurrency?: number;
}

export interface DashboardItem {
  readonly id: string;
  readonly title: string;
  readonly kind: "group" | "leaf";
  readonly state: CheckpointState;
  readonly parent_id: string | null;
  readonly nesting_depth: number;
  readonly active: boolean;
  readonly waiting: boolean;
  readonly progress?: string;
  readonly question_count: number;
}

export interface DashboardCounts {
  readonly total: number;
  readonly groups: number;
  readonly leaves: number;
  readonly planned: number;
  readonly ready: number;
  readonly completed: number;
  readonly blocked: number;
  readonly cancelled: number;
  readonly needs_replan: number;
  readonly active: number;
  readonly waiting: number;
  readonly questions: number;
}

export interface DashboardSnapshot {
  readonly workflow_slug: string;
  readonly repository_id: string;
  readonly generated_at: string;
  readonly concurrency_limit: number;
  readonly available_slots: number;
  readonly counts: DashboardCounts;
  readonly items: readonly DashboardItem[];
  readonly questions: readonly QuestionQueueEntry[];
  /** Current UI selection, if one was made; it does not answer the question. */
  readonly ui_pick?: string;
}

export interface WorkflowDashboardOptions {
  readonly workflow: WorkflowSource;
  readonly concurrency?: number;
  readonly runtime?: DashboardRuntimeState;
  readonly queue?: QuestionQueueLike;
  readonly now?: () => Date;
}

/** Structural queue surface used by the UI; avoids importing its implementation. */
export interface QuestionQueueLike {
  snapshot(): readonly QuestionQueueEntry[];
  setUiPick(questionId: string | undefined): void;
}

export interface WorkflowDashboard {
  snapshot(): DashboardSnapshot;
  update(runtime: DashboardRuntimeState): void;
  subscribe(listener: (snapshot: DashboardSnapshot) => void): () => void;
  /** Pick a pending question; never submits an answer. */
  pickQuestion(questionId: string): DashboardSnapshot;
  renderTui(): string;
  renderWidget(): string;
}

export type WorkflowRpcRequest =
  | { readonly method: "status" }
  | { readonly method: "widget" }
  | { readonly method: "pick-question"; readonly question_id: string };

export interface WorkflowRpcSuccess {
  readonly ok: true;
  readonly result:
    | DashboardSnapshot
    | { readonly widget: string }
    | { readonly selected_question_id: string; readonly status: DashboardSnapshot };
}

export interface WorkflowRpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code:
      | "invalid_request"
      | "request_too_large"
      | "response_too_large"
      | "unknown_method"
      | "unknown_question";
    readonly message: string;
  };
}

export type WorkflowRpcResponse = WorkflowRpcSuccess | WorkflowRpcFailure;

export interface WorkflowRpcHandler {
  handle(request: unknown): WorkflowRpcResponse;
}
