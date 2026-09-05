import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createIntegratorAdapter,
  makeBrokerAsker,
  makeProcessAutoResolvePort,
  makeProcessCherryPickPort,
  makeProcessCommitPort,
  makeProcessResetPort,
  makeProcessVerifyPort,
  type GitExecResult,
  type ProcessInvoker,
} from "../src/integrate/index.ts";
import {
  createQuestionBroker,
  EVENT_ENVELOPE_VERSION,
  type AskOperatorInput,
  type BrokerAnswer,
  type BrokerJournal,
  type QuestionBroker,
  type QuestionEventEnvelope,
} from "../src/questions/index.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeJournal(): BrokerJournal & { readonly records: Array<{ kind: string; itemId?: string; sessionId?: string; data?: unknown }> } {
  const records: Array<{ kind: string; itemId?: string; sessionId?: string; data?: unknown }> = [];
  let counter = 0;
  return {
    records,
    async append(entry) {
      records.push({ ...entry });
      counter += 1;
      return { id: `j-${counter}` };
    },
  };
}

function makeFakeInvoker(
  responses: ReadonlyMap<string, GitExecResult>,
): ProcessInvoker & { readonly calls: Array<{ program: string; args: readonly string[]; cwd: string }> } {
  const calls: Array<{ program: string; args: readonly string[]; cwd: string }> = [];
  return {
    get calls() {
      return calls;
    },
    run(program, args, options) {
      const key = `${program} ${args.join(" ")}`;
      calls.push({ program, args, cwd: options.cwd });
      const response = responses.get(key);
      if (response === undefined) {
        return { exit_code: 127, stdout: "", stderr: `no fake response for ${key}` };
      }
      return response;
    },
  };
}

function makeAnswer(overrides: Partial<BrokerAnswer>): BrokerAnswer {
  return {
    ledger_id: "ledger-1",
    created_at: "2026-09-04T20:00:01.000Z",
    question_type: "single_select",
    answer: "cherry-pick",
    ...overrides,
  };
}

function makeAsker(answer: BrokerAnswer): (input: AskOperatorInput) => Promise<BrokerAnswer> {
  return async (_input: AskOperatorInput) => answer;
}

// ---------------------------------------------------------------------------
// makeProcessVerifyPort
// ---------------------------------------------------------------------------

describe("makeProcessVerifyPort", () => {
  test("ok=true when the verify command exits 0", async () => {
    const invoker = makeFakeInvoker(
      new Map([["npm test", { exit_code: 0, stdout: "ok", stderr: "" }]]),
    );
    const port = makeProcessVerifyPort(invoker, ["npm", "test"]);
    const result = await port.verify("/worktree");
    assert.equal(result.ok, true);
    assert.equal(result.result.exit_code, 0);
    assert.equal(result.result.stdout, "ok");
    assert.deepEqual(invoker.calls, [{ program: "npm", args: ["test"], cwd: "/worktree" }]);
  });

  test("ok=false when the verify command exits non-zero", async () => {
    const invoker = makeFakeInvoker(
      new Map([["npm test", { exit_code: 1, stdout: "", stderr: "1 failing" }]]),
    );
    const port = makeProcessVerifyPort(invoker, ["npm", "test"]);
    const result = await port.verify("/worktree");
    assert.equal(result.ok, false);
    assert.equal(result.result.exit_code, 1);
    assert.equal(result.result.stderr, "1 failing");
  });
});

// ---------------------------------------------------------------------------
// makeProcessCommitPort
// ---------------------------------------------------------------------------

