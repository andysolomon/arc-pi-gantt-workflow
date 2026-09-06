import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Workflow } from "@arc/workflow-core";
import {
  createArchiveController,
  type ArchiveJournalTarget,
  type ArchiveOptions,
  type ArchiveSessionTarget,
} from "../src/archive/index.ts";
import type { BrokerAnswer } from "../src/questions/index.ts";

const NOW = "2026-09-06T00:00:00.000Z";

function makeWorkflow(states: readonly ("completed" | "blocked" | "cancelled" | "needs-replan")[] = ["completed", "cancelled"]): Workflow {
  return {
    schema_version: "1",
    slug: "release-workflow",
    repository: { id: "repo", path: "." },
    items: [
      {
        id: "9.0",
        kind: "group",
        title: "Release handoff",
        parent_id: null,
        nesting_depth: 0,
        dependencies: [],
        checkpoint: { state: "completed", updated_at: NOW },
      },
      ...states.map((state, index) => ({
        id: `leaf-${index + 1}`,
        kind: "leaf" as const,
        title: `Leaf ${index + 1}`,
        parent_id: "9.0",
        nesting_depth: 1,
        outcome: "A terminal leaf",
        scope: "the declared leaf",
        acceptance_criteria: ["terminal"],
        dependencies: [],
        preserved_behavior: "Existing behavior remains unchanged",
        checkpoint: { state, updated_at: NOW, evidence_ref: `journal-${index + 1}` },
      })),
    ],
  };
}

function answer(value = "keep"): BrokerAnswer {
  return {
    ledger_id: "ledger-archive",
    created_at: NOW,
    question_type: "single_select",
    answer: value,
  };
}

interface Harness {
  readonly options: ArchiveOptions;
  readonly calls: string[];
  readonly askInputs: Array<{ question: string; context?: Readonly<Record<string, string | readonly string[]>>; options?: readonly { label: string }[] }>;
  readonly writes: Array<{ workflowYaml: string; progressText: string; ganttText: string }>;
}

function makeHarness(
  workflow = makeWorkflow(),
  overrides: Partial<Pick<ArchiveOptions, "ask" | "writer">> = {},
): Harness {
  const calls: string[] = [];
  const askInputs: Harness["askInputs"] = [];
  const writes: Harness["writes"] = [];
  const ask = overrides.ask ?? (async (input) => {
    calls.push("ask");
    askInputs.push({
      question: input.question,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.options === undefined
        ? {}
        : { options: input.options.map((option) => ({ label: option.label })) }),
    });
    return answer();
  });
  const journal = {
    async append(): Promise<{ readonly id: string }> {
      calls.push("question-journal");
      return { id: "journal-answer" };
    },
  };
  const sessions = {
    owns(target: ArchiveSessionTarget): boolean {
      calls.push(`owns-session:${target.leaf}`);
      return true;
    },
    archive(target: ArchiveSessionTarget): void {
      calls.push(`archive-session:${target.leaf}`);
    },
    delete(target: ArchiveSessionTarget): void {
      calls.push(`delete-session:${target.leaf}`);
    },
  };
  const journalResource = {
    owns(target: ArchiveJournalTarget): boolean {
      calls.push(`owns-journal:${target.workflowSlug}`);
      return true;
    },
    archive(target: ArchiveJournalTarget): void {
      calls.push(`archive-journal:${target.workflowSlug}`);
    },
    delete(target: ArchiveJournalTarget): void {
      calls.push(`delete-journal:${target.workflowSlug}`);
    },
  };
  const writer = overrides.writer ?? {
    async writeAtomic(contents: Harness["writes"][number]): Promise<{
      readonly wrote: true;
      readonly paths: ArchiveOptions["paths"];
    }> {
      calls.push("write");
      writes.push(contents);
      return { wrote: true, paths: { workflowYaml: "/workflow.yaml", progressText: "/progress.txt", ganttText: "/gantt" } };
    },
  };
  return {
    calls,
    askInputs,
    writes,
    options: {
      workflow,
      sessionId: "controller-session",
      paths: { workflowYaml: "/workflow.yaml", progressText: "/progress.txt", ganttText: "/gantt" },
      renderContext: { generated_at: NOW, source: "workflow.yaml" },
      writer,
      ask,
      journal,
      sessions,
      journalResource,
      now: () => new Date(NOW),
      createQuestionId: () => "archive-question",
    },
  };
}

