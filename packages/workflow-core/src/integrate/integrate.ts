/**
 * Phase 4.3: verify → local commit → ask → cherry-pick, then resolve
 * conflicts within a bounded loop and rerun checks in the integration checkout.
 *
 * The integrator is a pure orchestrator. Every external operation is an
 * injected port; the module never imports `node:fs`, `node:child_process`, the
 * ARC Pi harness, or any model package.
 *
 * Failure model:
 *   - verify fails      → result.ok=false, phase="verify", no commit, no ask.
 *   - commit fails      → result.ok=false, phase="commit", no ask, no cherry-pick.
 *   - ask denied        → result.ok=true, phase="ask", integration.approved=false,
 *                          no cherry-pick. (The leaf asked the operator and
 *                          received an answer; the answer just wasn't
 *                          affirmative.)
 *   - ask broker fails  → result.ok=false, phase="ask", no cherry-pick.
 *   - conflict exhausts → reset, result.ok=false, phase="auto_resolve".
 *   - integration checks fail → reset, result.ok=false,
 *                                phase="verify_integration".
 *
 * Mandatory-gate semantics (gate="integration") are inherited from the broker:
 * the broker never auto-approves, so a timeout on the ask path surfaces as a
 * `BrokerFailure` here and is reported as phase="ask", reason="broker_failure"
 * without ever calling the cherry-pick port.
 */
import { EVENT_ENVELOPE_VERSION } from "../events/index.ts";
import type { EventEnvelope, EventQuestionOption, QuestionEventEnvelope } from "../events/index.ts";
import {
  AFFIRMATIVE_INTEGRATION_LABEL,
  NEGATIVE_INTEGRATION_LABEL,
} from "./types.ts";
import type {
  CreateIntegratorOptions,
  IntegrateAskerOutcome,
  IntegrateFailure,
  IntegrateIntegrationResolution,
  IntegrateResult,
  IntegrationAutoResolveStrategy,
  Integrator,
} from "./types.ts";

// Re-export the outcome type so callers using just the runtime entrypoint
// (createIntegrator) still see the asker port shape without importing types.
export type { IntegrateAskerOutcome };

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ITEM_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const AUTO_RESOLVE_STRATEGIES: readonly IntegrationAutoResolveStrategy[] = [
  "theirs",
  "ours",
  "rerere",
  "off",
];
const DEFAULT_AUTO_RESOLVE_STRATEGY = "theirs" as const;
const DEFAULT_MAX_AUTO_RESOLVE_ATTEMPTS = 2;
const MAX_AUTO_RESOLVE_ATTEMPTS = 2;

function requireSlug(value: string, field: string): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a valid workflow slug: ${value}`);
  }
  return value;
}

function requireItem(value: string, field: string): string {
  if (typeof value !== "string" || !ITEM_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a valid workflow item id: ${value}`);
  }
  return value;
}

function requireAbsolutePath(value: string, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return value;
}

function requireSubject(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new RangeError(`${field} must be 1..200 characters`);
  }
  return value;
}

function buildIntegrationEnvelope(
  options: CreateIntegratorOptions,
  integrationOptions: NonNullable<CreateIntegratorOptions["integration"]>,
  questionId: string,
  now: () => Date,
): QuestionEventEnvelope {
  const options1: EventQuestionOption[] = [
    {
      label: AFFIRMATIVE_INTEGRATION_LABEL,
      description: integrationOptions.cherryPickDescription,
    },
    {
      label: NEGATIVE_INTEGRATION_LABEL,
      description: integrationOptions.skipDescription,
    },
  ];
  const envelope: EventEnvelope = {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: `01H${now().getTime().toString(36).toUpperCase().padStart(13, "0")}`,
    workflow_slug: options.workflowSlug,
    item_id: options.itemId,
    session_id: options.sessionId,
    emitted_at: now().toISOString(),
    kind: "question",
    payload: {
      question_id: questionId,
      text: integrationOptions.question,
      options: options1,
      gate: "integration",
    },
    provenance: { source: "integrator", broker: "arc-pi-adapter" },
  };
  if (envelope.kind !== "question") throw new Error("integrator: expected question envelope");
  return envelope as QuestionEventEnvelope;
}

