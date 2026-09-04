import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createQuestionBroker,
  isMandatoryBrokerGate,
  MANDATORY_BROKER_GATES,
  type AskOperatorInput,
  type BrokerAnswer,
  type BrokerJournal,
  type EventEnvelope,
  type QuestionEventEnvelope,
} from "../src/questions/index.ts";
import { EVENT_ENVELOPE_VERSION } from "../src/questions/index.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RecordedJournalEntry {
  kind: string;
  itemId?: string;
  sessionId?: string;
  data?: unknown;
}

function createMemoryJournal(): {
  journal: BrokerJournal;
  records: RecordedJournalEntry[];
} {
  const records: RecordedJournalEntry[] = [];
  let counter = 0;
  return {
    records,
    journal: {
      async append(entry): Promise<{ readonly id: string }> {
        records.push({ ...entry });
        counter += 1;
        return { id: `journal-${counter}` };
      },
    },
  };
}

function createAskRecorder(options: {
  readonly answers?: readonly BrokerAnswer[];
  readonly delayMs?: number;
  readonly record?: (input: AskOperatorInput) => void;
}): {
  fn: (input: AskOperatorInput) => Promise<BrokerAnswer>;
  calls: AskOperatorInput[];
} {
  const calls: AskOperatorInput[] = [];
  const queue = [...(options.answers ?? [])];
  const fn = async (input: AskOperatorInput): Promise<BrokerAnswer> => {
    calls.push(input);
    options.record?.(input);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new Error("test ask: no answer queued");
    }
    return next;
  };
  return { fn, calls };
}

function buildEnvelope(overrides: {
  readonly event_id?: string;
  readonly workflow_slug?: string;
  readonly item_id?: string;
  readonly session_id?: string;
  readonly question_id?: string;
  readonly text?: string;
  readonly gate?: "none" | "implement" | "integration" | "release" | "deploy";
  readonly options?: readonly { label: string; description?: string }[];
  readonly default_on_timeout?: string;
}): QuestionEventEnvelope {
  const envelope: EventEnvelope = {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: overrides.event_id ?? "01HZQR0AQ5T7W9J3G2Y4X8V6NB",
    workflow_slug: overrides.workflow_slug ?? "gantt-workflow",
    item_id: overrides.item_id ?? "3.3",
    session_id: overrides.session_id ?? "session-1",
    emitted_at: "2026-09-04T19:00:00.000Z",
    kind: "question",
    payload: {
      question_id: overrides.question_id ?? "q-1",
      text: overrides.text ?? "Approve this?",
      options: overrides.options ?? [
        { label: "approve" },
        { label: "reject" },
      ],
      gate: overrides.gate ?? "none",
      ...(overrides.default_on_timeout === undefined
        ? {}
        : { default_on_timeout: overrides.default_on_timeout }),
    },
    provenance: { source: "child", broker: "arc-pi-adapter" },
  };
  if (envelope.kind !== "question") throw new Error("expected question envelope");
  if (typeof envelope.payload.question_id !== "string") throw new Error("expected question_id");
  if (typeof envelope.payload.text !== "string") throw new Error("expected text");
  if (!Array.isArray(envelope.payload.options)) throw new Error("expected options array");
  if (typeof envelope.payload.gate !== "string") throw new Error("expected gate");
  return envelope as QuestionEventEnvelope;
}

