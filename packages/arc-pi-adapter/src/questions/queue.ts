/**
 * Shared question queue for parallel workflow leaves.
 *
 * Child brokers still own envelope validation, timeout policy, and journal
 * provenance.  This adapter-side queue owns only the shared prompt boundary:
 * it accepts several pending asks, chooses the next one with the core hybrid
 * priority policy, and invokes the injected `arc_ask_operator` function one at
 * a time.  It never writes a decision record or invents a second prompt path.
 */

import {
  EVENT_GATES,
  prioritizeQuestionQueue,
  type EventGate,
  type QueuedQuestion,
  type Workflow,
} from "@arc/workflow-core";
import type {
  AskOperatorFn,
  AskOperatorInput,
  BrokerAnswer,
} from "./types.ts";

export const DEFAULT_MAX_QUEUED_QUESTIONS = 32 as const;
export const MAX_QUEUED_QUESTIONS = 32 as const;
export const DEFAULT_MAX_PENDING_QUESTIONS_PER_ITEM = 3 as const;
const MAX_QUEUE_ID_LENGTH = 64;

type WorkflowSource = Workflow | (() => Workflow);

export type QuestionQueueEntryStatus = "pending" | "active";

export interface QuestionQueueEntry extends QueuedQuestion {
  readonly status: QuestionQueueEntryStatus;
}

export interface QuestionQueueOptions {
  /** Current workflow used to compute the critical path when no override exists. */
  readonly workflow: WorkflowSource;
  /** The sole downstream prompt function; production wiring supplies arc_ask_operator. */
  readonly ask: AskOperatorFn;
  /** Maximum number of requests waiting behind the active request. */
  readonly max_pending?: number;
  /** Maximum number of pending requests contributed by one leaf. */
  readonly max_pending_per_item?: number;
  /** Optional fresh critical-path membership supplied by the controller. */
  readonly critical_path_item_ids?: readonly string[];
  /** A selected question wins over every computed priority. */
  readonly ui_pick?: string;
}

export interface QuestionQueue {
  /** Enqueue an operator question and resolve it with the downstream answer. */
  ask(input: AskOperatorInput): Promise<BrokerAnswer>;
  /** Select a pending question for the next available prompt turn. */
  setUiPick(questionId: string | undefined): void;
  /** Replace the critical-path override; undefined returns to computed data. */
  setCriticalPathItemIds(itemIds: readonly string[] | undefined): void;
  /** Active request first, followed by pending requests in priority order. */
  snapshot(): readonly QuestionQueueEntry[];
  readonly pendingCount: number;
  readonly inflight: number;
  readonly closed: boolean;
  /** Stop accepting new asks and reject requests that have not started. */
  close(): void;
}

interface PendingRequest {
  readonly metadata: QueuedQuestion;
  readonly input: AskOperatorInput;
  readonly resolve: (answer: BrokerAnswer) => void;
  readonly reject: (error: Error) => void;
}

function contextValue(input: AskOperatorInput, key: string): string | undefined {
  const value = input.context?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`question context.${key} must be a string`);
  }
  return value;
}

function isEventGate(value: string): value is EventGate {
  return (EVENT_GATES as readonly string[]).includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateQueueBound(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_QUEUED_QUESTIONS
  ) {
    throw new RangeError(
      `${field} must be a safe integer between 1 and ${MAX_QUEUED_QUESTIONS}`,
    );
  }
  return value;
}

function metadataFor(input: AskOperatorInput, sequence: number): QueuedQuestion {
  const itemId = contextValue(input, "item_id");
  if (itemId === undefined || itemId.length === 0) {
    throw new TypeError("question context.item_id is required");
  }
  if (itemId.length > MAX_QUEUE_ID_LENGTH) {
    throw new RangeError(`question context.item_id must be at most ${MAX_QUEUE_ID_LENGTH} characters`);
  }
  const suppliedQuestionId = contextValue(input, "question_id");
  if (suppliedQuestionId !== undefined && suppliedQuestionId.length === 0) {
    throw new TypeError("question context.question_id must be non-empty");
  }
  if (suppliedQuestionId !== undefined && suppliedQuestionId.length > MAX_QUEUE_ID_LENGTH) {
    throw new RangeError(
      `question context.question_id must be at most ${MAX_QUEUE_ID_LENGTH} characters`,
    );
  }
  const questionId = suppliedQuestionId ?? `queue-question-${sequence}`;
  const suppliedGate = contextValue(input, "gate");
  if (suppliedGate !== undefined && !isEventGate(suppliedGate)) {
    throw new TypeError("question context.gate is invalid");
  }
  const gate: EventGate = suppliedGate ?? "none";
  return { question_id: questionId, item_id: itemId, gate };
}

function withQuestionId(input: AskOperatorInput, questionId: string): AskOperatorInput {
  return {
    ...input,
    context: {
      ...(input.context ?? {}),
      question_id: questionId,
    },
  };
}

function workflowFrom(source: WorkflowSource): Workflow {
  return typeof source === "function" ? source() : source;
}

