import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

interface PackageManifest {
  readonly keywords?: readonly string[];
  readonly repository?: { readonly type?: string; readonly url?: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
  readonly files?: readonly string[];
  readonly pi?: { readonly extensions?: readonly string[] };
}

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackFile[];
}

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function readRootManifest(): Promise<PackageManifest> {
  const source = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
  return JSON.parse(source) as PackageManifest;
}

test("root manifest is a source-loaded, discoverable Pi package", async () => {
  const manifest = await readRootManifest();
  assert.ok(manifest.keywords?.includes("pi-package"));
  assert.equal(manifest.repository?.type, "git");
  assert.match(manifest.repository?.url ?? "", /github\.com\/andysolomon\/arc-pi-gantt-workflow/);
  assert.match(manifest.homepage ?? "", /github\.com\/andysolomon\/arc-pi-gantt-workflow/);
  assert.match(manifest.bugs?.url ?? "", /\/issues$/);
  assert.deepEqual(manifest.pi?.extensions, [
    "./packages/arc-pi-adapter/src/extension.ts",
  ]);
  assert.ok(manifest.files?.includes("packages/arc-pi-adapter/src/"));
  assert.ok(manifest.files?.includes("packages/workflow-core/schema/"));
  assert.ok(manifest.files?.includes("docs/USER_GUIDE.md"));
});

test("the actual package file list excludes local agent state and test code", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = JSON.parse(raw) as readonly PackResult[];
  const files = result[0]?.files.map((entry) => entry.path) ?? [];
  assert.ok(files.includes("packages/arc-pi-adapter/src/extension.ts"));
  assert.ok(files.includes("packages/workflow-core/schema/workflow.schema.json"));
  assert.ok(files.includes("packages/arc-pi-adapter/package.json"));
  assert.ok(files.includes("docs/USER_GUIDE.md"));
  assert.equal(files.some((path) => /(^|\/)(\.agents|\.claude|\.arc|node_modules|test)(\/|$)/u.test(path)), false);
  assert.equal(files.some((path) => path.endsWith(".tsbuildinfo")), false);
  assert.equal(files.some((path) => path.startsWith("packages/") && path.includes("/test/")), false);
});
