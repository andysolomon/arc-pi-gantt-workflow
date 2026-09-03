import assert from "node:assert/strict";
import { test } from "node:test";
import { PACKAGE_NAME } from "@arc/pi-workflow";

test("arc-pi-adapter publishes its package identity", () => {
  assert.equal(PACKAGE_NAME, "@arc/pi-workflow");
});