describe("makeProcessCommitPort", () => {
  test("runs git add --all, git commit, and git rev-parse", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["git add --all", { exit_code: 0, stdout: "", stderr: "" }],
        ["git commit --no-verify -m feat: hello", { exit_code: 0, stdout: "", stderr: "" }],
        ["git rev-parse HEAD", { exit_code: 0, stdout: "abcdef1234567890\n", stderr: "" }],
      ]),
    );
    const port = makeProcessCommitPort(invoker);
    const result = await port.commit("/worktree", "feat: hello");
    assert.equal(result.hash, "abcdef1234567890");
    assert.deepEqual(invoker.calls.map((c) => `${c.program} ${c.args.join(" ")}`), [
      "git add --all",
      "git commit --no-verify -m feat: hello",
      "git rev-parse HEAD",
    ]);
  });

  test("throws when git add fails", async () => {
    const invoker = makeFakeInvoker(
      new Map([["git add --all", { exit_code: 128, stdout: "", stderr: "fatal: not a git repo" }]]),
    );
    const port = makeProcessCommitPort(invoker);
    await assert.rejects(port.commit("/worktree", "feat: hi"), /git add failed/);
  });

  test("throws when git commit fails", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["git add --all", { exit_code: 0, stdout: "", stderr: "" }],
        [
          "git commit --no-verify -m feat: hi",
          { exit_code: 1, stdout: "", stderr: "nothing to commit" },
        ],
      ]),
    );
    const port = makeProcessCommitPort(invoker);
    await assert.rejects(port.commit("/worktree", "feat: hi"), /git commit failed/);
  });
});

// ---------------------------------------------------------------------------
// makeProcessCherryPickPort
// ---------------------------------------------------------------------------

describe("makeProcessCherryPickPort", () => {
  test("ok=true when cherry-pick + commit succeed", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["git -C /repo cherry-pick --no-commit feedface", { exit_code: 0, stdout: "", stderr: "" }],
        [
          "git -C /repo commit --no-verify -m Integrate feedface into main",
          { exit_code: 0, stdout: "", stderr: "" },
        ],
      ]),
    );
    const port = makeProcessCherryPickPort(invoker);
    const result = await port.cherryPick({
      commitRef: "feedface",
      integrationBranch: "main",
      repositoryRoot: "/repo",
      worktreePath: "/worktree",
    });
    assert.equal(result.ok, true);
    assert.equal(result.result.exit_code, 0);
  });

  test("ok=false when cherry-pick conflicts", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        [
          "git -C /repo cherry-pick --no-commit feedface",
          { exit_code: 1, stdout: "", stderr: "CONFLICT" },
        ],
        [
          "git -C /repo diff --name-only --diff-filter=U",
          { exit_code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" },
        ],
      ]),
    );
    const port = makeProcessCherryPickPort(invoker);
    const result = await port.cherryPick({
      commitRef: "feedface",
      integrationBranch: "main",
      repositoryRoot: "/repo",
      worktreePath: "/worktree",
    });
    assert.equal(result.ok, false);
    assert.equal(result.result.exit_code, 1);
    assert.equal(result.result.stderr, "CONFLICT");
    assert.deepEqual(result.conflictedFiles, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(invoker.calls.map((call) => `${call.program} ${call.args.join(" ")}`), [
      "git -C /repo cherry-pick --no-commit feedface",
      "git -C /repo diff --name-only --diff-filter=U",
    ]);
  });

  test("ok=false when cherry-pick applies but follow-up commit fails", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["git -C /repo cherry-pick --no-commit feedface", { exit_code: 0, stdout: "", stderr: "" }],
        [
          "git -C /repo commit --no-verify -m Integrate feedface into main",
          { exit_code: 1, stdout: "", stderr: "hook denied" },
        ],
      ]),
    );
    const port = makeProcessCherryPickPort(invoker);
    const result = await port.cherryPick({
      commitRef: "feedface",
      integrationBranch: "main",
      repositoryRoot: "/repo",
      worktreePath: "/worktree",
    });
    assert.equal(result.ok, false);
    assert.equal(result.result.exit_code, 1);
    assert.equal(result.result.stderr, "hook denied");
  });
});

// ---------------------------------------------------------------------------
// makeProcessAutoResolvePort / makeProcessResetPort
// ---------------------------------------------------------------------------

