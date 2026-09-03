import { createHash } from "node:crypto";

import type { Workflow } from "../model/workflow.ts";
import { canonicalOrder } from "./order.ts";

/** `sha256:<hex>` digest of a string. */
export function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Canonical JSON projection of everything the renderers read. Two workflows
 * with the same projection must render identically, so this is what the drift
 * check compares to decide whether a document is stale.
 */
export function canonicalWorkflowProjection(workflow: Workflow): string {
  const items = canonicalOrder(workflow.items).map(({ item, depth, group }) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    parent_id: item.parent_id,
    depth,
    group_id: group === null ? null : group.id,
    dependencies: [...item.dependencies].sort(),
    state: item.checkpoint.state,
    updated_at: item.checkpoint.updated_at,
    evidence_ref: item.checkpoint.evidence_ref ?? null,
  }));

  return JSON.stringify({
    schema_version: workflow.schema_version,
    slug: workflow.slug,
    repository: { id: workflow.repository.id, path: workflow.repository.path },
    items,
  });
}

/** Fingerprint of the workflow projection a document was rendered from. */
export function workflowFingerprint(workflow: Workflow): string {
  return fingerprint(canonicalWorkflowProjection(workflow));
}
