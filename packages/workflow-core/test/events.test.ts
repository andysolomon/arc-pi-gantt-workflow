import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVENT_ENVELOPE_VERSION,
  MANDATORY_EVENT_GATES,
  MAX_EVENT_PAYLOAD_BYTES,
  assertEventEnvelope,
  isMandatoryEventGate,
  isQuestionEventEnvelope,
  validateEventEnvelope,
  type EventDiagnosticCode,
  type EventEnvelopeValidationResult,
} from "../src/events/index.ts";

type JsonObject = Record<string, unknown>;

const examplesDirectory = new URL("../../../examples/event-envelope/", import.meta.url);
const eventsSourceDirectory = new URL("../src/events/", import.meta.url);
const schemaPath = fileURLToPath(
  new URL("../schema/event-envelope.schema.json", import.meta.url),
);
const requireFromPackage = createRequire(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

type SchemaValidator = ((data: unknown) => boolean) & { errors?: unknown };

/** Compiles the published schema so the module can be held to the same contract. */
async function compileEnvelopeSchema(): Promise<SchemaValidator> {
  const Ajv2020 = requireFromPackage("ajv/dist/2020.js") as new (options: {
    allErrors: boolean;
    strict: boolean;
  }) => { compile(schema: unknown): SchemaValidator };
  const addFormats = requireFromPackage("ajv-formats") as (ajv: unknown) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(await readFile(schemaPath, "utf8")));
}

async function readExample(name: string): Promise<JsonObject> {
  const raw = await readFile(new URL(name, examplesDirectory), "utf8");
  return JSON.parse(raw) as JsonObject;
}

async function question(): Promise<JsonObject> {
  return readExample("valid-question.json");
}

async function progress(): Promise<JsonObject> {
  return readExample("valid-progress.json");
}

function codes(result: EventEnvelopeValidationResult): EventDiagnosticCode[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function paths(result: EventEnvelopeValidationResult): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.path);
}

function assertValid(value: unknown, label: string): void {
  const result = validateEventEnvelope(value);
  assert.equal(
    result.valid,
    true,
    `${label}: ${JSON.stringify(result.diagnostics)}`,
  );
}

function assertRejected(
  value: unknown,
  code: EventDiagnosticCode,
  path: string,
): EventEnvelopeValidationResult {
  const result = validateEventEnvelope(value);
  assert.equal(result.valid, false, `${path} should be rejected`);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === code && diagnostic.path === path,
    ),
    `expected ${code} at ${path}, got ${JSON.stringify(result.diagnostics)}`,
  );
  return result;
}

test("valid example envelopes accept and expose their payload size", async () => {
  const questionEnvelope = await question();
  const progressEnvelope = await progress();

  const questionResult = validateEventEnvelope(questionEnvelope);
  assert.equal(
    questionResult.valid,
    true,
    JSON.stringify(questionResult.diagnostics),
  );
  assert.deepEqual(questionResult.diagnostics, []);
  assert.equal(
    questionResult.payload_bytes,
    Buffer.byteLength(JSON.stringify(questionEnvelope.payload), "utf8"),
  );
  assert.ok(questionResult.payload_bytes <= MAX_EVENT_PAYLOAD_BYTES);
  if (questionResult.valid) {
    // Validation returns the caller's object; it neither copies nor mutates.
    assert.equal(questionResult.envelope, questionEnvelope);
    assert.equal(isQuestionEventEnvelope(questionResult.envelope), true);
    assert.equal(questionResult.envelope.envelope_version, EVENT_ENVELOPE_VERSION);
  }

  const progressResult = validateEventEnvelope(progressEnvelope);
  assert.equal(progressResult.valid, true, JSON.stringify(progressResult.diagnostics));
  if (progressResult.valid) {
    assert.equal(isQuestionEventEnvelope(progressResult.envelope), false);
  }
  assert.deepEqual(progressEnvelope, await progress());
});

test("every envelope kind is accepted with a minimal payload", async () => {
  for (const kind of ["progress", "artifact", "verify", "error", "done"]) {
    const envelope = { ...(await progress()), kind };
    assertValid(envelope, `${kind} envelope`);
  }
});

test("unknown envelope versions and non-objects are rejected", async () => {
  for (const version of ["2.0.0", "1.0.1", "1", "1.0.0 ", 1, null]) {
    const envelope = { ...(await progress()), envelope_version: version };
    const result = assertRejected(
      envelope,
      "unsupported_version",
      "$.envelope_version",
    );
    // An unknown version short-circuits: v1 field rules cannot describe it.
    assert.equal(result.diagnostics.length, 1);
  }

  const missing = await progress();
  delete missing.envelope_version;
  assertRejected(missing, "missing_field", "$.envelope_version");

  for (const value of [null, undefined, 42, "envelope", [], [await progress()]]) {
    assertRejected(value, "invalid_envelope", "$");
  }
});

