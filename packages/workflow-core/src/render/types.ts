import type { CheckpointState } from "../model/checkpoint.ts";

/** Identifier stamped into every generated document. Bump when output changes. */
export const RENDER_GENERATOR = "@arc/workflow-core/render@2";

/** The generated document kinds this module knows how to produce and inspect. */
export type RenderKind = "progress" | "gantt";

/**
 * Caller-supplied render inputs. There is no ambient clock: `generated_at` is
 * always provided so repeated renders of the same workflow are byte-identical.
 */
export interface RenderContext {
  /** `YYYY-MM-DD` or an ISO-like timestamp with a valid calendar date/time. */
  generated_at: string;
  /** Where the workflow was read from, recorded for provenance only. */
  source?: string;
}

/** Provenance recorded in the header of every generated document. */
export interface RenderProvenance {
  kind: RenderKind;
  slug: string;
  generator: string;
  generated_at: string;
  source: string | null;
  /** Fingerprint of the workflow projection the document was rendered from. */
  source_fingerprint: string;
  /** Fingerprint of the document body, used to detect manual edits. */
  content_fingerprint: string;
}

/** A rendered document. Rendering never touches the filesystem. */
export interface RenderedDocument {
  kind: RenderKind;
  /** Header plus body; this is the exact text a writer should persist. */
  text: string;
  /** Body only, i.e. `text` without the provenance header. */
  body: string;
  provenance: RenderProvenance;
}

/** Both projections produced from a single workflow snapshot. */
export interface RenderedWorkflow {
  progress: RenderedDocument;
  gantt: RenderedDocument;
}

/**
 * How an on-disk document relates to what the workflow would render today.
 *
 * `provenance-drift` covers a document whose body is current but whose header
 * disagrees with this render in some way other than `generated_at`; a restamp
 * alone is still a `match`.
 */
export type DriftStatus =
  | "absent"
  | "match"
  | "source-drift"
  | "provenance-drift"
  | "content-drift"
  | "unrecognized";

/** Result of comparing existing document text against a fresh render. */
export interface DriftReport {
  kind: RenderKind;
  status: DriftStatus;
  /** True when the existing text is not what this workflow renders today. */
  drifted: boolean;
  /**
   * False whenever the existing text carries changes that regenerating would
   * destroy. Callers must surface `warnings` instead of overwriting.
   */
  safe_to_overwrite: boolean;
  warnings: string[];
  expected: RenderProvenance;
  /** Provenance parsed out of the existing document, when it had any. */
  actual: RenderProvenance | null;
  /** The fresh render, so callers never need a second render pass. */
  rendered: RenderedDocument;
}

/** Stable presentation of a checkpoint state across all projections. */
export interface CheckpointPresentation {
  state: CheckpointState;
  /** Fixed-width marker used in progress.txt, e.g. `[x]`. */
  symbol: string;
  /** Human label, identical to the schema value. */
  label: string;
  /** Mermaid gantt task tags; distinct for every state. */
  gantt_tags: readonly string[];
}
