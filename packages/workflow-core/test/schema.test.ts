import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromPackage = createRequire(join(here, "../package.json"));
const repoRoot = join(here, "../../..");
const schemaDir = join(here, "../schema");
const examplesDir = join(repoRoot, "examples");
const maxEnvelopeBytes = 32 * 1024;

type JsonObject = Record<string, unknown>;
type WorkflowItem = {
  id: string;
  dependencies?: string[];
};
type SchemaValidator = ((data: unknown) => boolean) & { errors?: unknown };
type Ajv2020Instance = {
  addSchema(schema: unknown): unknown;
  getSchema(id: string): SchemaValidator | undefined;
};

const Ajv2020 = requireFromPackage("ajv/dist/2020.js") as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => Ajv2020Instance;
const addFormats = requireFromPackage("ajv-formats") as (
  ajv: Ajv2020Instance,
) => void;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function compileValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const checkpoint = await readJson(join(schemaDir, "checkpoint.schema.json"));
  const envelope = await readJson(
    join(schemaDir, "event-envelope.schema.json"),
  );
  const workflow = await readJson(join(schemaDir, "workflow.schema.json"));
  ajv.addSchema(checkpoint);
  ajv.addSchema(envelope);
  ajv.addSchema(workflow);
  const checkpointId = "https://arc.dev/schema/checkpoint.schema.json";
  const envelopeId = "https://arc.dev/schema/event-envelope.schema.json";
  const workflowId = "https://arc.dev/schema/workflow.schema.json";
  const checkpointFn = ajv.getSchema(checkpointId);
  const envelopeFn = ajv.getSchema(envelopeId);
  const workflowFn = ajv.getSchema(workflowId);
  if (!checkpointFn || !envelopeFn || !workflowFn) {
    throw new Error("schema registration failed");
  }
  return {
    checkpoint: checkpointFn,
    envelope: envelopeFn,
    workflow: workflowFn,
  };
}

function assertValid(
  validate: { (data: unknown): boolean; errors?: unknown },
  data: unknown,
  label: string,
): void {
  assert.equal(validate(data), true, `${label}: ${JSON.stringify(validate.errors)}`);
}

function assertInvalid(
  validate: { (data: unknown): boolean; errors?: unknown },
  data: unknown,
  label: string,
): void {
  assert.equal(validate(data), false, `${label} should be rejected`);
}

