/**
 * Pure `progress.txt` and gantt projections of a workflow, plus the drift
 * check that keeps regeneration from silently discarding manual edits.
 *
 * This module is deliberately filesystem-free: it returns document text and
 * drift reports, and the caller decides what to persist.
 */
export {
  RENDER_GENERATOR,
  type CheckpointPresentation,
  type DriftReport,
  type DriftStatus,
  type RenderContext,
  type RenderKind,
  type RenderProvenance,
  type RenderedDocument,
  type RenderedWorkflow,
} from "./types.ts";
export {
  CHECKPOINT_LEGEND,
  CHECKPOINT_PRESENTATIONS,
  presentationFor,
} from "./state-presentation.ts";
export { canonicalOrder, compareIds, type OrderedItem } from "./order.ts";
export {
  canonicalWorkflowProjection,
  fingerprint,
  workflowFingerprint,
} from "./fingerprint.ts";
export { parseDocument, type ParsedDocument } from "./document.ts";
export { renderProgressText } from "./progress.ts";
export { renderGantt } from "./gantt.ts";
export {
  checkDrift,
  checkWorkflowDrift,
  renderWorkflow,
  type ExistingDocuments,
} from "./drift.ts";
