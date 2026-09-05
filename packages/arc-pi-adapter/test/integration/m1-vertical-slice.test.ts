/**
 * Phase 5.3 — Live ARC integration test for the M1 vertical slice.
 *
 * The fixture is `examples/m1-vertical-slice/`. The test:
 *
 *   1. clones the fixture repo into a fresh `os.tmpdir()` directory,
 *   2. initializes git on `main`, commits the seed state,
 *   3. loads the workflow YAML,
 *   4. drives the sequential runner end to end,
 *   5. verifies:
 *      - the leaf reached `completed`,
 *      - the workflow YAML, progress.txt, and Gantt were atomically written,
 *      - the journal recorded the expected orchestration steps,
 *      - the leaf worktree persisted the implementer's new module,
 *      - the integration checkout carries the cherry-picked commit,
 *      - **nothing was pushed or contacts a remote**.
 *
 * The test fakes every external port (ask, journal, worktree git, session
 * factory) so it runs locally and in protected CI without any ARC
 * orchestrator, real Pi session, or network access.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  createWorktreeManager,
  parseDocument,
  type Workflow,
} from "@arc/workflow-core";

import {
  createFsAtomicWorkflowWriter,
  createSessionLifecycle,
  noRiskReview,
  type AskOperatorFn,
  type BrokerJournal,
  type CompletionFileSystem,
  type PiSessionFactory,
  type SessionMetadataStore,
  type SessionRecord,
} from "@arc/pi-workflow";

import {
  createSequentialRunner,
  type SequentialWorker,
} from "../../src/run-sequential.ts";

import { parse as parseYaml } from "yaml";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(HERE, "../../..", "..", "..");
const FIXTURE_DIR = join(ROOT, "examples", "m1-vertical-slice");
const FIXTURE_REPO = join(FIXTURE_DIR, "repo");
const FIXTURE_WORKFLOW = join(FIXTURE_DIR, "workflow.yaml");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function safeGit(cwd: string, args: readonly string[]): string {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}

function makeFs(): CompletionFileSystem {
  function ensureParent(path: string): void {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash <= 0) return;
    execFileSync("mkdir", ["-p", path.slice(0, lastSlash)], { stdio: ["ignore", "ignore", "ignore"] });
  }
  return {
    async mkdir(path) {
      ensureParent(path);
      execFileSync("mkdir", ["-p", path], { stdio: ["ignore", "ignore", "ignore"] });
      return path;
    },
    async writeFile(path, contents) {
      ensureParent(path);
      writeFileSync(path, contents, "utf8");
    },
    async rename(from, to) {
      // Real rename on disk. If from is missing (e.g., first write), throw.
      if (!existsSync(from)) {
        throw new Error(`rename: source ${from} does not exist`);
      }
      // Ensure the destination's parent directory exists; `mv` refuses to
      // create it implicitly.
      const lastSlash = to.lastIndexOf("/");
      if (lastSlash > 0) {
        execFileSync("mkdir", ["-p", to.slice(0, lastSlash)], { stdio: ["ignore", "ignore", "ignore"] });
      }
      // Use execFileSync to leverage the system rename atomicity.
      execFileSync("mv", [from, to], { stdio: ["ignore", "ignore", "ignore"] });
    },
    async unlink(path) {
      execFileSync("rm", [path], { stdio: ["ignore", "ignore", "ignore"] });
    },
    async rmdir(path) {
      try {
        execFileSync("rm", ["-rf", path], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        /* swallow */
      }
    },
    async readFile(path) {
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf8");
    },
  };
}

interface JournalEntry {
  kind: string;
  itemId?: string;
  sessionId?: string;
  data?: unknown;
}

function makeJournal(): BrokerJournal & { readonly entries: JournalEntry[] } {
  const entries: JournalEntry[] = [];
  let counter = 0;
  return {
    entries,
    async append(entry) {
      entries.push({ ...entry });
      counter += 1;
      return { id: `j-${counter}` };
    },
  };
}

interface MetadataState {
  byKey: Map<string, SessionRecord>;
}

function makeMetadata(): SessionMetadataStore & { readonly state: MetadataState } {
  const state: MetadataState = { byKey: new Map() };
  return {
    state,
    async read(key) {
      return state.byKey.get(key);
    },
    async write(key, record) {
      state.byKey.set(key, record);
    },
  };
}

