import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  REDACTED_VALUE,
  createRuntimeJournal,
  getDefaultJournalPath,
  safeJournalMetadata,
  type JournalFileSystem,
  type JournalRecord,
  type JournalValue,
  type RuntimeJournalOptions,
} from "../src/journal/index.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const journalSourcePath = fileURLToPath(
  new URL("../src/journal/index.ts", import.meta.url),
);

interface FileSystemCall {
  operation: "appendFile" | "chmod" | "mkdir";
  path: string;
  mode: number;
}

class FakeJournalFileSystem implements JournalFileSystem {
  readonly calls: FileSystemCall[] = [];
  readonly #contents = new Map<string, string>();
  readonly #modes = new Map<string, number>();

  async mkdir(
    path: string,
    options: { mode: number; recursive: true },
  ): Promise<void> {
    assert.equal(options.recursive, true);
    this.calls.push({ operation: "mkdir", path, mode: options.mode });
    this.#modes.set(path, options.mode);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.calls.push({ operation: "chmod", path, mode });
    if (!this.#modes.has(path)) {
      const error = new Error(`Missing fake path: ${path}`) as Error & {
        code: string;
      };
      error.code = "ENOENT";
      throw error;
    }
    this.#modes.set(path, mode);
  }

  async appendFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<void> {
    assert.equal(options.encoding, "utf8");
    this.calls.push({ operation: "appendFile", path, mode: options.mode });
    this.#contents.set(path, `${this.#contents.get(path) ?? ""}${data}`);
    if (!this.#modes.has(path)) {
      this.#modes.set(path, options.mode);
    }
  }

  content(path: string): string {
    return this.#contents.get(path) ?? "";
  }

  mode(path: string): number | undefined {
    return this.#modes.get(path);
  }
}

test("default path uses the ignored local runtime area and validates the slug", async () => {
  const path = getDefaultJournalPath(repositoryRoot, "journal-wave-02");
  assert.equal(
    path,
    resolve(
      repositoryRoot,
      ".arc/runtime/workflows/journal-wave-02/journal.ndjson",
    ),
  );
  assert.notEqual(
    dirname(path),
    resolve(repositoryRoot, ".arc/workflows/journal-wave-02"),
  );
  const gitignore = await readFile(resolve(repositoryRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.arc\/runtime\/$/m);
  assert.throws(
    () => getDefaultJournalPath(repositoryRoot, "../outside"),
    /Invalid workflow slug/,
  );
});

test("runtime journal requires its filesystem port and journal source has no node filesystem import", async () => {
  assert.throws(
    () =>
      createRuntimeJournal({
        workflowSlug: "missing-filesystem",
      } as RuntimeJournalOptions),
    /requires an injected fileSystem/,
  );

  const source = await readFile(journalSourcePath, "utf8");
  assert.doesNotMatch(source, /node:fs(?:\/promises)?/);
});

test("fake append preserves prior bytes, call order, and private modes", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const ids = ["record-1", "record-2"];
  const journal = createRuntimeJournal({
    workflowSlug: "example",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => ids.shift() as string,
    now: () => new Date("2026-09-03T12:34:56.000Z"),
  });

  await journal.append({ kind: "started", data: { attempt: 1 } });
  const priorBytes = new TextEncoder().encode(fileSystem.content(journal.path));
  await journal.append({ kind: "progress", data: { percent: 50 } });
  const allBytes = new TextEncoder().encode(fileSystem.content(journal.path));

  assert.deepEqual(allBytes.slice(0, priorBytes.length), priorBytes);
  assert.equal(fileSystem.content(journal.path).trimEnd().split("\n").length, 2);
  assert.equal(fileSystem.mode(dirname(journal.path)), 0o700);
  assert.equal(fileSystem.mode(journal.path), 0o600);
  assert.deepEqual(
    fileSystem.calls.map(({ operation, mode }) => [operation, mode]),
    [
      ["mkdir", 0o700],
      ["chmod", 0o700],
      ["chmod", 0o600],
      ["appendFile", 0o600],
      ["chmod", 0o600],
      ["mkdir", 0o700],
      ["chmod", 0o700],
      ["chmod", 0o600],
      ["appendFile", 0o600],
      ["chmod", 0o600],
    ],
  );
});

