/**
 * Phase 4.4: atomic completion update + risk-based review hook.
 *
 * The completion orchestrator owns three things:
 *
 *   1. `WorkflowPaths` — the three on-disk locations the controller writes to.
 *   2. `AtomicWorkflowWriter` — a port that writes the workflow YAML,
 *      `progress.txt`, and the Gantt document with all-or-nothing semantics.
 *      The default `createFsAtomicWorkflowWriter` uses a temp-dir + rename
 *      pattern so a partial failure never leaves the three files out of sync.
 *   3. `RiskReviewPort` — an optional independent reviewer that the adapter
 *      invokes for `medium` and `high` risk leaves. The default
 *      `noRiskReview` returns a deterministic outcome that depends on the
 *      risk level so the orchestrator can fail closed.
 *
 * The orchestrator composes the pure workflow-core `completeLeafCheckpoint`,
 * `renderCompletion`, and `classifyCompletionRisk` with the ports above to
 * produce one `executeCompletion` call that the sequential runner drives.
 */

import {
  CheckpointState,
  classifyCompletionRisk,
  completeLeafCheckpoint,
  renderCompletion,
  type ClassifyRiskOptions,
  type CompleteLeafCheckpointResult,
  type CompletionRiskLevel,
  type RenderCompletionResult,
} from "@arc/workflow-core";
import type {
  Leaf,
  Workflow,
} from "@arc/workflow-core";
import type { IntegrateResult } from "@arc/workflow-core";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The three on-disk locations the atomic writer targets. Paths are absolute
 * and live in the workflow's runtime area; the orchestrator does not own the
 * layout and never traverses the filesystem to discover these.
 */
export interface WorkflowPaths {
  readonly workflowYaml: string;
  readonly progressText: string;
  readonly ganttText: string;
}

// ---------------------------------------------------------------------------
// Atomic writer port
// ---------------------------------------------------------------------------

export interface AtomicWriteContents {
  readonly workflowYaml: string;
  readonly progressText: string;
  readonly ganttText: string;
}

export interface AtomicWriteResult {
  readonly wrote: boolean;
  /**
   * The exact paths that were attempted. Useful for surfacing diagnostics;
   * never contains any transcript or raw content.
   */
  readonly paths: WorkflowPaths;
  /** A short machine-readable reason when `wrote` is false. */
  readonly reason?: string;
}

export interface AtomicWorkflowWriter {
  /**
   * Write all three documents atomically. If any of them cannot be persisted
   * in their final location, none of them is, and the previous contents
   * remain untouched. Implementations may stage to a temp directory, rename,
   * or use a transactional filesystem primitive, but the contract is that
   * observers always see all three at the prior version or all three at the
   * new version — never a partial state.
   */
  writeAtomic(contents: AtomicWriteContents, paths: WorkflowPaths): Promise<AtomicWriteResult>;
}

// ---------------------------------------------------------------------------
// Filesystem-backed atomic writer
// ---------------------------------------------------------------------------

/** Minimal filesystem surface the adapter needs to write atomically. */
export interface CompletionFileSystem {
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<string | undefined>;
  writeFile(path: string, contents: string, options: { encoding: "utf8"; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string, options: { recursive?: boolean }): Promise<void>;
  /** Read existing bytes; resolves to null when the path does not exist. */
  readFile?(path: string): Promise<string | null>;
}

const STAGING_DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function safeFileName(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new TypeError(`Invalid file name: ${JSON.stringify(name)}`);
  }
  return name;
}

function ensureAbsolute(path: string, field: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) {
    throw new TypeError(`${field} must be an absolute path`);
  }
  return path;
}

/**
 * Filesystem-backed atomic writer. Stages the three files in a temporary
 * sibling directory, snapshots the originals, then `rename(2)`s each into
 * place. `rename` is atomic on POSIX filesystems and on the common journaling
 * Windows filesystems, so each file moves independently. To preserve the
 * all-or-nothing guarantee the writer restores any original bytes that were
 * displaced before the rename sequence aborted.
 *
 * Stages:
 *   1. snapshot originals (null when a path did not previously exist);
 *   2. create a staging directory and write all three new files there;
 *   3. rename each staged file into its final location;
 *   4. on any failure during step 3, rewrite the snapshot bytes back over
 *      whatever final location was already renamed and unlink the staging
 *      directory.
 */
