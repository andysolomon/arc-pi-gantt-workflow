import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CheckpointState, type Leaf, type Workflow } from "@arc/workflow-core";
import {
  createCancellationController,
  type AskOperatorInput,
  type BrokerAnswer,
  type BrokerJournal,
} from "../src/index.ts";

const NOW = new Date("2026-09-05T14:00:00.000Z");

function workflow(): Workflow {
  const leaf: Leaf = {
    id: "7.3", kind: "leaf", title: "Cancel", parent_id: null,
    nesting_depth: 0, dependencies: [], outcome: "cancelled", scope: "src",
    acceptance_criteria: ["ordered"], preserved_behavior: "retain session",
    checkpoint: { state: CheckpointState.ready, updated_at: NOW.toISOString() },
  };
  return {
    schema_version: "1", slug: "cancel-test",
    repository: { id: "local", path: "." }, items: [leaf],
  };
}

function harness(answer: string) {
  const calls: string[] = [];
  let journalId = 0;
  const journal: BrokerJournal = {
    async append(entry) {
      calls.push(`journal:${entry.kind}`);
      return { id: `j-${++journalId}` };
    },
  };
  const subject = createCancellationController({
    workflow: workflow(), itemId: "7.3", sessionId: "session-73",
    journal, now: () => NOW, createQuestionId: () => "cancel-q-1",
    async ask(_input: AskOperatorInput): Promise<BrokerAnswer> {
      calls.push("ask");
      return {
        ledger_id: "ledger-1", created_at: NOW.toISOString(),
        question_type: "single_select", answer,
      };
    },
    worktrees: { async cancel(input) { calls.push(`worktree:${input.decision}`); } },
    sessions: { async archive() { calls.push("session:archive"); } },
    checkpoints: { apply({ checkpoint }) { calls.push(`checkpoint:${checkpoint.state}`); } },
  });
  return { calls, subject };
}

describe("cancellation recovery", () => {
  for (const decision of ["preserve", "delete"] as const) {
    test(`records stop intent first, asks, then applies ${decision}`, async () => {
      const { calls, subject } = harness(decision);
      const result = await subject.cancel();
      assert.equal(result.ok, true);
      assert.equal(result.decision, decision);
      assert.equal(result.workflow.items[0]?.checkpoint.state, CheckpointState.cancelled);
      assert.deepEqual(calls, [
        "journal:cancellation-started",
        "ask",
        "journal:question-answer",
        `worktree:${decision}`,
        "session:archive",
        "checkpoint:cancelled",
      ]);
    });
  }

  test("an invalid operator answer stops before worktree, session, or checkpoint changes", async () => {
    const { calls, subject } = harness("unexpected");
    const result = await subject.cancel();
    assert.equal(result.ok, false);
    assert.equal(result.failure?.code, "invalid-answer");
    assert.equal(result.workflow.items[0]?.checkpoint.state, CheckpointState.ready);
    assert.deepEqual(calls, [
      "journal:cancellation-started", "ask", "journal:question-answer",
    ]);
  });
});