function hasCycle(items: WorkflowItem[]): boolean {
  const deps = new Map(items.map((item) => [item.id, item.dependencies ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of deps.get(id) ?? []) {
      if (walk(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...deps.keys()].some(walk);
}

function payloadBytes(envelope: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(envelope.payload ?? {}), "utf8");
}

test("valid example fixtures accept", async () => {
  const validate = await compileValidators();
  const workflowJson = await readJson(
    join(examplesDir, "workflow/valid-phased.json"),
  );
  const workflowYaml = parseYaml(
    await readFile(join(examplesDir, "workflow/valid-phased.yaml"), "utf8"),
  );
  const checkpoint = await readJson(join(examplesDir, "checkpoint/valid.json"));
  const question = await readJson(
    join(examplesDir, "event-envelope/valid-question.json"),
  );
  const progress = await readJson(
    join(examplesDir, "event-envelope/valid-progress.json"),
  );

  assertValid(validate.workflow, workflowJson, "workflow json");
  assertValid(validate.workflow, workflowYaml, "workflow yaml");
  assert.deepEqual(workflowYaml, workflowJson);
  assertValid(validate.checkpoint, checkpoint, "checkpoint");
  assertValid(validate.envelope, question, "question envelope");
  assertValid(validate.envelope, progress, "progress envelope");
  assert.equal(payloadBytes(question as JsonObject) <= maxEnvelopeBytes, true);
});

test("missing leaf activation fields are rejected", async () => {
  const { workflow } = await compileValidators();
  const data = (await readJson(
    join(examplesDir, "workflow/valid-phased.json"),
  )) as JsonObject;
  const items = data.items as JsonObject[];
  const leaf = items.find((item) => item.kind === "leaf");
  assert.ok(leaf);
  delete leaf.outcome;
  assertInvalid(workflow, data, "leaf without outcome");
});

test("extra checkpoint states are rejected", async () => {
  const { checkpoint } = await compileValidators();
  assertInvalid(
    checkpoint,
    {
      state: "shipping",
      updated_at: "2026-09-03T00:00:00.000Z",
    },
    "shipping checkpoint",
  );
});

test("unknown envelope versions are rejected", async () => {
  const { envelope } = await compileValidators();
  const data = (await readJson(
    join(examplesDir, "event-envelope/valid-progress.json"),
  )) as JsonObject;
  data.envelope_version = "2.0.0";
  assertInvalid(envelope, data, "envelope 2.0.0");
});

test("unbounded collections are rejected", async () => {
  const { workflow } = await compileValidators();
  const data = (await readJson(
    join(examplesDir, "workflow/valid-phased.json"),
  )) as JsonObject;
  const leaf = (data.items as JsonObject[]).find((item) => item.kind === "leaf");
  assert.ok(leaf);
  leaf.dependencies = Array.from({ length: 21 }, (_, index) => `d${index}`);
  assertInvalid(workflow, data, "21 dependencies");

  const tooMany = (await readJson(
    join(examplesDir, "workflow/valid-phased.json"),
  )) as JsonObject;
  tooMany.items = Array.from({ length: 201 }, (_, index) => ({
    id: `i${index}`,
    kind: "group",
    title: `Item ${index}`,
    parent_id: null,
    nesting_depth: 0,
    dependencies: [],
    checkpoint: {
      state: "planned",
      updated_at: "2026-09-03T00:00:00.000Z",
    },
  }));
  assertInvalid(workflow, tooMany, "201 items");

  const deep = (await readJson(
    join(examplesDir, "workflow/valid-phased.json"),
  )) as JsonObject;
  const deepLeaf = (deep.items as JsonObject[]).find(
    (item) => item.kind === "leaf",
  );
  assert.ok(deepLeaf);
  deepLeaf.nesting_depth = 7;
  assertInvalid(workflow, deep, "nesting_depth 7");
});

test("reserved multi_repo cannot hold v1 repositories", async () => {
  const { workflow } = await compileValidators();
  const data = (await readJson(
    join(examplesDir, "workflow/valid-phased.json"),
  )) as JsonObject;
  data.multi_repo = [{ id: "other", path: "../other" }];
  assertInvalid(workflow, data, "multi_repo populated");
  data.multi_repo = [];
  assertValid(workflow, data, "empty reserved multi_repo");
});

test("dependency cycles are rejected", async () => {
  const items: WorkflowItem[] = [
    { id: "a", dependencies: ["b"] },
    { id: "b", dependencies: ["a"] },
  ];
  assert.equal(hasCycle(items), true);
  assert.equal(
    hasCycle([
      { id: "5.0", dependencies: [] },
      { id: "5.1", dependencies: ["5.0"] },
    ]),
    false,
  );
});

test("oversized envelope payloads are rejected", async () => {
  const { envelope } = await compileValidators();
  const data = (await readJson(
    join(examplesDir, "event-envelope/valid-progress.json"),
  )) as JsonObject;
  data.payload = { summary: "x".repeat(maxEnvelopeBytes + 1) };
  assert.equal(payloadBytes(data) > maxEnvelopeBytes, true);
  assertInvalid(envelope, data, "32 KiB+ payload");
});

test("default_on_timeout is forbidden on mandatory gates", async () => {
  const { envelope } = await compileValidators();
  const data = (await readJson(
    join(examplesDir, "event-envelope/valid-question.json"),
  )) as JsonObject;
  const payload = data.payload as JsonObject;
  payload.default_on_timeout = "Integrate";
  assertInvalid(envelope, data, "integration default_on_timeout");
  payload.gate = "none";
  assertValid(envelope, data, "ordinary default_on_timeout");
});
