import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  DEFAULT_SCHEDULER_CONCURRENCY,
  DEFAULT_WAIT_POLICY,
  MAX_SCHEDULER_CONCURRENCY,
  applyConcurrencyLimit,
  computeCriticalPath,
  computeReadySet,
  prioritizeQuestionQueue,
  resolveSchedulerConfig,
  resolveWaitPolicy,
  type Leaf,
  type QueuedQuestion,
  type Workflow,
  type WorkflowItem,
} from "@arc/workflow-core";

const UPDATED_AT = "2026-09-04T00:00:00.000Z";

function item(
  id: string,
  state: WorkflowItem["checkpoint"]["state"],
  dependencies: string[] = [],
): WorkflowItem {
  return {
    id,
    kind: "group",
    title: id,
    parent_id: null,
    nesting_depth: 0,
    dependencies,
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

function leaf(
  id: string,
  dependencies: string[],
  overrides: Partial<Leaf> = {},
): Leaf {
  return {
    id,
    kind: "leaf",
    title: id,
    parent_id: null,
    nesting_depth: 0,
    dependencies,
    outcome: `Complete ${id}`,
    scope: `src/${id}`,
    acceptance_criteria: [`${id} is verified`],
    preserved_behavior: "Existing behavior remains stable.",
    checkpoint: { state: "planned", updated_at: UPDATED_AT },
    ...overrides,
  };
}

function workflow(items: WorkflowItem[]): Workflow {
  return {
    schema_version: "1",
    slug: "scheduler-test",
    repository: { id: "local", path: "." },
    items,
  };
}

test("ready-set requires activation and completed dependencies", () => {
  const input = workflow([
    item("foundation", "completed"),
    item("pending", "planned"),
    leaf("ready", ["foundation"]),
    leaf("dependency-pending", ["pending"]),
    leaf("activation-missing", ["foundation"], { acceptance_criteria: [] }),
    leaf("already-completed", ["foundation"], {
      checkpoint: { state: "completed", updated_at: UPDATED_AT },
    }),
    leaf("blocked", ["foundation"], {
      checkpoint: { state: "blocked", updated_at: UPDATED_AT },
    }),
  ]);

  assert.deepEqual(
    computeReadySet(input).map((candidate) => candidate.id),
    ["ready"],
  );
  assert.equal(input.items[2]?.checkpoint.state, "planned");
});

test("invalid DAGs fail closed instead of yielding partial ready work", () => {
  const dangling = workflow([leaf("unsafe", ["missing"])]);
  assert.deepEqual(computeReadySet(dangling), []);
});

test("scheduler configuration defaults and concurrency bounds are enforced", () => {
  assert.deepEqual(resolveSchedulerConfig(), {
    concurrency: DEFAULT_SCHEDULER_CONCURRENCY,
    wait_policy: DEFAULT_WAIT_POLICY,
  });
  assert.deepEqual(resolveSchedulerConfig({ concurrency: 1 }), {
    concurrency: 1,
    wait_policy: DEFAULT_WAIT_POLICY,
  });
  assert.equal(
    resolveSchedulerConfig({ concurrency: MAX_SCHEDULER_CONCURRENCY }).concurrency,
    MAX_SCHEDULER_CONCURRENCY,
  );

  for (const concurrency of [0, -1, 1.5, MAX_SCHEDULER_CONCURRENCY + 1]) {
    assert.throws(() => resolveSchedulerConfig({ concurrency }), RangeError);
  }
  assert.throws(
    () =>
      resolveSchedulerConfig({
        wait_policy: "unknown" as typeof DEFAULT_WAIT_POLICY,
      }),
    RangeError,
  );

  assert.deepEqual(applyConcurrencyLimit([1, 2, 3, 4, 5]), [1, 2, 3, 4]);
  assert.deepEqual(
    applyConcurrencyLimit([1, 2, 3, 4], { concurrency: 3, active_count: 2 }),
    [1],
  );
  assert.deepEqual(
    applyConcurrencyLimit([1, 2], { concurrency: 1, active_count: 2 }),
    [],
  );
  assert.throws(() => applyConcurrencyLimit([1], { active_count: -1 }), RangeError);
});

test("default wait policy continues only independent authorized branches", () => {
  const foundation = item("foundation", "completed");
  const branchA = leaf("branch-a", ["foundation"]);
  const waitingA = leaf("branch-a-question", ["branch-a"]);
  const branchB = leaf("branch-b", ["foundation"]);
  const laterJoin = leaf("later-join", ["branch-a-question", "branch-b"]);
  const input = workflow([foundation, branchA, waitingA, branchB, laterJoin]);
  const ready = computeReadySet(input);
  const state = {
    authorized_item_ids: ["branch-a", "branch-b"],
    waiting_item_ids: ["branch-a-question"],
  };

  assert.equal(DEFAULT_WAIT_POLICY, "continue-independent-authorized-branches");
  assert.deepEqual(
    resolveWaitPolicy(input, ready, state).map((candidate) => candidate.id),
    ["branch-b"],
  );
  assert.deepEqual(
    resolveWaitPolicy(input, ready, state, "pause-all-authorized-branches"),
    [],
  );
  assert.deepEqual(
    resolveWaitPolicy(input, ready, {
      authorized_item_ids: ["branch-a"],
      waiting_item_ids: [],
    }).map((candidate) => candidate.id),
    ["branch-a"],
  );
});

test("hybrid question queue prioritizes mandatory gates, critical path, then FIFO", () => {
  const input = workflow([
    leaf("critical-a", ["completed-root"]),
    leaf("critical-b", ["critical-a"]),
    leaf("off-path", ["completed-root"]),
    item("completed-root", "completed"),
  ]);
  assert.deepEqual(computeCriticalPath(input), ["critical-a", "critical-b"]);

  const questions: QueuedQuestion[] = [
    { question_id: "fifo-off-path", item_id: "off-path", gate: "none" },
    { question_id: "mandatory-first", item_id: "off-path", gate: "implement" },
    { question_id: "critical", item_id: "critical-b", gate: "none" },
    { question_id: "mandatory-second", item_id: "critical-a", gate: "release" },
    { question_id: "fifo-last", item_id: "off-path", gate: "none" },
  ];

  assert.deepEqual(
    prioritizeQuestionQueue(input, questions).map((question) => question.question_id),
    [
      "mandatory-first",
      "mandatory-second",
      "critical",
      "fifo-off-path",
      "fifo-last",
    ],
  );
  assert.deepEqual(
    prioritizeQuestionQueue(input, questions, {
      ui_pick: "fifo-last",
    }).map((question) => question.question_id),
    [
      "fifo-last",
      "mandatory-first",
      "mandatory-second",
      "critical",
      "fifo-off-path",
    ],
  );
  assert.deepEqual(questions.map((question) => question.question_id), [
    "fifo-off-path",
    "mandatory-first",
    "critical",
    "mandatory-second",
    "fifo-last",
  ]);
});

test("schedule source is free of filesystem, adapter, Pi, and model calls", async () => {
  const scheduleDirectory = new URL("../src/schedule/", import.meta.url);
  const sourceFiles = (await readdir(scheduleDirectory)).filter((name) =>
    name.endsWith(".ts"),
  );
  const source = (
    await Promise.all(
      sourceFiles.map((name) => readFile(new URL(name, scheduleDirectory), "utf8")),
    )
  ).join("\n");

  assert.doesNotMatch(source, /node:fs|arc-pi|arc_pi|@arc\/arc-pi-adapter/u);
  assert.doesNotMatch(source, /\b(?:AgentSession|arc_delegate|model\.generate)\b/u);
});