describe("makeProcessAutoResolvePort", () => {
  for (const strategy of ["theirs", "ours"] as const) {
    test(`runs checkout --${strategy} and git add for conflicted files`, async () => {
      const invoker = makeFakeInvoker(
        new Map<string, GitExecResult>([
          [
            `git -C /repo checkout --${strategy} -- src/a.ts src/b.ts`,
            { exit_code: 0, stdout: "", stderr: "" },
          ],
          [
            "git -C /repo add -- src/a.ts src/b.ts",
            { exit_code: 0, stdout: "", stderr: "" },
          ],
        ]),
      );
      const result = await makeProcessAutoResolvePort(invoker).autoResolve({
        repositoryRoot: "/repo",
        strategy,
        conflictedFiles: ["src/a.ts", "src/b.ts"],
        attempt: 1,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(invoker.calls.map((call) => `${call.program} ${call.args.join(" ")}`), [
        `git -C /repo checkout --${strategy} -- src/a.ts src/b.ts`,
        "git -C /repo add -- src/a.ts src/b.ts",
      ]);
    });
  }

  test("runs git rerere and git add for rerere strategy", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["git -C /repo rerere", { exit_code: 0, stdout: "", stderr: "" }],
        ["git -C /repo add -- src/a.ts", { exit_code: 0, stdout: "", stderr: "" }],
      ]),
    );
    const result = await makeProcessAutoResolvePort(invoker).autoResolve({
      repositoryRoot: "/repo",
      strategy: "rerere",
      conflictedFiles: ["src/a.ts"],
      attempt: 1,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(invoker.calls.map((call) => `${call.program} ${call.args.join(" ")}`), [
      "git -C /repo rerere",
      "git -C /repo add -- src/a.ts",
    ]);
  });
});

describe("makeProcessResetPort", () => {
  test("locks reset to HEAD~1 in the repository root", async () => {
    const invoker = makeFakeInvoker(
      new Map([
        [
          "git -C /repo reset --hard HEAD~1",
          { exit_code: 0, stdout: "HEAD is now at abc", stderr: "" },
        ],
      ]),
    );
    const result = await makeProcessResetPort(invoker).reset("/repo");
    assert.equal(result.ok, true);
    assert.deepEqual(invoker.calls, [{
      program: "git",
      args: ["-C", "/repo", "reset", "--hard", "HEAD~1"],
      cwd: "/repo",
    }]);
  });
});

// ---------------------------------------------------------------------------
// makeBrokerAsker
// ---------------------------------------------------------------------------

describe("makeBrokerAsker", () => {
  test("forwards envelope to the broker", async () => {
    const journal = makeJournal();
    const { broker, envelope } = createBrokerWithAsker(
      makeAnswer({ answer: "skip" }),
      journal,
    );
    const asker = makeBrokerAsker(broker);
    const result = await asker.ask(envelope);
    assert.equal(result.ok, true);
    assert.equal(broker.inflight, 0);
    assert.equal(journal.records.length, 1);
  });
});

function createBrokerWithAsker(answer: BrokerAnswer, journal: BrokerJournal): {
  readonly broker: QuestionBroker;
  readonly envelope: QuestionEventEnvelope;
} {
  const ask = makeAsker(answer);
  const broker = createQuestionBroker({ ask, journal });
  const envelope: QuestionEventEnvelope = {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: "01HZQR0AQ5T7W9J3G2Y4X8V6NB",
    workflow_slug: "gantt-workflow",
    item_id: "4.2",
    session_id: "session-1",
    emitted_at: "2026-09-04T20:00:00.000Z",
    kind: "question",
    payload: {
      question_id: "q-1",
      text: "Cherry-pick?",
      options: [{ label: "cherry-pick" }, { label: "skip" }],
      gate: "integration",
    },
    provenance: { source: "integrator", broker: "arc-pi-adapter" },
  };
  return { broker, envelope };
}

// ---------------------------------------------------------------------------
// createIntegratorAdapter (full wiring)
// ---------------------------------------------------------------------------