test("concurrent appends remain ordered and preserve every prior record", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const ids = ["concurrent-1", "concurrent-2", "concurrent-3"];
  const journal = createRuntimeJournal({
    workflowSlug: "concurrent",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => ids.shift() as string,
    now: () => new Date("2026-09-03T12:34:56.000Z"),
  });

  const appends = [
    journal.append({ kind: "first", data: { sequence: 1 } }),
    journal.append({ kind: "second", data: { sequence: 2 } }),
    journal.append({ kind: "third", data: { sequence: 3 } }),
  ];
  await Promise.all(appends);

  const records = fileSystem
    .content(journal.path)
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { id: string; kind: string });
  assert.deepEqual(
    records.map(({ id, kind }) => [id, kind]),
    [
      ["concurrent-1", "first"],
      ["concurrent-2", "second"],
      ["concurrent-3", "third"],
    ],
  );
});

test("injected time and ID produce deterministic canonical NDJSON", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "deterministic",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "01TESTID",
    now: () => new Date("2026-01-02T03:04:05.006Z"),
  });

  const record = await journal.append({
    kind: "evidence",
    sessionId: "session-1",
    itemId: "leaf-1",
    data: { z: true, nested: { beta: 2, alpha: 1 }, a: false },
  });

  assert.deepEqual(record, {
    id: "01TESTID",
    recorded_at: "2026-01-02T03:04:05.006Z",
    workflow_slug: "deterministic",
    kind: "evidence",
    item_id: "leaf-1",
    session_id: "session-1",
    data: { a: false, nested: { alpha: 1, beta: 2 }, z: true },
  });
  assert.equal(
    fileSystem.content(journal.path),
    '{"data":{"a":false,"nested":{"alpha":1,"beta":2},"z":true},"id":"01TESTID","item_id":"leaf-1","kind":"evidence","recorded_at":"2026-01-02T03:04:05.006Z","session_id":"session-1","workflow_slug":"deterministic"}\n',
  );
  assert.deepEqual(JSON.parse(fileSystem.content(journal.path)), record);
});

test("signed zero is normalized to the persisted JSON representation", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "signed-zero",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "signed-zero-record",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  const record = await journal.append({
    kind: "numeric-event",
    data: { negativeZero: -0, nested: [-0, 1] },
  });

  assert.deepEqual(record.data, { negativeZero: 0, nested: [0, 1] });
  assert.equal(Object.is((record.data as Record<string, JournalValue>)["negativeZero"], -0), false);
  assert.deepEqual(JSON.parse(fileSystem.content(journal.path)), record);
});

