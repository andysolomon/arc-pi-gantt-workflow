import type { Workflow, WorkflowItem } from "../model/workflow.ts";
import { buildDocument, datePortion } from "./document.ts";
import { workflowFingerprint } from "./fingerprint.ts";
import { canonicalOrder, compareIds } from "./order.ts";
import { singleLine } from "./progress.ts";
import { presentationFor } from "./state-presentation.ts";
import type { RenderContext, RenderedDocument } from "./types.ts";

const INDENT = "    ";

const UNGROUPED_SECTION = "ungrouped";

const EMPTY_WORKFLOW_BASELINE = "1970-01-01";

/** A stable gantt baseline derived from the workflow, never render time. */
function workflowBaselineDate(workflow: Workflow): string {
  const dates = workflow.items.map((item) =>
    datePortion(item.checkpoint.updated_at, `checkpoint ${item.id} updated_at`),
  );
  dates.sort();
  return dates[0] ?? EMPTY_WORKFLOW_BASELINE;
}

/** Strip characters mermaid treats as field separators inside a task name. */
function ganttText(value: string): string {
  return singleLine(value)
    .replace(/%/gu, "percent")
    .replace(/[:;#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Deterministic, mermaid-safe task ids derived from workflow ids. */
function taskIds(ordered: readonly { item: WorkflowItem }[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const { item } of ordered) {
    if (item.kind !== "leaf") continue;
    const base = `t_${item.id.replace(/[^A-Za-z0-9_]/gu, "_")}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    if (!ids.has(item.id)) ids.set(item.id, candidate);
  }
  return ids;
}

function sectionTitle(group: WorkflowItem | null): string {
  if (group === null) return UNGROUPED_SECTION;
  return `${ganttText(group.title)} [${presentationFor(group.checkpoint.state).label}]`;
}

/**
 * Task ids this leaf must follow.
 *
 * Every dependency that resolves to a leaf task is emitted, including one whose
 * target appears later in canonical order: canonical order is by id, not
 * topological, so filtering on "already emitted" silently dropped forward edges
 * and made the gantt understate the DAG. Dependencies on groups or on ids that
 * are not in the workflow have no task to point at and are skipped, and a
 * self-dependency is dropped so a task never waits on itself.
 */
function afterTasks(item: WorkflowItem, ids: ReadonlyMap<string, string>): string[] {
  return [...new Set(item.dependencies)]
    .filter((dependency) => dependency !== item.id)
    .sort(compareIds)
    .map((dependency) => ids.get(dependency))
    .filter((id): id is string => id !== undefined);
}

/**
 * Render a mermaid-compatible gantt projection. Sequencing comes from the DAG
 * (`after <task>`) rather than from wall-clock estimates, so the output is a
 * pure function of the workflow plus the caller-supplied render context.
 */
export function renderGantt(
  workflow: Workflow,
  context: RenderContext,
): RenderedDocument {
  const baseline = workflowBaselineDate(workflow);
  const ordered = canonicalOrder(workflow.items);
  const ids = taskIds(ordered);

  const lines = [
    "gantt",
    `${INDENT}dateFormat YYYY-MM-DD`,
    `${INDENT}axisFormat %Y-%m-%d`,
    `${INDENT}title ${ganttText(workflow.slug)}`,
  ];

  let section: string | null = null;

  for (const { item, group } of ordered) {
    if (item.kind === "group") {
      section = sectionTitle(item);
      lines.push(`${INDENT}section ${section}`);
      continue;
    }

    const wanted = sectionTitle(group);
    if (section !== wanted) {
      section = wanted;
      lines.push(`${INDENT}section ${section}`);
    }

    const presentation = presentationFor(item.checkpoint.state);
    const taskId = ids.get(item.id) ?? `t_${item.id.replace(/[^A-Za-z0-9_]/gu, "_")}`;
    const after = afterTasks(item, ids);
    const start = after.length === 0 ? baseline : `after ${after.join(" ")}`;
    const fields = [...presentation.gantt_tags, taskId, start, "1d"].join(", ");

    lines.push(
      `${INDENT}${ganttText(item.title)} [${presentation.label}] :${fields}`,
    );
  }

  if (ordered.length === 0) lines.push(`${INDENT}section ${UNGROUPED_SECTION}`);

  return buildDocument({
    kind: "gantt",
    slug: workflow.slug,
    context,
    sourceFingerprint: workflowFingerprint(workflow),
    body: `${lines.join("\n")}\n`,
  });
}