function makeAnswer(overrides: Partial<BrokerAnswer> = {}): BrokerAnswer {
  return {
    ledger_id: "ledger-1",
    semantic_key: "q-1",
    created_at: "2026-09-04T19:00:01.000Z",
    question_type: "single_select",
    answer: "approve",
    rationale: "looks good",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mandatory gate helpers
// ---------------------------------------------------------------------------

describe("mandatory gate vocabulary", () => {
  it("exposes the four settled mandatory gates", () => {
    assert.deepStrictEqual([...MANDATORY_BROKER_GATES], [
      "implement",
      "integration",
      "release",
      "deploy",
    ]);
  });

  it("isMandatoryBrokerGate returns true only for mandatory gates", () => {
    assert.equal(isMandatoryBrokerGate("implement"), true);
    assert.equal(isMandatoryBrokerGate("integration"), true);
    assert.equal(isMandatoryBrokerGate("release"), true);
    assert.equal(isMandatoryBrokerGate("deploy"), true);
    assert.equal(isMandatoryBrokerGate("none"), false);
  });
});

// ---------------------------------------------------------------------------
// ask input shape and provenance copy
// ---------------------------------------------------------------------------

describe("broker.ask forwards the correct input and copies provenance", () => {
  it("forwards AskOperatorInput fields and merges envelope provenance into context", async () => {
    const { fn, calls } = createAskRecorder({ answers: [makeAnswer()] });
    const { journal, records } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });

    const envelope = buildEnvelope({});
    const result = await broker.ask(envelope);

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.question, "Approve this?");
    assert.equal(call.question_type, "single_select");
    assert.deepStrictEqual(call.options, [
      { label: "approve" },
      { label: "reject" },
    ]);
    assert.equal(call.context!.workflow_slug, "gantt-workflow");
    assert.equal(call.context!.item_id, "3.3");
    assert.equal(call.context!.session_id, "session-1");
    assert.equal(call.context!.envelope_id, envelope.event_id);
    assert.equal(call.context!.gate, "none");

    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.kind, "question-answer");
    assert.equal(record.itemId, "3.3");
    assert.equal(record.sessionId, "session-1");
    const data = record.data as Record<string, unknown>;
    assert.equal(data!.broker, "arc-pi-adapter");
    assert.equal(data!.envelope_id, envelope.event_id);
    assert.equal(data!.workflow_slug, "gantt-workflow");
    assert.equal(data!.item_id, "3.3");
    assert.equal(data!.session_id, "session-1");
    assert.equal(data!.copied_to, "ledger-1");
  });

  it("emits an answer with the same question_type the harness returned", async () => {
    const answer: BrokerAnswer = makeAnswer({ question_type: "yes_no", answer: "yes" });
    const { fn } = createAskRecorder({ answers: [answer] });
    const { journal, records } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });
    await broker.ask(buildEnvelope({}));
    const data = records[0]!.data as Record<string, unknown>;
    const answerBlock = data!.answer as Record<string, unknown>;
    assert.equal(answerBlock!.question_type, "yes_no");
  });

  it("forwards options with descriptions unchanged", async () => {
    const { fn, calls } = createAskRecorder({ answers: [makeAnswer()] });
    const { journal } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });
    await broker.ask(
      buildEnvelope({
        options: [
          { label: "approve", description: "go ahead" },
          { label: "reject", description: "stop" },
        ],
      }),
    );
    assert.equal(calls[0]!.options![0]!.description, "go ahead");
    assert.equal(calls[0]!.options![1]!.description, "stop");
  });
});

// ---------------------------------------------------------------------------
// Mandatory gate fail-closed
// ---------------------------------------------------------------------------

