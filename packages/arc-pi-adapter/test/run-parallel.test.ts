import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CheckpointState,
  createWorktreeManager,
  type Leaf,
  type Workflow,
  type WorkflowItem,
} from "@arc/workflow-core";
import {
  createParallelRunner,
  createQuestionQueue,
  createSessionLifecycle,
  noRiskReview,
  type AskOperatorFn,
  type AtomicWorkflowWriter,
  type BrokerJournal,
  type ParallelWorker,
  type PiSessionFactory,
  type QuestionQueue,
  type SessionMetadataStore,
  type SessionRecord,
} from "@arc/pi-workflow";
import type { ProcessInvoker } from "../src/integrate/index.ts";

const UPDATED_AT = "2026-09-05T00:00:00.000Z";
const ROOT = "/parallel-runner";

function group(
  id: string,
  state: CheckpointState = CheckpointState.planned,
): WorkflowItem {
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

function leaf(
  id: string,
  dependencies: string[] = ["foundation"],
  state: CheckpointState = CheckpointState.ready,
): Leaf {
  return {
    id,
    kind: "leaf",
    title: `Leaf ${id}`,
    parent_id: "phase",
    nesting_depth: 1,
    dependencies,
    outcome: `Complete ${id}`,
    scope: `src/${id}.ts`,
    acceptance_criteria: [`${id} is verified`],
    preserved_behavior: "Keep unrelated workflow behavior unchanged.",
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

function workflow(leaves: readonly Leaf[]): Workflow {
  return {
    schema_version: "1",
    slug: "parallel-fixture",
    repository: { id: "local", path: "." },
    items: [group("foundation", CheckpointState.completed), group("phase"), ...leaves],
  };
}

interface FixtureState {
  activeWorkers: number;
  maxActiveWorkers: number;
  workerStarts: string[];
  workerFinishes: string[];
  askItems: string[];
  writes: Array<{ workflowYaml: string; progressText: string; ganttText: string }>;
  journalEntries: number;
  revCounter: number;
}

function makeFixture(): FixtureState {
  return {
    activeWorkers: 0,
    maxActiveWorkers: 0,
    workerStarts: [],
    workerFinishes: [],
    askItems: [],
    writes: [],
    journalEntries: 0,
    revCounter: 0,
  };
}

function makeWorker(state: FixtureState, failures: readonly string[] = []): ParallelWorker {
  const failed = new Set(failures);
  return {
    async run({ leaf: current }) {
      state.activeWorkers += 1;
      state.maxActiveWorkers = Math.max(state.maxActiveWorkers, state.activeWorkers);
      state.workerStarts.push(current.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      state.workerFinishes.push(current.id);
      state.activeWorkers -= 1;
      if (failed.has(current.id)) throw new Error(`failure-${current.id}`);
    },
  };
}

function makeLifecycle() {
  const byKey = new Map<string, SessionRecord>();
  const factory: PiSessionFactory<{ readonly id: string }> = {
    async create(cwd) {
      return { path: `${cwd}/session`, session: { id: cwd } };
    },
    async open(path) {
      return { id: path };
    },
  };
  const metadata: SessionMetadataStore = {
    async read(key) {
      return byKey.get(key);
    },
    async write(key, record) {
      byKey.set(key, record);
    },
  };
  return createSessionLifecycle({ factory, metadata });
}

function makeInvoker(state: FixtureState): ProcessInvoker {
  return {
    run(program, args, options) {
      if (program === "verify") {
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      if (program !== "git") {
        return { exit_code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        state.revCounter += 1;
        return {
          exit_code: 0,
          stdout: `commit-${state.revCounter}-${options.cwd.split("/").pop() ?? "unknown"}\n`,
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "", stderr: "" };
    },
  };
}

function makeRunner(
  input: {
    readonly workflow: Workflow;
    readonly state: FixtureState;
    readonly failures?: readonly string[];
    readonly answer?: string;
    readonly concurrency?: number;
    readonly questionQueue?: QuestionQueue;
  },
) {
  const state = input.state;
  const ask: AskOperatorFn = async (operatorInput) => {
    const itemId = operatorInput.context?.item_id;
    if (typeof itemId === "string") state.askItems.push(itemId);
    return {
      ledger_id: `ledger-${state.askItems.length}`,
      created_at: UPDATED_AT,
      question_type: "single_select",
      answer: input.answer ?? "cherry-pick",
    };
  };
  const journal: BrokerJournal = {
    async append() {
      state.journalEntries += 1;
      return { id: `journal-${state.journalEntries}` };
    },
  };
  const writer: AtomicWorkflowWriter = {
    async writeAtomic(contents, paths) {
      state.writes.push(contents);
      return { wrote: true, paths };
    },
  };
  const fileSystem = {
    async mkdir() {},
  };
  const runner = createParallelRunner({
    workflow: input.workflow,
    paths: {
      workflowYaml: `${ROOT}/workflow.yaml`,
      progressText: `${ROOT}/progress.txt`,
      ganttText: `${ROOT}/gantt.mmd`,
      sessionDir: `${ROOT}/sessions`,
      worktreesRoot: `${ROOT}/worktrees`,
    },
    now: () => new Date(UPDATED_AT),
    worker: makeWorker(state, input.failures),
    lifecycle: makeLifecycle(),
    ...(input.questionQueue === undefined ? {} : { questionQueue: input.questionQueue }),
    worktreeManager: createWorktreeManager({
      repositoryRoot: ROOT,
      workflowSlug: input.workflow.slug,
      fileSystem,
      git: {
        async createWorktree() {},
        async removeWorktree() {},
      },
    }),
    writer,
    review: noRiskReview,
    ask,
    journal,
    integrationBranch: "main",
    repositoryRoot: ROOT,
    invoker: makeInvoker(state),
    verifyCommand: ["verify"],
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
  });
  return runner;
}

describe("createParallelRunner", () => {
  test("runs independent leaves in parallel up to the default cap and targets every completion", async () => {
    const state = makeFixture();
    const leaves = ["a", "b", "c", "d", "e"].map((id) => leaf(id));
    const runner = makeRunner({ workflow: workflow(leaves), state });

    const result = await runner.run();

    assert.equal(state.maxActiveWorkers, 4);
    assert.equal(result.leaves.length, 5);
    assert.deepEqual(
      result.leaves.map((entry) => [entry.itemId, entry.status]),
      [
        ["a", "completed"],
        ["b", "completed"],
        ["c", "completed"],
        ["d", "completed"],
        ["e", "completed"],
      ],
    );
    for (const id of ["a", "b", "c", "d", "e"]) {
      const completed = result.workflow.items.find((item) => item.id === id);
      assert.ok(completed && completed.kind === "leaf");
      assert.equal(completed.checkpoint.state, CheckpointState.completed);
    }
    assert.equal(state.writes.length, 5);
    assert.equal(state.askItems.length, 5);
    assert.equal(state.journalEntries, 5);
    // The last projection contains all prior completion transitions rather
    // than a stale snapshot from the first parallel worker.
    for (const id of ["a", "b", "c", "d", "e"]) {
      assert.match(state.writes.at(-1)!.workflowYaml, new RegExp(`id: ${id}`));
    }
  });

  test("supervises failures per item and continues independent work", async () => {
    const state = makeFixture();
    const leaves = ["a", "b", "c", "d"].map((id) => leaf(id));
    const runner = makeRunner({ workflow: workflow(leaves), state, failures: ["b"] });

    const result = await runner.run();

    assert.equal(state.maxActiveWorkers, 4);
    assert.deepEqual(
      result.leaves.map((entry) => `${entry.itemId}:${entry.status}`),
      ["a:completed", "b:needs-replan", "c:completed", "d:completed"],
    );
    assert.equal(
      result.workflow.items.find((item) => item.id === "b")?.checkpoint.state,
      CheckpointState.needsReplan,
    );
    assert.deepEqual(state.workerStarts.sort(), ["a", "b", "c", "d"]);
  });

  test("waits for dependency completion and does not duplicate a single-flight run", async () => {
    const state = makeFixture();
    const runner = makeRunner({
      workflow: workflow([
        leaf("a"),
        leaf("b", ["a"]),
        leaf("c"),
      ]),
      state,
      concurrency: 2,
    });

    const first = runner.run();
    const second = runner.run();
    assert.strictEqual(first, second);
    const result = await first;

    assert.deepEqual(state.workerStarts.slice(0, 2).sort(), ["a", "c"]);
    assert.equal(state.workerStarts.indexOf("b") > state.workerFinishes.indexOf("a"), true);
    assert.deepEqual(result.leaves.map((entry) => entry.itemId), ["a", "c", "b"]);
    assert.equal(result.leaves.length, 3);
  });

  test("uses a supplied shared question queue for integration asks", async () => {
    const state = makeFixture();
    const workflowInput = workflow([leaf("a"), leaf("b")]);
    let queuedAsks = 0;
    const queue = createQuestionQueue({
      workflow: workflowInput,
      ask: async () => {
        queuedAsks += 1;
        return {
          ledger_id: `shared-${queuedAsks}`,
          created_at: UPDATED_AT,
          question_type: "single_select",
          answer: "cherry-pick",
        };
      },
    });
    const runner = makeRunner({
      workflow: workflowInput,
      state,
      questionQueue: queue,
    });

    const result = await runner.run();

    assert.equal(result.leaves.every((entry) => entry.status === "completed"), true);
    assert.equal(queuedAsks, 2);
    assert.equal(state.askItems.length, 0, "the runner used the supplied queue, not the fallback ask");
  });

  test("does not complete a leaf when integration is denied", async () => {
    const state = makeFixture();
    const runner = makeRunner({
      workflow: workflow([leaf("a")]),
      state,
      answer: "skip",
    });

    const result = await runner.run();

    assert.deepEqual(result.leaves.map((entry) => [entry.itemId, entry.status]), [["a", "blocked"]]);
    assert.equal(
      result.workflow.items.find((item) => item.id === "a")?.checkpoint.state,
      CheckpointState.blocked,
    );
    assert.equal(state.writes.length, 0);
  });

  test("honors a configurable cap and rejects invalid caps", async () => {
    const state = makeFixture();
    const runner = makeRunner({
      workflow: workflow([leaf("a"), leaf("b"), leaf("c")]),
      state,
      concurrency: 2,
    });
    await runner.run();
    assert.equal(state.maxActiveWorkers, 2);
    assert.throws(
      () => makeRunner({ workflow: workflow([leaf("a")]), state: makeFixture(), concurrency: 0 }),
      /concurrency/,
    );
  });
});
