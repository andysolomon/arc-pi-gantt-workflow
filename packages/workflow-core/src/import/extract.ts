import type {
  FlatInput,
  GroupInput,
  LeafInput,
  NormalizeInput,
  PhasedInput,
  WorkItemInput,
} from "../normalize/types.ts";
import type { Repository } from "../model/workflow.ts";

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const CHECKBOX_RE = /^(\s*)-\s+\[[ x]\]\s+(.+)$/;
const FLAT_CHECKBOX_RE = /^-\s+\[[ x]\]\s+(.+)$/;

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

function leafId(groupPrefix: string, index: number): string {
  return groupPrefix ? `${groupPrefix}-leaf-${index}` : `leaf-${index}`;
}

function buildLeaf(id: string, title: string): LeafInput {
  return {
    kind: "leaf",
    id,
    title: title.trim(),
    outcome: "",
    scope: "",
    acceptance_criteria: [],
    preserved_behavior: "",
    dependencies: [],
  };
}

// ---------------------------------------------------------------------------
// Phased extractor
// ---------------------------------------------------------------------------

interface HeadingFrame {
  level: number;
  group: GroupInput;
}

/**
 * Extract a phased plan from markdown that uses H1/H2/H3 headings as groups
 * and indented checkboxes as leaves. Unknown lines are ignored.
 */
export function extractPhased(
  markdown: string,
  slug: string,
  repository: Repository,
): PhasedInput {
  const lines = markdown.split("\n");
  const root: WorkItemInput[] = [];
  const stack: HeadingFrame[] = [];
  let leafCounter = 0;

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const hashes = headingMatch[1]!;
      const title = headingMatch[2]!.trim();
      const level = hashes.length;

      // Pop frames at same or deeper level
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
        stack.pop();
      }

      const parent = stack.length > 0 ? stack[stack.length - 1]! : null;
      const parentItems: WorkItemInput[] = parent
        ? (parent.group.items as WorkItemInput[])
        : root;

      const stableId = parent
        ? `${parent.group.id}-g${parentItems.length}`
        : `group-${parentItems.length}`;

      const group: GroupInput = {
        kind: "group",
        id: stableId,
        title,
        dependencies: [],
        items: [],
      };

      parentItems.push(group);
      stack.push({ level, group });
      continue;
    }

    const checkMatch = CHECKBOX_RE.exec(line);
    if (checkMatch) {
      const title = checkMatch[2]!.trim();
      const parentFrame = stack.length > 0 ? stack[stack.length - 1]! : null;
      const parentGroup = parentFrame?.group ?? null;
      const id = parentGroup
        ? leafId(parentGroup.id, (parentGroup.items as WorkItemInput[]).length)
        : leafId("", leafCounter);

      const leaf = buildLeaf(id, title);

      if (parentGroup) {
        (parentGroup.items as WorkItemInput[]).push(leaf);
      } else {
        root.push(leaf);
      }
      leafCounter++;
      continue;
    }
    // Unknown lines are ignored.
  }

  return { form: "phased", slug, repository, groups: root };
}

// ---------------------------------------------------------------------------
// Flat extractor
// ---------------------------------------------------------------------------

/**
 * Extract a flat story list from markdown containing only top-level checkboxes.
 * Headings and indented lines are ignored.
 */
export function extractFlat(
  markdown: string,
  slug: string,
  repository: Repository,
): FlatInput {
  const lines = markdown.split("\n");
  const stories: LeafInput[] = [];

  for (const line of lines) {
    const m = FLAT_CHECKBOX_RE.exec(line);
    if (m) {
      stories.push(buildLeaf(`leaf-${stories.length}`, m[1]!));
    }
  }

  return { form: "flat", slug, repository, stories };
}

// ---------------------------------------------------------------------------
// Auto-detect convenience
// ---------------------------------------------------------------------------

/**
 * Detect plan shape: if the markdown contains any H1-H3 heading, treat as
 * phased; otherwise treat as flat.
 */
export function extractPlan(
  markdown: string,
  slug: string,
  repository: Repository,
): NormalizeInput {
  if (markdown.split("\n").some((l) => HEADING_RE.test(l))) {
    return extractPhased(markdown, slug, repository);
  }
  return extractFlat(markdown, slug, repository);
}