test("runtime-cast record metadata must be strings before filesystem access", async () => {
  const fileSystem = new FakeJournalFileSystem();
  let createdIds = 0;
  const journal = createRuntimeJournal({
    workflowSlug: "runtime-metadata",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => {
      createdIds += 1;
      return "valid-id";
    },
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  for (const entry of [
    { kind: 1 },
    { kind: "event", itemId: 1 },
    { kind: "event", sessionId: { value: "session" } },
  ]) {
    await assert.rejects(journal.append(entry as never), /must be a string/);
  }

  const invalidIdJournal = createRuntimeJournal({
    workflowSlug: "runtime-id",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => 42 as never,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });
  await assert.rejects(
    invalidIdJournal.append({ kind: "event" }),
    /record id must be a string/,
  );
  assert.throws(
    () => safeJournalMetadata(42 as never),
    /Invalid safe journal metadata/,
  );
  assert.throws(
    () => safeJournalMetadata({ toString: () => "ok" } as never),
    /Invalid safe journal metadata/,
  );

  assert.equal(createdIds, 0);
  assert.deepEqual(fileSystem.calls, []);
  assert.equal(fileSystem.content(journal.path), "");
});

test("non-finite numbers fail before any filesystem operation", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "finite-only",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "finite-only-record",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  for (const data of [
    { nested: [Number.NaN] },
    { secretValue: Number.POSITIVE_INFINITY },
    { output: { value: Number.NEGATIVE_INFINITY } },
  ]) {
    await assert.rejects(
      journal.append({ kind: "invalid-number", data }),
      /only finite numbers/,
    );
  }

  assert.deepEqual(fileSystem.calls, []);
  assert.equal(fileSystem.content(journal.path), "");
});

test("unsupported runtime shapes fail before enqueue or filesystem access", async () => {
  const fileSystem = new FakeJournalFileSystem();
  let createdIds = 0;
  const journal = createRuntimeJournal({
    workflowSlug: "json-safe-only",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => {
      createdIds += 1;
      return `unexpected-${createdIds}`;
    },
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });
  const sparse = new Array<unknown>(2);
  sparse[1] = 1;
  const symbolKeyed = { value: 1 };
  Object.defineProperty(symbolKeyed, Symbol("unsupported-key"), {
    enumerable: true,
    value: "hidden from JSON",
  });
  const arrayWithUnsupportedProperty = Object.assign([1], {
    extra: 2,
  });
  class ArraySubclass extends Array<unknown> {}
  const arraySubclass = new ArraySubclass(1);
  arraySubclass[0] = 1;
  class RecordSubclass {
    value = 1;
  }
  const cyclicObject: Record<string, unknown> = {};
  cyclicObject["self"] = cyclicObject;
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  const unsupported: Array<[string, unknown]> = [
    ["undefined", { nested: undefined }],
    ["function", { secretValue: () => "must not run" }],
    ["symbol", [Symbol("unsupported")]],
    ["symbol key", symbolKeyed],
    ["bigint", { value: 1n }],
    ["sparse hole", sparse],
    ["unsupported array property", arrayWithUnsupportedProperty],
    ["array subclass", arraySubclass],
    ["object subclass", new RecordSubclass()],
    ["date", new Date("2026-09-03T00:00:00.000Z")],
    ["map", new Map([["value", 1]])],
    ["set", new Set([1])],
    ["regular expression", /value/u],
    ["cyclic object", cyclicObject],
    ["cyclic array", cyclicArray],
  ];

  for (const [name, data] of unsupported) {
    await assert.rejects(
      journal.append({ kind: "invalid-runtime", data } as never),
      TypeError,
      name,
    );
  }

  assert.equal(createdIds, 0);
  assert.deepEqual(fileSystem.calls, []);
  assert.equal(fileSystem.content(journal.path), "");
});

test("an own __proto__ key remains data without changing object prototypes", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "prototype-safe",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "prototype-safe-record",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });
  const data: Record<string, unknown> = {
    status: safeJournalMetadata("ok"),
  };
  Object.defineProperty(data, "__proto__", {
    enumerable: true,
    value: safeJournalMetadata("prototype-metadata"),
  });

  const record = await journal.append({
    kind: "prototype-key",
    data,
  } as never);
  const returnedData = record.data as Record<string, JournalValue>;
  const persisted = fileSystem.content(journal.path);
  const lines = persisted.trimEnd().split("\n");
  const parsed = JSON.parse(lines[0] as string) as JournalRecord;
  const parsedData = parsed.data as Record<string, JournalValue>;

  assert.equal(lines.length, 1);
  assert.equal(persisted.endsWith("\n"), true);
  assert.equal(Object.getPrototypeOf(returnedData), Object.prototype);
  assert.equal(Object.hasOwn(returnedData, "__proto__"), true);
  assert.equal(returnedData["__proto__"], "prototype-metadata");
  assert.equal(Object.getPrototypeOf(parsedData), Object.prototype);
  assert.equal(Object.hasOwn(parsedData, "__proto__"), true);
  assert.equal(parsedData["__proto__"], "prototype-metadata");
  assert.deepEqual(parsed, record);
});

