import type { Checkpoint } from "./checkpoint.ts";

export type WorkflowItemKind = "group" | "leaf";

export interface Repository {
  id: string;
  path: string;
}

export interface WorkflowItemBase {
  id: string;
  kind: WorkflowItemKind;
  title: string;
  parent_id: string | null;
  nesting_depth: number;
  dependencies: string[];
  checkpoint: Checkpoint;
}

export interface Group extends WorkflowItemBase {
  kind: "group";
}

export interface Leaf extends WorkflowItemBase {
  kind: "leaf";
  outcome: string;
  scope: string;
  acceptance_criteria: string[];
  preserved_behavior: string;
}

export type WorkflowItem = Group | Leaf;

export interface Workflow {
  schema_version: "1";
  slug: string;
  repository: Repository;
  multi_repo?: [];
  items: WorkflowItem[];
}

export type WorkflowDocument = Workflow;
