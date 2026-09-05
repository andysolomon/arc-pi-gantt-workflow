import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ModelProposalHook,
  NormalizeInput,
  QuestionEventEnvelope,
} from "@arc/workflow-core";
import {
  createModelProposalImporter,
  importModelProposal,
  MODEL_PROPOSAL_CONFIRM_LABEL,
  type ModelProposalImportResult,
} from "../src/index.ts";
import {
  createQuestionBroker,
  type AskOperatorInput,
  type BrokerAnswer,
  type BrokerJournal,
  type BrokerResult,
  type QuestionBroker,
} from "../src/questions/index.ts";

const UPDATED_AT = "2026-09-05T18:00:00.000Z";

function completeProposal(): NormalizeInput {
  return {
    form: "phased",
    slug: "proposal-test",
    repository: { id: "repo", path: "/tmp/repo" },
    groups: [
      {
        kind: "group",
        id: "phase",
        title: "Phase",
        items: [
          {
            kind: "leaf",
            id: "leaf-1",
            title: "Leaf one",
            outcome: "Ship one bounded change",
            scope: "Adapter importer only",
            acceptance_criteria: ["Focused tests pass"],
            dependencies: ["phase"],
            preserved_behavior: "Existing APIs remain stable",
          },
        ],
      },
    ],
  };
}

function answer(value: string, ledgerId = "ledger-1"): BrokerAnswer {
  return {
    ledger_id: ledgerId,
    created_at: "2026-09-05T18:00:01.000Z",
    question_type: "single_select",
    answer: value,
  };
}

function memoryJournal(): { journal: BrokerJournal; records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    journal: {
      async append(entry) {
        records.push(entry);
        return { id: `journal-${records.length}` };
      },
    },
  };
}

function shippedBroker(answers: readonly BrokerAnswer[]): {
  broker: QuestionBroker;
  calls: AskOperatorInput[];
  records: unknown[];
} {
  const queue = [...answers];
  const calls: AskOperatorInput[] = [];
  const { journal, records } = memoryJournal();
  const broker = createQuestionBroker({
    journal,
    ask: async (input) => {
      calls.push(input);
      const next = queue.shift();
      if (next === undefined) throw new Error("no answer queued");
      return next;
    },
  });
  return { broker, calls, records };
}

function fakeBroker(
  respond: (envelope: QuestionEventEnvelope, index: number) => BrokerResult | Promise<BrokerResult>,
): { broker: QuestionBroker; envelopes: QuestionEventEnvelope[] } {
  const envelopes: QuestionEventEnvelope[] = [];
  let closed = false;
  return {
    envelopes,
    broker: {
      get closed() {
        return closed;
      },
      get inflight() {
        return 0;
      },
      async ask(envelope) {
        envelopes.push(envelope);
        return respond(envelope, envelopes.length - 1);
      },
      close() {
        closed = true;
      },
    },
  };
}

function options(hook: ModelProposalHook, broker: QuestionBroker) {
  let question = 0;
  let event = 0;
  return {
    hook,
    broker,
    session_id: "proposal-session",
    updated_at: UPDATED_AT,
    now: () => new Date(UPDATED_AT),
    createQuestionId: () => `q-${++question}`,
    createEventId: () => `event-${++event}`,
  } as const;
}

function successfulBrokerResult(
  envelope: QuestionEventEnvelope,
  overrides: {
    answer?: string;
    ledgerId?: string;
    journalId?: string;
    usedDefault?: boolean;
    evidenceEnvelope?: QuestionEventEnvelope;
  } = {},
): BrokerResult {
  return {
    ok: true,
    resolution: {
      envelope: overrides.evidenceEnvelope ?? envelope,
      answer: answer(
        overrides.answer ?? MODEL_PROPOSAL_CONFIRM_LABEL,
        overrides.ledgerId ?? "ledger-1",
      ),
      journal_id: overrides.journalId ?? "journal-1",
      used_default: overrides.usedDefault ?? false,
    },
  };
}

function requireSuccess(result: ModelProposalImportResult) {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected successful proposal import");
  return result;
}

