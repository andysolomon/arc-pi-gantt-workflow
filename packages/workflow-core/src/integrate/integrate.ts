/**
 * Phase 4.2: verify → local commit → ask → cherry-pick.
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
 *   - cherry-pick fails → result.ok=false, phase="cherry_pick".
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
  Integrator,
} from "./types.ts";

// Re-export the outcome type so callers using just the runtime entrypoint
// (createIntegrator) still see the asker port shape without importing types.
export type { IntegrateAskerOutcome };

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ITEM_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

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
  if (typeof options.git.commit?.commit !== "function") throw new TypeError("git.commit is required");
  if (typeof options.git.cherryPick?.cherryPick !== "function") throw new TypeError("git.cherryPick is required");
  if (typeof options.asker?.ask !== "function") throw new TypeError("asker.ask is required");
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

    // 4) Cherry-pick. A failure here is terminal for this integration
    // attempt; the operator will be informed via the next status update.
    const cherryOutcome = await options.git.cherryPick.cherryPick({
      commitRef: commitHash,
      integrationBranch: options.integrationBranch,
      repositoryRoot: options.repositoryRoot,
      worktreePath: options.worktreePath,
    });
    if (!cherryOutcome.ok) {
      const failure: IntegrateFailure = {
        phase: "cherry_pick",
        reason: "cherry-pick failed",
        ...(cherryOutcome.result.stderr.length > 0
          ? { stderr: cherryOutcome.result.stderr }
          : {}),
      };
      return {
        ok: false,
        phase: "cherry_pick",
        verify: { ok: true, exit_code: verifyOutcome.result.exit_code },
        commit: { hash: commitHash },
        integration: integrationResolution,
        failure,
      };
    }

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

  return { run };
}
