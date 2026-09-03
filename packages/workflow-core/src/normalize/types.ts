import type { Repository } from "../model/workflow.ts";

/**
 * The activation fields an authoring source supplies for one executable unit of
 * work. They are carried through to the emitted `Leaf` verbatim; the normalizer
 * neither fills them in nor judges whether they are sufficient (that gate is
 * 1.3).
 */
export interface LeafInput {
  readonly kind: "leaf";
  readonly id: string;
  readonly title: string;
  readonly outcome: string;
  readonly scope: string;
  readonly acceptance_criteria: readonly string[];
  readonly preserved_behavior: string;
  /** Explicit references to other item ids. Copied through in order. */
  readonly dependencies?: readonly string[];
}

/**
 * A node that owns other nodes. A group stays a group even when `items` is
 * empty: ownership is declared by the source, never inferred from arity.
 */
export interface GroupInput {
  readonly kind: "group";
  readonly id: string;
  readonly title: string;
  readonly dependencies?: readonly string[];
  readonly items: readonly WorkItemInput[];
}

/** One node of a phased tree, discriminated by `kind`. */
export type WorkItemInput = GroupInput | LeafInput;

/** Fields every input form carries to address the emitted workflow. */
export interface NormalizeInputBase {
  readonly slug: string;
  readonly repository: Repository;
}

/** A phased plan: a tree of groups and leaves. */
export interface PhasedInput extends NormalizeInputBase {
  readonly form: "phased";
  readonly groups: readonly WorkItemInput[];
}

/** A flat story list: leaves only, each one a root in source order. */
export interface FlatInput extends NormalizeInputBase {
  readonly form: "flat";
  readonly stories: readonly LeafInput[];
}

export type NormalizeInput = PhasedInput | FlatInput;

/**
 * Caller-supplied values the normalizer would otherwise have to invent.
 * `updated_at` is required so that normalization stays pure: it reads no clock,
 * and identical input always yields an identical document.
 */
export interface NormalizeOptions {
  readonly updated_at: string;
}
