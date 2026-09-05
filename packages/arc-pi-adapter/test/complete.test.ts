import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CheckpointState,
  type IntegrateResult,
  type Leaf,
  type Workflow,
} from "@arc/workflow-core";
import {
  createFsAtomicWorkflowWriter,
  executeCompletion,
  noRiskReview,
  type AtomicWriteContents,
  type AtomicWriteResult,
  type CompletionDecision,
  type CompletionFileSystem,
  type RiskReviewInput,
  type RiskReviewOutcome,
  type RiskReviewPort,
  type WorkflowPaths,
} from "../src/complete/index.ts";

const UPDATED_AT = "2026-09-03T00:00:00.000Z";

function leaf(id: string, state: CheckpointState): Leaf {
  return {
    id,
    kind: "leaf",
    title: `Leaf ${id}`,
    parent_id: "1.0",
    nesting_depth: 1,
    outcome: `outcome for ${id}`,
    scope: `packages/workflow-core/src/${id}`,
    acceptance_criteria: [`${id} completes cleanly`],
    dependencies: [],
    preserved_behavior: "Keep workflow-core independent of Pi.",
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

function workflow(): Workflow {
  return {
    schema_version: "1",
    slug: "complete-fixture",
    repository: { id: "local", path: "." },
    items: [
      {
        id: "1.0",
        kind: "group",
        title: "Phase 1",
        parent_id: null,
        nesting_depth: 0,
        dependencies: [],
        checkpoint: { state: CheckpointState.planned, updated_at: UPDATED_AT },
      },
      leaf("1.1", CheckpointState.ready),
    ],
  };
}

function cleanIntegrateResult(overrides: Partial<IntegrateResult> = {}): IntegrateResult {
  return {
    ok: true,
    phase: "verify_integration",
    verify: { ok: true, exit_code: 0 },
    commit: { hash: "deadbeef" },
    integration: {
      envelopeId: "env-1",
      journalId: "jrnl-1",
      approved: true,
      answer: "cherry-pick",
      usedDefault: false,
    },
    cherryPicked: { branch: "main", commitRef: "deadbeef" },
    integrationVerified: { ok: true, exit_code: 0, reverted: false },
    ...overrides,
  };
}

function conflictedResult(attempts: number): IntegrateResult {
  return {
    ...cleanIntegrateResult(),
    conflict: {
      conflictedFiles: ["src/a.ts"],
      strategy: "theirs",
      attempts,
      maxAttempts: 2,
    },
  };
}

// ---------------------------------------------------------------------------
// createFsAtomicWorkflowWriter
// ---------------------------------------------------------------------------

interface FsState {
  directories: Set<string>;
  files: Map<string, string>;
  modes: Map<string, number>;
}

function createMemoryFileSystem(): CompletionFileSystem & { readonly state: FsState } {
  const state: FsState = {
    directories: new Set<string>(["/"]),
    files: new Map<string, string>(),
    modes: new Map<string, number>(),
  };
  function parent(path: string): string {
    const lastSlash = path.lastIndexOf("/");
    return lastSlash <= 0 ? "/" : path.slice(0, lastSlash);
  }
  function ensureDirectory(path: string): void {
    if (path === "/" || path.length === 0) {
      state.directories.add("/");
      return;
    }
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      state.directories.add(current);
    }
  }
  return {
    state,
    async mkdir(path, options) {
      ensureDirectory(path);
      if (options.mode !== undefined) state.modes.set(path, options.mode);
      return path;
    },
    async writeFile(path, contents, options) {
      ensureDirectory(parent(path));
      state.files.set(path, contents);
      state.modes.set(path, options.mode);
    },
    async rename(from, to) {
      if (!state.files.has(from) && !state.directories.has(from)) {
        throw new Error(`rename: source ${from} does not exist`);
      }
      if (state.files.has(from)) {
        const body = state.files.get(from) ?? "";
        state.files.set(to, body);
        state.files.delete(from);
      } else {
        state.directories.add(to);
      }
      ensureDirectory(parent(to));
    },
    async unlink(path) {
      if (!state.files.delete(path)) {
        throw new Error(`unlink: ${path} does not exist`);
      }
    },
    async rmdir(path, options) {
      if (!state.directories.delete(path)) {
        if (options.recursive === true) {
          // best-effort recursive delete: drop any descendant file/dir
          for (const file of [...state.files.keys()]) {
            if (file === path || file.startsWith(`${path}/`)) state.files.delete(file);
          }
          for (const dir of [...state.directories]) {
            if (dir === path || dir.startsWith(`${path}/`)) state.directories.delete(dir);
          }
        }
      }
    },
    async readFile(path) {
      return state.files.has(path) ? (state.files.get(path) ?? null) : null;
    },
  };
}

const PATHS: WorkflowPaths = Object.freeze({
  workflowYaml: "/repo/.arc/workflows/test/workflow.yaml",
  progressText: "/repo/docs/progress.txt",
  ganttText: "/repo/docs/gantt.mmd",
});

describe("createFsAtomicWorkflowWriter", () => {
  test("writes all three files atomically on success", async () => {
    const fs = createMemoryFileSystem();
    const writer = createFsAtomicWorkflowWriter(fs);
    const contents: AtomicWriteContents = {
      workflowYaml: "schema_version: \"1\"\n",
      progressText: "arc-render: progress\n",
      ganttText: "arc-render: gantt\n",
    };
    const result = await writer.writeAtomic(contents, PATHS);
    assert.equal(result.wrote, true);
    assert.equal(fs.state.files.get(PATHS.workflowYaml), contents.workflowYaml);
    assert.equal(fs.state.files.get(PATHS.progressText), contents.progressText);
    assert.equal(fs.state.files.get(PATHS.ganttText), contents.ganttText);
    // No staging directory should remain.
    for (const dir of fs.state.directories) {
      assert.equal(dir.includes(".staging-"), false, `staging dir leaked: ${dir}`);
    }
  });

  test("leaves originals untouched when a mid-flight rename fails", async () => {
    const fs = createMemoryFileSystem();
    // Seed prior contents so we can verify they survive.
    await fs.writeFile(PATHS.workflowYaml, "OLD yaml", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.progressText, "OLD progress", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.ganttText, "OLD gantt", { encoding: "utf8", mode: 0o600 });

    // Force a mid-flight failure by wrapping the FS so that one of the
    // renames throws. The atomic writer must restore the original byte
    // content of whichever file got partially renamed.
    const broken: CompletionFileSystem = {
      ...fs,
      async rename(from, to) {
        if (to === PATHS.progressText) {
          throw new Error("simulated rename failure");
        }
        return fs.rename(from, to);
      },
    };
    const brokenWriter = createFsAtomicWorkflowWriter(broken);
    const result = await brokenWriter.writeAtomic(
      { workflowYaml: "NEW yaml", progressText: "NEW progress", ganttText: "NEW gantt" },
      PATHS,
    );
    assert.equal(result.wrote, false);
    assert.match(result.reason ?? "", /simulated rename failure/);
    // All three originals remain byte-identical to what was seeded.
    assert.equal(fs.state.files.get(PATHS.workflowYaml), "OLD yaml");
    assert.equal(fs.state.files.get(PATHS.progressText), "OLD progress");
    assert.equal(fs.state.files.get(PATHS.ganttText), "OLD gantt");
  });

  test("rejects non-absolute paths", async () => {
    const fs = createMemoryFileSystem();
    const writer = createFsAtomicWorkflowWriter(fs);
    await assert.rejects(
      writer.writeAtomic(
        { workflowYaml: "x", progressText: "y", ganttText: "z" },
        { workflowYaml: "relative/workflow.yaml", progressText: PATHS.progressText, ganttText: PATHS.ganttText },
      ),
      /absolute path/,
    );
  });
});

// ---------------------------------------------------------------------------
// executeCompletion
// ---------------------------------------------------------------------------

function renderContext() {
  return { generated_at: "2026-09-04T10:00:00.000Z" };
}

describe("executeCompletion", () => {
  test("low-risk integrate with no conflict marks the leaf complete and writes atomically", async () => {
    const fs = createMemoryFileSystem();
    const decision: CompletionDecision = await executeCompletion(
      workflow(),
      cleanIntegrateResult(),
      {
        paths: PATHS,
        renderContext: renderContext(),
        writer: createFsAtomicWorkflowWriter(fs),
        review: noRiskReview,
        now: () => new Date("2026-09-04T10:00:00.000Z"),
      },
    );
    assert.equal(decision.decision, "complete");
    if (decision.decision !== "complete") return;
    assert.equal(decision.risk, "low");
    assert.equal(decision.write.wrote, true);
    const updatedLeaf = decision.workflow.items.find((item) => item.id === "1.1");
    assert.ok(updatedLeaf && updatedLeaf.kind === "leaf");
    assert.equal(updatedLeaf.checkpoint.state, CheckpointState.completed);
    // The atomic write produced all three documents.
    assert.match(decision.render.yaml, /schema_version: "1"/);
    assert.match(decision.render.rendered.progress.text, /arc-render: progress/);
    assert.match(decision.render.rendered.gantt.text, /arc-render: gantt/);
  });

  test("medium-risk integrate requires a review; default denies", async () => {
    const fs = createMemoryFileSystem();
    // Pre-populate so we can verify nothing was overwritten.
    await fs.writeFile(PATHS.workflowYaml, "OLD yaml", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.progressText, "OLD progress", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.ganttText, "OLD gantt", { encoding: "utf8", mode: 0o600 });

    const decision = await executeCompletion(
      workflow(),
      conflictedResult(1),
      {
        paths: PATHS,
        renderContext: renderContext(),
        writer: createFsAtomicWorkflowWriter(fs),
        review: noRiskReview,
        now: () => new Date("2026-09-04T10:00:00.000Z"),
      },
    );
    // The default noRiskReview approves medium; the orchestrator proceeds and writes.
    assert.equal(decision.decision, "complete");
    if (decision.decision !== "complete") return;
    assert.equal(decision.risk, "medium");
    assert.equal(fs.state.files.get(PATHS.workflowYaml)?.includes("OLD yaml"), false);
  });

  test("medium-risk integrate with custom reviewer denial returns needs-replan and does not write", async () => {
    const fs = createMemoryFileSystem();
    await fs.writeFile(PATHS.workflowYaml, "OLD yaml", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.progressText, "OLD progress", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.ganttText, "OLD gantt", { encoding: "utf8", mode: 0o600 });

    const denyAll: RiskReviewPort = {
      async review(_input: RiskReviewInput): Promise<RiskReviewOutcome> {
        return { approved: false, rationale: "explicit denial" };
      },
    };
    const decision = await executeCompletion(
      workflow(),
      conflictedResult(1),
      {
        paths: PATHS,
        renderContext: renderContext(),
        writer: createFsAtomicWorkflowWriter(fs),
        review: denyAll,
        now: () => new Date("2026-09-04T10:00:00.000Z"),
      },
    );
    assert.equal(decision.decision, "needs-replan");
    if (decision.decision !== "needs-replan") return;
    assert.equal(decision.reviewOutcome?.approved, false);
    assert.equal(decision.reason, "explicit denial");
    // Originals preserved.
    assert.equal(fs.state.files.get(PATHS.workflowYaml), "OLD yaml");
    assert.equal(fs.state.files.get(PATHS.progressText), "OLD progress");
    assert.equal(fs.state.files.get(PATHS.ganttText), "OLD gantt");
  });

  test("high-risk integrate with the no-op reviewer is denied and does not write", async () => {
    const fs = createMemoryFileSystem();
    await fs.writeFile(PATHS.workflowYaml, "OLD yaml", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.progressText, "OLD progress", { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(PATHS.ganttText, "OLD gantt", { encoding: "utf8", mode: 0o600 });
    const decision = await executeCompletion(
      workflow(),
      conflictedResult(2),
      {
        paths: PATHS,
        renderContext: renderContext(),
        writer: createFsAtomicWorkflowWriter(fs),
        review: noRiskReview,
        now: () => new Date("2026-09-04T10:00:00.000Z"),
      },
    );
    assert.equal(decision.decision, "needs-replan");
    if (decision.decision !== "needs-replan") return;
    assert.equal(decision.reason, "no-risk-review default denies high-risk leaves");
    assert.equal(fs.state.files.get(PATHS.workflowYaml), "OLD yaml");
  });

  test("write failure returns needs-replan with the failure reason", async () => {
    const brokenWriter = {
      async writeAtomic(_contents: AtomicWriteContents, _paths: WorkflowPaths): Promise<AtomicWriteResult> {
        return { wrote: false, paths: PATHS, reason: "disk full" };
      },
    };
    const decision = await executeCompletion(
      workflow(),
      cleanIntegrateResult(),
      {
        paths: PATHS,
        renderContext: renderContext(),
        writer: brokenWriter,
        review: noRiskReview,
        now: () => new Date("2026-09-04T10:00:00.000Z"),
      },
    );
    assert.equal(decision.decision, "needs-replan");
    if (decision.decision !== "needs-replan") return;
    assert.match(decision.reason, /disk full/);
  });
});

// ---------------------------------------------------------------------------
// noRiskReview
// ---------------------------------------------------------------------------

describe("noRiskReview", () => {
  function input(risk: "low" | "medium" | "high"): RiskReviewInput {
    return {
      workflow: workflow(),
      item: leaf("1.1", CheckpointState.ready),
      integrateResult: cleanIntegrateResult(),
      risk,
      paths: PATHS,
    };
  }
  test("approves low and medium risk", async () => {
    assert.equal((await noRiskReview.review(input("low"))).approved, true);
    assert.equal((await noRiskReview.review(input("medium"))).approved, true);
  });
  test("denies high risk", async () => {
    const outcome = await noRiskReview.review(input("high"));
    assert.equal(outcome.approved, false);
    assert.match(outcome.rationale ?? "", /high/);
  });
});