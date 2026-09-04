import assert from "node:assert/strict";
import { test } from "node:test";
import { WorktreeManager, type WorktreeFileSystem, type WorktreeGit, type WorktreeManagerOptions } from "../src/integrate/index.ts";

class FakePorts implements WorktreeFileSystem, WorktreeGit {
  readonly calls: string[] = [];
  async mkdir(path: string): Promise<void> { this.calls.push(`mkdir:${path}`); }
  async createWorktree(path: string, root: string): Promise<void> { this.calls.push(`create:${path}:${root}`); }
  async removeWorktree(path: string, root: string): Promise<void> { this.calls.push(`remove:${path}:${root}`); }
}

function manager(ports = new FakePorts(), mode?: "worktree" | "off") {
  const options: WorktreeManagerOptions = {
    repositoryRoot: "/repo",
    workflowSlug: "demo",
    fileSystem: ports,
    git: ports,
  };
  if (mode !== undefined) options.mode = mode;
  return { manager: new WorktreeManager(options), ports };
}

test("creates one deterministic worktree per writing item by default", async () => {
  const { manager: subject, ports } = manager();
  const first = await subject.acquire("4.1");
  const second = await subject.acquire("4.1");
  assert.equal(first.path, "/repo/.arc/worktrees/demo/4.1");
  assert.equal(second.reused, true);
  assert.deepEqual(ports.calls, ["mkdir:/repo/.arc/worktrees/demo", "create:/repo/.arc/worktrees/demo/4.1:/repo"]);
});

test("concurrent acquisition of one item is single-flight", async () => {
  class DeferredPorts extends FakePorts {
    readonly release: Promise<void>;
    #resolve!: () => void;
    constructor() {
      super();
      this.release = new Promise<void>((resolve) => { this.#resolve = resolve; });
    }
    override async createWorktree(path: string, root: string): Promise<void> {
      await this.release;
      await super.createWorktree(path, root);
    }
    finish(): void { this.#resolve(); }
  }
  const ports = new DeferredPorts();
  const { manager: subject } = manager(ports);
  const first = subject.acquire("one");
  const second = subject.acquire("one");
  ports.finish();
  const [created, reused] = await Promise.all([first, second]);
  assert.equal(created.path, "/repo/.arc/worktrees/demo/one");
  assert.equal(reused.path, created.path);
  assert.equal(reused.reused, false);
  assert.deepEqual(ports.calls, ["mkdir:/repo/.arc/worktrees/demo", "create:/repo/.arc/worktrees/demo/one:/repo"]);
});

test("off mode performs no filesystem or git operation", async () => {
  const { manager: subject, ports } = manager(new FakePorts(), "off");
  const result = await subject.acquire("one");
  assert.deepEqual(result, { mode: "off", path: null, workflowSlug: "demo", itemId: "one", reused: false });
  await subject.cancel("one", "delete");
  assert.deepEqual(ports.calls, []);
});

test("items are isolated and cancellation requires an answer", async () => {
  const { manager: subject, ports } = manager();
  const one = await subject.acquire("one");
  const two = await subject.acquire("two");
  assert.notEqual(one.path, two.path);
  await assert.rejects(subject.cancel("one", undefined as never), /explicit preserve or delete/);
  await subject.cancel("one", "preserve");
  assert.equal(ports.calls.filter((call) => call.startsWith("remove:")).length, 0);
  await subject.cancel("one", "delete");
  assert.equal(ports.calls.filter((call) => call.startsWith("remove:")).length, 1);
  assert.equal((await subject.acquire("two")).path, "/repo/.arc/worktrees/demo/two");
  await assert.rejects(subject.cancel("missing", "delete"), /unowned/);
});

test("rejects unsafe identifiers and propagates operation failures", async () => {
  const { manager: subject, ports } = manager();
  for (const id of ["../x", "a/b", "a\\b", "", ".", ".."] ) {
    await assert.rejects(subject.acquire(id), /Invalid workflow item id/);
  }
  await assert.rejects(subject.acquire("valid", "../bad"), /Invalid workflow slug/);
  assert.throws(() => new WorktreeManager({ repositoryRoot: "relative", workflowSlug: "demo", fileSystem: ports, git: ports }), /absolute/);
  const failing = new FakePorts();
  failing.createWorktree = async () => { throw new Error("git failed"); };
  const broken = new WorktreeManager({ repositoryRoot: "/repo", workflowSlug: "demo", fileSystem: failing, git: failing });
  await assert.rejects(broken.acquire("one"), /git failed/);
  await assert.rejects(broken.cancel("one", "delete"), /unowned/);
  const failingFs = new FakePorts();
  failingFs.mkdir = async () => { throw new Error("filesystem failed"); };
  const brokenFs = new WorktreeManager({ repositoryRoot: "/repo", workflowSlug: "demo", fileSystem: failingFs, git: failingFs });
  await assert.rejects(brokenFs.acquire("one"), /filesystem failed/);
  assert.equal(ports.calls.length, 0);
});
