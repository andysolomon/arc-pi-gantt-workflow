/**
 * Phase 4.2 adapter: wires the production git/npm commands into the pure
 * `workflow-core` integrator, and reuses the shipped `createQuestionBroker`
 * for the integration ask.
 *
 * The adapter is the only place where `node:child_process` and the ARC Pi
 * question broker meet the integrator. Workflow-core stays pure and adapter
 * callers compose both by calling `createIntegratorAdapter`.
 */
import { spawnSync } from "node:child_process";
import {
  AFFIRMATIVE_INTEGRATION_LABEL,
  createIntegrator,
  type GitCherryPickPort,
  type GitCommitPort,
  type GitExecResult,
  type GitVerifyPort,
  type IntegrateAskerOutcome,
  type IntegrateAskerPort,
  type IntegrateOptions,
  type Integrator,
} from "@arc/workflow-core";
import {
  createQuestionBroker,
  type AskOperatorFn,
  type BrokerJournal,
  type QuestionBroker,
} from "../questions/index.ts";

/** Minimal shape required by the process-backed git adapter. */
export interface ProcessInvoker {
  run(program: string, args: readonly string[], options: { readonly cwd: string }): GitExecResult;
}

const defaultInvoker: ProcessInvoker = {
  run(program, args, options) {
    const result = spawnSync(program, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      exit_code: result.status ?? -1,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  },
};

function makeProcessVerifyPort(
  invoker: ProcessInvoker,
  verifyCommand: readonly [string, ...string[]],
): GitVerifyPort {
  return {
    async verify(worktreePath: string) {
      const [program, ...args] = verifyCommand;
      const result = invoker.run(program, args, { cwd: worktreePath });
      return { ok: result.exit_code === 0, result };
    },
  };
}

function makeProcessCommitPort(invoker: ProcessInvoker): GitCommitPort {
  return {
    async commit(worktreePath, subject) {
      // Stage every change in the worktree, then commit with the supplied subject.
      const addResult = invoker.run("git", ["add", "--all"], { cwd: worktreePath });
      if (addResult.exit_code !== 0) {
        throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
      }
      const commitResult = invoker.run(
        "git",
        ["commit", "--no-verify", "-m", subject],
        { cwd: worktreePath },
      );
      if (commitResult.exit_code !== 0) {
        throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
      }
      const revResult = invoker.run("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
      if (revResult.exit_code !== 0) {
        throw new Error(`git rev-parse failed: ${revResult.stderr || revResult.stdout}`);
      }
      return { hash: revResult.stdout.trim() };
    },
  };
}

function makeProcessCherryPickPort(invoker: ProcessInvoker): GitCherryPickPort {
  return {
    async cherryPick({ commitRef, integrationBranch, repositoryRoot }) {
      // Apply the local commit on top of the integration branch without an
      // editor and without auto-commit; we want to surface conflicts as a
      // non-zero exit. The integrator will translate the failure to its
      // `cherry_pick` phase. We pass the commit directly so we never need
      // network or remote refs.
      const result = invoker.run(
        "git",
        ["-C", repositoryRoot, "cherry-pick", "--no-commit", commitRef],
        { cwd: repositoryRoot },
      );
      if (result.exit_code !== 0) {
        return { ok: false, result };
      }
      const commitResult = invoker.run(
        "git",
        ["-C", repositoryRoot, "commit", "--no-verify", "-m", `Integrate ${commitRef} into ${integrationBranch}`],
        { cwd: repositoryRoot },
      );
      return { ok: commitResult.exit_code === 0, result: commitResult };
    },
  };
}

function makeBrokerAsker(broker: QuestionBroker): IntegrateAskerPort {
  return {
    async ask(envelope): Promise<IntegrateAskerOutcome> {
      const result = await broker.ask(envelope);
      if (!result.ok) {
        return {
          ok: false,
          brokerCode: result.reason.code,
          brokerMessage: result.reason.message,
        };
      }
      const resolution = result.resolution;
      return {
        ok: true,
        envelopeId: resolution.envelope.event_id,
        journalId: resolution.journal_id,
        approved: resolution.answer.answer === AFFIRMATIVE_INTEGRATION_LABEL,
        answer: resolution.answer.answer,
        usedDefault: resolution.used_default,
      };
    },
  };
}

export interface CreateIntegratorAdapterOptions {
  readonly workflowSlug: string;
  readonly itemId: string;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly repositoryRoot: string;
  readonly integrationBranch: string;
  readonly commitSubject: string;
  readonly integration?: IntegrateOptions["integration"];
  readonly ask: AskOperatorFn;
  readonly journal: BrokerJournal;
  readonly verifyCommand?: readonly [string, ...string[]];
  readonly invoker?: ProcessInvoker;
  readonly now?: () => Date;
  readonly createQuestionId?: () => string;
}

/**
 * Production wiring: compose a process-backed git adapter with the shipped
 * question broker and return an `Integrator`. The returned broker remains
 * owned by the caller for lifecycle (close, diagnostics).
 */
export interface CreateIntegratorAdapterResult {
  readonly integrator: Integrator;
  readonly broker: QuestionBroker;
}

export function createIntegratorAdapter(
  options: CreateIntegratorAdapterOptions,
): CreateIntegratorAdapterResult {
  const invoker = options.invoker ?? defaultInvoker;
  const verifyCommand = options.verifyCommand ?? ["npm", "test"];
  const broker = createQuestionBroker({
    ask: options.ask,
    journal: options.journal,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.createQuestionId !== undefined
      ? { createQuestionId: options.createQuestionId }
      : {}),
  });
  const integrator = createIntegrator({
    workflowSlug: options.workflowSlug,
    itemId: options.itemId,
    sessionId: options.sessionId,
    worktreePath: options.worktreePath,
    repositoryRoot: options.repositoryRoot,
    integrationBranch: options.integrationBranch,
    commitSubject: options.commitSubject,
    git: {
      verify: makeProcessVerifyPort(invoker, verifyCommand),
      commit: makeProcessCommitPort(invoker),
      cherryPick: makeProcessCherryPickPort(invoker),
    },
    asker: makeBrokerAsker(broker),
    ...(options.integration !== undefined ? { integration: options.integration } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.createQuestionId !== undefined
      ? { createQuestionId: options.createQuestionId }
      : {}),
  });
  return { integrator, broker };
}

export { makeBrokerAsker, makeProcessCherryPickPort, makeProcessCommitPort, makeProcessVerifyPort };
export type { GitExecResult, IntegrateAskerOutcome, IntegrateAskerPort, IntegrateOptions, Integrator };