test("required envelope fields are reported when absent", async () => {
  for (const field of [
    "event_id",
    "workflow_slug",
    "item_id",
    "session_id",
    "emitted_at",
    "kind",
    "payload",
    "provenance",
  ]) {
    const envelope = await progress();
    delete envelope[field];
    assertRejected(envelope, "missing_field", `$.${field}`);
  }
});

test("extra fields are rejected at every level", async () => {
  const topLevel = { ...(await progress()), transcript: "leaked" };
  assertRejected(topLevel, "unknown_field", "$.transcript");

  const payload = await progress();
  payload.payload = { ...(payload.payload as JsonObject), stdout: "leaked" };
  assertRejected(payload, "unknown_field", "$.payload.stdout");

  const provenance = await progress();
  provenance.provenance = {
    ...(provenance.provenance as JsonObject),
    token: "leaked",
  };
  assertRejected(provenance, "unknown_field", "$.provenance.token");

  const option = await question();
  const optionPayload = option.payload as JsonObject;
  optionPayload.options = [{ label: "Integrate", weight: 1 }, { label: "Hold" }];
  assertRejected(option, "unknown_field", "$.payload.options[0].weight");
});

test("scalar field formats and bounds are enforced", async () => {
  const cases: ReadonlyArray<
    readonly [field: string, value: unknown, path: string]
  > = [
    ["event_id", "not-a-ulid", "$.event_id"],
    ["event_id", "81ARZ3NDEKTSV4RRFFQ69G5FAV", "$.event_id"],
    ["event_id", "01arz3ndektsv4rrffq69g5fav", "$.event_id"],
    ["workflow_slug", "Not A Slug", "$.workflow_slug"],
    ["workflow_slug", "-leading", "$.workflow_slug"],
    ["item_id", "", "$.item_id"],
    ["item_id", "x".repeat(65), "$.item_id"],
    ["item_id", 5, "$.item_id"],
    ["session_id", "s".repeat(129), "$.session_id"],
    ["emitted_at", "2026-09-03", "$.emitted_at"],
    ["emitted_at", "2026-13-03T00:00:00.000Z", "$.emitted_at"],
    ["emitted_at", "2026-02-30T00:00:00.000Z", "$.emitted_at"],
    ["emitted_at", "2026-09-03 00:00:00Z", "$.emitted_at"],
    ["emitted_at", "2026-09-03T00:00:00+0530", "$.emitted_at"],
    ["emitted_at", "2026-06-30T23:59:60Z", "$.emitted_at"],
    ["kind", "transcript", "$.kind"],
  ];

  for (const [field, value, path] of cases) {
    const envelope = { ...(await progress()), [field]: value };
    assertRejected(envelope, "invalid_field", path);
  }

  for (const emittedAt of [
    "2026-09-03T00:00:00Z",
    "2026-09-03T00:00:00.123456Z",
    "2024-02-29T23:59:59+05:30",
    "2026-09-03t00:00:00-08:00",
  ]) {
    assertValid(
      { ...(await progress()), emitted_at: emittedAt },
      `emitted_at ${emittedAt}`,
    );
  }
});

test("payload and provenance must be non-empty plain objects", async () => {
  const emptyPayload = { ...(await progress()), payload: {} };
  assertRejected(emptyPayload, "invalid_field", "$.payload");

  const arrayPayload = { ...(await progress()), payload: [] };
  assertRejected(arrayPayload, "invalid_field", "$.payload");

  const emptyProvenance = { ...(await progress()), provenance: {} };
  assertRejected(emptyProvenance, "invalid_field", "$.provenance");

  const longSource = {
    ...(await progress()),
    provenance: { source: "s".repeat(65) },
  };
  assertRejected(longSource, "invalid_field", "$.provenance.source");
});

test("question envelopes require question_id, text, options, and gate", async () => {
  for (const field of ["question_id", "text", "options", "gate"]) {
    const envelope = await question();
    const payload = { ...(envelope.payload as JsonObject) };
    delete payload[field];
    envelope.payload = payload;
    assertRejected(envelope, "missing_field", `$.payload.${field}`);
  }

  const nonQuestion = await progress();
  nonQuestion.payload = { summary: "Child session started" };
  assertValid(nonQuestion, "progress payload without question fields");
});