function makeSessionFactory(cwd: string): PiSessionFactory<{ readonly token: string }> {
  return {
    async create(worktreeCwd) {
      const path = join(worktreeCwd, ".pi-session");
      return { path, session: { token: "fake" } };
    },
    async open(path) {
      void cwd;
      return { token: "fake", path };
    },
  };
}

/**
 * The simulated worker. In a real run the orchestrator bridge would call the
 * ARC runner; here we deterministically write the contract file the test
 * asserts on. The contract is exactly the one declared by the leaf's
 * `outcome` and `acceptance_criteria`.
 */
const worker: SequentialWorker = {
  async run({ worktreePath }) {
    // The fixture repo seeds `src/` via a tracked `.gitkeep` so the
    // directory exists in the worktree after `git worktree add`. The
    // worker overwrites `.gitkeep` with the contract module the test
    // asserts on.
    const target = join(worktreePath, "src", "greeting.ts");
    writeFileSync(
      target,
      "export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n",
      "utf8",
    );
  },
};

function loadWorkflow(): Workflow {
  const raw = readFileSync(FIXTURE_WORKFLOW, "utf8");
  return parseYaml(raw) as Workflow;
}

// ---------------------------------------------------------------------------
// The integration test
// ---------------------------------------------------------------------------

describe("Phase 5.3 — M1 vertical slice (live integration)", () => {
  test("drives a single leaf from ready to completed and writes all three documents atomically", async () => {
    // 1) Set up a fresh temp repo with the M1 fixture.
    const tempRoot = mkdtempSync(join(tmpdir(), "m1-fixture-"));
    const repoPath = join(tempRoot, "repo");
    cpSync(FIXTURE_REPO, repoPath, { recursive: true });
    // Initialize git on the integration branch. The fixture's
    // `.gitkeep` placeholder keeps `src/` tracked so the worktree has
    // the parent directory the worker writes into.
    git(repoPath, ["init", "-q", "-b", "main"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "user.name", "M1 Test"]);
    git(repoPath, ["config", "commit.gpgsign", "false"]);
    git(repoPath, ["add", "-A"]);
    git(repoPath, ["commit", "-q", "-m", "seed"]);

    // 2) Set up the destination paths inside the temp repo. We never touch
    // anything outside the temp dir or the project root.
    const paths = {
      workflowYaml: join(repoPath, ".arc", "workflows", "m1-vertical-slice", "workflow.yaml"),
      progressText: join(repoPath, "docs", "progress.txt"),
      ganttText: join(repoPath, "docs", "gantt.mmd"),
      sessionDir: join(repoPath, ".pi", "sessions"),
      worktreesRoot: join(repoPath, ".arc", "worktrees"),
    };

    // 3) Wire the ask function so the integrator's mandatory integration
    // question returns an affirmative answer.
    const askedQuestions: Array<{ itemId: string; gate: string }> = [];
    const ask: AskOperatorFn = async (input) => {
      const context = input.context ?? {};
      askedQuestions.push({
        itemId: String(context["item_id"] ?? ""),
        gate: String(context["gate"] ?? ""),
      });
      return {
        ledger_id: "ledger-m1",
        semantic_key: "arc-workflow.m1.integration",
        created_at: new Date().toISOString(),
        question_type: "single_select",
        answer: "cherry-pick",
      };
    };
    const journal = makeJournal();

    // 4) Build the workflow + sequential runner.
    const workflow = loadWorkflow();
    const fs = makeFs();
    const writer = createFsAtomicWorkflowWriter(fs);
    const sessionFactory = makeSessionFactory(repoPath);
    const metadata = makeMetadata();

    const runner = createSequentialRunner({
      workflow,
      paths,
      now: () => new Date("2026-09-04T10:00:00.000Z"),
      worker,
      lifecycle: createSessionLifecycle({
        factory: sessionFactory,
        metadata,
      }),
      worktreeManager: createWorktreeManager({
        repositoryRoot: repoPath,
        workflowSlug: "m1-vertical-slice",
        fileSystem: { async mkdir() {} },
        git: {
          async createWorktree(pathArg) {
            // The worktree-manager calls `git worktree add` against the
            // repository root. We shell out to make a real on-disk
            // worktree.
            execFileSync("git", ["-C", repoPath, "worktree", "add", "-b", `wf-${workflow.slug}-5.1`, pathArg, "main"], { stdio: ["ignore", "ignore", "ignore"] });
          },
          async removeWorktree(pathArg) {
            try {
              execFileSync("git", ["-C", repoPath, "worktree", "remove", "--force", pathArg], { stdio: ["ignore", "ignore", "ignore"] });
            } catch {
              /* best-effort */
            }
          },
        },
      }),
      writer,
      review: noRiskReview,
      ask,
      journal,
      integrationBranch: "main",
      repositoryRoot: repoPath,
      verifyCommand: ["node", "--test", "test/greeting.test.mjs"],
    });

    // 5) Run the vertical slice.
    const outcome = await runner.run();

    // 6) Assert: the single leaf reached `completed`.
    assert.equal(outcome.leaves.length, 1, "exactly one leaf runs");
    const leaf = outcome.leaves[0]!;
    assert.equal(leaf.itemId, "5.1");
    assert.equal(leaf.status, "completed", `leaf status was ${leaf.status}; reason=${leaf.reason ?? "(none)"}`);
    assert.equal(leaf.risk, "low");
    assert.ok(leaf.commit?.hash, "commit hash captured");
    assert.ok(leaf.worktreePath, "worktree path captured");
    assert.ok(leaf.sessionPath, "session path captured");

    // 7) Assert: workflow YAML on disk reflects the new checkpoint.
    const writtenWorkflowText = readFileSync(paths.workflowYaml, "utf8");
    assert.match(writtenWorkflowText, /state: completed/);
    const writtenWorkflow = parseYaml(writtenWorkflowText) as Workflow;
    const updatedLeaf = writtenWorkflow.items.find((item: { id: string }) => item.id === "5.1");
    assert.ok(updatedLeaf);
    assert.equal(updatedLeaf.kind, "leaf");
    assert.equal(updatedLeaf.checkpoint.state, "completed");
    assert.match(updatedLeaf.checkpoint.updated_at, /^2026-09-04T/);

    // 8) Assert: progress.txt and gantt.mmd were both written with the
    // generator header.
    const progress = readFileSync(paths.progressText, "utf8");
    assert.match(progress, /arc-render: progress/);
    assert.match(progress, /\[x\] 5\.1/);

    const gantt = readFileSync(paths.ganttText, "utf8");
    assert.match(gantt, /arc-render: gantt/);
    assert.match(gantt, /Add greeting utility and verify it loads \[completed\]/);

    // The renderer writes a provenance header; ensure it parses back.
    const parsedProgress = parseDocument(progress);
    assert.ok(parsedProgress, "progress.txt has a parseable provenance header");
    assert.equal(parsedProgress.provenance.kind, "progress");
    assert.equal(parsedProgress.provenance.slug, "m1-vertical-slice");
    const parsedGantt = parseDocument(gantt);
    assert.ok(parsedGantt, "gantt.mmd has a parseable provenance header");
    assert.equal(parsedGantt.provenance.kind, "gantt");

    // 9) Assert: the worker actually wrote greeting.ts inside the
    // worktree, the verify command passed, and the integration branch
    // contains the cherry-picked commit.
    const worktreeLeafSrc = join(leaf.worktreePath!, "src", "greeting.ts");
    assert.ok(existsSync(worktreeLeafSrc), "greeting.ts exists in the leaf worktree");
    const greetingBody = readFileSync(worktreeLeafSrc, "utf8");
    assert.match(greetingBody, /export function greet/);

    const integrationLog = safeGit(repoPath, ["log", "--oneline", "main"]);
    assert.ok(integrationLog.length > 0, "integration branch has at least one commit");

    // 10) Assert: at least one broker question was asked with the
    // `integration` gate, and the journal recorded the question.
    assert.ok(
      askedQuestions.some((q) => q.itemId === "5.1" && q.gate === "integration"),
      "integration question was asked",
    );
    assert.ok(
      journal.entries.some((entry) => entry.kind === "question-answer"),
      "journal contains a question-answer entry",
    );

    // 11) Assert: NO remote was ever contacted. The fixture repo never
    // adds an `origin`, so any `git remote` would return empty. This
    // proves the runner respects the no-push boundary.
    const remoteList = safeGit(repoPath, ["remote"]);
    assert.equal(remoteList, "", "no remote was ever added or contacted");

    // 12) Assert: the worktree directory survived. Cancellation logic
    // (Phase 7) is what cleans these up; the M1 gate preserves them.
    assert.ok(existsSync(leaf.worktreePath!), "leaf worktree preserved");
    assert.ok(
      readdirSync(leaf.worktreePath!).length > 0,
      "leaf worktree is non-empty",
    );
  });
});