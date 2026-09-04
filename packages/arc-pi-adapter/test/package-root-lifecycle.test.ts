import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionLifecycle,
  createSessionLifecycle,
} from "@arc/pi-workflow";

test("package root exposes the session lifecycle class and factory", () => {
  assert.equal(typeof SessionLifecycle, "function");
  assert.equal(typeof createSessionLifecycle, "function");
});