describe("createArchiveController", () => {
  it("rejects unfinished leaves before ownership checks or prompting", async () => {
    const harness = makeHarness({
      ...makeWorkflow(),
      items: makeWorkflow().items.map((item) => item.kind === "leaf"
        ? { ...item, checkpoint: { state: "ready" as const, updated_at: NOW } }
        : item),
    });
    const result = await createArchiveController(harness.options).archive();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, "unfinished-workflow");
    assert.deepEqual(harness.calls, []);
  });

  it("fails closed for unowned resources without asking", async () => {
    const harness = makeHarness();
    const guarded = {
      ...harness.options,
      sessions: {
        ...harness.options.sessions,
        owns: () => false,
      },
    };
    const result = await createArchiveController(guarded).archive();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, "unowned-resource");
    assert.equal(harness.calls.includes("ask"), false);
    assert.equal(harness.calls.includes("write"), false);
  });

  it("asks one brokered release question with keep/delete options", async () => {
    const harness = makeHarness();
    const result = await createArchiveController(harness.options).archive();
    assert.equal(result.ok, true);
    assert.equal(harness.askInputs.length, 1);
    assert.match(harness.askInputs[0]?.question ?? "", /release archival/);
    assert.equal(harness.askInputs[0]?.context?.gate, "release");
    assert.deepEqual(harness.askInputs[0]?.options, [{ label: "keep" }, { label: "delete" }]);
  });

  it("does not write or clean up when the broker fails", async () => {
    const harness = makeHarness();
    const controller = createArchiveController(harness.options);
    controller.broker.close();
    const result = await controller.archive();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, "broker-failure");
    assert.equal(harness.calls.includes("ask"), false);
    assert.equal(harness.calls.includes("write"), false);
    assert.equal(harness.calls.some((call) => call.startsWith("archive-") || call.startsWith("delete-")), false);
  });

  it("does not write or clean up for an invalid retention answer", async () => {
    const harness = makeHarness(makeWorkflow(), { ask: async () => answer("maybe") });
    const result = await createArchiveController(harness.options).archive();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, "invalid-answer");
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.calls.some((call) => call.startsWith("archive-") || call.startsWith("delete-")), false);
  });

  it("writes final projections before archiving sessions and the journal", async () => {
    const harness = makeHarness();
    const result = await createArchiveController(harness.options).archive();
    assert.equal(result.ok, true);
    assert.deepEqual(harness.calls.slice(-3), [
      "archive-session:leaf-1",
      "archive-session:leaf-2",
      "archive-journal:release-workflow",
    ]);
    assert.ok(harness.calls.indexOf("write") < harness.calls.indexOf("archive-session:leaf-1"));
    assert.match(harness.writes[0]?.workflowYaml ?? "", /state: completed/);
    assert.match(harness.writes[0]?.progressText ?? "", /release-workflow/);
  });

  it("deletes only owned sessions and journal after an explicit delete", async () => {
    const harness = makeHarness(makeWorkflow(), { ask: async () => answer("delete") });
    const result = await createArchiveController(harness.options).archive();
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.retention, "delete");
    assert.deepEqual(harness.calls.slice(-3), [
      "delete-session:leaf-1",
      "delete-session:leaf-2",
      "delete-journal:release-workflow",
    ]);
  });

  it("leaves resources untouched when the final atomic write fails", async () => {
    const harness = makeHarness(makeWorkflow(), {
      writer: {
        async writeAtomic(): Promise<{
          readonly wrote: false;
          readonly paths: ArchiveOptions["paths"];
          readonly reason: string;
        }> {
          harness.calls.push("write");
          return {
            wrote: false,
            reason: "disk full",
            paths: { workflowYaml: "/workflow.yaml", progressText: "/progress.txt", ganttText: "/gantt" },
          };
        },
      },
    });
    const result = await createArchiveController(harness.options).archive();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, "write-failed");
    assert.equal(harness.calls.some((call) => call.startsWith("archive-") || call.startsWith("delete-")), false);
  });

  it("rejects a concurrent archive while the first call owns the operation", async () => {
    const harness = makeHarness();
    let resolveAnswer: ((value: BrokerAnswer) => void) | undefined;
    const pending = new Promise<BrokerAnswer>((resolve) => { resolveAnswer = resolve; });
    const options: ArchiveOptions = {
      ...harness.options,
      ask: async (input) => {
        harness.calls.push("ask");
        harness.askInputs.push({
          question: input.question,
          ...(input.context === undefined ? {} : { context: input.context }),
        });
        return pending;
      },
    };
    const controller = createArchiveController(options);
    const first = controller.archive();
    const second = await controller.archive();
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.failure.code, "already-running");
    resolveAnswer?.(answer());
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
  });
});
