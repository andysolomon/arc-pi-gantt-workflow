import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CheckpointState,
  type Checkpoint,
  type Leaf,
  type Workflow,
} from "@arc/workflow-core";
import {
  createRestartReconciler,
  findRestartDiscrepancies,
  type AskOperatorInput,
  type BrokerAnswer,
  type BrokerJournal,
} from "../src/index.ts";

const NOW = new Date("2026-09-05T13:00:00.000Z");

function leaf(id: string, state: CheckpointState): Leaf {
  return {
    id, kind: "leaf", title: id, parent_id: null, nesting_depth: 0,
    dependencies: [], outcome: "done", scope: "src",
    acceptance_criteria: ["verified"], preserved_behavior: "none",
    checkpoint: { state, updated_at: NOW.toISOString() },
  };
}

function workflow(): Workflow {
  return {
    schema_version: "1", slug: "restart-test",
    repository: { id: "local", path: "." },
    items: [leaf("one", CheckpointState.ready), leaf("two", CheckpointState.ready)],
  };
}

describe("restart recovery", () => {
  test("detects all three journal/YAML/worktree discrepancy classes", () => {
    const journalCheckpoint: Checkpoint = {
      state: CheckpointState.blocked,
      updated_at: "2026-09-05T12:00:00.000Z",
    };
    const found = findRestartDiscrepancies(
      workflow(),
      [{ itemId: "one", checkpoint: journalCheckpoint }],
      [{ itemId: "two", exists: false }, { itemId: "gone", exists: true }],
    );
    assert.deepEqual(found.map((entry) => entry.kind), [
      "checkpoint-mismatch",
      "missing-worktree",
      "orphan-worktree",
    ]);
  });

  test("asks through one broker per discrepancy and applies selected checkpoints", async () => {
    const calls: string[] = [];
    const journal: BrokerJournal = {
      async append(entry) {
        calls.push(`journal:${entry.kind}`);
        return { id: `j-${calls.length}` };
      },
    };
    const answers = ["use-journal", "mark-needs-replan"];
    let answerIndex = 0;
    const applied: Checkpoint[] = [];
    const subject = createRestartReconciler({
      workflow: workflow(),
      journalCheckpoints: [{
        itemId: "one",
        checkpoint: { state: CheckpointState.blocked, updated_at: "2026-09-05T12:00:00.000Z" },
      }],
      worktrees: [{ itemId: "one", exists: true }, { itemId: "two", exists: false }],
      sessionId: "session-1",
      journal,
      now: () => NOW,
      createQuestionId: (() => { let n = 0; return () => `restart-q-${++n}`; })(),
      async ask(input: AskOperatorInput): Promise<BrokerAnswer> {
        calls.push(`ask:${input.context?.item_id}`);
        return {
          ledger_id: `ledger-${answerIndex + 1}`,
          created_at: NOW.toISOString(),
          question_type: "single_select",
          answer: answers[answerIndex++] ?? "keep-yaml",
        };
      },
      checkpoints: { apply({ checkpoint }) { applied.push(checkpoint); } },
    });
    const result = await subject.restart();
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.resolutions.map((entry) => entry.answer), answers);
    assert.deepEqual(applied.map((checkpoint) => checkpoint.state), [
      CheckpointState.blocked,
      CheckpointState.needsReplan,
    ]);
    assert.deepEqual(
      result.workflow.items.filter((item) => item.kind === "leaf").map((item) => item.checkpoint.state),
      [CheckpointState.blocked, CheckpointState.needsReplan],
    );
    assert.deepEqual(calls, [
      "ask:one", "journal:question-answer",
      "ask:two", "journal:question-answer",
    ]);
  });
});
