import { CHECKPOINT_STATES, type CheckpointState } from "../model/checkpoint.ts";
import type { Workflow } from "../model/workflow.ts";
import { buildDocument } from "./document.ts";
import { workflowFingerprint } from "./fingerprint.ts";
import { canonicalOrder } from "./order.ts";
import { CHECKPOINT_LEGEND, presentationFor } from "./state-presentation.ts";
import type { RenderContext, RenderedDocument } from "./types.ts";

const INDENT = "    ";

/** Collapse whitespace so one item always occupies exactly one line. */
export function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function countByState(
  workflow: Workflow,
): ReadonlyMap<CheckpointState, number> {
  const counts = new Map<CheckpointState, number>(
    CHECKPOINT_STATES.map((state) => [state, 0]),
  );
  for (const item of workflow.items) {
    counts.set(item.checkpoint.state, (counts.get(item.checkpoint.state) ?? 0) + 1);
  }
  return counts;
}

/**
 * Render the `progress.txt` projection of a workflow. Depends only on the
 * workflow and the caller-supplied context, so the same inputs always produce
 * byte-identical output.
 */
export function renderProgressText(
  workflow: Workflow,
  context: RenderContext,
): RenderedDocument {
  const ordered = canonicalOrder(workflow.items);
  const groups = ordered.filter(({ item }) => item.kind === "group").length;
  const leaves = ordered.length - groups;
  const counts = countByState(workflow);

  const lines = [
    `${workflow.slug} - progress`,
    `Repository: ${singleLine(workflow.repository.id)} (${singleLine(workflow.repository.path)})`,
    `Items: ${ordered.length} (${groups} groups, ${leaves} leaves)`,
    `Checkpoints: ${CHECKPOINT_STATES.map(
      (state) => `${state}=${counts.get(state) ?? 0}`,
    ).join(" ")}`,
    CHECKPOINT_LEGEND,
    "",
  ];

  if (ordered.length === 0) {
    lines.push("(no items)");
  } else {
    for (const { item, depth } of ordered) {
      const presentation = presentationFor(item.checkpoint.state);
      const evidence = item.checkpoint.evidence_ref;
      const suffix = evidence === undefined ? "" : ` [evidence: ${singleLine(evidence)}]`;
      lines.push(
        `${INDENT.repeat(depth)}${presentation.symbol} ${singleLine(item.id)} - ${singleLine(item.title)} (${presentation.label})${suffix}`,
      );
    }
  }

  return buildDocument({
    kind: "progress",
    slug: workflow.slug,
    context,
    sourceFingerprint: workflowFingerprint(workflow),
    body: `${lines.join("\n")}\n`,
  });
}
