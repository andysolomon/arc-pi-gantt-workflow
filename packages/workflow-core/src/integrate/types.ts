/**
 * Phase 4.3 types: verify → local commit → ask → cherry-pick, with
 * bounded conflict resolution and integration-branch verification.
 *
 * The integrate module is pure: every external operation (running tests,
 * making a commit, cherry-picking into the integration branch, and asking the
 * operator) is exposed as an injected port. The production adapter wires the
 * real `git` / `npm` CLI plus the shipped `createQuestionBroker`.
 *
 * Mandatory-gate semantics are inherited from the broker: a `gate ===
 * "integration"` question never auto-approves. Timeout and denial both fail
 * closed (no cherry-pick), which is enforced by the integrator through the
 * `IntegrateAskerOutcome` shape rather than by re-implementing the broker.
 */
import type { QuestionEventEnvelope } from "../events/index.ts";

/**
 * Outcome returned by the asker port. The integrator is broker-agnostic: the
 * adapter maps `BrokerResult` into this shape so workflow-core never depends
 * on `@arc/pi-workflow`.
 */
export type IntegrateAskerOutcome =
  | {
      readonly ok: true;
      readonly envelopeId: string;
      readonly journalId: string | undefined;
      readonly approved: boolean;
      readonly answer: string;
      readonly usedDefault: boolean;
    }
  | {
      readonly ok: false;
      readonly brokerCode?: string;
      readonly brokerMessage?: string;
    };

export interface GitExecResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitVerifyPort {
  /**
   * Run the leaf's verification suite inside the worktree. `ok` must be
   * `false` for any non-zero exit, signal, or spawned failure.
   */
  verify(worktreePath: string): Promise<{ readonly ok: boolean; readonly result: GitExecResult }>;
}

export interface GitCommitPort {
  /**
   * Stage the leaf's changes in the worktree and commit them with the given
   * subject. Returns the resulting commit hash on success.
   */
  commit(worktreePath: string, subject: string): Promise<{ readonly hash: string }>;
}

export interface GitCherryPickPort {
  /**
   * Cherry-pick `commitRef` from the worktree into `integrationBranch` in
   * `repositoryRoot`. The port must surface any non-zero exit through `ok`.
   */
  cherryPick(opts: {
    readonly commitRef: string;
    readonly integrationBranch: string;
    readonly repositoryRoot: string;
    readonly worktreePath: string;
  }): Promise<{
    readonly ok: boolean;
    readonly result: GitExecResult;
    readonly conflictedFiles?: readonly string[];
  }>;
}

export type IntegrationAutoResolveStrategy = "theirs" | "ours" | "rerere" | "off";

export interface IntegrationAutoResolveOptions {
  /** Conflict strategy. Defaults to `theirs`. */
  readonly strategy?: IntegrationAutoResolveStrategy;
  /** Number of resolution/retry cycles. Defaults to 2; zero disables resolution. */
  readonly maxAttempts?: number;
}

export interface GitAutoResolvePort {
  autoResolve(opts: {
    readonly repositoryRoot: string;
    readonly strategy: Exclude<IntegrationAutoResolveStrategy, "off">;
    readonly conflictedFiles: readonly string[];
    readonly attempt: number;
  }): Promise<{ readonly ok: boolean; readonly result: GitExecResult }>;
}

export interface GitResetPort {
  /** Revert the current integration commit. Production adapters lock this to HEAD~1. */
  reset(repositoryRoot: string): Promise<{ readonly ok: boolean; readonly result: GitExecResult }>;
}

/**
 * The asker port accepts an already-built `QuestionEventEnvelope` and returns
 * an integrator-shaped outcome. The adapter maps the broker result into this
 * shape so workflow-core never imports the broker types.
 */
export interface IntegrateAskerPort {
  ask(envelope: QuestionEventEnvelope): Promise<IntegrateAskerOutcome>;
}

