import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createIntegrator,
  type GitCherryPickPort,
  type GitCommitPort,
  type GitVerifyPort,
  type IntegrateAskerOutcome,
  type IntegrateAskerPort,
  type IntegrateOptions,
} from "../src/integrate/index.ts";
import { EVENT_ENVELOPE_VERSION, type QuestionEventEnvelope } from "@arc/workflow-core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeGit {
  verify: GitVerifyPort & { readonly calls: string[] };
  commit: GitCommitPort & { readonly calls: Array<{ worktreePath: string; subject: string }> };
  cherryPick: GitCherryPickPort & {
    readonly calls: Array<{ commitRef: string; integrationBranch: string; repositoryRoot: string; worktreePath: string }>;
  };
}

function makeFakeGit(overrides?: {
  readonly verify?: (path: string) => Promise<{ ok: boolean; result: { exit_code: number; stdout: string; stderr: string } }>;
  readonly commit?: (path: string, subject: string) => Promise<{ hash: string }>;
  readonly cherryPick?: (opts: {
    commitRef: string;
    integrationBranch: string;
    repositoryRoot: string;
    worktreePath: string;
  }) => Promise<{ ok: boolean; result: { exit_code: number; stdout: string; stderr: string } }>;
}): FakeGit {
  const verifyCalls: string[] = [];
  const commitCalls: Array<{ worktreePath: string; subject: string }> = [];
  const cherryCalls: Array<{ commitRef: string; integrationBranch: string; repositoryRoot: string; worktreePath: string }> = [];
  const verifyImpl = overrides?.verify ?? (async () => ({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } }));
  const commitImpl = overrides?.commit ?? (async (_path: string, _subject: string) => ({ hash: "deadbeef0001" }));
  const cherryImpl = overrides?.cherryPick ?? (async () => ({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } }));
  return {
    verify: {
      async verify(worktreePath) {
        verifyCalls.push(worktreePath);
        return verifyImpl(worktreePath);
      },
      get calls() {
        return verifyCalls;
      },
    },
    commit: {
      async commit(worktreePath, subject) {
        commitCalls.push({ worktreePath, subject });
        return commitImpl(worktreePath, subject);
      },
      get calls() {
        return commitCalls;
      },
    },
    cherryPick: {
      async cherryPick(opts) {
        cherryCalls.push(opts);
        return cherryImpl(opts);
      },
      get calls() {
        return cherryCalls;
      },
    },
  };
}

function makeAsker(options: {
  readonly result: IntegrateAskerOutcome;
  readonly record?: (envelope: QuestionEventEnvelope) => void;
}): IntegrateAskerPort & { readonly calls: QuestionEventEnvelope[] } {
  const calls: QuestionEventEnvelope[] = [];
  return {
    get calls() {
      return calls;
    },
    async ask(envelope) {
      calls.push(envelope);
      options.record?.(envelope);
      return options.result;
    },
  };
}

function approvedOutcome(overrides?: { readonly journalId?: string; readonly envelopeId?: string }): Extract<IntegrateAskerOutcome, { ok: true }> {
  const base: Extract<IntegrateAskerOutcome, { ok: true }> = {
    ok: true,
    envelopeId: overrides?.envelopeId ?? "01HZQR0AQ5T7W9J3G2Y4X8V6NB",
    journalId: overrides?.journalId ?? "j-1",
    approved: true,
    answer: "cherry-pick",
    usedDefault: false,
  };
  return base;
}

function deniedOutcome(): Extract<IntegrateAskerOutcome, { ok: true }> {
  const base: Extract<IntegrateAskerOutcome, { ok: true }> = {
    ok: true,
    envelopeId: "01HZQR0AQ5T7W9J3G2Y4X8V6NB",
    journalId: "j-1",
    approved: false,
    answer: "skip",
    usedDefault: false,
  };
  return base;
}

function brokerFailureOutcome(code: string, message: string): IntegrateAskerOutcome {
  return { ok: false, brokerCode: code, brokerMessage: message };
}