test("question options are bounded to between two and five entries", async () => {
  const tooFew = await question();
  (tooFew.payload as JsonObject).options = [{ label: "Integrate" }];
  assertRejected(tooFew, "invalid_field", "$.payload.options");

  const tooMany = await question();
  (tooMany.payload as JsonObject).options = Array.from(
    { length: 6 },
    (_, index) => ({ label: `Option ${index}` }),
  );
  assertRejected(tooMany, "invalid_field", "$.payload.options");

  const missingLabel = await question();
  (missingLabel.payload as JsonObject).options = [
    { description: "no label" },
    { label: "Hold" },
  ];
  assertRejected(missingLabel, "missing_field", "$.payload.options[0].label");

  const longDescription = await question();
  (longDescription.payload as JsonObject).options = [
    { label: "Integrate", description: "d".repeat(241) },
    { label: "Hold" },
  ];
  assertRejected(
    longDescription,
    "invalid_field",
    "$.payload.options[0].description",
  );
});

test("default_on_timeout is forbidden for mandatory gates", async () => {
  for (const gate of MANDATORY_EVENT_GATES) {
    assert.equal(isMandatoryEventGate(gate), true);
    const envelope = await question();
    const payload = envelope.payload as JsonObject;
    payload.gate = gate;
    payload.default_on_timeout = "Integrate";
    assertRejected(envelope, "gate_conflict", "$.payload.default_on_timeout");
  }
});

test("default_on_timeout is allowed when the gate is none", async () => {
  assert.equal(isMandatoryEventGate("none"), false);
  const envelope = await question();
  const payload = envelope.payload as JsonObject;
  payload.gate = "none";
  payload.default_on_timeout = "Hold";
  assertValid(envelope, "ungated question with a timeout default");
});

test("oversized payloads are rejected by UTF-8 byte length, not code points", async () => {
  const codePoints = 20_000;
  const multiByte = await progress();
  (multiByte.payload as JsonObject).summary = "é".repeat(codePoints);
  const rejected = assertRejected(multiByte, "payload_too_large", "$.payload");
  assert.equal(codes(rejected).length, 1);
  assert.ok(rejected.payload_bytes > MAX_EVENT_PAYLOAD_BYTES);

  // The same code-point count in ASCII stays under the byte bound, proving the
  // check is stricter than the schema's code-point maxLength.
  const singleByte = await progress();
  (singleByte.payload as JsonObject).summary = "a".repeat(codePoints);
  const accepted = validateEventEnvelope(singleByte);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.diagnostics));
  assert.ok(accepted.payload_bytes < MAX_EVENT_PAYLOAD_BYTES);

  const overLength = await progress();
  (overLength.payload as JsonObject).summary = "a".repeat(32_769);
  assertRejected(overLength, "invalid_field", "$.payload.summary");
});

test("diagnostics are deterministic and independent of key order", async () => {
  const base = await progress();
  delete base.item_id;
  const forward = {
    envelope_version: base.envelope_version,
    event_id: "nope",
    workflow_slug: "Bad Slug",
    session_id: base.session_id,
    emitted_at: base.emitted_at,
    kind: base.kind,
    payload: base.payload,
    provenance: base.provenance,
    extra: true,
  };
  const reordered = {
    extra: true,
    provenance: base.provenance,
    payload: base.payload,
    kind: base.kind,
    emitted_at: base.emitted_at,
    session_id: base.session_id,
    workflow_slug: "Bad Slug",
    event_id: "nope",
    envelope_version: base.envelope_version,
  };

  const first = validateEventEnvelope(forward);
  const second = validateEventEnvelope(forward);
  const third = validateEventEnvelope(reordered);

  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.deepEqual(first.diagnostics, third.diagnostics);
  assert.deepEqual(paths(first), [...paths(first)].sort());
  assert.deepEqual(codes(first).sort(), [
    "invalid_field",
    "invalid_field",
    "missing_field",
    "unknown_field",
  ]);
});

test("assertEventEnvelope narrows valid input and throws deterministic messages", async () => {
  const envelope: unknown = await question();
  assertEventEnvelope(envelope);
  assert.equal(envelope.kind, "question");

  const invalid = await progress();
  invalid.envelope_version = "2.0.0";
  assert.throws(
    () => {
      assertEventEnvelope(invalid);
    },
    (error: unknown) =>
      error instanceof TypeError &&
      error.message ===
        'Invalid event envelope: $.envelope_version: unsupported_version: envelope_version must be "1.0.0".',
  );
});

