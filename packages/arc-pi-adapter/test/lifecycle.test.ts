import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SessionLifecycle,
  type SessionMetadataStore,
  type SessionRecord,
} from "../src/sessions/index.ts";

function harness() {
  const records = new Map<string, SessionRecord>();
  let creates = 0;
  let opens = 0;
  const metadata: SessionMetadataStore = {
    read: (key: string) => records.get(key),
    write: (key: string, record: SessionRecord) => void records.set(key, record),
  };
  const factory = {
    create: (cwd: string) => ({ path: `/sessions/${++creates}.jsonl`, session: { id: creates }, cwd }),
    open: (path: string) => { opens++; return { id: Number(path.match(/(\d+)\.jsonl$/)?.[1]) }; },
  };
  return { records, factory, metadata, get creates() { return creates; }, get opens() { return opens; } };
}

const input = { workflowSlug: "demo", leaf: "implement", cwd: "/repo", sessionDir: "/sessions", profileId: "implement" as const };

test("creates once and reuses the in-process session", async () => {
  const h = harness();
  const lifecycle = new SessionLifecycle({ factory: h.factory, metadata: h.metadata });
  const first = await lifecycle.acquire(input);
  const second = await lifecycle.acquire(input);
  assert.equal(first.session, second.session);
  assert.equal(h.creates, 1);
  assert.equal(h.opens, 0);
  assert.equal(first.profile.id, "implement");
});

test("a new lifecycle opens the recorded path", async () => {
  const h = harness();
  const one = new SessionLifecycle({ factory: h.factory, metadata: h.metadata });
  const first = await one.acquire(input);
  const two = new SessionLifecycle({ factory: h.factory, metadata: h.metadata });
  const reopened = await two.acquire(input);
  assert.equal(reopened.record.sessionPath, first.record.sessionPath);
  assert.equal(h.creates, 1);
  assert.equal(h.opens, 1);
});

test("concurrent acquisition is single-flight", async () => {
  const h = harness();
  const lifecycle = new SessionLifecycle({ factory: h.factory, metadata: h.metadata });
  const results = await Promise.all(Array.from({ length: 8 }, () => lifecycle.acquire(input)));
  assert.equal(h.creates, 1);
  const first = results[0];
  assert.ok(first);
  assert.ok(results.every((result) => result.session === first.session));
});

test("concurrent mismatched acquisition does not receive another caller's session", async () => {
  const h = harness();
  const lifecycle = new SessionLifecycle<unknown, string>({
    factory: h.factory,
    metadata: h.metadata,
    ownerIdentity: (request) => request.options ?? "missing-owner",
  });
  const first = lifecycle.acquire({ ...input, options: "owner-a" });
  const mismatched = lifecycle.acquire({ ...input, options: "owner-b" });

  await assert.rejects(mismatched, /in-flight session owner mismatch/);
  const acquired = await first;
  assert.equal(h.creates, 1);
  assert.equal(h.opens, 0);
  assert.equal(acquired.record.ownerIdentity, "owner-a");
});

test("archive retains metadata and never disposes the session", async () => {
  const h = harness();
  const lifecycle = new SessionLifecycle({ factory: h.factory, metadata: h.metadata });
  await lifecycle.acquire(input);
  await lifecycle.archive(input);
  assert.equal(h.records.size, 1);
  assert.equal(h.creates, 1);
});

test("rejects unsafe and mismatched records", async () => {
  const h = harness();
  const lifecycle = new SessionLifecycle({ factory: h.factory, metadata: h.metadata });
  await lifecycle.acquire(input);
  const saved = [...h.records.values()][0];
  assert.ok(saved);
  h.records.set("demo\u0000implement", { ...saved, ownerIdentity: "other" });
  const restarted = new SessionLifecycle({ factory: h.factory, metadata: h.metadata });
  await assert.rejects(() => restarted.acquire(input), /owner mismatch/);
});

test("factory failures do not persist a record", async () => {
  const h = harness();
  const factory = { ...h.factory, create: () => { throw new Error("factory failed"); } };
  const lifecycle = new SessionLifecycle({ factory, metadata: h.metadata });
  await assert.rejects(() => lifecycle.acquire(input), /factory failed/);
  assert.equal(h.records.size, 0);
});