function makeOptions(overrides?: {
  readonly git?: FakeGit;
  readonly asker?: IntegrateAskerPort;
}): IntegrateOptions {
  return {
    workflowSlug: "gantt-workflow",
    itemId: "4.2",
    sessionId: "session-1",
    worktreePath: "/repo/.arc/worktrees/gantt-workflow/4.2",
    repositoryRoot: "/repo",
    integrationBranch: "main",
    commitSubject: "feat(wf): integrate phase 4.2",
    git: overrides?.git ?? makeFakeGit(),
    asker: overrides?.asker ?? makeAsker({ result: approvedOutcome() }),
    integration: {
      question: "Cherry-pick?",
      cherryPickDescription: "Cherry-pick the commit into main.",
      skipDescription: "Skip and leave the worktree as-is.",
    },
    now: () => new Date("2026-09-04T20:00:00.000Z"),
  };
}

// ---------------------------------------------------------------------------
// Verification short-circuits the pipeline
// ---------------------------------------------------------------------------

describe("integrator.verify", () => {
  test("verify failure skips commit, ask, and cherry-pick", async () => {
    const git = makeFakeGit({
      verify: async () => ({ ok: false, result: { exit_code: 1, stdout: "", stderr: "tests failed" } }),
    });
    const asker = makeAsker({ result: approvedOutcome() });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "verify");
    assert.equal(result.verify.ok, false);
    assert.equal(result.verify.exit_code, 1);
    assert.equal(result.commit, undefined);
    assert.equal(result.integration, undefined);
    assert.equal(result.cherryPicked, undefined);
    assert.ok(result.failure);
    if (result.failure && result.failure.phase === "verify") {
      assert.equal(result.failure.stderr, "tests failed");
    }
    assert.deepEqual(git.commit.calls, []);
    assert.deepEqual(git.cherryPick.calls, []);
    assert.deepEqual(asker.calls, []);
  });

  test("verify success with non-zero exit code but ok=false is treated as failure", async () => {
    const git = makeFakeGit({
      verify: async () => ({ ok: false, result: { exit_code: 2, stdout: "out", stderr: "err" } }),
    });
    const integrator = createIntegrator(makeOptions({ git }));
    const result = await integrator.run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "verify");
    assert.equal(result.verify.exit_code, 2);
  });
});

// ---------------------------------------------------------------------------
// Commit failures
// ---------------------------------------------------------------------------

describe("integrator.commit", () => {
  test("commit exception skips ask and cherry-pick", async () => {
    const git = makeFakeGit({
      commit: async () => {
        throw new Error("git commit failed");
      },
    });
    const asker = makeAsker({ result: approvedOutcome() });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "commit");
    assert.equal(result.verify.ok, true);
    assert.equal(result.commit, undefined);
    assert.ok(result.failure);
    if (result.failure && result.failure.phase === "commit") {
      assert.equal(result.failure.reason, "git commit failed");
    }
    assert.deepEqual(asker.calls, []);
    assert.deepEqual(git.cherryPick.calls, []);
  });
});

// ---------------------------------------------------------------------------
// Ask gating
// ---------------------------------------------------------------------------