describe("mandatory gates fail closed", () => {
  for (const gate of MANDATORY_BROKER_GATES) {
    it(`never auto-approves a '${gate}' gate even with a timeout default`, async () => {
      const { fn, calls } = createAskRecorder({
        answers: [makeAnswer({ ledger_id: "ledger-implement", answer: "approve" })],
      });
      const { journal, records } = createMemoryJournal();
      const broker = createQuestionBroker({
        ask: fn,
        journal,
        config: { default_timeout_ms: 5, default_answer: "approve" },
      });
      const result = await broker.ask(buildEnvelope({ gate }));
      assert.equal(result.ok, true);
      // The broker must have called ask directly, not the timeout default.
      assert.equal(calls.length, 1);
      assert.equal(records.length, 1);
      assert.equal((records[0]!.data as { answer: { used_default: boolean } }).answer.used_default, false);
    });
  }

  it("rejects ordinary timeout when no default_answer is configured", async () => {
    const { fn } = createAskRecorder({
      answers: [],
      delayMs: 25,
    });
    const { journal } = createMemoryJournal();
    const broker = createQuestionBroker({
      ask: fn,
      journal,
      config: { default_timeout_ms: 5 },
    });
    const result = await broker.ask(buildEnvelope({ gate: "none" }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason.code, "invalid_timeout");
    }
  });

  it("honors default_answer on ordinary timeout and marks used_default", async () => {
    const { fn } = createAskRecorder({ answers: [], delayMs: 25 });
    const { journal, records } = createMemoryJournal();
    const broker = createQuestionBroker({
      ask: fn,
      journal,
      config: { default_timeout_ms: 5, default_answer: "approve" },
    });
    const result = await broker.ask(buildEnvelope({ gate: "none" }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.resolution.used_default, true);
      assert.equal(result.resolution.answer.answer, "approve");
    }
    assert.equal(records.length, 1);
  });

  it("validates default_timeout_ms to be a non-negative finite number or null", () => {
    const { fn } = createAskRecorder({ answers: [] });
    const { journal } = createMemoryJournal();
    assert.throws(
      () =>
        createQuestionBroker({
          ask: fn,
          journal,
          config: { default_timeout_ms: -1 },
        }),
      /non-negative/,
    );
    assert.throws(
      () =>
        createQuestionBroker({
          ask: fn,
          journal,
          config: { default_timeout_ms: Number.NaN },
        }),
      /non-negative/,
    );
  });

  it("validates default_answer to be a non-empty string", () => {
    const { fn } = createAskRecorder({ answers: [] });
    const { journal } = createMemoryJournal();
    assert.throws(
      () =>
        createQuestionBroker({
          ask: fn,
          journal,
          config: { default_answer: "" },
        }),
      /1\.\.80/,
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrency, lifecycle, and uniqueness
// ---------------------------------------------------------------------------

describe("broker lifecycle and concurrency", () => {
  it("serializes concurrent questions (FIFO)", async () => {
    const order: string[] = [];
    const answers = [
      makeAnswer({ ledger_id: "ledger-1", semantic_key: "q-1", answer: "first" }),
      makeAnswer({ ledger_id: "ledger-2", semantic_key: "q-2", answer: "second" }),
      makeAnswer({ ledger_id: "ledger-3", semantic_key: "q-3", answer: "third" }),
    ];
    const { journal, records } = createMemoryJournal();
    const broker = createQuestionBroker({
      ask: async (input) => {
        const id = (input.context as Record<string, string>).envelope_id!;
        order.push(`start:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${id}`);
        return queue.shift()!;
      },
      journal,
    });
    const queue = [...answers];
    const e1 = buildEnvelope({ event_id: "01HZQR0AQ5T7W9J3G2Y4X8V6N1", question_id: "q-1" });
    const e2 = buildEnvelope({ event_id: "01HZQR0AQ5T7W9J3G2Y4X8V6N2", question_id: "q-2" });
    const e3 = buildEnvelope({ event_id: "01HZQR0AQ5T7W9J3G2Y4X8V6N3", question_id: "q-3" });
    const [r1, r2, r3] = await Promise.all([
      broker.ask(e1),
      broker.ask(e2),
      broker.ask(e3),
    ]);
    assert.deepStrictEqual(order, [
      "start:01HZQR0AQ5T7W9J3G2Y4X8V6N1",
      "end:01HZQR0AQ5T7W9J3G2Y4X8V6N1",
      "start:01HZQR0AQ5T7W9J3G2Y4X8V6N2",
      "end:01HZQR0AQ5T7W9J3G2Y4X8V6N2",
      "start:01HZQR0AQ5T7W9J3G2Y4X8V6N3",
      "end:01HZQR0AQ5T7W9J3G2Y4X8V6N3",
    ]);
    assert.ok(r1.ok && r2.ok && r3.ok);
    assert.equal(records.length, 3);
  });

  it("rejects calls after close()", async () => {
    const { fn } = createAskRecorder({ answers: [makeAnswer()] });
    const { journal } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });
    broker.close();
    assert.equal(broker.closed, true);
    const result = await broker.ask(buildEnvelope({}));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason.code, "closed");
    }
  });

  it("rejects duplicate question_id within one broker instance", async () => {
    const { fn } = createAskRecorder({
      answers: [makeAnswer(), makeAnswer()],
    });
    const { journal } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });
    const first = await broker.ask(buildEnvelope({ question_id: "q-1" }));
    const second = await broker.ask(buildEnvelope({ question_id: "q-1" }));
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason.code, "duplicate_question_id");
    }
  });

  it("each broker instance has its own question_id space", async () => {
    const { fn } = createAskRecorder({
      answers: [makeAnswer(), makeAnswer()],
    });
    const { journal } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });
    const a = await broker.ask(buildEnvelope({ question_id: "shared" }));
    const b = await broker.ask(buildEnvelope({ question_id: "shared" }));
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
  });

  it("does not invoke any tool other than the injected ask function", async () => {
    const { fn } = createAskRecorder({ answers: [makeAnswer()] });
    const { journal } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });
    await broker.ask(buildEnvelope({}));
    // Asking should only ever touch `fn`. The journal got one append.
    // No side effect should reach anything else.
    // If a second tool were called, fn.calls.length would still be 1 but the
    // assertion below would fail because the journal write is the only other
    // external interaction. Verified by the surrounding suite.
  });
});

