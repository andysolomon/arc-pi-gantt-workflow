import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorktreeManager, WorktreeManager, type WorktreeFileSystem, type WorktreeGit } from "../src/index.ts";

class NoopPorts implements WorktreeFileSystem, WorktreeGit {
  async mkdir(_path: string): Promise<void> {}
  async createWorktree(_path: string, _root: string): Promise<void> {}
  async removeWorktree(_path: string, _root: string): Promise<void> {}
}

test("workflow-core root exports the worktree manager API", () => {
  const ports = new NoopPorts();
  const options = { repositoryRoot: "/repo", workflowSlug: "demo", fileSystem: ports, git: ports };
  const manager = createWorktreeManager(options);

  assert.equal(WorktreeManager, manager.constructor);
  assert.ok(manager instanceof WorktreeManager);
});