/** Create one process-wide prompt queue for concurrent workflow leaf asks. */
export function createQuestionQueue(options: QuestionQueueOptions): QuestionQueue {
  if (typeof options.ask !== "function") {
    throw new TypeError("QuestionQueueOptions.ask must be a function");
  }
  const maxPending = validateQueueBound(
    options.max_pending ?? DEFAULT_MAX_QUEUED_QUESTIONS,
    "max_pending",
  );
  const maxPendingPerItem = validateQueueBound(
    options.max_pending_per_item ?? DEFAULT_MAX_PENDING_QUESTIONS_PER_ITEM,
    "max_pending_per_item",
  );
  let uiPick = options.ui_pick;
  let criticalPathItemIds = options.critical_path_item_ids === undefined
    ? undefined
    : [...options.critical_path_item_ids];
  let sequence = 0;
  let closed = false;
  let active: PendingRequest | undefined;
  let draining = false;
  const pending: PendingRequest[] = [];
  const pendingByItem = new Map<string, number>();
  const seenQuestionIds = new Set<string>();

  function rejectError(message: string): Promise<BrokerAnswer> {
    return Promise.reject(new Error(message));
  }

  function priorityOptions(): {
    readonly ui_pick?: string;
    readonly critical_path_item_ids?: readonly string[];
  } {
    return {
      ...(uiPick === undefined ? {} : { ui_pick: uiPick }),
      ...(criticalPathItemIds === undefined
        ? {}
        : { critical_path_item_ids: criticalPathItemIds }),
    };
  }

  function orderedPending(): PendingRequest[] {
    const workflow = workflowFrom(options.workflow);
    const metadata = pending.map((request) => request.metadata);
    const ordered = prioritizeQuestionQueue(workflow, metadata, priorityOptions());
    const byId = new Map(
      pending.map((request) => [request.metadata.question_id, request]),
    );
    return ordered.flatMap((question) => {
      const request = byId.get(question.question_id);
      return request === undefined ? [] : [request];
    });
  }

  function decrementPendingItem(itemId: string): void {
    const count = pendingByItem.get(itemId) ?? 0;
    if (count <= 1) pendingByItem.delete(itemId);
    else pendingByItem.set(itemId, count - 1);
  }

  function rejectPending(error: Error): void {
    while (pending.length > 0) {
      const request = pending.shift();
      if (request === undefined) continue;
      decrementPendingItem(request.metadata.item_id);
      request.reject(error);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!closed && pending.length > 0) {
        let next: PendingRequest | undefined;
        try {
          next = orderedPending()[0];
        } catch (error) {
          rejectPending(new Error(`question queue priority failed: ${errorMessage(error)}`));
          break;
        }
        if (next === undefined) break;
        const index = pending.indexOf(next);
        if (index < 0) continue;
        pending.splice(index, 1);
        decrementPendingItem(next.metadata.item_id);
        active = next;
        try {
          const answer = await options.ask(next.input);
          next.resolve(answer);
        } catch (error) {
          next.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          active = undefined;
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    ask(input: AskOperatorInput): Promise<BrokerAnswer> {
      if (closed) return rejectError("question queue is closed");
      let metadata: QueuedQuestion;
      try {
        sequence += 1;
        metadata = metadataFor(input, sequence);
      } catch (error) {
        return rejectError(errorMessage(error));
      }
      if (seenQuestionIds.has(metadata.question_id)) {
        return rejectError(`question_id already seen by this queue: ${metadata.question_id}`);
      }
      if (pending.length >= maxPending) {
        return rejectError("question queue is full");
      }
      if ((pendingByItem.get(metadata.item_id) ?? 0) >= maxPendingPerItem) {
        return rejectError(`question queue is full for item: ${metadata.item_id}`);
      }
      seenQuestionIds.add(metadata.question_id);
      const requestPromise = new Promise<BrokerAnswer>((resolve, reject) => {
        pending.push({
          metadata,
          input: withQuestionId(input, metadata.question_id),
          resolve,
          reject: (error) => reject(error),
        });
      });
      pendingByItem.set(
        metadata.item_id,
        (pendingByItem.get(metadata.item_id) ?? 0) + 1,
      );
      void drain();
      return requestPromise;
    },

    setUiPick(questionId: string | undefined): void {
      if (
        questionId !== undefined
        && (typeof questionId !== "string" || questionId.length === 0)
      ) {
        throw new TypeError("questionId must be a non-empty string when provided");
      }
      uiPick = questionId;
      if (!closed) void drain();
    },

    setCriticalPathItemIds(itemIds: readonly string[] | undefined): void {
      criticalPathItemIds = itemIds === undefined ? undefined : [...itemIds];
      if (!closed) void drain();
    },

    snapshot(): readonly QuestionQueueEntry[] {
      const activeEntry: QuestionQueueEntry[] = active === undefined
        ? []
        : [{ ...active.metadata, status: "active" }];
      const pendingEntries = orderedPending().map((request) => ({
        ...request.metadata,
        status: "pending" as const,
      }));
      return [...activeEntry, ...pendingEntries];
    },

    get pendingCount(): number {
      return pending.length;
    },

    get inflight(): number {
      return active === undefined ? 0 : 1;
    },

    get closed(): boolean {
      return closed;
    },

    close(): void {
      if (closed) return;
      closed = true;
      rejectPending(new Error("question queue is closed"));
    },
  };
}