export interface IntegrateIntegrationOptions {
  /**
   * Question text surfaced to the operator. Should reference the leaf, the
   * local commit, and the integration branch.
   */
  readonly question: string;
  /**
   * Operator-visible description of what a cherry-pick will do.
   */
  readonly cherryPickDescription: string;
  /**
   * Operator-visible description of what skipping will do (leave the local
   * commit in the worktree, mark the leaf blocked from integration).
   */
  readonly skipDescription: string;
  /** Automatic conflict handling after an approved cherry-pick. */
  readonly auto_resolve?: IntegrationAutoResolveOptions;
}

export interface IntegrateOptions {
  readonly workflowSlug: string;
  readonly itemId: string;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly repositoryRoot: string;
  readonly integrationBranch: string;
  readonly commitSubject: string;
  readonly git: {
    readonly verify: GitVerifyPort;
    readonly integrationVerify?: GitVerifyPort;
    readonly commit: GitCommitPort;
    readonly cherryPick: GitCherryPickPort;
    readonly autoResolve?: GitAutoResolvePort;
    readonly reset?: GitResetPort;
  };
  readonly asker: IntegrateAskerPort;
  readonly integration?: IntegrateIntegrationOptions;
  readonly now?: () => Date;
  readonly createQuestionId?: () => string;
}

export type IntegratePhase =
  | "verify"
  | "commit"
  | "ask"
  | "cherry_pick"
  | "auto_resolve"
  | "verify_integration";

export interface IntegrateIntegrationResolution {
  readonly envelopeId: string;
  readonly journalId: string | undefined;
  readonly approved: boolean;
  readonly answer: string;
  readonly usedDefault: boolean;
}

export type IntegrateFailure =
  | { readonly phase: "verify"; readonly reason: string; readonly stderr?: string }
  | { readonly phase: "commit"; readonly reason: string }
  | {
      readonly phase: "ask";
      readonly reason: "denied" | "broker_failure";
      readonly brokerCode?: string;
      readonly brokerMessage?: string;
      readonly envelopeId?: string;
    }
  | { readonly phase: "cherry_pick"; readonly reason: string; readonly stderr?: string }
  | {
      readonly phase: "auto_resolve";
      readonly reason: "auto_resolve_disabled" | "auto_resolve_exhausted" | "reset_failed";
      readonly stderr?: string;
    }
  | {
      readonly phase: "verify_integration";
      readonly reason: "checks_failed" | "reset_failed";
      readonly stderr?: string;
    };

export interface IntegrateConflict {
  readonly conflictedFiles: readonly string[];
  readonly strategy: IntegrationAutoResolveStrategy;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface IntegrateIntegrationVerified {
  readonly ok: boolean;
  readonly exit_code: number;
  readonly reverted: boolean;
}

export interface IntegrateResult {
  readonly ok: boolean;
  readonly phase: IntegratePhase;
  readonly verify: { readonly ok: boolean; readonly exit_code: number };
  readonly commit?: { readonly hash: string };
  readonly integration?: IntegrateIntegrationResolution;
  readonly cherryPicked?: { readonly branch: string; readonly commitRef: string };
  readonly conflict?: IntegrateConflict;
  readonly integrationVerified?: IntegrateIntegrationVerified;
  readonly needsReplan?: boolean;
  readonly reverted?: boolean;
  readonly failure?: IntegrateFailure;
}

export interface Integrator {
  /** Run the full pipeline once. Pure orchestration; never throws on user-visible failure modes. */
  run(): Promise<IntegrateResult>;
}

export type CreateIntegratorOptions = IntegrateOptions;

/**
 * Default labels for the integration question. The affirmative label is the
 * only string the integrator treats as approval; everything else is treated as
 * a non-affirmative answer and the cherry-pick is skipped.
 */
export const AFFIRMATIVE_INTEGRATION_LABEL = "cherry-pick" as const;
export const NEGATIVE_INTEGRATION_LABEL = "skip" as const;