test("plain safe-looking strings are redacted unless explicitly validated", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "nominal-safe-metadata",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "nominal-safe-record",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  const record = await journal.append({
    kind: "worker-event",
    data: {
      label: "production",
      source: "worker-1",
      reasonCode: "approved",
      status: "ok",
      author: "reviewer",
      safeMetadata: "retained-looking",
      arbitrary: "opaque-123",
      opaqueValues: {
        label: "sk-proj-abcdefghijklmnop",
        source: "AKIAIOSFODNN7EXAMPLE",
      },
      plainArray: ["alpha", "beta"],
      explicit: safeJournalMetadata("reviewed-v1"),
      explicitArray: [
        safeJournalMetadata("source-a"),
        safeJournalMetadata("source-b"),
      ],
      tokenValue: safeJournalMetadata("opaque-01"),
    },
  });

  assert.deepEqual(record.data, {
    arbitrary: REDACTED_VALUE,
    author: REDACTED_VALUE,
    explicit: "reviewed-v1",
    explicitArray: ["source-a", "source-b"],
    label: REDACTED_VALUE,
    plainArray: [REDACTED_VALUE, REDACTED_VALUE],
    reasonCode: REDACTED_VALUE,
    opaqueValues: {
      label: REDACTED_VALUE,
      source: REDACTED_VALUE,
    },
    safeMetadata: REDACTED_VALUE,
    source: REDACTED_VALUE,
    status: REDACTED_VALUE,
    tokenValue: REDACTED_VALUE,
  });
  assert.deepEqual(JSON.parse(fileSystem.content(journal.path)), record);
  assert.throws(
    () => safeJournalMetadata("sk-proj-abcdefghijklmnop"),
    /Invalid safe journal metadata/,
  );
  assert.throws(
    () => safeJournalMetadata("free form text"),
    /Invalid safe journal metadata/,
  );
});

test("recursive containing-key redaction retains only safe metadata", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "redaction-keys",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "redacted-keys",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  await journal.append({
    kind: "worker-event",
    data: {
      safeMetadata: safeJournalMetadata("retained"),
      sensitiveByKey: {
        secretValue: "opaque-01",
        passwordHash: "opaque-02",
        passphraseHint: "opaque-03",
        passwdDigest: "opaque-04",
        credentialHint: "opaque-05",
        apiKeySuffix: "opaque-06",
        accessTokenEnvelope: "opaque-07",
        refreshTokenEnvelope: "opaque-08",
        authHeader: "opaque-09",
        tokenValue: "opaque-10",
        private_key_material: "opaque-11",
        cookieJar: "opaque-12",
      },
      unsafeTextByKey: {
        executionTranscript: "opaque-13",
        priorHistory: "opaque-14",
        originalPrompt: "opaque-15",
        modelResponse: "opaque-16",
        completionText: "opaque-17",
        conversationLog: "opaque-18",
        dialogueTurns: "opaque-19",
        rawContentBuffer: "opaque-20",
        messagePayload: "opaque-21",
      },
    },
  });

  const persisted = fileSystem.content(journal.path);
  for (const forbidden of [
    "opaque-01",
    "opaque-02",
    "opaque-03",
    "opaque-04",
    "opaque-05",
    "opaque-06",
    "opaque-07",
    "opaque-08",
    "opaque-09",
    "opaque-10",
    "opaque-11",
    "opaque-12",
    "opaque-13",
    "opaque-14",
    "opaque-15",
    "opaque-16",
    "opaque-17",
    "opaque-18",
    "opaque-19",
    "opaque-20",
    "opaque-21",
  ]) {
    assert.equal(persisted.includes(forbidden), false, forbidden);
  }

  const record = JSON.parse(persisted) as { data: Record<string, unknown> };
  assert.equal(record.data["safeMetadata"], "retained");
  assert.deepEqual(record.data["sensitiveByKey"], {
    apiKeySuffix: REDACTED_VALUE,
    accessTokenEnvelope: REDACTED_VALUE,
    authHeader: REDACTED_VALUE,
    cookieJar: REDACTED_VALUE,
    credentialHint: REDACTED_VALUE,
    passphraseHint: REDACTED_VALUE,
    passwdDigest: REDACTED_VALUE,
    passwordHash: REDACTED_VALUE,
    private_key_material: REDACTED_VALUE,
    refreshTokenEnvelope: REDACTED_VALUE,
    secretValue: REDACTED_VALUE,
    tokenValue: REDACTED_VALUE,
  });
  assert.deepEqual(record.data["unsafeTextByKey"], {
    completionText: REDACTED_VALUE,
    conversationLog: REDACTED_VALUE,
    dialogueTurns: REDACTED_VALUE,
    executionTranscript: REDACTED_VALUE,
    messagePayload: REDACTED_VALUE,
    modelResponse: REDACTED_VALUE,
    originalPrompt: REDACTED_VALUE,
    priorHistory: REDACTED_VALUE,
    rawContentBuffer: REDACTED_VALUE,
  });
});

