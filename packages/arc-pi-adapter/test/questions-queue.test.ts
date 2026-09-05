import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CheckpointState,
  type Leaf,
  type Workflow,
  type WorkflowItem,
} from "@arc/workflow-core";
import {
  createQuestionQueue,
  type AskOperatorFn,
  type AskOperatorInput,
  type BrokerAnswer,
} from "@arc/pi-workflow";

const UPDATED_AT = "2026-09-05T00:00:00.000Z";

function group(id: string, state: CheckpointState = CheckpointState.planned): WorkflowItem {
  return {
    id,
    kind: "group",
    title: id,
    parent_id: null,
    nesting_depth: 0,
    dependencies: [],
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

function leaf(id: string, dependencies: string[]): Leaf {
  return {
    id,
    kind: "leaf",
    title: id,
    parent_id: "phase",
    nesting_depth: 1,
    dependencies,
    outcome: `Complete ${id}`,
    scope: `src/${id}.ts`,
    acceptance_criteria: [`${id} is verified`],
    preserved_behavior: "Keep the queue independent from the decision ledger.",
    checkpoint: { state: CheckpointState.ready, updated_at: UPDATED_AT },
  };
}

function fixtureWorkflow(): Workflow {
  return {
    schema_version: "1",
    slug: "question-queue-fixture",
    repository: { id: "local", path: "." },
    items: [
      group("foundation", CheckpointState.completed),
      group("phase"),
      leaf("critical", ["foundation"]),
      leaf("off-path", ["foundation"]),
    ],
  };
}

function input(questionId: string, itemId: string, gate: string = "none"): AskOperatorInput {
  return {
    question: `Question ${questionId}`,
    question_type: "single_select",
    context: {
      question_id: questionId,
      item_id: itemId,
      gate,
    },
    options: [{ label: "yes" }, { label: "no" }],
  };
}

function answer(questionId: string): BrokerAnswer {
  return {
    ledger_id: `ledger-${questionId}`,
    created_at: UPDATED_AT,
    question_type: "single_select",
    answer: "yes",
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition did not become true");
}

describe("createQuestionQueue", () => {
  test("keeps multiple waiting asks and applies mandatory, critical-path, then FIFO priority", async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const ask: AskOperatorFn = async (operatorInput) => {
      const questionId = String(operatorInput.context?.question_id ?? "");
      started.push(questionId);
      if (questionId === "q-first") {
        firstStarted();
        await firstRelease;
      }
      return answer(questionId);
    };
    const queue = createQuestionQueue({
      workflow: fixtureWorkflow(),
      ask,
      critical_path_item_ids: ["critical"],
    });

    const first = queue.ask(input("q-first", "off-path"));
    await firstStartedPromise;
    const critical = queue.ask(input("q-critical", "critical"));
    const mandatory = queue.ask(input("q-mandatory", "off-path", "implement"));
    await eventually(() => queue.pendingCount === 2);

    assert.deepEqual(queue.snapshot().map((entry) => `${entry.status}:${entry.question_id}`), [
      "active:q-first",
      "pending:q-mandatory",
      "pending:q-critical",
    ]);
    releaseFirst();
    await Promise.all([first, critical, mandatory]);

    assert.deepEqual(started, ["q-first", "q-mandatory", "q-critical"]);
    assert.equal(queue.inflight, 0);
    assert.equal(queue.pendingCount, 0);
  });

  test("a UI pick overrides computed priority for pending questions", async () => {
    const started: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ask: AskOperatorFn = async (operatorInput) => {
      const questionId = String(operatorInput.context?.question_id ?? "");
      started.push(questionId);
      if (questionId === "q-active") await hold;
      return answer(questionId);
    };
    const queue = createQuestionQueue({ workflow: fixtureWorkflow(), ask });

    const active = queue.ask(input("q-active", "off-path"));
    await eventually(() => queue.inflight === 1);
    const critical = queue.ask(input("q-critical", "critical"));
    const other = queue.ask(input("q-other", "off-path"));
    queue.setUiPick("q-other");
    await eventually(() => queue.pendingCount === 2);
    release();
    await Promise.all([active, critical, other]);

    assert.deepEqual(started, ["q-active", "q-other", "q-critical"]);
  });

  test("bounds pending requests, rejects duplicates, and closes pending work without cancelling the active ask", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ask: AskOperatorFn = async (operatorInput) => {
      if (operatorInput.context?.question_id === "q-active") await hold;
      return answer(String(operatorInput.context?.question_id ?? "unknown"));
    };
    const queue = createQuestionQueue({
      workflow: fixtureWorkflow(),
      ask,
      max_pending: 1,
    });

    const active = queue.ask(input("q-active", "off-path"));
    await eventually(() => queue.inflight === 1);
    const pending = queue.ask(input("q-pending", "critical"));
    await eventually(() => queue.pendingCount === 1);
    await assert.rejects(queue.ask(input("q-overflow", "off-path")), /full/);
    await assert.rejects(queue.ask(input("q-pending", "critical")), /already seen/);

    queue.close();
    assert.equal(queue.closed, true);
    await assert.rejects(pending, /closed/);
    release();
    await active;
    assert.equal(queue.inflight, 0);
  });

  test("requires item context and preserves the queue-selected input identity", async () => {
    const received: AskOperatorInput[] = [];
    const ask: AskOperatorFn = async (operatorInput) => {
      received.push(operatorInput);
      return answer("q-identity");
    };
    const queue = createQuestionQueue({ workflow: fixtureWorkflow(), ask });

    await assert.rejects(
      queue.ask({ question: "missing context", question_type: "freeform" }),
      /item_id/,
    );
    await assert.rejects(
      queue.ask(input("q-invalid-gate", "critical", "not-a-gate")),
      /gate/,
    );
    await queue.ask(input("q-identity", "critical", "release"));

    assert.equal(received.length, 1);
    assert.equal(received[0]!.context?.question_id, "q-identity");
    assert.equal(received[0]!.context?.item_id, "critical");
    assert.equal(received[0]!.context?.gate, "release");

    await queue.ask({
      question: "Generated identity",
      question_type: "freeform",
      context: { item_id: "critical", gate: "none" },
    });
    assert.match(String(received[1]!.context?.question_id), /^queue-question-/);
  });

  test("bounds total and per-item pending requests", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ask: AskOperatorFn = async (operatorInput) => {
      if (operatorInput.context?.question_id === "q-active") await hold;
      return answer(String(operatorInput.context?.question_id ?? "unknown"));
    };
    const queue = createQuestionQueue({
      workflow: fixtureWorkflow(),
      ask,
      max_pending: 2,
      max_pending_per_item: 1,
    });

    const active = queue.ask(input("q-active", "off-path"));
    await eventually(() => queue.inflight === 1);
    const firstForItem = queue.ask(input("q-one", "critical"));
    await eventually(() => queue.pendingCount === 1);
    await assert.rejects(
      queue.ask(input("q-two", "critical")),
      /full for item/,
    );
    const otherItem = queue.ask(input("q-other", "off-path"));
    await eventually(() => queue.pendingCount === 2);
    await assert.rejects(queue.ask(input("q-overflow", "off-path")), /queue is full/);

    release();
    await Promise.all([active, firstForItem, otherItem]);
  });

  test("validates the structural queue bounds", () => {
    const ask: AskOperatorFn = async () => answer("unused");
    assert.throws(
      () => createQuestionQueue({ workflow: fixtureWorkflow(), ask, max_pending: 0 }),
      /max_pending/,
    );
    assert.throws(
      () => createQuestionQueue({ workflow: fixtureWorkflow(), ask, max_pending: 33 }),
      /max_pending/,
    );
    assert.throws(
      () => createQuestionQueue({ workflow: fixtureWorkflow(), ask, max_pending_per_item: 0 }),
      /max_pending_per_item/,
    );
  });
});
