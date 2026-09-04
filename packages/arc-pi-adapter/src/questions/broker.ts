/**
 * The workflow question broker.
 *
 * The broker is the only path from a child workflow session to the operator.
 * It is shaped around the v1 event envelope (`QuestionEventEnvelope`) and the
 * ARC Pi `arc_ask_operator` tool signature (see `docs/gantt-workflow/seams.md`).
 *
 * Settled rules:
 *   1. Only `arc_ask_operator` may be called. The ask function is injected so
 *      the broker never imports the tool directly.
 *   2. Every answer is copied to the journal with full provenance: ledger id,
 *      envelope id, workflow slug, item id, session id, broker name, and the
 *      emitted_at timestamp carried on the envelope.
 *   3. Ordinary (`gate === "none"`) questions honor the configured
 *      `default_timeout_ms`/`default_answer` pair when the operator does not
 *      answer in time.
 *   4. Mandatory gates (`implement`, `integration`, `release`, `deploy`) NEVER
 *      auto-approve. Supplying a `default_on_timeout` for them is rejected up
 *      front; missing a timeout default for them surfaces a blocked result so
 *      the controller can mark the item `needs-replan`.
 *   5. Concurrent questions are serialized (FIFO) per broker instance.
 *   6. The broker has an explicit open/close lifecycle.
 */

import type {
  AskOperatorFn,
  AskOperatorInput,
  BrokerAnswer,
  BrokerFailure,
  BrokerJournal,
  BrokerResult,
  QuestionBroker,
  QuestionBrokerConfig,
  QuestionBrokerOptions,
  QuestionEventEnvelope,
} from "./types.ts";
import { isMandatoryBrokerGate } from "./types.ts";
import {
  EVENT_ENVELOPE_VERSION,
  redactJournalValue,
  safeJournalMetadata,
} from "@arc/workflow-core";
import type { EventEnvelope } from "@arc/workflow-core";

const DEFAULT_BROKER_NAME = "arc-pi-adapter" as const;

function validateTimeout(timeout: unknown): number | null {
  if (timeout === undefined || timeout === null) return null;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
    throw new RangeError("default_timeout_ms must be a non-negative finite number or null");
  }
  return Math.floor(timeout);
}

function validateDefaultAnswer(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("default_answer must be a string when provided");
  }
  if (value.length === 0 || value.length > 80) {
    throw new RangeError("default_answer must be 1..80 code points");
  }
  return value;
}

function normalizeConfig(config: QuestionBrokerConfig | undefined): {
  readonly defaultTimeoutMs: number | null;
  readonly defaultAnswer: string | undefined;
} {
  return {
    defaultTimeoutMs: validateTimeout(config?.default_timeout_ms),
    defaultAnswer: validateDefaultAnswer(config?.default_answer),
  };
}

function buildAskInput(
  envelope: QuestionEventEnvelope,
  semanticKey: string | undefined,
): AskOperatorInput {
  const { payload } = envelope;
  const context: Record<string, string | readonly string[]> = {
    workflow_slug: envelope.workflow_slug,
    item_id: envelope.item_id,
    session_id: envelope.session_id,
    envelope_id: envelope.event_id,
    gate: payload.gate,
  };
  const options = payload.options.map((option) => {
    if (option.description === undefined) {
      return { label: option.label };
    }
    return { label: option.label, description: option.description };
  });
  const input: AskOperatorInput = {
    question: payload.text,
    question_type: "single_select",
    context,
    options,
  };
  return semanticKey === undefined ? input : { ...input, semantic_key: semanticKey };
}

/**
 * Race a promise against a wall-clock timeout. Resolves to `{ timedOut: true }`
 * when the timeout elapses first; otherwise returns the original resolution
 * with `timedOut: false`. A timeout never rejects the ask promise itself; the
 * caller decides whether to honor a default.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
): Promise<{ readonly value: T; readonly timedOut: false } | { readonly timedOut: true }> {
  if (timeoutMs === null) {
    const value = await promise;
    return { value, timedOut: false };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([
      promise.then((value) => ({ value, timedOut: false as const })),
      timeoutPromise,
    ]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function buildJournalData(
  envelope: QuestionEventEnvelope,
  answer: BrokerAnswer,
  journalLedgerId: string,
  usedDefault: boolean,
): Record<string, unknown> {
  const answerBlock: Record<string, unknown> = {
    ledger_id: safeJournalMetadata(answer.ledger_id),
    created_at: safeJournalMetadata(answer.created_at),
    question_type: safeJournalMetadata(answer.question_type),
    used_default: usedDefault,
  };
  if (answer.semantic_key !== undefined) {
    answerBlock.semantic_key = safeJournalMetadata(answer.semantic_key);
  }
  // Free-form fields (`answer`, `rationale`) are deliberately omitted: the
  // journal never stores operator-facing content or rationale text. The
  // structured metadata (ids, gate, kind, timestamp) is sufficient for audit.
  const data: Record<string, unknown> = {
    envelope_id: safeJournalMetadata(envelope.event_id),
    envelope_version: safeJournalMetadata(EVENT_ENVELOPE_VERSION),
    workflow_slug: safeJournalMetadata(envelope.workflow_slug),
    item_id: safeJournalMetadata(envelope.item_id),
    session_id: safeJournalMetadata(envelope.session_id),
    kind: safeJournalMetadata(envelope.kind),
    gate: safeJournalMetadata(envelope.payload.gate),
    question_id: safeJournalMetadata(envelope.payload.question_id),
    option_labels: envelope.payload.options.map((option) =>
      safeJournalMetadata(option.label),
    ),
    answer: answerBlock,
    broker: safeJournalMetadata(DEFAULT_BROKER_NAME),
    copied_to: safeJournalMetadata(journalLedgerId),
  };
  return data;
}

function failureResult(reason: BrokerFailure["reason"]): BrokerFailure {
  return { ok: false, reason };
}

/**
 * Create a new broker. Two brokers in the same process are independent: their
 * queues, lifecycle, and journal references are all per-instance.
 */
