import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CheckpointState,
  type Leaf,
  type Workflow,
  type WorkflowItem,
} from "@arc/workflow-core";
import {
  createWorkflowDashboard,
  createWorkflowRpc,
  type AskOperatorInput,
  type QuestionQueueEntry,
  type QuestionQueueLike,
} from "@arc/pi-workflow";

const UPDATED_AT = "2026-09-05T00:00:00.000Z";

function group(): WorkflowItem {
  return {
    id: "phase",
    kind: "group",
    title: "Phase",
    parent_id: null,
    nesting_depth: 0,
    dependencies: [],
    checkpoint: { state: CheckpointState.planned, updated_at: UPDATED_AT },
  };
}

function leaf(id: string, state: CheckpointState): Leaf {
  return {
    id,
    kind: "leaf",
    title: `Leaf ${id}`,
    parent_id: "phase",
    nesting_depth: 1,
    dependencies: ["phase"],
    outcome: `Complete ${id}`,
    scope: `src/${id}.ts`,
    acceptance_criteria: [`${id} is verified`],
    preserved_behavior: "Keep the UI read-only with respect to decisions.",
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

function fixtureWorkflow(): Workflow {
  return {
    schema_version: "1",
    slug: "dashboard-fixture",
    repository: { id: "local", path: "." },
    items: [
      group(),
      leaf("planned", CheckpointState.planned),
      leaf("ready", CheckpointState.ready),
      leaf("completed", CheckpointState.completed),
      leaf("blocked", CheckpointState.blocked),
      leaf("cancelled", CheckpointState.cancelled),
      leaf("replan", CheckpointState.needsReplan),
    ],
  };
}

const QUESTIONS: readonly QuestionQueueEntry[] = [
  { question_id: "q-ready", item_id: "ready", gate: "integration", status: "pending" },
  { question_id: "q-active", item_id: "completed", gate: "none", status: "active" },
];

function queueRecorder(): QuestionQueueLike & { readonly picks: string[] } {
  const picks: string[] = [];
  return {
    picks,
    snapshot: () => QUESTIONS,
    setUiPick(questionId) {
      if (questionId !== undefined) picks.push(questionId);
    },
  };
}

function dashboard(queue?: QuestionQueueLike) {
  return createWorkflowDashboard({
    workflow: fixtureWorkflow(),
    concurrency: 4,
    runtime: {
      active_item_ids: ["ready"],
      waiting_item_ids: ["planned"],
      progress_by_item_id: {
        ready: "running\nwith a bounded status",
      },
      ...(queue === undefined ? { questions: QUESTIONS } : {}),
    },
    ...(queue === undefined ? {} : { queue }),
    now: () => new Date(UPDATED_AT),
  });
}

describe("workflow dashboard and passive widget", () => {
  test("projects all checkpoint states, runtime counts, and bounded live progress deterministically", () => {
    const view = dashboard();
    const first = view.snapshot();
    const second = view.snapshot();

    assert.deepEqual(second, first);
    assert.deepEqual(first.counts, {
      total: 7,
      groups: 1,
      leaves: 6,
      planned: 2,
      ready: 1,
      completed: 1,
      blocked: 1,
      cancelled: 1,
      needs_replan: 1,
      active: 1,
      waiting: 1,
      questions: 2,
    });
    assert.equal(first.available_slots, 3);
    assert.equal(first.items.find((item) => item.id === "ready")?.active, true);
    assert.equal(first.items.find((item) => item.id === "planned")?.waiting, true);
    assert.equal(first.items.find((item) => item.id === "ready")?.progress, "running with a bounded status");

    const tui = view.renderTui();
    assert.match(tui, /Checkpoints: planned=2 ready=1 completed=1 blocked=1 cancelled=1 needs-replan=1/);
    assert.match(tui, /\[>\] ready - Leaf ready \(ready\)/);
    assert.match(tui, /q-ready.*integration.*pending/);
    assert.match(tui, /q-active.*active/);
    assert.match(tui, /\n$/);

    const widget = view.renderWidget();
    assert.match(widget, /dashboard-fixture/);
    assert.match(widget, /1\/6 complete/);
    assert.match(widget, /1 running/);
    assert.match(widget, /1 waiting/);
    assert.doesNotMatch(widget, /Question ready/);
    assert.equal(widget.includes("\n"), false);
  });

  test("subscriptions receive runtime updates and can be removed", () => {
    const view = dashboard();
    const received: number[] = [];
    const unsubscribe = view.subscribe((snapshot) => {
      received.push(snapshot.counts.active);
    });
    view.update({ active_item_ids: ["completed"] });
    assert.deepEqual(received, [1]);
    unsubscribe();
    view.update({ active_item_ids: [] });
    assert.deepEqual(received, [1]);
  });

  test("question selection delegates only to the queue and never asks the operator", () => {
    const queue = queueRecorder();
    const view = dashboard(queue);
    const selected = view.pickQuestion("q-ready");
    assert.deepEqual(queue.picks, ["q-ready"]);
    assert.equal(selected.ui_pick, "q-ready");
    assert.throws(() => view.pickQuestion("q-missing"), /unknown pending question/);
    assert.throws(() => view.pickQuestion("q-active"), /unknown pending question/);
  });
});

describe("workflow RPC handler", () => {
  test("serves status, widget, and question-pick requests as JSON-safe responses", () => {
    const queue = queueRecorder();
    const handler = createWorkflowRpc(dashboard(queue));

    const status = handler.handle({ method: "status" });
    assert.equal(status.ok, true);
    assert.doesNotThrow(() => JSON.stringify(status));
    if (status.ok && !("widget" in status.result) && !("selected_question_id" in status.result)) {
      assert.equal(status.result.workflow_slug, "dashboard-fixture");
    }

    const widget = handler.handle({ method: "widget" });
    assert.equal(widget.ok, true);
    if (widget.ok) {
      assert.equal("widget" in widget.result, true);
    }

    const pick = handler.handle({ method: "pick-question", question_id: "q-ready" });
    assert.equal(pick.ok, true);
    assert.deepEqual(queue.picks, ["q-ready"]);
  });

  test("rejects unknown, malformed, oversized, and non-pending requests fail-closed", () => {
    const handler = createWorkflowRpc(dashboard());
    assert.deepEqual(handler.handle({ method: "unknown" }), {
      ok: false,
      error: { code: "unknown_method", message: "workflow RPC method is not supported" },
    });
    assert.deepEqual(handler.handle({ method: "status", extra: true }), {
      ok: false,
      error: { code: "invalid_request", message: "workflow RPC request has invalid fields" },
    });
    assert.deepEqual(handler.handle({ method: "pick-question", question_id: "missing" }), {
      ok: false,
      error: { code: "unknown_question", message: "workflow RPC question is not pending" },
    });
    assert.equal(handler.handle("not an object").ok, false);
    assert.equal(handler.handle({ method: "status", padding: "x".repeat(9000) }).ok, false);
    assert.equal(handler.handle({ method: "status", padding: "x" }).ok, false);
  });

  test("does not expose a prompt function through the UI surface", () => {
    const view = dashboard();
    const candidate = view as unknown as Record<string, unknown>;
    assert.equal("ask" in candidate, false);
    const unusedInput: AskOperatorInput | undefined = undefined;
    assert.equal(unusedInput, undefined);
  });
});
