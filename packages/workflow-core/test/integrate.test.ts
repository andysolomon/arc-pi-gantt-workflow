import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createIntegrator,
  type GitAutoResolvePort,
  type GitCherryPickPort,
  type GitCommitPort,
  type GitResetPort,
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
  integrationVerify: GitVerifyPort & { readonly calls: string[] };
  commit: GitCommitPort & { readonly calls: Array<{ worktreePath: string; subject: string }> };
  cherryPick: GitCherryPickPort & {
    readonly calls: Array<{ commitRef: string; integrationBranch: string; repositoryRoot: string; worktreePath: string }>;
  };
  autoResolve: GitAutoResolvePort & {
    readonly calls: Array<{
      repositoryRoot: string;
      strategy: "theirs" | "ours" | "rerere";
      conflictedFiles: readonly string[];
      attempt: number;
    }>;
  };
  reset: GitResetPort & { readonly calls: string[] };
}

function makeFakeGit(overrides?: {
  readonly verify?: (path: string) => Promise<{ ok: boolean; result: { exit_code: number; stdout: string; stderr: string } }>;
  readonly integrationVerify?: (path: string) => Promise<{ ok: boolean; result: { exit_code: number; stdout: string; stderr: string } }>;
  readonly commit?: (path: string, subject: string) => Promise<{ hash: string }>;
  readonly cherryPick?: (opts: {
    commitRef: string;
    integrationBranch: string;
    repositoryRoot: string;
    worktreePath: string;
  }) => Promise<{
    ok: boolean;
    result: { exit_code: number; stdout: string; stderr: string };
    conflictedFiles?: readonly string[];
  }>;
  readonly autoResolve?: GitAutoResolvePort["autoResolve"];
  readonly reset?: GitResetPort["reset"];
}): FakeGit {
  const verifyCalls: string[] = [];
  const integrationVerifyCalls: string[] = [];
  const commitCalls: Array<{ worktreePath: string; subject: string }> = [];
  const cherryCalls: Array<{ commitRef: string; integrationBranch: string; repositoryRoot: string; worktreePath: string }> = [];
  const autoResolveCalls: Array<{
    repositoryRoot: string;
    strategy: "theirs" | "ours" | "rerere";
    conflictedFiles: readonly string[];
    attempt: number;
  }> = [];
  const resetCalls: string[] = [];
  const verifyImpl = overrides?.verify ?? (async () => ({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } }));
  const integrationVerifyImpl = overrides?.integrationVerify ?? (async () => ({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } }));
  const commitImpl = overrides?.commit ?? (async (_path: string, _subject: string) => ({ hash: "deadbeef0001" }));
  const cherryImpl = overrides?.cherryPick ?? (async () => ({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } }));
  const autoResolveImpl = overrides?.autoResolve ?? (async () => ({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } }));
  const resetImpl = overrides?.reset ?? (async () => ({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } }));
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
    integrationVerify: {
      async verify(repositoryRoot) {
        integrationVerifyCalls.push(repositoryRoot);
        return integrationVerifyImpl(repositoryRoot);
      },
      get calls() {
        return integrationVerifyCalls;
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
    autoResolve: {
      async autoResolve(opts) {
        autoResolveCalls.push(opts);
        return autoResolveImpl(opts);
      },
      get calls() {
        return autoResolveCalls;
      },
    },
    reset: {
      async reset(repositoryRoot) {
        resetCalls.push(repositoryRoot);
        return resetImpl(repositoryRoot);
      },
      get calls() {
        return resetCalls;
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
    assert.deepEqual(git.autoResolve.calls, []);
    assert.deepEqual(git.reset.calls, []);
    assert.deepEqual(git.verify.calls, ["/repo/.arc/worktrees/gantt-workflow/4.2"]);
    assert.deepEqual(git.integrationVerify.calls, []);
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
  test("Phase 4.2 conflict now fails closed in auto_resolve with needsReplan", async () => {
    const git = makeFakeGit({
      cherryPick: async () => ({
        ok: false,
        result: { exit_code: 1, stdout: "", stderr: "conflict" },
        conflictedFiles: ["src/a.ts"],
      }),
    });
    const asker = makeAsker({ result: approvedOutcome() });
    const integrator = createIntegrator(makeOptions({ git, asker }));
    const result = await integrator.run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "auto_resolve");
    assert.equal(result.needsReplan, true);
    assert.ok(result.failure);
    if (result.failure && result.failure.phase === "auto_resolve") {
      assert.equal(result.failure.reason, "auto_resolve_exhausted");
      assert.equal(result.failure.stderr, "conflict");
    }
    assert.equal(result.cherryPicked, undefined);
  });
});

// ---------------------------------------------------------------------------
// Conflict resolution and integration verification
// ---------------------------------------------------------------------------

describe("integrator.autoResolve", () => {
  test("resolved conflict passes full checks in the integration checkout", async () => {
    let cherryAttempts = 0;
    const git = makeFakeGit({
      integrationVerify: async (path) => ({
        ok: true,
        result: { exit_code: 0, stdout: path, stderr: "" },
      }),
      cherryPick: async () => {
        cherryAttempts += 1;
        return cherryAttempts === 1
          ? {
              ok: false,
              result: { exit_code: 1, stdout: "", stderr: "conflict" },
              conflictedFiles: ["src/a.ts"],
            }
          : { ok: true, result: { exit_code: 0, stdout: "", stderr: "" } };
      },
    });
    const result = await createIntegrator(makeOptions({ git })).run();
    assert.equal(result.ok, true);
    assert.equal(result.phase, "verify_integration");
    assert.deepEqual(result.cherryPicked, { branch: "main", commitRef: "deadbeef0001" });
    assert.deepEqual(result.integrationVerified, { ok: true, exit_code: 0, reverted: false });
    assert.deepEqual(result.conflict?.conflictedFiles, ["src/a.ts"]);
    assert.equal(result.reverted, false);
    assert.deepEqual(git.verify.calls, ["/repo/.arc/worktrees/gantt-workflow/4.2"]);
    assert.deepEqual(git.integrationVerify.calls, ["/repo"]);
    assert.equal(git.autoResolve.calls[0]?.strategy, "theirs");
    assert.deepEqual(git.reset.calls, []);
  });

  test("exhausted retries reset and request replanning", async () => {
    const git = makeFakeGit({
      cherryPick: async () => ({
        ok: false,
        result: { exit_code: 1, stdout: "", stderr: "still conflicted" },
        conflictedFiles: ["src/a.ts", "src/b.ts"],
      }),
    });
    const result = await createIntegrator(makeOptions({ git })).run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "auto_resolve");
    assert.equal(result.failure?.reason, "auto_resolve_exhausted");
    assert.equal(result.needsReplan, true);
    assert.equal(result.reverted, true);
    assert.equal(result.conflict?.attempts, 2);
    assert.equal(result.conflict?.maxAttempts, 2);
    assert.equal(git.autoResolve.calls.length, 2);
    assert.deepEqual(git.reset.calls, ["/repo"]);
  });

  test("failed integration checks reset the cherry-pick and preserve conflict evidence", async () => {
    let cherryAttempts = 0;
    const git = makeFakeGit({
      integrationVerify: async () => ({
        ok: false,
        result: { exit_code: 1, stdout: "", stderr: "full checks failed" },
      }),
      cherryPick: async () => {
        cherryAttempts += 1;
        return cherryAttempts === 1
          ? {
              ok: false,
              result: { exit_code: 1, stdout: "", stderr: "conflict" },
              conflictedFiles: ["src/a.ts"],
            }
          : { ok: true, result: { exit_code: 0, stdout: "", stderr: "" } };
      },
    });
    const result = await createIntegrator(makeOptions({ git })).run();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "verify_integration");
    assert.equal(result.failure?.reason, "checks_failed");
    assert.equal(result.needsReplan, true);
    assert.equal(result.reverted, true);
    assert.deepEqual(result.conflict?.conflictedFiles, ["src/a.ts"]);
    assert.deepEqual(result.integrationVerified, { ok: false, exit_code: 1, reverted: true });
  });

  test("strategy off disables resolution and still resets", async () => {
    const git = makeFakeGit({
      cherryPick: async () => ({
        ok: false,
        result: { exit_code: 1, stdout: "", stderr: "conflict" },
        conflictedFiles: ["src/a.ts"],
      }),
    });
    const options = makeOptions({ git });
    const result = await createIntegrator({
      ...options,
      integration: { ...options.integration!, auto_resolve: { strategy: "off" } },
    }).run();
    assert.equal(result.phase, "auto_resolve");
    assert.equal(result.failure?.reason, "auto_resolve_disabled");
    assert.equal(result.needsReplan, true);
    assert.deepEqual(git.autoResolve.calls, []);
    assert.deepEqual(git.reset.calls, ["/repo"]);
  });

  test("zero maxAttempts disables resolution", async () => {
    const git = makeFakeGit({
      cherryPick: async () => ({
        ok: false,
        result: { exit_code: 1, stdout: "", stderr: "conflict" },
      }),
    });
    const options = makeOptions({ git });
    const result = await createIntegrator({
      ...options,
      integration: { ...options.integration!, auto_resolve: { maxAttempts: 0 } },
    }).run();
    assert.equal(result.failure?.reason, "auto_resolve_disabled");
    assert.equal(result.conflict?.attempts, 0);
    assert.deepEqual(git.autoResolve.calls, []);
  });

  for (const strategy of ["ours", "rerere"] as const) {
    test(`records ${strategy} strategy on the resolution port`, async () => {
      let cherryAttempts = 0;
      const git = makeFakeGit({
        cherryPick: async () => {
          cherryAttempts += 1;
          return cherryAttempts === 1
            ? {
                ok: false,
                result: { exit_code: 1, stdout: "", stderr: "conflict" },
                conflictedFiles: ["src/a.ts"],
              }
            : { ok: true, result: { exit_code: 0, stdout: "", stderr: "" } };
        },
      });
      const options = makeOptions({ git });
      await createIntegrator({
        ...options,
        integration: { ...options.integration!, auto_resolve: { strategy } },
      }).run();
      assert.equal(git.autoResolve.calls[0]?.strategy, strategy);
    });
  }

  test("reset failure overrides checks failure and reports stderr", async () => {
    let cherryAttempts = 0;
    const git = makeFakeGit({
      integrationVerify: async () => ({
        ok: false,
        result: { exit_code: 1, stdout: "", stderr: "checks failed" },
      }),
      cherryPick: async () => {
        cherryAttempts += 1;
        return cherryAttempts === 1
          ? { ok: false, result: { exit_code: 1, stdout: "", stderr: "conflict" } }
          : { ok: true, result: { exit_code: 0, stdout: "", stderr: "" } };
      },
      reset: async () => ({
        ok: false,
        result: { exit_code: 128, stdout: "", stderr: "reset denied" },
      }),
    });
    const result = await createIntegrator(makeOptions({ git })).run();
    assert.equal(result.phase, "verify_integration");
    assert.equal(result.failure?.reason, "reset_failed");
    assert.ok(result.failure?.phase === "verify_integration");
    assert.equal(result.failure.stderr, "reset denied");
    assert.equal(result.reverted, false);
    assert.equal(result.integrationVerified?.reverted, false);
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

  test("rejects invalid auto-resolve strategies", () => {
    const options = makeOptions();
    assert.throws(
      () => createIntegrator({
        ...options,
        integration: {
          ...options.integration!,
          auto_resolve: { strategy: "union" as "theirs" },
        },
      }),
      /strategy is invalid/,
    );
  });

  for (const maxAttempts of [-1, 1.5, 3]) {
    test(`rejects invalid maxAttempts=${maxAttempts}`, () => {
      const options = makeOptions();
      assert.throws(
        () => createIntegrator({
          ...options,
          integration: { ...options.integration!, auto_resolve: { maxAttempts } },
        }),
        /must be an integer/,
      );
    });
  }
});