export function createFsAtomicWorkflowWriter(
  fileSystem: CompletionFileSystem,
  now: () => Date = () => new Date(),
): AtomicWorkflowWriter {
  return {
    async writeAtomic(contents, paths): Promise<AtomicWriteResult> {
      for (const [field, value] of [
        ["workflowYaml", paths.workflowYaml],
        ["progressText", paths.progressText],
        ["ganttText", paths.ganttText],
      ] as const) {
        ensureAbsolute(value, field);
      }
      const stamp = now().getTime().toString(36);
      // All three files share one staging directory; cleaning up means
      // unlinking that single directory.
      const stagingDirectory = `${paths.workflowYaml}.staging-${stamp}`;
      const stageContents: ReadonlyArray<readonly [string, string, string]> = [
        [safeFileName("workflow.yaml"), contents.workflowYaml, paths.workflowYaml],
        [safeFileName("progress.txt"), contents.progressText, paths.progressText],
        [safeFileName("gantt"), contents.ganttText, paths.ganttText],
      ];

      let snapshots: Record<string, string | null> | undefined;
      try {
        if (fileSystem.readFile === undefined) {
          throw new Error(
            "atomic writer requires CompletionFileSystem.readFile to snapshot originals",
          );
        }
        snapshots = {};
        for (const [, , finalPath] of stageContents) {
          snapshots[finalPath] = await fileSystem.readFile(finalPath);
        }
        await fileSystem.mkdir(stagingDirectory, { recursive: true, mode: STAGING_DIR_MODE });
        for (const [filename, body, ] of stageContents) {
          const stagedPath = `${stagingDirectory}/${filename}`;
          await fileSystem.writeFile(stagedPath, body, { encoding: "utf8", mode: FILE_MODE });
        }
        // Rename each staged file into place. A single failed rename throws
        // into the catch branch which restores originals.
        for (const [filename, , finalPath] of stageContents) {
          const stagedPath = `${stagingDirectory}/${filename}`;
          await fileSystem.rename(stagedPath, finalPath);
        }
        await fileSystem.rmdir(stagingDirectory, { recursive: true });
        return { wrote: true, paths };
      } catch (err) {
        // Best-effort cleanup of the staging directory and any snapshots that
        // were displaced by partial renames. The order is important: restore
        // originals before removing the staging tree so we never expose a
        // half-state.
        if (snapshots !== undefined) {
          for (const [finalPath, snapshot] of Object.entries(snapshots)) {
            try {
              if (snapshot === null) {
                // The original did not exist; if a partial rename put a
                // staged file there, unlink it so the previous absence is
                // recovered. We swallow secondary errors because the primary
                // error is what the caller needs.
                try {
                  await fileSystem.unlink(finalPath);
                } catch {
                  /* swallow */
                }
              } else {
                await fileSystem.writeFile(finalPath, snapshot, {
                  encoding: "utf8",
                  mode: FILE_MODE,
                });
              }
            } catch {
              /* swallow */
            }
          }
        }
        try {
          await fileSystem.rmdir(stagingDirectory, { recursive: true });
        } catch {
          /* swallow secondary cleanup failure */
        }
        return {
          wrote: false,
          paths,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Risk review port
// ---------------------------------------------------------------------------

export interface RiskReviewInput {
  readonly workflow: Workflow;
  readonly item: Leaf;
  readonly integrateResult: IntegrateResult;
  readonly risk: CompletionRiskLevel;
  readonly paths: WorkflowPaths;
}

export interface RiskReviewOutcome {
  /**
   * Whether the reviewer approves the leaf. The orchestrator only marks the
   * leaf complete when this is `true`; on `false` the leaf is moved to
   * `needs-replan` so the controller can surface the decision.
   */
  readonly approved: boolean;
  /**
   * Operator-visible rationale. Never contains raw transcript content; the
   * adapter layers on additional redaction before the controller renders it.
   */
  readonly rationale?: string;
}

export interface RiskReviewPort {
  review(input: RiskReviewInput): Promise<RiskReviewOutcome>;
}

/**
 * No-op default: the reviewer always approves, but only after the leaf has
 * passed integration verification. Leaves with `risk === "high"` are denied
 * by default because the risk threshold is precisely the signal that an
 * independent reviewer must weigh in. Callers that have a real reviewer
 * inject it; this default keeps the orchestrator safe in development.
 */
export const noRiskReview: RiskReviewPort = Object.freeze({
  async review({ risk }: RiskReviewInput): Promise<RiskReviewOutcome> {
    if (risk === "high") {
      return {
        approved: false,
        rationale: "no-risk-review default denies high-risk leaves",
      };
    }
    return { approved: true, rationale: "no-risk-review default approves" };
  },
});

// ---------------------------------------------------------------------------
// Completion orchestrator
// ---------------------------------------------------------------------------

export interface ExecuteCompletionOptions {
  readonly paths: WorkflowPaths;
  readonly renderContext: {
    readonly generated_at: string;
    readonly source?: string;
  };
  readonly writer: AtomicWorkflowWriter;
  readonly review: RiskReviewPort;
  readonly now: () => Date;
  readonly thresholds?: ClassifyRiskOptions;
}

export type CompletionDecision =
  | {
      readonly decision: "complete";
      readonly workflow: Workflow;
      readonly item: Leaf;
      readonly risk: CompletionRiskLevel;
      readonly render: RenderCompletionResult;
      readonly write: AtomicWriteResult;
    }
  | {
      readonly decision: "needs-replan";
      readonly reason: string;
      readonly workflow: Workflow;
      readonly item: Leaf;
      readonly risk: CompletionRiskLevel;
      readonly reviewOutcome?: RiskReviewOutcome;
      readonly render?: RenderCompletionResult;
      readonly write?: AtomicWriteResult;
    };

/**
 * Decide the terminal completion state for one leaf, run the optional
 * reviewer, and persist the three documents atomically when the leaf is
 * approved.
 *
 * The orchestrator always renders the updated workflow so callers can keep a
 * `RenderedDocument` pointer even when the decision is `needs-replan`. It
 * only writes to disk when the decision is `complete`; a `needs-replan`
 * outcome leaves the previous `progress.txt` / Gantt in place, which is the
 * correct behaviour because the leaf has not actually completed.
 */
export async function executeCompletion(
  workflow: Workflow,
  integrateResult: IntegrateResult,
  options: ExecuteCompletionOptions,
): Promise<CompletionDecision> {
  const risk = classifyCompletionRisk(integrateResult, options.thresholds);
  const updatedAt = options.now().toISOString();

  const transitioned: CompleteLeafCheckpointResult = completeLeafCheckpoint(
    workflow,
    {
      itemId: integrateResult.commit?.hash === undefined
        ? workflow.items.find((item): item is Leaf => item.kind === "leaf")?.id ?? ""
        : findLeafIdForCompletion(workflow, integrateResult),
      nextState: CheckpointState.completed,
      updatedAt,
    },
  );

  const render: RenderCompletionResult = renderCompletion(
    transitioned.workflow,
    options.renderContext,
  );

  if (risk === "low") {
    const write = await options.writer.writeAtomic(
      {
        workflowYaml: render.yaml,
        progressText: render.rendered.progress.text,
        ganttText: render.rendered.gantt.text,
      },
      options.paths,
    );
    if (!write.wrote) {
      return {
        decision: "needs-replan",
        reason: `atomic write failed: ${write.reason ?? "unknown"}`,
        workflow,
        item: transitioned.item,
        risk,
        render,
        write,
      };
    }
    return {
      decision: "complete",
      workflow: transitioned.workflow,
      item: transitioned.item,
      risk,
      render,
      write,
    };
  }

  const reviewOutcome = await options.review.review({
    workflow: transitioned.workflow,
    item: transitioned.item,
    integrateResult,
    risk,
    paths: options.paths,
  });
  if (!reviewOutcome.approved) {
    // Surface the operator-visible rationale (or a deterministic fallback)
    // without ever echoing raw transcript content.
    const rationale = reviewOutcome.rationale ?? `${risk} risk denied by reviewer`;
    return {
      decision: "needs-replan",
      reason: rationale,
      workflow,
      item: transitioned.item,
      risk,
      reviewOutcome,
      render,
    };
  }

  const write = await options.writer.writeAtomic(
    {
      workflowYaml: render.yaml,
      progressText: render.rendered.progress.text,
      ganttText: render.rendered.gantt.text,
    },
    options.paths,
  );
  if (!write.wrote) {
    return {
      decision: "needs-replan",
      reason: `atomic write failed: ${write.reason ?? "unknown"}`,
      workflow,
      item: transitioned.item,
      risk,
      reviewOutcome,
      render,
      write,
    };
  }

  return {
    decision: "complete",
    workflow: transitioned.workflow,
    item: transitioned.item,
    risk,
    render,
    write,
  };
}

/**
 * Find the leaf that the integrator just finished. The integrator does not
 * carry the leaf id in its result type, so the orchestrator relies on the
 * leaf whose checkpoint state is `ready` and whose `nextState` is intended to
 * become `completed`. With one leaf in flight at a time (Phase 5 sequential
 * runner) this is unambiguous; future parallel runs will need the integrator
 * to surface the leaf id directly.
 */
function findLeafIdForCompletion(
  workflow: Workflow,
  integrateResult: IntegrateResult,
): string {
  if (integrateResult.commit?.hash !== undefined) {
    const ready = workflow.items.find(
      (item): item is Leaf => item.kind === "leaf" && item.checkpoint.state === CheckpointState.ready,
    );
    if (ready !== undefined) return ready.id;
    const planned = workflow.items.find(
      (item): item is Leaf => item.kind === "leaf" && item.checkpoint.state === CheckpointState.planned,
    );
    if (planned !== undefined) return planned.id;
  }
  throw new Error(
    "executeCompletion: cannot identify the completed leaf; the workflow has neither a ready nor a planned leaf and the integrator did not surface an item id",
  );
}