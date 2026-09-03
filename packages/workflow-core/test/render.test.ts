import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECKPOINT_STATES,
  CheckpointState,
} from "../src/model/checkpoint.ts";
import type { Group, Leaf, Workflow, WorkflowItem } from "../src/model/workflow.ts";
import {
  CHECKPOINT_PRESENTATIONS,
  canonicalOrder,
  checkDrift,
  checkWorkflowDrift,
  fingerprint,
  parseDocument,
  presentationFor,
  renderGantt,
  renderProgressText,
  renderWorkflow,
  type RenderContext,
} from "../src/render/index.ts";

const CONTEXT: RenderContext = {
  generated_at: "2026-09-03T00:00:00.000Z",
  source: ".arc/workflows/render-fixture/workflow.yaml",
};

const UPDATED_AT = "2026-09-03T00:00:00.000Z";

function group(id: string, title: string, parent: string | null, state: CheckpointState): Group {
  return {
    id,
    kind: "group",
    title,
    parent_id: parent,
    nesting_depth: parent === null ? 0 : 1,
    dependencies: [],
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

function leaf(
  id: string,
  title: string,
  parent: string | null,
  state: CheckpointState,
  dependencies: string[] = [],
): Leaf {
  return {
    id,
    kind: "leaf",
    title,
    parent_id: parent,
    nesting_depth: parent === null ? 0 : 2,
    outcome: `outcome for ${id}`,
    scope: `packages/workflow-core/src/${id}`,
    acceptance_criteria: [`${id} is rendered`],
    dependencies,
    preserved_behavior: "Keep workflow-core independent of Pi.",
    checkpoint: { state, updated_at: UPDATED_AT },
  };
}

/** A fixture that exercises every checkpoint state, nesting, and dependencies. */
function fixture(items?: WorkflowItem[]): Workflow {
  return {
    schema_version: "1",
    slug: "render-fixture",
    repository: { id: "local", path: "." },
    items: items ?? [
      group("1.0", "Phase 1", null, CheckpointState.ready),
      leaf("1.1", "DAG model", "1.0", CheckpointState.completed),
      leaf("1.2", "Normalizer", "1.0", CheckpointState.ready, ["1.1"]),
      group("1.3", "Renderers", "1.0", CheckpointState.planned),
      leaf("1.3.1", "progress.txt", "1.3", CheckpointState.planned, ["1.1"]),
      leaf("1.3.2", "Gantt", "1.3", CheckpointState.blocked, ["1.3.1"]),
      leaf("1.10", "Importer", "1.0", CheckpointState.cancelled),
      leaf("2.1", "Journal", null, CheckpointState.needsReplan),
    ],
  };
}

function shuffled(items: readonly WorkflowItem[]): WorkflowItem[] {
  // Deterministic reordering: reverse, then rotate by three.
  const reversed = [...items].reverse();
  return [...reversed.slice(3), ...reversed.slice(0, 3)];
}

test("repeated renders of the same workflow are byte-identical", () => {
  const workflow = fixture();
  const first = renderWorkflow(workflow, CONTEXT);
  const second = renderWorkflow(fixture(), CONTEXT);

  assert.equal(first.progress.text, second.progress.text);
  assert.equal(first.gantt.text, second.gantt.text);
  assert.equal(
    first.progress.provenance.content_fingerprint,
    second.progress.provenance.content_fingerprint,
  );
  assert.equal(
    first.progress.provenance.source_fingerprint,
    second.progress.provenance.source_fingerprint,
  );
});

test("render output is stable under input reordering and sorts ids naturally", () => {
  const workflow = fixture();
  const reordered = fixture(shuffled(workflow.items));

  assert.notDeepEqual(
    workflow.items.map((item) => item.id),
    reordered.items.map((item) => item.id),
  );
  assert.equal(
    renderProgressText(workflow, CONTEXT).text,
    renderProgressText(reordered, CONTEXT).text,
  );
  assert.equal(
    renderGantt(workflow, CONTEXT).text,
    renderGantt(reordered, CONTEXT).text,
  );

  assert.deepEqual(
    canonicalOrder(reordered.items).map(({ item }) => item.id),
    ["1.0", "1.1", "1.2", "1.3", "1.3.1", "1.3.2", "1.10", "2.1"],
  );
  assert.deepEqual(
    canonicalOrder(workflow.items).map(({ depth }) => depth),
    [0, 1, 1, 1, 2, 2, 1, 0],
  );
});

test("progress projection renders all six checkpoint states with stable symbols", () => {
  const items = CHECKPOINT_STATES.map((state, index) =>
    leaf(`s.${index + 1}`, `Leaf ${state}`, null, state),
  );
  const { body } = renderProgressText(fixture(items), CONTEXT);
  const lines = body.split("\n");

  for (const presentation of CHECKPOINT_PRESENTATIONS) {
    const line = lines.find(
      (candidate) =>
        candidate.startsWith(presentation.symbol) &&
        candidate.includes(`Leaf ${presentation.state}`),
    );
    assert.ok(line, `missing line for ${presentation.state}`);
    assert.ok(
      line.endsWith(`(${presentation.label})`),
      `state label missing for ${presentation.state}: ${line}`,
    );
  }

  const symbols = CHECKPOINT_PRESENTATIONS.map((entry) => entry.symbol);
  assert.equal(new Set(symbols).size, symbols.length);
  assert.ok(body.includes("Legend:"));
  for (const presentation of CHECKPOINT_PRESENTATIONS) {
    assert.ok(body.includes(`${presentation.symbol} ${presentation.label}`));
  }
  assert.ok(
    body.includes(
      `Checkpoints: ${CHECKPOINT_STATES.map((state) => `${state}=1`).join(" ")}`,
    ),
  );
});

test("progress projection reports groups, leaves, nesting, and evidence", () => {
  const workflow = fixture();
  const { body } = renderProgressText(workflow, CONTEXT);

  assert.ok(body.startsWith("render-fixture - progress\n"));
  assert.ok(body.includes("Items: 8 (2 groups, 6 leaves)"));
  assert.ok(body.includes("[>] 1.0 - Phase 1 (ready)"));
  assert.ok(body.includes("    [x] 1.1 - DAG model (completed)"));
  assert.ok(body.includes("        [!] 1.3.2 - Gantt (blocked)"));

  const withEvidence = fixture([
    {
      ...leaf("1.1", "DAG model", null, CheckpointState.completed),
      checkpoint: {
        state: CheckpointState.completed,
        updated_at: UPDATED_AT,
        evidence_ref: "jrnl-1",
      },
    },
  ]);
  assert.ok(
    renderProgressText(withEvidence, CONTEXT).body.includes(
      "[x] 1.1 - DAG model (completed) [evidence: jrnl-1]",
    ),
  );
});

test("gantt projection is mermaid-shaped, ordered, and state-distinct", () => {
  const workflow = fixture();
  const { body } = renderGantt(workflow, CONTEXT);
  const lines = body.split("\n");

  assert.equal(lines[0], "gantt");
  assert.ok(lines.includes("    dateFormat YYYY-MM-DD"));
  assert.ok(lines.includes("    title render-fixture"));
  assert.ok(lines.includes("    section Phase 1 [ready]"));
  assert.ok(lines.includes("    section Renderers [planned]"));
  assert.ok(lines.includes("    section ungrouped"));

  // Baseline start for a task with no rendered dependency, `after` otherwise.
  assert.ok(lines.includes("    DAG model [completed] :done, t_1_1, 2026-09-03, 1d"));
  assert.ok(lines.includes("    Normalizer [ready] :active, t_1_2, after t_1_1, 1d"));
  assert.ok(lines.includes("    Gantt [blocked] :crit, t_1_3_2, after t_1_3_1, 1d"));

  const stateLines = CHECKPOINT_STATES.map((state) => {
    const single = renderGantt(fixture([leaf("1.1", "Task", null, state)]), CONTEXT);
    const taskLine = single.body
      .split("\n")
      .find((line) => line.includes("Task ["));
    assert.ok(taskLine, `missing gantt task for ${state}`);
    assert.ok(taskLine.includes(`[${presentationFor(state).label}]`));
    return taskLine;
  });
  assert.equal(new Set(stateLines).size, CHECKPOINT_STATES.length);
});

test("gantt titles cannot emit Mermaid comment lines", () => {
  const workflow = fixture([
    leaf("1.1", "%% hidden 100%", null, CheckpointState.ready),
  ]);
  const body = renderGantt(workflow, CONTEXT).body;

  assert.ok(body.includes("percentpercent hidden 100percent [ready]"));
  assert.equal(
    body.split("\\n").some((line) => /^\\s*%%/u.test(line)),
    false,
  );
});

test("gantt sequencing keeps dependencies whose target is rendered later", () => {
  // "1.1" depends on "1.9", which canonical id order places after it, and on a
  // group and an unknown id, neither of which is a gantt task.
  const workflow = fixture([
    group("1.0", "Phase 1", null, CheckpointState.ready),
    leaf("1.1", "Early", "1.0", CheckpointState.ready, ["1.9", "1.0", "nope"]),
    leaf("1.9", "Late", "1.0", CheckpointState.completed),
    leaf("2.1", "Both", null, CheckpointState.planned, ["1.9", "1.1", "1.9"]),
  ]);
  const lines = renderGantt(workflow, CONTEXT).body.split("\n");

  assert.ok(
    lines.includes("    Early [ready] :active, t_1_1, after t_1_9, 1d"),
    `forward dependency dropped: ${lines.join(" | ")}`,
  );
  // Duplicates collapse and dependency task ids stay in natural id order.
  assert.ok(lines.includes("    Both [planned] :t_2_1, after t_1_1 t_1_9, 1d"));
  // A leaf nothing points at still starts from the baseline.
  assert.ok(lines.includes("    Late [completed] :done, t_1_9, 2026-09-03, 1d"));

  // A self-dependency never makes a task wait on itself.
  const selfDependent = fixture([
    leaf("1.1", "Self", null, CheckpointState.ready, ["1.1"]),
  ]);
  assert.ok(
    renderGantt(selfDependent, CONTEXT).body.includes(
      "    Self [ready] :active, t_1_1, 2026-09-03, 1d",
    ),
  );
});

test("documents carry a parseable source fingerprint and provenance marker", () => {
  const workflow = fixture();
  const { progress, gantt } = renderWorkflow(workflow, CONTEXT);

  for (const document of [progress, gantt]) {
    const parsed = parseDocument(document.text);
    assert.ok(parsed, `${document.kind} header did not parse`);
    assert.deepEqual(parsed.provenance, document.provenance);
    assert.equal(parsed.body, document.body);
    assert.equal(document.provenance.kind, document.kind);
    assert.equal(document.provenance.slug, "render-fixture");
    assert.equal(document.provenance.source, CONTEXT.source);
    assert.match(document.provenance.source_fingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.match(document.provenance.content_fingerprint, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(document.text, `${document.text.split("\n\n")[0]}\n\n${document.body}`);
  }

  // The gantt header stays inside mermaid comments.
  for (const line of gantt.text.split("\n\n")[0]?.split("\n") ?? []) {
    assert.ok(line.startsWith("%% "), `gantt header line not commented: ${line}`);
  }

  // Provenance timestamps do not participate in the content fingerprint.
  const later = renderProgressText(workflow, {
    ...CONTEXT,
    generated_at: "2026-12-25T11:22:33.000Z",
  });
  assert.equal(later.provenance.content_fingerprint, progress.provenance.content_fingerprint);
  assert.notEqual(later.text, progress.text);
});

test("a cross-day gantt restamp changes only generated-at", () => {
  const workflow = fixture();
  const first = renderGantt(workflow, CONTEXT);
  const later = renderGantt(workflow, {
    ...CONTEXT,
    generated_at: "2027-01-15T11:22:33.000Z",
  });

  assert.equal(first.body, later.body);
  assert.equal(first.provenance.content_fingerprint, later.provenance.content_fingerprint);
  assert.notEqual(first.text, later.text);
  const report = checkDrift(first.text, later);
  assert.equal(report.status, "match");
  assert.equal(report.drifted, false);
  assert.equal(report.safe_to_overwrite, true);
});

test("cross-day restamps match with absent and literal dash sources", () => {
  for (const source of [undefined, "-"] as const) {
    const firstContext: RenderContext =
      source === undefined
        ? { generated_at: "2026-09-03" }
        : { generated_at: "2026-09-03", source };
    const laterContext: RenderContext =
      source === undefined
        ? { generated_at: "2027-01-15T11:22:33-05:00" }
        : { generated_at: "2027-01-15T11:22:33-05:00", source };
    const first = renderProgressText(fixture(), firstContext);
    const later = renderProgressText(fixture(), laterContext);

    assert.equal(checkDrift(first.text, later).status, "match");
    assert.equal(parseDocument(first.text)?.provenance.source, source ?? null);
  }
});

test("source provenance round-trips without sentinel or escape collisions", () => {
  const sources = [undefined, "-", "null", '"quoted"', "line one\nline two"] as const;
  const serialized = new Set<string>();

  for (const source of sources) {
    const context: RenderContext =
      source === undefined ? { generated_at: CONTEXT.generated_at } : { ...CONTEXT, source };
    const rendered = renderProgressText(fixture(), context);
    const sourceLine = rendered.text.split("\n")[4];
    assert.ok(sourceLine);
    assert.ok(sourceLine.startsWith("source: "));
    assert.ok(!serialized.has(sourceLine), `source collision for ${JSON.stringify(source)}`);
    serialized.add(sourceLine);
    assert.equal(parseDocument(rendered.text)?.provenance.source, source ?? null);
  }
});

test("a hand-edited generated document drifts instead of being overwritten", () => {
  const workflow = fixture();
  const rendered = renderProgressText(workflow, CONTEXT);
  const edited = rendered.text.replace(
    "[x] 1.1 - DAG model (completed)",
    "[x] 1.1 - DAG model (completed) <- hand edited",
  );
  assert.notEqual(edited, rendered.text);

  const report = checkDrift(edited, rendered);
  assert.equal(report.status, "content-drift");
  assert.equal(report.drifted, true);
  assert.equal(report.safe_to_overwrite, false);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0] ?? "", /edited by hand/u);
  assert.equal(report.actual?.content_fingerprint, rendered.provenance.content_fingerprint);

  // The check is a comparison, not a write: inputs are untouched and the fresh
  // render is handed back for the caller to decide what to do.
  assert.equal(report.rendered.text, rendered.text);
  assert.ok(edited.includes("<- hand edited"));

  // A hand edit is still drift when the workflow itself also moved on.
  const moved = fixture(
    workflow.items.map((item) =>
      item.id === "1.2"
        ? { ...item, checkpoint: { state: CheckpointState.completed, updated_at: UPDATED_AT } }
        : item,
    ),
  );
  const afterChange = checkDrift(edited, renderProgressText(moved, CONTEXT));
  assert.equal(afterChange.status, "content-drift");
  assert.equal(afterChange.safe_to_overwrite, false);
});

test("drift check separates absent, matching, stale, and foreign documents", () => {
  const workflow = fixture();
  const rendered = renderProgressText(workflow, CONTEXT);

  const absent = checkDrift(null, rendered);
  assert.equal(absent.status, "absent");
  assert.equal(absent.drifted, false);
  assert.equal(absent.safe_to_overwrite, true);
  assert.equal(absent.actual, null);

  const match = checkDrift(rendered.text, rendered);
  assert.equal(match.status, "match");
  assert.equal(match.drifted, false);
  assert.deepEqual(match.warnings, []);

  // Same body, older header timestamp: still a match.
  const restamped = renderProgressText(workflow, {
    ...CONTEXT,
    generated_at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(checkDrift(restamped.text, rendered).status, "match");

  // Pristine generated document, workflow has since advanced.
  const advanced = fixture(
    workflow.items.map((item) =>
      item.id === "1.2"
        ? { ...item, checkpoint: { state: CheckpointState.completed, updated_at: UPDATED_AT } }
        : item,
    ),
  );
  const stale = checkDrift(rendered.text, renderProgressText(advanced, CONTEXT));
  assert.equal(stale.status, "source-drift");
  assert.equal(stale.drifted, true);
  assert.equal(stale.safe_to_overwrite, false);
  assert.ok(stale.warnings.some((warning) => warning.includes("stale")));
  assert.ok(stale.warnings.some((warning) => warning.includes("source fingerprint")));

  const foreign = checkDrift("hand written notes\nno header here\n", rendered);
  assert.equal(foreign.status, "unrecognized");
  assert.equal(foreign.drifted, true);
  assert.equal(foreign.safe_to_overwrite, false);
  assert.match(foreign.warnings[0] ?? "", /refusing to overwrite/u);
});

/** Rewrite one provenance header field, leaving the body byte-identical. */
function withHeaderField(text: string, key: string, value: string): string {
  const [header = "", ...rest] = text.split("\n\n");
  const rewritten = header
    .split("\n")
    .map((line) => {
      const prefix = line.startsWith("%% ") ? "%% " : "";
      return line.slice(prefix.length).startsWith(`${key}: `)
        ? `${prefix}${key}: ${value}`
        : line;
    })
    .join("\n");
  assert.notEqual(rewritten, header, `header field ${key} not found`);
  return [rewritten, ...rest].join("\n\n");
}

test("a header edit is drift and never safe to overwrite", () => {
  const workflow = fixture();
  const rendered = renderProgressText(workflow, CONTEXT);

  // Only the restamp is a match: same body, same header everywhere else.
  const restamped = renderProgressText(workflow, {
    ...CONTEXT,
    generated_at: "2026-01-01T00:00:00.000Z",
  });
  const restamp = checkDrift(restamped.text, rendered);
  assert.notEqual(restamped.text, rendered.text);
  assert.equal(restamp.status, "match");
  assert.equal(restamp.drifted, false);
  assert.equal(restamp.safe_to_overwrite, true);
  assert.deepEqual(restamp.warnings, []);

  const cases = [
    { key: "slug", value: "other-workflow", pattern: /belongs to workflow other-workflow/u },
    { key: "generator", value: "hand@0", pattern: /generator hand@0/u },
    { key: "source", value: '"elsewhere.yaml"', pattern: /source elsewhere\.yaml/u },
    {
      key: "source-fingerprint",
      value: `sha256:${"0".repeat(64)}`,
      pattern: /source fingerprint sha256:0{64}/u,
    },
  ] as const;

  for (const { key, value, pattern } of cases) {
    const edited = withHeaderField(rendered.text, key, value);
    const report = checkDrift(edited, rendered);
    assert.equal(report.status, "provenance-drift", `${key}: ${report.status}`);
    assert.equal(report.drifted, true, `${key} should drift`);
    assert.equal(report.safe_to_overwrite, false, `${key} overwrite verdict`);
    assert.ok(
      report.warnings.some((warning) => pattern.test(warning)),
      `${key} warning missing: ${report.warnings.join(" | ")}`,
    );
    // The check never rewrites the caller's text.
    assert.ok(edited.includes(value));
  }

  // Changing the document kind also violates its kind-specific comment prefix,
  // so strict parsing rejects it rather than trusting the edited provenance.
  const wrongKind = checkDrift(
    withHeaderField(rendered.text, "arc-render", "gantt"),
    rendered,
  );
  assert.equal(wrongKind.status, "unrecognized");
  assert.equal(wrongKind.safe_to_overwrite, false);
});

test("provenance parsing requires the exact ordered header", () => {
  const { progress, gantt } = renderWorkflow(fixture(), CONTEXT);
  const progressLines = progress.text.split("\n");

  const malformed = [
    // Missing and duplicate fields.
    [...progressLines.slice(0, 2), ...progressLines.slice(3)].join("\n"),
    [...progressLines.slice(0, 2), progressLines[1] ?? "", ...progressLines.slice(2)].join("\n"),
    // Unknown field, reordered fields, edited notice, and missing separator.
    [...progressLines.slice(0, 2), "unknown: value", ...progressLines.slice(2)].join("\n"),
    [progressLines[0] ?? "", progressLines[2] ?? "", progressLines[1] ?? "", ...progressLines.slice(3)].join("\n"),
    progress.text.replace("notice: generated by", "notice: edited; generated by"),
    progress.text.replace("\n\nrender-fixture - progress", "\nrender-fixture - progress"),
    // Progress must be unprefixed and every gantt header line must be prefixed.
    progress.text.replace("slug: render-fixture", "%% slug: render-fixture"),
    gantt.text.replace("%% slug: render-fixture", "slug: render-fixture"),
  ];

  for (const [index, text] of malformed.entries()) {
    assert.equal(parseDocument(text), null, `malformed header ${index} parsed`);
    const rendered = text.includes("%% arc-render") ? gantt : progress;
    const report = checkDrift(text, rendered);
    assert.equal(report.status, "unrecognized", `malformed header ${index}`);
    assert.equal(report.drifted, true, `malformed header ${index}`);
    assert.equal(report.safe_to_overwrite, false, `malformed header ${index}`);
  }
});

test("a recomputed content fingerprint does not disguise a hand edit", () => {
  const workflow = fixture();
  const rendered = renderProgressText(workflow, CONTEXT);

  // Edit the body and restore header self-consistency, as a careful hand edit
  // would: the header no longer proves anything, but the workflow has not moved.
  const editedBody = rendered.body.replace(
    "[x] 1.1 - DAG model (completed)",
    "[x] 1.1 - DAG model (completed) <- hand edited",
  );
  assert.notEqual(editedBody, rendered.body);
  const resealed = withHeaderField(
    rendered.text,
    "content-fingerprint",
    fingerprint(editedBody),
  ).replace(rendered.body, editedBody);

  const parsed = parseDocument(resealed);
  assert.equal(parsed?.body, editedBody);
  assert.equal(parsed?.provenance.content_fingerprint, fingerprint(editedBody));

  const report = checkDrift(resealed, rendered);
  assert.equal(report.status, "content-drift");
  assert.equal(report.safe_to_overwrite, false);
  assert.ok(report.warnings.some((warning) => /hand edit/u.test(warning)));

  // A fingerprint that matches neither the body nor this render is still a
  // hand edit, not stale output.
  const bogus = withHeaderField(
    rendered.text,
    "content-fingerprint",
    `sha256:${"f".repeat(64)}`,
  );
  const tampered = checkDrift(bogus, rendered);
  assert.equal(tampered.status, "content-drift");
  assert.equal(tampered.safe_to_overwrite, false);

  // Stale output from a workflow that really moved stays safe to regenerate.
  const advanced = fixture(
    workflow.items.map((item) =>
      item.id === "1.2"
        ? { ...item, checkpoint: { state: CheckpointState.completed, updated_at: UPDATED_AT } }
        : item,
    ),
  );
  const stale = checkDrift(rendered.text, renderProgressText(advanced, CONTEXT));
  assert.equal(stale.status, "source-drift");
  assert.equal(stale.safe_to_overwrite, false);

  // Stale output that also claims another workflow is not ours to overwrite.
  const foreignStale = checkDrift(
    withHeaderField(rendered.text, "slug", "other-workflow"),
    renderProgressText(advanced, CONTEXT),
  );
  assert.equal(foreignStale.status, "provenance-drift");
  assert.equal(foreignStale.safe_to_overwrite, false);
  assert.ok(
    foreignStale.warnings.some((warning) => /refusing to overwrite/u.test(warning)),
  );
});

test("checkWorkflowDrift reports both projections", () => {
  const workflow = fixture();
  const { progress, gantt } = renderWorkflow(workflow, CONTEXT);
  const reports = checkWorkflowDrift(workflow, CONTEXT, {
    progress: progress.text,
    gantt: gantt.text.replace("    title render-fixture", "    title hand edited"),
  });

  assert.deepEqual(
    reports.map((report) => [report.kind, report.status]),
    [
      ["progress", "match"],
      ["gantt", "content-drift"],
    ],
  );
  assert.equal(reports[1]?.safe_to_overwrite, false);
  assert.deepEqual(checkWorkflowDrift(workflow, CONTEXT).map((r) => r.status), [
    "absent",
    "absent",
  ]);
});

test("renderers accept valid date formats and reject impossible dates and times", () => {
  const valid = [
    "2024-02-29",
    "2026-09-03T00:00:00.000Z",
    "2026-09-03 23:59:59+23:59",
    "2026-09-03T12:30:45-05:00",
  ];
  for (const generated_at of valid) {
    assert.equal(
      parseDocument(renderProgressText(fixture(), { generated_at }).text)
        ?.provenance.generated_at,
      generated_at,
    );
  }

  const invalid = [
    "not-a-date",
    "2023-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-09-03T24:00:00Z",
    "2026-09-03T23:60:00Z",
    "2026-09-03T23:59:60Z",
    "2026-09-03T23:59:59+24:00",
  ];
  for (const generated_at of invalid) {
    assert.throws(
      () => renderProgressText(fixture(), { generated_at }),
      /generated_at/u,
    );
  }
});

test("parsing rejects semantically invalid generated-at header edits", () => {
  const rendered = renderProgressText(fixture(), CONTEXT);
  for (const generatedAt of [
    "2023-02-29",
    "2026-04-31T00:00:00Z",
    "2026-09-03T25:00:00Z",
  ]) {
    const edited = withHeaderField(rendered.text, "generated-at", generatedAt);
    assert.equal(parseDocument(edited), null);
    const report = checkDrift(edited, rendered);
    assert.equal(report.status, "unrecognized");
    assert.equal(report.safe_to_overwrite, false);
  }
});

test("the render module performs no filesystem or Pi access", () => {
  const directory = fileURLToPath(new URL("../src/render/", import.meta.url));
  const sources = readdirSync(directory).filter((name) => name.endsWith(".ts"));
  assert.ok(sources.length > 0);

  for (const name of sources) {
    const source = readFileSync(path.join(directory, name), "utf8");
    assert.doesNotMatch(source, /from "node:fs/u, `${name} imports node:fs`);
    assert.doesNotMatch(source, /from "node:path/u, `${name} imports node:path`);
    assert.doesNotMatch(source, /\bpi\b/iu, `${name} references Pi`);
  }
});

test("drift check refuses to silently overwrite an empty existing document", () => {
  const workflow = fixture();
  const rendered = renderProgressText(workflow, CONTEXT);
  const report = checkDrift("", rendered);
  assert.equal(report.status, "unrecognized");
  assert.equal(report.drifted, true);
  assert.equal(report.safe_to_overwrite, false);
});

test("presentation objects are deeply frozen and cannot be mutated by callers", () => {
  const presentation = presentationFor(CheckpointState.completed);
  assert.ok(Object.isFrozen(presentation));
  assert.ok(Object.isFrozen(presentation.gantt_tags));
  assert.throws(
    () => {
      (presentation as { symbol: string }).symbol = "[*]";
    },
    TypeError,
  );
});

test("buildDocument rejects a slug that contains newlines", () => {
  const workflow = fixture();
  const slugged: Workflow = { ...workflow, slug: "broken\nslug" };
  assert.throws(
    () => renderProgressText(slugged, CONTEXT),
    /render slug must not contain newlines/u,
  );
});
