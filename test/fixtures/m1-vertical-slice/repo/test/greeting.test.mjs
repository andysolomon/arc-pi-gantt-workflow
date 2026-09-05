// Disposable-repo acceptance test for the M1 vertical slice.
//
// This test lives in the disposable repo copy created by the integration
// test (Phase 5.3). It is intentionally small and dependency-free so the
// verify command (`node --test <path>`) exits 0 without external setup.
//
// The leaf's implementation contract is that `greeting.ts` exports a
// `greet(name)` function returning `"hello, <name>"`. Before the leaf runs,
// this file imports the function and the test fails with a useful error;
// after the leaf lands the test passes.

import { test } from "node:test";
import assert from "node:assert/strict";

test("greet(name) returns the documented greeting", async () => {
  const mod = await import("../src/greeting.ts");
  assert.equal(typeof mod.greet, "function");
  assert.equal(mod.greet("m1"), "hello, m1");
});