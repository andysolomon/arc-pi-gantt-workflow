import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPhased,
  extractFlat,
  extractPlan,
} from "../src/import/index.ts";
import type { ModelProposalHook } from "../src/import/index.ts";
import type { NormalizeInput, GroupInput } from "../src/normalize/types.ts";

const repo = { id: "repo-1", path: "/tmp/repo" };

// ---------------------------------------------------------------------------
// Phased plans
// ---------------------------------------------------------------------------
describe("extractPhased", () => {
  const md = [
    "# Phase 1",
    "- [ ] Task A",
    "- [x] Task B",
    "## Phase 1.1",
    "- [ ] Sub-task C",
    "### Phase 1.1.1",
    "- [ ] Deep task D",
    "# Phase 2",
    "- [ ] Task E",
    "Random paragraph ignored",
  ].join("\n");

  it("produces phased form with correct groups", () => {
    const result = extractPhased(md, "test", repo);
    assert.equal(result.form, "phased");
    assert.equal(result.slug, "test");
    assert.deepStrictEqual(result.repository, repo);
    const topGroups = result.groups.filter((g) => g.kind === "group");
    assert.equal(topGroups.length, 2);
  });

  it("nests subgroups under parent headings", () => {
    const result = extractPhased(md, "test", repo);
    const phase1 = result.groups[0]!;
    assert.equal(phase1.kind, "group");
    if (phase1.kind === "group") {
      const subGroup = phase1.items.filter(
        (i): i is GroupInput => i.kind === "group",
      );
      assert.equal(subGroup.length, 1);
      assert.equal(subGroup[0]!.title, "Phase 1.1");
    }
  });

  it("assigns leaves with empty activation fields", () => {
    const result = extractPhased(md, "test", repo);
    const phase1 = result.groups[0]!;
    if (phase1.kind === "group") {
      const leaf = phase1.items.find((i) => i.kind === "leaf");
      assert.ok(leaf);
      if (leaf && leaf.kind === "leaf") {
        assert.equal(leaf.outcome, "");
        assert.equal(leaf.scope, "");
        assert.deepStrictEqual(leaf.acceptance_criteria, []);
        assert.equal(leaf.preserved_behavior, "");
      }
    }
  });

  it("ignores unknown markdown lines", () => {
    const result = extractPhased(md, "test", repo);
    const allTitles = JSON.stringify(result.groups);
    assert.ok(!allTitles.includes("Random paragraph ignored"));
  });
});

// ---------------------------------------------------------------------------
// Flat plans
// ---------------------------------------------------------------------------
describe("extractFlat", () => {
  const md = [
    "- [ ] Story one",
    "- [x] Story two",
    "  - [ ] Indented ignored",
    "Some text",
    "- [ ] Story three",
  ].join("\n");

  it("produces flat form with top-level checkboxes only", () => {
    const result = extractFlat(md, "flat-test", repo);
    assert.equal(result.form, "flat");
    assert.equal(result.stories.length, 3);
    assert.equal(result.stories[0]!.title, "Story one");
    assert.equal(result.stories[2]!.title, "Story three");
  });

  it("assigns stable sequential ids", () => {
    const result = extractFlat(md, "flat-test", repo);
    assert.equal(result.stories[0]!.id, "leaf-0");
    assert.equal(result.stories[1]!.id, "leaf-1");
    assert.equal(result.stories[2]!.id, "leaf-2");
  });
});

// ---------------------------------------------------------------------------
// Auto-detect
// ---------------------------------------------------------------------------
describe("extractPlan", () => {
  it("detects phased when headings present", () => {
    const result = extractPlan("# Heading\n- [ ] Item", "s", repo);
    assert.equal(result.form, "phased");
  });

  it("detects flat when no headings present", () => {
    const result = extractPlan("- [ ] Item\n- [ ] Item 2", "s", repo);
    assert.equal(result.form, "flat");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe("determinism", () => {
  const md = "# G\n- [ ] A\n## G2\n- [ ] B";

  it("produces identical output on repeated calls", () => {
    const a = extractPhased(md, "s", repo);
    const b = extractPhased(md, "s", repo);
    assert.deepStrictEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// ModelProposalHook is type-only
// ---------------------------------------------------------------------------
describe("ModelProposalHook", () => {
  it("is assignable as a type without runtime invocation", () => {
    const _hook: ModelProposalHook = async (_markdown: string): Promise<NormalizeInput> => {
      return { form: "flat", slug: "x", repository: repo, stories: [] };
    };
    assert.equal(typeof _hook, "function");
  });
});