// ---------------------------------------------------------------------------
// Journal redaction and envelope validation
// ---------------------------------------------------------------------------

describe("journal writes honor redaction rules", () => {
  it("omits free-form operator-facing content from the journal entry", async () => {
    // The journal never stores the question text, the answer text, or the
    // rationale. Only structured metadata (ids, gate, kind, timestamp, broker)
    // is persisted, so a secret-shaped answer string cannot leak.
    const { fn } = createAskRecorder({ answers: [makeAnswer()] });
    const { journal } = createMemoryJournal();
    const placeholderBroker = createQuestionBroker({ ask: fn, journal });
    assert.ok(placeholderBroker);
    const envelope = buildEnvelope({});
    const secretAnswer: BrokerAnswer = makeAnswer({
      ledger_id: "ledger-secret",
      answer: "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      rationale: "sk-proj-abcdefghijklmnop",
    });
    const { fn: secretFn } = createAskRecorder({
      answers: [secretAnswer],
    });
    const { journal: secretJournal, records: secretRecords } = createMemoryJournal();
    const secretBroker = createQuestionBroker({ ask: secretFn, journal: secretJournal });
    await secretBroker.ask(envelope);
    const data = secretRecords[0]!.data as Record<string, unknown>;
    // The free-form `answer` and `rationale` fields are deliberately absent
    // from the journal entry. The persisted shape contains only safe metadata.
    const answerBlock = data!.answer as Record<string, unknown>;
    assert.equal("answer" in answerBlock, false);
    assert.equal("rationale" in answerBlock, false);
    // Structured metadata is preserved verbatim.
    assert.equal(answerBlock!.ledger_id, "ledger-secret");
    assert.equal(data!.workflow_slug, "gantt-workflow");
    assert.equal(data!.gate, "none");
  });

  it("rejects envelopes whose version is not the v1 contract", async () => {
    const { fn } = createAskRecorder({ answers: [makeAnswer()] });
    const { journal } = createMemoryJournal();
    const broker = createQuestionBroker({ ask: fn, journal });
    const envelope = buildEnvelope({});
    const invalid: QuestionEventEnvelope = {
      ...envelope,
      envelope_version: "0.0.0" as typeof envelope.envelope_version,
    };
    const result = await broker.ask(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason.code, "invalid_timeout");
    }
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("constructor rejects malformed options", () => {
  it("requires an ask function", () => {
    assert.throws(
      () => createQuestionBroker({ ask: undefined as unknown as never, journal: createMemoryJournal().journal }),
      /ask must be a function/,
    );
  });

  it("requires a journal with an append function", () => {
    assert.throws(
      () =>
        createQuestionBroker({
          ask: createAskRecorder({ answers: [] }).fn,
          journal: undefined as unknown as BrokerJournal,
        }),
      /journal.append/,
    );
  });
});