describe("model proposal hook boundary", () => {
  it("invokes the injected hook and promotes only after two brokered confirmations", async () => {
    let received = "";
    const hook: ModelProposalHook = async (markdown) => {
      received = markdown;
      return completeProposal();
    };
    const { broker, calls, records } = shippedBroker([
      answer("confirm", "ledger-dependencies"),
      answer("confirm", "ledger-parallel"),
    ]);

    const result = requireSuccess(
      await importModelProposal("# proposed plan", options(hook, broker)),
    );

    assert.equal(received, "# proposed plan");
    assert.equal(calls.length, 2);
    assert.equal(records.length, 2);
    assert.equal(result.leaves[0]!.ready, true);
    assert.equal(result.workflow.items[0]!.checkpoint.state, "planned");
    assert.equal(result.workflow.items[1]!.checkpoint.state, "ready");
    assert.equal(
      result.workflow.items[1]!.checkpoint.evidence_ref,
      "proposal-confirmations:journal-1:journal-2",
    );
  });

  it("reports a synchronous hook throw without asking", async () => {
    const hook = (() => {
      throw new Error("sync hook failure");
    }) as ModelProposalHook;
    const { broker, envelopes } = fakeBroker(() => {
      throw new Error("must not ask");
    });
    const result = await importModelProposal("plan", options(hook, broker));
    assert.deepStrictEqual(result, {
      ok: false,
      stage: "hook_invocation",
      message: "sync hook failure",
    });
    assert.equal(envelopes.length, 0);
  });

  it("reports a rejected hook without asking", async () => {
    const hook: ModelProposalHook = async () => {
      throw new Error("rejected proposal");
    };
    const { broker, envelopes } = fakeBroker(() => {
      throw new Error("must not ask");
    });
    const result = await importModelProposal("plan", options(hook, broker));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, "hook_rejection");
    assert.equal(envelopes.length, 0);
  });

  it("rejects a malformed proposal root before normalization", async () => {
    const hook = (async () => null) as unknown as ModelProposalHook;
    const { broker, envelopes } = fakeBroker(() => {
      throw new Error("must not ask");
    });
    const result = await importModelProposal("plan", options(hook, broker));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, "malformed_proposal");
    assert.equal(envelopes.length, 0);
  });

  it("contains normalization exceptions from nested untrusted values", async () => {
    const hook = (async () => ({
      form: "phased",
      slug: "proposal-test",
      repository: { id: "repo", path: "/tmp/repo" },
      groups: [null],
    })) as unknown as ModelProposalHook;
    const { broker } = fakeBroker(() => {
      throw new Error("must not ask");
    });
    const result = await importModelProposal("plan", options(hook, broker));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stage, "normalization");
  });

  it("rejects structurally invalid normalized output before asking", async () => {
    const proposal = completeProposal();
    assert.equal(proposal.form, "phased");
    const duplicate = {
      ...proposal,
      groups: [...proposal.groups, { ...proposal.groups[0] }],
    } as NormalizeInput;
    const hook: ModelProposalHook = async () => duplicate;
    const { broker, envelopes } = fakeBroker(() => {
      throw new Error("must not ask");
    });
    const result = await importModelProposal("plan", options(hook, broker));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "validation");
      assert.ok(result.diagnostics?.some((entry) => entry.code === "duplicate_id"));
    }
    assert.equal(envelopes.length, 0);
  });
});