test("every envelope the validator accepts also satisfies the schema", async () => {
  const validateSchema = await compileEnvelopeSchema();
  const accepted: unknown[] = [await question(), await progress()];

  for (const kind of ["artifact", "verify", "error", "done"]) {
    accepted.push({ ...(await progress()), kind });
  }
  for (const gate of ["none", ...MANDATORY_EVENT_GATES]) {
    const envelope = await question();
    (envelope.payload as JsonObject).gate = gate;
    accepted.push(envelope);
  }
  const ungated = await question();
  const ungatedPayload = ungated.payload as JsonObject;
  ungatedPayload.gate = "none";
  ungatedPayload.default_on_timeout = "Hold";
  accepted.push(ungated);

  const boundary = await progress();
  (boundary.payload as JsonObject).summary = "a".repeat(32_000);
  accepted.push(boundary);

  for (const envelope of accepted) {
    assertValid(envelope, "candidate envelope");
    assert.equal(
      validateSchema(envelope),
      true,
      `schema rejected an accepted envelope: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
});

test("the byte bound and date-time rules are stricter than the schema", async () => {
  const validateSchema = await compileEnvelopeSchema();
  // Cases the schema allows but this module deliberately refuses.
  const stricter = [await progress(), await progress(), await progress()];
  (stricter[0]?.payload as JsonObject).summary = "é".repeat(20_000);
  (stricter[1] as JsonObject).emitted_at = "2026-09-03 00:00:00Z";
  (stricter[2] as JsonObject).emitted_at = "2026-06-30T23:59:60Z";

  for (const envelope of stricter) {
    assert.equal(validateSchema(envelope), true, "schema should allow it");
    assert.equal(validateEventEnvelope(envelope).valid, false, "module should refuse it");
  }
});

test("the events module stays pure and free of Pi or adapter imports", async () => {
  for (const file of ["index.ts", "types.ts", "validate.ts"]) {
    const source = await readFile(
      fileURLToPath(new URL(file, eventsSourceDirectory)),
      "utf8",
    );
    assert.doesNotMatch(source, /from\s+"node:/);
    assert.doesNotMatch(source, /\barc[-_]?pi\b/i);
    assert.doesNotMatch(source, /import\s+.*from\s+"\.\.\//);
    assert.doesNotMatch(source, /\bprocess\.|globalThis\./);
  }
});

test("present-but-undefined payload and provenance fields are rejected", async () => {
  const envelope = await progress();
  const payloadOnlyUndefined = {
    ...envelope,
    payload: { summary: undefined },
  };
  const payloadResult = validateEventEnvelope(payloadOnlyUndefined);
  assert.equal(payloadResult.valid, false, JSON.stringify(payloadResult));
  assert.ok(
    payloadResult.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "invalid_field" &&
        diagnostic.path === "$.payload.summary",
    ),
    JSON.stringify(payloadResult.diagnostics),
  );
  assert.ok(
    payloadResult.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "invalid_field" && diagnostic.path === "$.payload",
    ),
    JSON.stringify(payloadResult.diagnostics),
  );

  const provenanceOnlyUndefined = {
    ...envelope,
    provenance: { source: undefined },
  };
  const provenanceResult = validateEventEnvelope(provenanceOnlyUndefined);
  assert.equal(provenanceResult.valid, false, JSON.stringify(provenanceResult));
  assert.ok(
    provenanceResult.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "invalid_field" &&
        diagnostic.path === "$.provenance.source",
    ),
    JSON.stringify(provenanceResult.diagnostics),
  );
  assert.ok(
    provenanceResult.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "invalid_field" && diagnostic.path === "$.provenance",
    ),
    JSON.stringify(provenanceResult.diagnostics),
  );

  // Multi-undefined mix: reject every undefined key individually, plus the
  // empty-after-serialization diagnostic.
  const mixed = {
    ...envelope,
    payload: { summary: undefined, gate: undefined },
    provenance: { source: undefined, broker: undefined },
  };
  const mixedResult = validateEventEnvelope(mixed);
  assert.equal(mixedResult.valid, false);
  const paths = mixedResult.diagnostics.map((diagnostic) => diagnostic.path).sort();
  assert.deepEqual(paths, [
    "$.payload",
    "$.payload.gate",
    "$.payload.summary",
    "$.provenance",
    "$.provenance.broker",
    "$.provenance.source",
  ]);

  // Nothing-changing envelope must not gain spurious diagnostics.
  const original = await progress();
  const originalResult = validateEventEnvelope({ ...original });
  assert.equal(originalResult.valid, true, JSON.stringify(originalResult));
});