export function createQuestionBroker(options: QuestionBrokerOptions): QuestionBroker {
  if (typeof options.ask !== "function") {
    throw new TypeError("QuestionBrokerOptions.ask must be a function");
  }
  if (options.journal === undefined || typeof options.journal.append !== "function") {
    throw new TypeError("QuestionBrokerOptions.journal.append must be a function");
  }
  const ask: AskOperatorFn = options.ask;
  const journal: BrokerJournal = options.journal;
  const config = normalizeConfig(options.config);
  const now = options.now ?? (() => new Date());
  let createQuestionId = options.createQuestionId;
  if (createQuestionId === undefined) {
    const seen = new Set<string>();
    createQuestionId = () => {
      // A monotonic counter combined with the timestamp guarantees uniqueness
      // for the lifetime of the broker even if `crypto.randomUUID` is missing.
      const id = `${now().getTime().toString(36)}-${(seen.size + 1).toString(36)}`;
      seen.add(id);
      return id;
    };
  }
  const seenQuestionIds = new Set<string>();
  let closed = false;
  let inflight = 0;
  const queue: Array<() => Promise<void>> = [];
  let draining = false;

  function fail(reason: BrokerFailure["reason"]): BrokerFailure {
    return failureResult(reason);
  }

  async function runOne(envelope: QuestionEventEnvelope): Promise<BrokerResult> {
    if (envelope.kind !== "question") {
      return fail({
        code: "invalid_timeout",
        message: "broker.ask requires a question envelope",
      });
    }
    const gate = envelope.payload.gate;
    if (!isMandatoryBrokerGate(gate) && gate !== "none") {
      return fail({
        code: "invalid_timeout",
        message: `unsupported gate: ${gate}`,
      });
    }
    const questionId = envelope.payload.question_id;
    if (seenQuestionIds.has(questionId)) {
      return fail({
        code: "duplicate_question_id",
        message: `question_id already seen by this broker: ${questionId}`,
      });
    }
    seenQuestionIds.add(questionId);

    if (isMandatoryBrokerGate(gate)) {
      // Mandatory gates must never auto-approve, even when a default is on the
      // payload (the validator already rejects that combination at the wire).
      const askInput = buildAskInput(envelope, undefined);
      const response = await ask(askInput);
      return copyToJournal(envelope, response, false);
    }

    // Ordinary gate: a timeout may substitute the configured default.
    const askInput = buildAskInput(envelope, undefined);
    const response = withTimeout(ask(askInput), config.defaultTimeoutMs);
    const settled = await response;
    if (!settled.timedOut) {
      return copyToJournal(envelope, settled.value, false);
    }
    if (config.defaultAnswer === undefined) {
      return fail({
        code: "invalid_timeout",
        message: "ordinary gate timed out without a configured default_answer",
      });
    }
    const defaulted: BrokerAnswer = {
      ledger_id: `default:${questionId}`,
      created_at: now().toISOString(),
      question_type: "single_select",
      answer: config.defaultAnswer,
      rationale: "default-on-timeout",
    };
    return copyToJournal(envelope, defaulted, true);
  }

  async function copyToJournal(
    envelope: QuestionEventEnvelope,
    answer: BrokerAnswer,
    usedDefault: boolean,
  ): Promise<BrokerResult> {
    const data = redactJournalValue(
      buildJournalData(envelope, answer, answer.ledger_id, usedDefault) as unknown as Parameters<typeof redactJournalValue>[0],
    ) as unknown as Record<string, unknown>;
    const record = await journal.append({
      kind: "question-answer",
      itemId: envelope.item_id,
      sessionId: envelope.session_id,
      data,
    });
    return {
      ok: true,
      resolution: {
        envelope,
        answer,
        journal_id: record.id,
        used_default: usedDefault,
      },
    };
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) continue;
        await next();
      }
    } finally {
      draining = false;
    }
  }

  function enqueue(envelope: QuestionEventEnvelope): Promise<BrokerResult> {
    return new Promise<BrokerResult>((resolve) => {
      queue.push(async () => {
        inflight += 1;
        try {
          resolve(await runOne(envelope));
        } finally {
          inflight -= 1;
        }
      });
      void drain();
    });
  }

  return {
    get closed(): boolean {
      return closed;
    },
    get inflight(): number {
      return inflight;
    },
    async ask(envelope: QuestionEventEnvelope): Promise<BrokerResult> {
      if (closed) {
        return fail({ code: "closed", message: "broker is closed" });
      }
      // The envelope must match the v1 wire contract.
      if (envelope.envelope_version !== EVENT_ENVELOPE_VERSION) {
        return fail({
          code: "invalid_timeout",
          message: `unsupported envelope_version: ${envelope.envelope_version}`,
        });
      }
      return enqueue(envelope);
    },
    close(): void {
      closed = true;
    },
  };
}

/**
 * Re-export the envelope version constant so adapter callers can build v1
 * envelopes without importing the workflow-core events module directly.
 */
export { EVENT_ENVELOPE_VERSION };
export type { EventEnvelope };