describe("proposal confirmations fail closed", () => {
  it("leaves activation-incomplete work planned without asking", async () => {
    const proposal = completeProposal();
    assert.equal(proposal.form, "phased");
    const group = proposal.groups[0]!;
    assert.equal(group.kind, "group");
    const leaf = group.items[0]!;
    assert.equal(leaf.kind, "leaf");
    const hook: ModelProposalHook = async () => ({
      ...proposal,
      groups: [{ ...group, items: [{ ...leaf, outcome: "" }] }],
    });
    const { broker, envelopes } = fakeBroker(() => {
      throw new Error("must not ask");
    });
    const result = requireSuccess(await importModelProposal("plan", options(hook, broker)));
    assert.equal(result.leaves[0]!.activation_complete, false);
    assert.deepStrictEqual(result.leaves[0]!.missing_fields, ["outcome"]);
    assert.equal(result.leaves[0]!.dependencies.status, "not_asked");
    assert.equal(result.workflow.items[1]!.checkpoint.state, "planned");
    assert.equal(envelopes.length, 0);
  });

  it("canonicalizes omitted activation fields to an incomplete planned leaf", async () => {
    const proposal = completeProposal();
    assert.equal(proposal.form, "phased");
    const group = proposal.groups[0]!;
    assert.equal(group.kind, "group");
    const leaf = group.items[0]!;
    assert.equal(leaf.kind, "leaf");
    const incomplete = { ...leaf } as Record<string, unknown>;
    delete incomplete.outcome;
    delete incomplete.acceptance_criteria;
    const hook = (async () => ({
      ...proposal,
      groups: [{ ...group, items: [incomplete] }],
    })) as unknown as ModelProposalHook;
    const { broker, envelopes } = fakeBroker(() => {
      throw new Error("must not ask");
    });

    const result = requireSuccess(await importModelProposal("plan", options(hook, broker)));

    assert.deepStrictEqual(result.leaves[0]!.missing_fields, [
      "outcome",
      "acceptance_criteria",
    ]);
    const normalizedLeaf = result.workflow.items[1]!;
    assert.equal(normalizedLeaf.kind, "leaf");
    if (normalizedLeaf.kind === "leaf") {
      assert.equal(normalizedLeaf.outcome, "");
      assert.deepStrictEqual(normalizedLeaf.acceptance_criteria, []);
    }
    assert.equal(normalizedLeaf.checkpoint.state, "planned");
    assert.equal(envelopes.length, 0);
  });

  it("stops after explicit dependency denial", async () => {
    const { broker, calls } = shippedBroker([answer("reject")]);
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(calls.length, 1);
    assert.equal(result.leaves[0]!.dependencies.status, "denied");
    assert.equal(result.leaves[0]!.parallel_safety.status, "not_asked");
    assert.equal(result.workflow.items[1]!.checkpoint.state, "planned");
  });

  it("keeps the leaf planned after parallel-safety denial", async () => {
    const { broker, calls } = shippedBroker([answer("confirm"), answer("reject")]);
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(calls.length, 2);
    assert.equal(result.leaves[0]!.dependencies.status, "confirmed");
    assert.equal(result.leaves[0]!.parallel_safety.status, "denied");
    assert.equal(result.workflow.items[1]!.checkpoint.state, "planned");
  });

  it("contains broker rejection and stops the confirmation chain", async () => {
    const { broker, envelopes } = fakeBroker(async () => {
      throw new Error("operator channel unavailable");
    });
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(envelopes.length, 1);
    assert.equal(result.leaves[0]!.dependencies.status, "broker_failure");
    assert.equal(result.leaves[0]!.parallel_safety.status, "not_asked");
  });

  it("rejects a broker failure result", async () => {
    const { broker } = fakeBroker(() => ({
      ok: false,
      reason: { code: "closed", message: "broker is closed" },
    }));
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(result.leaves[0]!.dependencies.status, "broker_failure");
    assert.equal(result.leaves[0]!.dependencies.broker_code, "closed");
  });

  it("rejects an affirmative defaulted answer", async () => {
    const { broker } = fakeBroker((envelope) =>
      successfulBrokerResult(envelope, { usedDefault: true }),
    );
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(result.leaves[0]!.dependencies.status, "defaulted_answer");
    assert.equal(result.workflow.items[1]!.checkpoint.state, "planned");
  });

  it("rejects an unknown answer even when evidence is present", async () => {
    const { broker } = fakeBroker((envelope) =>
      successfulBrokerResult(envelope, { answer: "probably" }),
    );
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(result.leaves[0]!.dependencies.status, "unknown_answer");
  });

  it("rejects confirmation with missing journal evidence", async () => {
    const { broker } = fakeBroker((envelope) =>
      successfulBrokerResult(envelope, { journalId: "" }),
    );
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(result.leaves[0]!.dependencies.status, "missing_evidence");
  });

  it("rejects evidence whose envelope provenance does not match", async () => {
    const { broker } = fakeBroker((envelope) =>
      successfulBrokerResult(envelope, {
        evidenceEnvelope: {
          ...envelope,
          provenance: { ...envelope.provenance, source: "other-source" },
        },
      }),
    );
    const result = requireSuccess(
      await importModelProposal("plan", options(async () => completeProposal(), broker)),
    );
    assert.equal(result.leaves[0]!.dependencies.status, "missing_evidence");
  });
});

describe("question ordering and provenance", () => {
  it("asks dependencies before parallel safety with mandatory gate provenance", async () => {
    const { broker, envelopes } = fakeBroker((envelope, index) =>
      successfulBrokerResult(envelope, {
        ledgerId: `ledger-${index + 1}`,
        journalId: `journal-${index + 1}`,
      }),
    );
    const importer = createModelProposalImporter(
      options(async () => completeProposal(), broker),
    );
    const result = requireSuccess(await importer.import("plan"));

    assert.deepStrictEqual(
      envelopes.map((envelope) => envelope.payload.question_id),
      ["q-1", "q-2"],
    );
    assert.match(envelopes[0]!.payload.text, /declared dependencies/);
    assert.match(envelopes[1]!.payload.text, /safe to run in parallel/);
    for (const envelope of envelopes) {
      assert.equal(envelope.envelope_version, "1.0.0");
      assert.equal(envelope.workflow_slug, "proposal-test");
      assert.equal(envelope.item_id, "leaf-1");
      assert.equal(envelope.session_id, "proposal-session");
      assert.equal(envelope.payload.gate, "implement");
      assert.equal(envelope.payload.default_on_timeout, undefined);
      assert.deepStrictEqual(envelope.provenance, {
        source: "model-proposal-importer",
        broker: "arc-pi-adapter",
      });
    }
    assert.equal(result.leaves[0]!.ready, true);
    assert.equal(result.leaves[0]!.dependencies.ledger_id, "ledger-1");
    assert.equal(result.leaves[0]!.parallel_safety.ledger_id, "ledger-2");
  });
});
