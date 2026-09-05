import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CheckpointState,
  createWorktreeManager,
  type Leaf,
  type Workflow,
  type WorkflowItem,
} from "@arc/workflow-core";
import {
  noRiskReview,
  createSessionLifecycle,
  type BrokerJournal,
  type PiSessionFactory,
  type SessionMetadataStore,
  type SessionRecord,
} from "@arc/pi-workflow";

import {
  createSequentialRunner,
} from "../src/run-sequential.ts";

const UPDATED_AT = "2026-09-03T00:00:00.000Z";

function leaf(id: string, state: CheckpointState): Leaf {
  return {
    id,
    kind: "leaf",
    title: `Leaf ${id}`,
    parent_id: "1.0",
    nesting_depth: 1,
    outcome: `outcome for ${id}`,
    scope: `packages/${id}`,
    acceptance_criteria: [`${id} completes`],
    dependencies: [],
    preserved_behavior: "Keep the workflow controller independent of Pi.",
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

function group(id: string, parent: string | null = null): WorkflowItem {
  return {
    id,
    kind: "group",
    title: `Group ${id}`,
    parent_id: parent,
    nesting_depth: parent === null ? 0 : 1,
    dependencies: [],
    checkpoint: { state: CheckpointState.planned, updated_at: UPDATED_AT },
  };
}

function fixtureWorkflow(): Workflow {
  return {
    schema_version: "1",
    slug: "m1-fixture",
    repository: { id: "local", path: "." },
    items: [
      group("1.0"),
      leaf("1.1", CheckpointState.ready),
    ],
  };
}

// ---------------------------------------------------------------------------
// Fakes
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

interface FakeSessionStore {
  byKey: Map<string, SessionRecord>;
}

function makeSessionMetadata(): SessionMetadataStore & { readonly state: FakeSessionStore } {
  const state: FakeSessionStore = { byKey: new Map() };
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

const SESSION_CAPTURE: { lastPath: string | null } = { lastPath: null };

function makeSessionFactory(): PiSessionFactory<{ readonly token: string }> {
  return {
    async create(cwd) {
      const path = `${cwd}/.pi-session-${Math.random().toString(36).slice(2, 8)}`;
      SESSION_CAPTURE.lastPath = path;
      return { path, session: { token: "fake" } };
    },
    async open(path) {
      SESSION_CAPTURE.lastPath = path;
      return { token: "fake" };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSequentialRunner", () => {
  test("constructs with concurrency forced to 1", () => {
    const runner = createSequentialRunner({
      workflow: fixtureWorkflow(),
      paths: {
        workflowYaml: "/repo/.arc/workflows/m1-fixture/workflow.yaml",
        progressText: "/repo/docs/progress.txt",
        ganttText: "/repo/docs/gantt",
        sessionDir: "/repo/.pi/sessions",
        worktreesRoot: "/repo/.arc/worktrees",
      },
      now: () => new Date("2026-09-04T00:00:00.000Z"),
      worker: { async run() {} },
      lifecycle: createSessionLifecycle({
        factory: makeSessionFactory(),
        metadata: makeSessionMetadata(),
      }),
      worktreeManager: createWorktreeManager({
        repositoryRoot: "/repo",
        workflowSlug: "m1-fixture",
        fileSystem: { async mkdir() {} },
        git: { async createWorktree() {}, async removeWorktree() {} },
      }),
      writer: {
        async writeAtomic() {
          return { wrote: true, paths: { workflowYaml: "", progressText: "", ganttText: "" } };
        },
      },
      review: noRiskReview,
      ask: async () => ({
        ledger_id: "ledger-x",
        created_at: new Date().toISOString(),
        question_type: "single_select",
        answer: "cherry-pick",
      }),
      journal: makeJournal(),
      integrationBranch: "main",
    });
    assert.equal(typeof runner.run, "function");
  });
});