test("role, type, author, and speaker objects redact content but retain metadata", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "redaction-content",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "redacted-content",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  await journal.append({
    kind: "worker-event",
    data: {
      entries: [
        {
          role: safeJournalMetadata("user"),
          content: "raw role content",
          sequence: 1,
        },
        {
          type: safeJournalMetadata("tool"),
          content: "raw type content",
          status: safeJournalMetadata("ok"),
        },
        {
          author: safeJournalMetadata("worker"),
          content: "raw author content",
          id: safeJournalMetadata("worker-1"),
        },
        {
          speaker: safeJournalMetadata("reviewer"),
          content: "raw speaker content",
          turn: 2,
        },
      ],
    },
  });

  const record = JSON.parse(fileSystem.content(journal.path)) as {
    data: { entries: unknown[] };
  };
  assert.deepEqual(record.data.entries, [
    { content: REDACTED_VALUE, role: "user", sequence: 1 },
    { content: REDACTED_VALUE, status: "ok", type: "tool" },
    { author: "worker", content: REDACTED_VALUE, id: "worker-1" },
    { content: REDACTED_VALUE, speaker: "reviewer", turn: 2 },
  ]);
});

test("recognizable inline secret values are redacted before persistence", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const inlineSecrets = [
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "deploy with password=hunter2 now",
    "credential: production-credential-value",
    "refresh_token='refresh-token-value'",
    "postgres://admin:database-password@example.invalid/db",
    "-----BEGIN PRIVATE KEY----- confidential",
  ];
  const journal = createRuntimeJournal({
    workflowSlug: "redaction-inline",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "redacted-inline",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  await journal.append({
    kind: "worker-event",
    data: { safe: safeJournalMetadata("retained"), details: inlineSecrets },
  });

  const persisted = fileSystem.content(journal.path);
  for (const secret of inlineSecrets) {
    assert.equal(persisted.includes(secret), false, secret);
  }
  const record = JSON.parse(persisted) as {
    data: { details: unknown[]; safe: string };
  };
  assert.deepEqual(record.data.details, inlineSecrets.map(() => REDACTED_VALUE));
  assert.equal(record.data.safe, "retained");
});

test("secret-valued dynamic property keys are redacted before persistence", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const dynamicSecretKeys = [
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "password=dynamic-secret-value",
    "postgres://admin:database-password@example.invalid/db",
  ];
  const journal = createRuntimeJournal({
    workflowSlug: "redaction-dynamic-keys",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "redacted-dynamic-keys",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  const record = await journal.append({
    kind: "worker-event",
    data: {
      dynamicKeys: dynamicSecretKeys.map((key) => ({
        [key]: safeJournalMetadata("retained"),
      })),
    },
  });

  const persisted = fileSystem.content(journal.path);
  for (const secretKey of dynamicSecretKeys) {
    assert.equal(persisted.includes(secretKey), false, secretKey);
  }
  assert.deepEqual(record.data, {
    dynamicKeys: [
      { [REDACTED_VALUE]: "retained" },
      { [REDACTED_VALUE]: REDACTED_VALUE },
      { [REDACTED_VALUE]: REDACTED_VALUE },
    ],
  });
  assert.deepEqual(JSON.parse(persisted), record);
});

test("fail-closed redaction removes unlabelled transcripts and arbitrary strings", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const ids = ["plain-record", "array-record", "fail-closed-record"];
  const journal = createRuntimeJournal({
    workflowSlug: "fail-closed",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => ids.shift() as string,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  const forbidden = [
    "plain transcript without a label",
    "user: explain the private incident",
    "assistant: here is the private answer",
    "arbitrary free-form value",
    "array transcript line one",
    "array transcript line two",
  ];
  const plainRecord = await journal.append({
    kind: "plain-event",
    data: forbidden[0] as string,
  });
  const arrayRecord = await journal.append({
    kind: "array-event",
    data: [forbidden[4] as string, forbidden[5] as string],
  });
  const record = await journal.append({
    kind: "worker-event",
    data: {
      plain: forbidden[0] as string,
      rolePrefixed: [forbidden[1] as string, forbidden[2] as string],
      arbitrary: forbidden[3] as string,
      lines: [forbidden[4] as string, forbidden[5] as string],
      safeMetadata: safeJournalMetadata("retained"),
      status: safeJournalMetadata("ok"),
      attempt: 2,
    },
  });

  const persisted = fileSystem.content(journal.path);
  for (const value of forbidden) {
    assert.equal(persisted.includes(value), false, value);
  }
  assert.equal(plainRecord.data, REDACTED_VALUE);
  assert.deepEqual(arrayRecord.data, [REDACTED_VALUE, REDACTED_VALUE]);
  assert.deepEqual(record.data, {
    arbitrary: REDACTED_VALUE,
    attempt: 2,
    lines: [REDACTED_VALUE, REDACTED_VALUE],
    plain: REDACTED_VALUE,
    rolePrefixed: [REDACTED_VALUE, REDACTED_VALUE],
    safeMetadata: "retained",
    status: "ok",
  });
  assert.equal(record.id, "fail-closed-record");
  assert.equal(record.kind, "worker-event");
  assert.equal(record.recorded_at, "2026-09-03T00:00:00.000Z");
  assert.equal(record.workflow_slug, "fail-closed");
});

test("compound secrets, environment assignments, and process output are redacted", async () => {
  const fileSystem = new FakeJournalFileSystem();
  const journal = createRuntimeJournal({
    workflowSlug: "adversarial-fields",
    rootDirectory: "/workspace/repository",
    fileSystem,
    createId: () => "adversarial-record",
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });

  const forbidden = [
    "compound-secret-value",
    "AKIAIOSFODNN7EXAMPLE",
    "AWS_REGION=us-east-1",
    "raw command output",
    "raw standard error",
    "raw standard output",
    "raw build log",
    "raw role text",
    "raw type text",
    "raw author text",
    "raw speaker text",
  ];
  await journal.append({
    kind: "worker-event",
    data: {
      AWS_SECRET_ACCESS_KEY: forbidden[0] as string,
      AWS_ACCESS_KEY_ID: forbidden[1] as string,
      environmentAssignment: forbidden[2] as string,
      output: forbidden[3] as string,
      stderr: forbidden[4] as string,
      stdout: forbidden[5] as string,
      buildLog: forbidden[6] as string,
      transcriptShape: [
        { role: "user", text: forbidden[7] as string },
        { type: "assistant", value: forbidden[8] as string },
        { author: "worker", body: forbidden[9] as string },
        { speaker: "reviewer", parts: [forbidden[10] as string] },
      ],
      safeMetadata: safeJournalMetadata("retained"),
      status: safeJournalMetadata("completed"),
    },
  });

  const persisted = fileSystem.content(journal.path);
  for (const value of forbidden) {
    assert.equal(persisted.includes(value), false, value);
  }
  const record = JSON.parse(persisted) as {
    data: Record<string, JournalValue>;
  };
  assert.equal(record.data["AWS_SECRET_ACCESS_KEY"], REDACTED_VALUE);
  assert.equal(record.data["AWS_ACCESS_KEY_ID"], REDACTED_VALUE);
  assert.equal(record.data["output"], REDACTED_VALUE);
  assert.equal(record.data["stderr"], REDACTED_VALUE);
  assert.equal(record.data["stdout"], REDACTED_VALUE);
  assert.equal(record.data["buildLog"], REDACTED_VALUE);
  assert.equal(record.data["safeMetadata"], "retained");
  assert.equal(record.data["status"], "completed");
});
