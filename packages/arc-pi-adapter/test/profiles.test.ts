import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHILD_PROFILES,
  CHILD_PROFILE_IDS,
  WORKFLOW_EXTENSION_ID,
  getChildProfile,
  type ChildProfileId,
} from "@arc/pi-workflow";

const BASELINE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const FORBIDDEN_TOOLS = [
  WORKFLOW_EXTENSION_ID,
  "arc_delegate",
  "arc_delegate_status",
  "arc_delegate_cancel",
  "arc_ask_operator",
  "arc_terminal_start",
  "arc_terminal_status",
  "arc_terminal_list",
  "arc_terminal_kill",
  "arc_monitor_status",
  "arc_record_assumption",
  "arc_decisions",
  "arc_prompt_recommend",
  "arc_task_artifact",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
];

function profileOf(id: ChildProfileId) {
  const profile = CHILD_PROFILES.find((entry) => entry.id === id);
  assert.ok(profile, `profile ${id} should exist`);
  return profile;
}

test("CHILD_PROFILES exports exactly four profiles", () => {
  assert.equal(CHILD_PROFILES.length, 4);
});

test("CHILD_PROFILE_IDS lists the four settled names", () => {
  assert.deepEqual(
    [...CHILD_PROFILE_IDS].sort(),
    ["explore-research", "implement", "plan-analyze", "verify-review"].sort(),
  );
});

test("profile ids are unique and exhaustive", () => {
  const ids = CHILD_PROFILES.map((profile) => profile.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  assert.deepEqual(
    [...ids].sort(),
    [...CHILD_PROFILE_IDS].sort(),
    "ids must exhaust CHILD_PROFILE_IDS",
  );
});

test("each profile excludes WORKFLOW_EXTENSION_ID", () => {
  for (const profile of CHILD_PROFILES) {
    assert.ok(
      profile.excludes.includes(WORKFLOW_EXTENSION_ID),
      `${profile.id} must exclude ${WORKFLOW_EXTENSION_ID}`,
    );
  }
});

test("each profile excludes every forbidden tool", () => {
  for (const profile of CHILD_PROFILES) {
    for (const forbidden of FORBIDDEN_TOOLS) {
      assert.ok(
        profile.excludes.includes(forbidden),
        `${profile.id} must exclude ${forbidden}`,
      );
    }
  }
});

test("each profile excludes at least one subagent_* tool", () => {
  for (const profile of CHILD_PROFILES) {
    const subagent = profile.excludes.filter((tool) => tool.startsWith("subagent_"));
    assert.ok(
      subagent.length >= 1,
      `${profile.id} must exclude at least one subagent_* tool`,
    );
  }
});

test("allowlist never contains arc_*, subagent_*, or the workflow extension id", () => {
  for (const profile of CHILD_PROFILES) {
    for (const tool of profile.allowlist) {
      assert.doesNotMatch(tool, /^arc_/, `${profile.id} allowlist must not contain arc_* tools`);
      assert.doesNotMatch(
        tool,
        /^subagent_/,
        `${profile.id} allowlist must not contain subagent_* tools`,
      );
      assert.notEqual(
        tool,
        WORKFLOW_EXTENSION_ID,
        `${profile.id} allowlist must not include the workflow extension id`,
      );
    }
  }
});

test("implement profile exposes the full baseline allowlist", () => {
  const profile = profileOf("implement");
  assert.deepEqual(
    [...profile.allowlist].sort(),
    [...BASELINE_TOOLS].sort(),
  );
});

test("explore-research and plan-analyze are read-only", () => {
  for (const id of ["explore-research", "plan-analyze"] as const) {
    const profile = profileOf(id);
    assert.ok(!profile.allowlist.includes("edit"), `${id} must not allow edit`);
    assert.ok(!profile.allowlist.includes("write"), `${id} must not allow write`);
    assert.ok(!profile.allowlist.includes("bash"), `${id} must not allow bash`);
  }
});

test("verify-review runs commands but never edits or writes", () => {
  const profile = profileOf("verify-review");
  assert.ok(!profile.allowlist.includes("edit"), "verify-review must not allow edit");
  assert.ok(!profile.allowlist.includes("write"), "verify-review must not allow write");
});

test("getChildProfile returns the same object the array holds", () => {
  for (const id of CHILD_PROFILE_IDS) {
    const profile = getChildProfile(id);
    assert.equal(profile.id, id);
  }
});

test("getChildProfile throws on unknown ids", () => {
  assert.throws(
    // Cast to a deliberately invalid id to verify the runtime guard.
    () => getChildProfile("not-a-real-profile" as unknown as ChildProfileId),
    /unknown child profile id/,
  );
});
