/**
 * Public types for the question broker.
 *
 * The broker is the only path that calls `arc_ask_operator` on behalf of a child
 * session. It copies answers into the private journal with full provenance and
 * applies the settled timeout policy: ordinary (`gate === "none"`) questions
 * honor a configured default; mandatory gates (`implement`, `integration`,
 * `release`, `deploy`) never auto-approve.
 */

import type {
  EventEnvelope,
  EventGate,
  QuestionEventEnvelope,
} from "@arc/workflow-core";

export type {
  EventEnvelope,
  EventGate,
  QuestionEventEnvelope,
};

/**
 * The settled set of gates that must fail closed. The list is exported from
 * workflow-core but reproduced here so the broker module owns its own
 * vocabulary without reaching into the core.
 */
export const MANDATORY_BROKER_GATES = Object.freeze([
  "implement",
  "integration",
  "release",
  "deploy",
] as const) satisfies readonly EventGate[];

export type MandatoryBrokerGate = (typeof MANDATORY_BROKER_GATES)[number];

export function isMandatoryBrokerGate(gate: EventGate): gate is MandatoryBrokerGate {
  return MANDATORY_BROKER_GATES.some((entry) => entry === gate);
}

/**
 * One operator answer as recorded on the Decision Ledger. The broker only ever
 * sees answers returned by `ask`; the harness owns the underlying
 * `arc_ask_operator` tool.
 */
export interface BrokerAnswer {
  readonly ledger_id: string;
  readonly semantic_key?: string;
  readonly created_at: string;
  readonly question_type: "single_select" | "multi_select" | "yes_no" | "freeform";
  readonly answer: string;
  readonly rationale?: string;
}

/**
 * Decision entry handed back to the controller once the broker has copied the
 * answer to the journal. The controller still owns question-queue placement
 * and the corresponding workflow checkpoint transition.
 */
export interface BrokerResolution {
  readonly envelope: QuestionEventEnvelope;
  readonly answer: BrokerAnswer;
  readonly journal_id: string;
  readonly used_default: boolean;
}

/**
 * Reasons the broker refuses to call `ask` or refuses to honor a default. The
 * controller turns these into `needs-replan` or `blocked` checkpoints without
 * ever auto-approving mandatory gates.
 */
export type BrokerFailureReason =
  | { readonly code: "closed"; readonly message: string }
  | { readonly code: "invalid_timeout"; readonly message: string }
  | { readonly code: "mandatory_gate_default"; readonly message: string }
  | { readonly code: "duplicate_question_id"; readonly message: string };

export interface BrokerFailure {
  readonly ok: false;
  readonly reason: BrokerFailureReason;
}

export interface BrokerSuccess {
  readonly ok: true;
  readonly resolution: BrokerResolution;
}

export type BrokerResult = BrokerSuccess | BrokerFailure;

/**
 * Shaped like ARC Pi's `AskOperatorInput` (see `docs/gantt-workflow/seams.md`).
 * The broker only depends on the fields it actually forwards; downstream
 * fields such as `blocking` or `request_rationale` are owned by the controller
 * and need not be exposed here.
 */
export interface AskOperatorInput {
  readonly question: string;
  readonly question_type: "single_select" | "multi_select" | "yes_no" | "freeform";
  readonly context?: Readonly<Record<string, string | readonly string[]>>;
  readonly options?: readonly {
    readonly label: string;
    readonly description?: string;
    readonly tradeoffs?: readonly string[];
  }[];
  readonly recommendation?: { readonly option: string; readonly rationale?: string };
  readonly tradeoffs?: readonly string[];
  readonly semantic_key?: string;
  readonly rationale?: string;
  readonly sensitive?: boolean;
}

/**
 * Pluggable ask function. The production wiring injects the ARC Pi
 * `arc_ask_operator` tool; tests inject a fake so the broker never reaches a
 * real prompt channel.
 */
export type AskOperatorFn = (input: AskOperatorInput) => Promise<BrokerAnswer>;

/**
 * Pluggable journal reference. The broker calls `append` once per answered
 * question; tests inject an in-memory implementation.
 */
export interface BrokerJournal {
  append(entry: {
    readonly kind: string;
    readonly itemId?: string;
    readonly sessionId?: string;
    readonly data?: unknown;
  }): Promise<{ readonly id: string }>;
}

/**
 * Configuration honored by the broker. `default_timeout_ms` is the wall-clock
 * window the harness gives the operator to answer an ordinary question before
 * the configured `default_answer` is returned. Mandatory gates always pass
 * `default_timeout_ms = null`, so the timeout itself never fires for them.
 */
export interface QuestionBrokerConfig {
  readonly default_timeout_ms?: number | null;
  readonly default_answer?: string;
}

export interface QuestionBrokerOptions {
  readonly ask: AskOperatorFn;
  readonly journal: BrokerJournal;
  readonly config?: QuestionBrokerConfig;
  readonly now?: () => Date;
  readonly createQuestionId?: () => string;
}

export interface QuestionBroker {
  /**
   * Run one bounded child question through `arc_ask_operator` and copy the
   * answer to the journal. Rejects calls after `close()`.
   */
  ask(envelope: QuestionEventEnvelope): Promise<BrokerResult>;
  /** Stop accepting new questions. The broker remains readable for diagnostics. */
  close(): void;
  readonly closed: boolean;
  readonly inflight: number;
}
