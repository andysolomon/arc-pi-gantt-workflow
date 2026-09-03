import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PACKAGE_NAME } from "@arc/workflow-core";

test("workflow-core publishes its package identity", () => {
  assert.equal(PACKAGE_NAME, "@arc/workflow-core");
});

test("workflow-core does not depend on Pi packages", async () => {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  for (const name of names) {
    assert.doesNotMatch(name, /pi/i);
  }
});