describe("integrator.ask", () => {
  test("non-affirmative answer returns ok=true with no cherry-pick", async () => {
    const git = makeFakeGit();
    const asker = makeAsker({ result: deniedOutcome() });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, true);
    assert.equal(result.phase, "ask");
    assert.equal(result.verify.ok, true);
    assert.ok(result.commit);
    assert.ok(result.integration);
    assert.equal(result.integration!.approved, false);
    assert.equal(result.integration!.answer, "skip");
    assert.equal(result.integration!.envelopeId, "01HZQR0AQ5T7W9J3G2Y4X8V6NB");
    assert.equal(result.integration!.journalId, "j-1");
    assert.deepEqual(git.cherryPick.calls, []);
  });

  test("broker failure short-circuits before cherry-pick", async () => {
    const git = makeFakeGit();
    const asker = makeAsker({
      result: brokerFailureOutcome("invalid_timeout", "ask timed out"),
    });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "ask");
    assert.ok(result.commit);
    assert.ok(result.failure);
    if (result.failure && result.failure.phase === "ask") {
      assert.equal(result.failure.reason, "broker_failure");
      assert.equal(result.failure.brokerCode, "invalid_timeout");
      assert.equal(result.failure.brokerMessage, "ask timed out");
    }
    assert.deepEqual(git.cherryPick.calls, []);
  });

  test("affirmative answer triggers cherry-pick with the local commit hash", async () => {
    const git = makeFakeGit({
      commit: async () => ({ hash: "feedface1234" }),
    });
    const asker = makeAsker({ result: approvedOutcome({ journalId: "j-ok" }) });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, true);
    assert.equal(result.phase, "cherry_pick");
    assert.equal(result.verify.ok, true);
    assert.equal(result.commit?.hash, "feedface1234");
    assert.ok(result.integration);
    assert.equal(result.integration!.approved, true);
    assert.equal(result.integration!.answer, "cherry-pick");
    assert.equal(result.integration!.journalId, "j-ok");
    assert.ok(result.cherryPicked);
    assert.equal(result.cherryPicked!.branch, "main");
    assert.equal(result.cherryPicked!.commitRef, "feedface1234");
    assert.deepEqual(git.cherryPick.calls, [
      {
        commitRef: "feedface1234",
        integrationBranch: "main",
        repositoryRoot: "/repo",
        worktreePath: "/repo/.arc/worktrees/gantt-workflow/4.2",
      },
    ]);
  });

  test("integration question envelope carries gate=integration and the v1 contract", async () => {
    const git = makeFakeGit();
    let captured: QuestionEventEnvelope | undefined;
    const asker = makeAsker({
      result: deniedOutcome(),
      record: (e) => { captured = e; },
    });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    await integrator.run();
    assert.ok(captured);
    assert.equal(captured!.envelope_version, EVENT_ENVELOPE_VERSION);
    assert.equal(captured!.kind, "question");
    assert.equal(captured!.workflow_slug, "gantt-workflow");
    assert.equal(captured!.item_id, "4.2");
    assert.equal(captured!.session_id, "session-1");
    assert.equal(captured!.payload.gate, "integration");
    assert.deepEqual(
      captured!.payload.options.map((o) => o.label),
      ["cherry-pick", "skip"],
    );
    assert.ok(captured!.payload.question_id.length > 0);
  });

  test("used_default=true on a mandatory gate is still treated as approved only when label matches", async () => {
    // Mandatory gates never auto-default per broker contract, but if the
    // broker somehow returned used_default=true we must still check the
    // label. This guards against future broker regressions.
    const git = makeFakeGit();
    const asker = makeAsker({
      result: {
        ok: true,
        envelopeId: "01HZQR0AQ5T7W9J3G2Y4X8V6NB",
        journalId: "j-defaulted",
        approved: false,
        answer: "skip",
        usedDefault: true,
      },
    });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, true);
    assert.equal(result.phase, "ask");
    assert.equal(result.integration!.approved, false);
    assert.equal(result.integration!.usedDefault, true);
    assert.deepEqual(git.cherryPick.calls, []);
  });
});

// ---------------------------------------------------------------------------
// Cherry-pick failures
// ---------------------------------------------------------------------------

describe("integrator.cherryPick", () => {
  test("cherry-pick failure returns ok=false with phase=cherry_pick", async () => {
    const git = makeFakeGit({
      cherryPick: async () => ({ ok: false, result: { exit_code: 1, stdout: "", stderr: "conflict" } }),
    });
    const asker = makeAsker({ result: approvedOutcome() });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "cherry_pick");
    assert.ok(result.failure);
    if (result.failure && result.failure.phase === "cherry_pick") {
      assert.equal(result.failure.reason, "cherry-pick failed");
      assert.equal(result.failure.stderr, "conflict");
    }
    assert.equal(result.cherryPicked, undefined);
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("createIntegrator validates inputs", () => {
  test("rejects relative worktree paths", () => {
    assert.throws(
      () =>
        createIntegrator({
          ...makeOptions(),
          worktreePath: "relative/path",
        }),
      /absolute path/,
    );
  });

  test("rejects empty commit subjects", () => {
    assert.throws(
      () =>
        createIntegrator({
          ...makeOptions(),
          commitSubject: "",
        }),
      /1\.\.200/,
    );
  });

  test("rejects invalid workflow slugs", () => {
    assert.throws(
      () =>
        createIntegrator({
          ...makeOptions(),
          workflowSlug: "BAD/SLUG",
        }),
      /workflow slug/,
    );
  });

  test("rejects missing git ports", () => {
    assert.throws(
      () =>
        createIntegrator({
          ...makeOptions(),
          git: undefined as unknown as IntegrateOptions["git"],
        }),
      /git ports/,
    );
  });

  test("rejects missing asker port", () => {
    assert.throws(
      () =>
        createIntegrator({
          ...makeOptions(),
          asker: undefined as unknown as IntegrateAskerPort,
        }),
      /asker/,
    );
  });
});
