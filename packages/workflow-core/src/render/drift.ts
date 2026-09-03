import type { Workflow } from "../model/workflow.ts";
import { parseDocument } from "./document.ts";
import { fingerprint } from "./fingerprint.ts";
import { renderGantt } from "./gantt.ts";
import { renderProgressText } from "./progress.ts";
import type {
  DriftReport,
  RenderContext,
  RenderedDocument,
  RenderedWorkflow,
  RenderProvenance,
} from "./types.ts";

/** Both projections of one workflow snapshot. */
export function renderWorkflow(
  workflow: Workflow,
  context: RenderContext,
): RenderedWorkflow {
  return {
    progress: renderProgressText(workflow, context),
    gantt: renderGantt(workflow, context),
  };
}

/** One header field that disagrees with the fresh render. */
interface ProvenanceMismatch {
  field: "kind" | "slug" | "generator" | "source" | "source_fingerprint";
  warning: string;
}

const ABSENT_SOURCE = "-";

/**
 * Header fields that disagree between an existing document and this render.
 *
 * `generated_at` is excluded on purpose: re-rendering an unchanged workflow at
 * a later time restamps it and nothing else, so a restamp is not drift.
 * `content_fingerprint` is excluded too, because it is checked against the body
 * it describes and a body mismatch is always unsafe to overwrite.
 */
function provenanceMismatches(
  kind: string,
  actual: RenderProvenance,
  expected: RenderProvenance,
): ProvenanceMismatch[] {
  const mismatches: ProvenanceMismatch[] = [];

  if (actual.kind !== expected.kind) {
    mismatches.push({
      field: "kind",
      warning: `${kind}: document header declares kind ${actual.kind}, rendering ${expected.kind}`,
    });
  }
  if (actual.slug !== expected.slug) {
    mismatches.push({
      field: "slug",
      warning: `${kind}: document belongs to workflow ${actual.slug}, rendering workflow ${expected.slug}`,
    });
  }
  if (actual.generator !== expected.generator) {
    mismatches.push({
      field: "generator",
      warning: `${kind}: written by generator ${actual.generator}, current generator is ${expected.generator}`,
    });
  }
  if (actual.source !== expected.source) {
    mismatches.push({
      field: "source",
      warning: `${kind}: document records source ${actual.source ?? ABSENT_SOURCE}, rendering from ${expected.source ?? ABSENT_SOURCE}`,
    });
  }
  if (actual.source_fingerprint !== expected.source_fingerprint) {
    mismatches.push({
      field: "source_fingerprint",
      warning: `${kind}: rendered from source fingerprint ${actual.source_fingerprint}, workflow is now ${expected.source_fingerprint}`,
    });
  }

  return mismatches;
}

/**
 * Compare document text that already exists against a fresh render.
 *
 * This never writes and never rewrites `existing`; it classifies the
 * difference and hands the caller both the warnings and the fresh render so the
 * decision to overwrite stays with the caller. A document whose body no longer
 * matches its own embedded content fingerprint was edited by hand, and is
 * reported as `content-drift` with `safe_to_overwrite: false`. So is a document
 * whose body differs from this render even though the workflow it names has not
 * moved, which is what a hand edit with a recomputed fingerprint looks like.
 *
 * Only a `generated_at` restamp is a `match`. Any other header disagreement is
 * surfaced as `provenance-drift` with an explicit warning, so a hand-edited
 * header is never mistaken for a clean document.
 */
export function checkDrift(
  existing: string | null | undefined,
  rendered: RenderedDocument,
): DriftReport {
  const base = {
    kind: rendered.kind,
    expected: rendered.provenance,
    rendered,
  } as const;

  if (existing === null || existing === undefined) {
    return {
      ...base,
      status: "absent",
      drifted: false,
      safe_to_overwrite: true,
      warnings: [],
      actual: null,
    };
  }

  if (existing.length === 0) {
    return {
      ...base,
      status: "unrecognized",
      drifted: true,
      safe_to_overwrite: false,
      warnings: [
        `${rendered.kind}: existing document is empty; refusing to overwrite unrecognized content`,
      ],
      actual: null,
    };
  }

  if (existing === rendered.text) {
    return {
      ...base,
      status: "match",
      drifted: false,
      safe_to_overwrite: true,
      warnings: [],
      actual: rendered.provenance,
    };
  }

  const parsed = parseDocument(existing);
  if (parsed === null) {
    return {
      ...base,
      status: "unrecognized",
      drifted: true,
      safe_to_overwrite: false,
      warnings: [
        `${rendered.kind}: existing document has no @arc/workflow-core provenance header; refusing to overwrite unrecognized content`,
      ],
      actual: null,
    };
  }

  const actual = parsed.provenance;

  if (fingerprint(parsed.body) !== actual.content_fingerprint) {
    return {
      ...base,
      status: "content-drift",
      drifted: true,
      safe_to_overwrite: false,
      warnings: [
        `${rendered.kind}: generated document was edited by hand (content fingerprint ${actual.content_fingerprint} does not match its body); re-render would discard those edits`,
      ],
      actual,
    };
  }

  const mismatches = provenanceMismatches(
    rendered.kind,
    actual,
    rendered.provenance,
  );

  if (parsed.body !== rendered.body) {
    if (
      mismatches.some(
        (mismatch) => mismatch.field === "kind" || mismatch.field === "slug",
      )
    ) {
      return {
        ...base,
        status: "provenance-drift",
        drifted: true,
        safe_to_overwrite: false,
        warnings: [
          ...mismatches.map((mismatch) => mismatch.warning),
          `${rendered.kind}: existing document identifies as another generated document; refusing to overwrite it`,
        ],
        actual,
      };
    }

    const sameSource =
      actual.source_fingerprint === rendered.provenance.source_fingerprint;
    const sameGenerator = actual.generator === rendered.provenance.generator;
    if (sameSource && sameGenerator) {
      // The workflow and the generator both agree with this render, so the body
      // cannot have gone stale: it was edited and its fingerprint recomputed.
      return {
        ...base,
        status: "content-drift",
        drifted: true,
        safe_to_overwrite: false,
        warnings: [
          `${rendered.kind}: body differs from this render even though source fingerprint ${actual.source_fingerprint} and generator ${actual.generator} are unchanged; treating it as a hand edit rather than stale output`,
        ],
        actual,
      };
    }

    return {
      ...base,
      status: "source-drift",
      drifted: true,
      safe_to_overwrite: false,
      warnings: [
        `${rendered.kind}: generated document is stale, but its differing body must be reviewed before regeneration`,
        ...mismatches.map((mismatch) => mismatch.warning),
      ],
      actual,
    };
  }

  if (mismatches.length > 0) {
    return {
      ...base,
      status: "provenance-drift",
      drifted: true,
      safe_to_overwrite: false,
      warnings: mismatches.map((mismatch) => mismatch.warning),
      actual,
    };
  }

  return {
    ...base,
    status: "match",
    drifted: false,
    safe_to_overwrite: true,
    warnings: [],
    actual,
  };
}

/** Existing text for each projection, as read by a caller that owns the disk. */
export interface ExistingDocuments {
  progress?: string | null;
  gantt?: string | null;
}

/** Drift reports for both projections, progress first. */
export function checkWorkflowDrift(
  workflow: Workflow,
  context: RenderContext,
  existing: ExistingDocuments = {},
): DriftReport[] {
  const { progress, gantt } = renderWorkflow(workflow, context);
  return [
    checkDrift(existing.progress, progress),
    checkDrift(existing.gantt, gantt),
  ];
}