function defaultQuestionIdFactory(now: () => Date): () => string {
  const seen = new Set<string>();
  return () => {
    const id = `q-${now().getTime().toString(36)}-${(seen.size + 1).toString(36)}`;
    seen.add(id);
    return id;
  };
}

function normalizeOptions(options: CreateIntegratorOptions): CreateIntegratorOptions {
  requireSlug(options.workflowSlug, "workflowSlug");
  requireItem(options.itemId, "itemId");
  requireAbsolutePath(options.worktreePath, "worktreePath");
  requireAbsolutePath(options.repositoryRoot, "repositoryRoot");
  requireItem(options.integrationBranch, "integrationBranch");
  requireSubject(options.commitSubject, "commitSubject");
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  if (options.git === undefined) throw new TypeError("git ports are required");
  if (typeof options.git.verify?.verify !== "function") throw new TypeError("git.verify is required");
  if (
    options.git.integrationVerify !== undefined
    && typeof options.git.integrationVerify.verify !== "function"
  ) {
    throw new TypeError("git.integrationVerify must implement verify");
  }
  if (typeof options.git.commit?.commit !== "function") throw new TypeError("git.commit is required");
  if (typeof options.git.cherryPick?.cherryPick !== "function") throw new TypeError("git.cherryPick is required");
  if (options.git.autoResolve !== undefined && typeof options.git.autoResolve.autoResolve !== "function") {
    throw new TypeError("git.autoResolve must implement autoResolve");
  }
  if (options.git.reset !== undefined && typeof options.git.reset.reset !== "function") {
    throw new TypeError("git.reset must implement reset");
  }
  if (typeof options.asker?.ask !== "function") throw new TypeError("asker.ask is required");
  const autoResolve = options.integration?.auto_resolve;
  if (
    autoResolve?.strategy !== undefined
    && !AUTO_RESOLVE_STRATEGIES.includes(autoResolve.strategy)
  ) {
    throw new TypeError(`integration.auto_resolve.strategy is invalid: ${autoResolve.strategy}`);
  }
  if (autoResolve?.maxAttempts !== undefined) {
    if (
      !Number.isInteger(autoResolve.maxAttempts)
      || autoResolve.maxAttempts < 0
      || autoResolve.maxAttempts > MAX_AUTO_RESOLVE_ATTEMPTS
    ) {
      throw new RangeError(
        `integration.auto_resolve.maxAttempts must be an integer from 0 to ${MAX_AUTO_RESOLVE_ATTEMPTS}`,
      );
    }
  }
  return options;
}

/**
 * Build an integrator bound to the supplied options. The integrator is
 * single-shot per workflow leaf: each `run()` represents one integration
 * attempt for one local commit.
 */