describe("createIntegratorAdapter", () => {
  test("happy path: verify ok, commit ok, ask approve, cherry-pick ok", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["npm test", { exit_code: 0, stdout: "ok", stderr: "" }],
        ["git add --all", { exit_code: 0, stdout: "", stderr: "" }],
        ["git commit --no-verify -m feat(wf): integrate 4.2", { exit_code: 0, stdout: "", stderr: "" }],
        ["git rev-parse HEAD", { exit_code: 0, stdout: "abc123\n", stderr: "" }],
        ["git -C /repo cherry-pick --no-commit abc123", { exit_code: 0, stdout: "", stderr: "" }],
        [
          "git -C /repo commit --no-verify -m Integrate abc123 into main",
          { exit_code: 0, stdout: "", stderr: "" },
        ],
      ]),
    );
    const journal = makeJournal();
    const ask = makeAsker(makeAnswer({ answer: "cherry-pick" }));
    const { integrator, broker } = createIntegratorAdapter({
      workflowSlug: "gantt-workflow",
      itemId: "4.2",
      sessionId: "session-1",
      worktreePath: "/worktree",
      repositoryRoot: "/repo",
      integrationBranch: "main",
      commitSubject: "feat(wf): integrate 4.2",
      ask,
      journal,
      invoker,
    });
    const result = await integrator.run();
    broker.close();
    assert.equal(result.ok, true);
    assert.equal(result.phase, "cherry_pick");
    assert.equal(result.commit?.hash, "abc123");
    assert.ok(result.cherryPicked);
    assert.equal(result.cherryPicked!.branch, "main");
    assert.equal(result.cherryPicked!.commitRef, "abc123");
    assert.equal(journal.records.length, 1);
    assert.equal(journal.records[0]!.kind, "question-answer");
  });

  test("threads auto-resolve settings and verifies the integration checkout", async () => {
    const calls: Array<{ program: string; args: readonly string[]; cwd: string }> = [];
    let cherryAttempts = 0;
    const invoker: ProcessInvoker = {
      run(program, args, options) {
        calls.push({ program, args, cwd: options.cwd });
        const command = `${program} ${args.join(" ")}`;
        if (command === "npm test") {
          return { exit_code: 0, stdout: "ok", stderr: "" };
        }
        if (command === "git add --all") {
          return { exit_code: 0, stdout: "", stderr: "" };
        }
        if (command === "git commit --no-verify -m feat(wf): integrate 4.3") {
          return { exit_code: 0, stdout: "", stderr: "" };
        }
        if (command === "git rev-parse HEAD") {
          return { exit_code: 0, stdout: "abc123\n", stderr: "" };
        }
        if (command === "git -C /repo cherry-pick --no-commit abc123") {
          cherryAttempts += 1;
          return cherryAttempts === 1
            ? { exit_code: 1, stdout: "", stderr: "CONFLICT" }
            : { exit_code: 0, stdout: "", stderr: "" };
        }
        if (command === "git -C /repo diff --name-only --diff-filter=U") {
          return { exit_code: 0, stdout: "src/a.ts\n", stderr: "" };
        }
        if (command === "git -C /repo checkout --ours -- src/a.ts") {
          return { exit_code: 0, stdout: "", stderr: "" };
        }
        if (command === "git -C /repo add -- src/a.ts") {
          return { exit_code: 0, stdout: "", stderr: "" };
        }
        if (command === "git -C /repo commit --no-verify -m Integrate abc123 into main") {
          return { exit_code: 0, stdout: "", stderr: "" };
        }
        return { exit_code: 127, stdout: "", stderr: `unexpected command: ${command}` };
      },
    };
    const { integrator, broker } = createIntegratorAdapter({
      workflowSlug: "gantt-workflow",
      itemId: "4.3",
      sessionId: "session-1",
      worktreePath: "/worktree",
      repositoryRoot: "/repo",
      integrationBranch: "main",
      commitSubject: "feat(wf): integrate 4.3",
      integration: {
        question: "Cherry-pick?",
        cherryPickDescription: "Integrate.",
        skipDescription: "Skip.",
        auto_resolve: { strategy: "ours", maxAttempts: 1 },
      },
      ask: makeAsker(makeAnswer({ answer: "cherry-pick" })),
      journal: makeJournal(),
      invoker,
    });
    const result = await integrator.run();
    broker.close();
    assert.equal(result.ok, true);
    assert.equal(result.phase, "verify_integration");
    assert.equal(result.conflict?.strategy, "ours");
    assert.deepEqual(
      calls.filter((call) => call.program === "npm").map((call) => call.cwd),
      ["/worktree", "/repo"],
    );
  });

  test("verify failure prevents ask and cherry-pick", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["npm test", { exit_code: 1, stdout: "", stderr: "1 failing" }],
      ]),
    );
    const journal = makeJournal();
    const ask = makeAsker(makeAnswer({ answer: "cherry-pick" }));
    const { integrator, broker } = createIntegratorAdapter({
      workflowSlug: "gantt-workflow",
      itemId: "4.2",
      sessionId: "session-1",
      worktreePath: "/worktree",
      repositoryRoot: "/repo",
      integrationBranch: "main",
      commitSubject: "feat(wf): integrate 4.2",
      ask,
      journal,
      invoker,
    });
    const result = await integrator.run();
    broker.close();
    assert.equal(result.ok, false);
    assert.equal(result.phase, "verify");
    assert.equal(journal.records.length, 0);
    // No commit, no cherry-pick attempted.
    assert.deepEqual(
      invoker.calls.filter((c) => c.program === "git").map((c) => c.args.join(" ")),
      [],
    );
  });

  test("ask denial leaves the local commit in place and skips cherry-pick", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["npm test", { exit_code: 0, stdout: "ok", stderr: "" }],
        ["git add --all", { exit_code: 0, stdout: "", stderr: "" }],
        ["git commit --no-verify -m feat(wf): integrate 4.2", { exit_code: 0, stdout: "", stderr: "" }],
        ["git rev-parse HEAD", { exit_code: 0, stdout: "abc123\n", stderr: "" }],
      ]),
    );
    const journal = makeJournal();
    const ask = makeAsker(makeAnswer({ answer: "skip" }));
    const { integrator, broker } = createIntegratorAdapter({
      workflowSlug: "gantt-workflow",
      itemId: "4.2",
      sessionId: "session-1",
      worktreePath: "/worktree",
      repositoryRoot: "/repo",
      integrationBranch: "main",
      commitSubject: "feat(wf): integrate 4.2",
      ask,
      journal,
      invoker,
    });
    const result = await integrator.run();
    broker.close();
    assert.equal(result.ok, true);
    assert.equal(result.phase, "ask");
    assert.equal(result.integration?.approved, false);
    assert.equal(result.cherryPicked, undefined);
    // No cherry-pick invocation.
    assert.equal(
      invoker.calls.filter((c) => c.args.includes("cherry-pick")).length,
      0,
    );
  });

  test("mandatory gate answer is forwarded as single_select with options unchanged", async () => {
    const invoker = makeFakeInvoker(
      new Map<string, GitExecResult>([
        ["npm test", { exit_code: 0, stdout: "ok", stderr: "" }],
        ["git add --all", { exit_code: 0, stdout: "", stderr: "" }],
        ["git commit --no-verify -m feat(wf): integrate 4.2", { exit_code: 0, stdout: "", stderr: "" }],
        ["git rev-parse HEAD", { exit_code: 0, stdout: "abc123\n", stderr: "" }],
      ]),
    );
    const journal = makeJournal();
    const seen: AskOperatorInput[] = [];
    const ask = async (input: AskOperatorInput): Promise<BrokerAnswer> => {
      seen.push(input);
      return {
        ledger_id: "ledger-1",
        created_at: "2026-09-04T20:00:01.000Z",
        question_type: "single_select",
        answer: "skip",
      };
    };
    const { integrator, broker } = createIntegratorAdapter({
      workflowSlug: "gantt-workflow",
      itemId: "4.2",
      sessionId: "session-1",
      worktreePath: "/worktree",
      repositoryRoot: "/repo",
      integrationBranch: "main",
      commitSubject: "feat(wf): integrate 4.2",
      ask,
      journal,
      invoker,
    });
    await integrator.run();
    broker.close();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.question_type, "single_select");
    assert.equal(seen[0]!.context!.gate, "integration");
    assert.deepEqual(seen[0]!.options!.map((o) => o.label), ["cherry-pick", "skip"]);
  });
});