export function createIntegrator(rawOptions: CreateIntegratorOptions): Integrator {
  const options = normalizeOptions(rawOptions);
  const now = options.now ?? (() => new Date());
  const createQuestionId = options.createQuestionId ?? defaultQuestionIdFactory(now);
  const autoResolveStrategy =
    options.integration?.auto_resolve?.strategy ?? DEFAULT_AUTO_RESOLVE_STRATEGY;
  const maxAutoResolveAttempts =
    options.integration?.auto_resolve?.maxAttempts ?? DEFAULT_MAX_AUTO_RESOLVE_ATTEMPTS;

  async function run(): Promise<IntegrateResult> {
    // 1) Verify in the worktree. Failure here short-circuits the whole
    // pipeline: we never commit, never ask, never cherry-pick.
    const verifyOutcome = await options.git.verify.verify(options.worktreePath);
    if (!verifyOutcome.ok) {
      const failure: IntegrateFailure = {
        phase: "verify",
        reason: "verification failed",
        ...(verifyOutcome.result.stderr.length > 0
          ? { stderr: verifyOutcome.result.stderr }
          : {}),
      };
      return {
        ok: false,
        phase: "verify",
        verify: { ok: false, exit_code: verifyOutcome.result.exit_code },
        failure,
      };
    }

    // 2) Commit. Failure here aborts before the operator sees an integration
    // question, since there is no commit to cherry-pick.
    let commitHash: string;
    try {
      const committed = await options.git.commit.commit(options.worktreePath, options.commitSubject);
      commitHash = committed.hash;
    } catch (err) {
      const failure: IntegrateFailure = {
        phase: "commit",
        reason: err instanceof Error ? err.message : String(err),
      };
      return {
        ok: false,
        phase: "commit",
        verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
        failure,
      };
    }

    // 3) Ask. If no integration options were supplied we still surface a
    // question so the operator must approve; this keeps the fail-closed
    // invariant even for callers that forget to provide a description.
    const integrationOptions = options.integration ?? {
      question: `Cherry-pick commit ${commitHash} from ${options.itemId} into ${options.integrationBranch}?`,
      cherryPickDescription: `Apply commit ${commitHash} onto ${options.integrationBranch} in this repository.`,
      skipDescription: `Leave the local commit in the worktree and mark ${options.itemId} blocked from integration.`,
    };
    const questionId = createQuestionId();
    const envelope = buildIntegrationEnvelope(options, integrationOptions, questionId, now);

    const brokerResult = await options.asker.ask(envelope);
    if (!brokerResult.ok) {
      const failure: IntegrateFailure = {
        phase: "ask",
        reason: "broker_failure",
        ...(brokerResult.brokerCode !== undefined
          ? { brokerCode: brokerResult.brokerCode }
          : {}),
        ...(brokerResult.brokerMessage !== undefined
          ? { brokerMessage: brokerResult.brokerMessage }
          : {}),
      };
      return {
        ok: false,
        phase: "ask",
        verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
        commit: { hash: commitHash },
        failure,
      };
    }

    const answerLabel = brokerResult.answer;
    const approved = answerLabel === AFFIRMATIVE_INTEGRATION_LABEL;
    const integrationResolution: IntegrateIntegrationResolution = {
      envelopeId: brokerResult.envelopeId,
      journalId: brokerResult.journalId,
      approved,
      answer: answerLabel,
      usedDefault: brokerResult.usedDefault,
    };

    if (!approved) {
      // The operator answered but did not affirm. Treat this as a non-fatal
      // integration outcome: the leaf stays locally committed but is not
      // cherry-picked. `ok` is true because the leaf successfully reached a
      // terminal integration decision.
      return {
        ok: true,
        phase: "ask",
        verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
        commit: { hash: commitHash },
        integration: integrationResolution,
      };
    }

    const cherryPickOptions = {
      commitRef: commitHash,
      integrationBranch: options.integrationBranch,
      repositoryRoot: options.repositoryRoot,
      worktreePath: options.worktreePath,
    } as const;

    // 4) Cherry-pick. The no-conflict path deliberately preserves the Phase
    // 4.2 result shape byte-for-byte and does not touch any new port.
    let cherryOutcome = await options.git.cherryPick.cherryPick(cherryPickOptions);

    if (cherryOutcome.ok) {
      return {
        ok: true,
        phase: "cherry_pick",
        verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
        commit: { hash: commitHash },
        integration: integrationResolution,
        cherryPicked: {
          branch: options.integrationBranch,
          commitRef: commitHash,
        },
      };
    }

    let conflictedFiles = [...(cherryOutcome.conflictedFiles ?? [])];
    let attempts = 0;

    const resetIntegration = async (): Promise<{
      readonly ok: boolean;
      readonly stderr?: string;
    }> => {
      if (options.git.reset === undefined) {
        return { ok: false, stderr: "git.reset port is required after an integration failure" };
      }
      try {
        const resetOutcome = await options.git.reset.reset(options.repositoryRoot);
        return {
          ok: resetOutcome.ok,
          ...(!resetOutcome.ok && resetOutcome.result.stderr.length > 0
            ? { stderr: resetOutcome.result.stderr }
            : {}),
        };
      } catch (err) {
        return { ok: false, stderr: err instanceof Error ? err.message : String(err) };
      }
    };

    const autoResolveFailure = async (
      reason: "auto_resolve_disabled" | "auto_resolve_exhausted",
      stderr?: string,
    ): Promise<IntegrateResult> => {
      const resetOutcome = await resetIntegration();
      const resetFailed = !resetOutcome.ok;
      const failureStderr = resetFailed ? resetOutcome.stderr : stderr;
      const failure: IntegrateFailure = {
        phase: "auto_resolve",
        reason: resetFailed ? "reset_failed" : reason,
        ...(failureStderr !== undefined ? { stderr: failureStderr } : {}),
      };
      return {
        ok: false,
        phase: "auto_resolve",
        verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
        commit: { hash: commitHash },
        integration: integrationResolution,
        conflict: {
          conflictedFiles,
          strategy: autoResolveStrategy,
          attempts,
          maxAttempts: maxAutoResolveAttempts,
        },
        needsReplan: true,
        reverted: resetOutcome.ok,
        failure,
      };
    };

    if (autoResolveStrategy === "off" || maxAutoResolveAttempts === 0) {
      return autoResolveFailure("auto_resolve_disabled", cherryOutcome.result.stderr);
    }

    // 5) Resolve and retry within the configured hard bound. The port is
    // optional for Phase 4.2 callers; absence fails closed and proceeds to the
    // same reset path as exhausted retries.
    let lastAutoResolveStderr = cherryOutcome.result.stderr;
    while (attempts < maxAutoResolveAttempts) {
      attempts += 1;
      if (options.git.autoResolve === undefined) break;

      const resolved = await options.git.autoResolve.autoResolve({
        repositoryRoot: options.repositoryRoot,
        strategy: autoResolveStrategy,
        conflictedFiles,
        attempt: attempts,
      });
      if (!resolved.ok) {
        lastAutoResolveStderr = resolved.result.stderr;
        continue;
      }

      cherryOutcome = await options.git.cherryPick.cherryPick(cherryPickOptions);
      if (cherryOutcome.ok) {
        // 6) Any automatically-resolved integration must pass the full suite
        // in the integration checkout, never in the leaf worktree.
        const integrationVerify = options.git.integrationVerify === undefined
          ? {
              ok: false,
              result: {
                exit_code: -1,
                stdout: "",
                stderr: "git.integrationVerify port is required after automatic resolution",
              },
            }
          : await options.git.integrationVerify.verify(options.repositoryRoot);
        if (integrationVerify.ok) {
          return {
            ok: true,
            phase: "verify_integration",
            verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
            commit: { hash: commitHash },
            integration: integrationResolution,
            cherryPicked: {
              branch: options.integrationBranch,
              commitRef: commitHash,
            },
            conflict: {
              conflictedFiles,
              strategy: autoResolveStrategy,
              attempts,
              maxAttempts: maxAutoResolveAttempts,
            },
            integrationVerified: {
              ok: true,
              exit_code: integrationVerify.result.exit_code,
              reverted: false,
            },
            needsReplan: false,
            reverted: false,
          };
        }

        const resetOutcome = await resetIntegration();
        const failure: IntegrateFailure = {
          phase: "verify_integration",
          reason: resetOutcome.ok ? "checks_failed" : "reset_failed",
          ...((resetOutcome.ok
            ? integrationVerify.result.stderr
            : resetOutcome.stderr) !== undefined
            && (resetOutcome.ok
              ? integrationVerify.result.stderr
              : resetOutcome.stderr)!.length > 0
            ? {
                stderr: resetOutcome.ok
                  ? integrationVerify.result.stderr
                  : resetOutcome.stderr,
              }
            : {}),
        };
        return {
          ok: false,
          phase: "verify_integration",
          verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
          commit: { hash: commitHash },
          integration: integrationResolution,
          conflict: {
            conflictedFiles,
            strategy: autoResolveStrategy,
            attempts,
            maxAttempts: maxAutoResolveAttempts,
          },
          integrationVerified: {
            ok: false,
            exit_code: integrationVerify.result.exit_code,
            reverted: resetOutcome.ok,
          },
          needsReplan: true,
          reverted: resetOutcome.ok,
          failure,
        };
      }

      conflictedFiles = [...(cherryOutcome.conflictedFiles ?? conflictedFiles)];
      lastAutoResolveStderr = cherryOutcome.result.stderr;
    }

    return autoResolveFailure("auto_resolve_exhausted", lastAutoResolveStderr);
  }

  return { run };
}
