/**
 * Child profile definitions for executable workflow leaves.
 *
 * The four profiles are settled by the v1 design (see
 * `docs/IMPLEMENTATION_PLAN.md` §2 and `docs/gantt-workflow/seams.md`):
 *
 *   - explore-research
 *   - plan-analyze
 *   - implement
 *   - verify-review
 *
 * Every profile excludes this workflow extension and every nested subagent
 * tool. No profile may load this extension because the controller is the only
 * legitimate owner of the workflow runtime.
 *
 * Profile-based parent-model selection (not orchestrator-routing-v4): each
 * profile carries a `parentModel` selector so the controller can choose the
 * parent model per profile without reaching into runner routing.
 */

export const WORKFLOW_EXTENSION_ID = "@arc/pi-workflow" as const;

export const CHILD_PROFILE_IDS = [
  "explore-research",
  "plan-analyze",
  "implement",
  "verify-review",
] as const;

export type ChildProfileId = (typeof CHILD_PROFILE_IDS)[number];

/**
 * The baseline tool allowlist inherited from the confirmed
 * `createIsolatedChildSession` seam (see `docs/gantt-workflow/seams.md`).
 */
const BASELINE_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/**
 * The settled forbidden tool set: this workflow extension, every
 * `arc_delegate*`/`arc_ask_operator`/`arc_terminal_*`/`arc_monitor_*`/
 * `arc_record_*`/`arc_decisions*`/`arc_prompt_*`/`arc_delegate_*`/
 * `arc_task_*` tool, and every `subagent_*` tool.
 *
 * A profile exclude-list is closed under this union plus any per-profile
 * tightening.
 */
const FORBIDDEN_TOOLS = [
  WORKFLOW_EXTENSION_ID,
  "arc_delegate",
  "arc_delegate_status",
  "arc_delegate_cancel",
  "arc_ask_operator",
  "arc_terminal_start",
  "arc_terminal_status",
  "arc_terminal_list",
  "arc_terminal_kill",
  "arc_monitor_status",
  "arc_record_assumption",
  "arc_decisions",
  "arc_prompt_recommend",
  "arc_task_artifact",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
] as const;

/**
 * Parent-model selection is profile-based. The controller (not the runner
 * router) decides which parent model serves a child profile.
 *
 *   - `inherit` keeps the controller session's parent model.
 *   - `profile` lets the profile request a named profile slot.
 *   - `explicit` pins a model id (e.g. for a deterministic review run).
 */
export type ParentModelSelection =
  | { readonly kind: "inherit" }
  | { readonly kind: "profile"; readonly profileId: string }
  | { readonly kind: "explicit"; readonly modelId: string };

export interface ChildProfile {
  readonly id: ChildProfileId;
  readonly description: string;
  readonly parentModel: ParentModelSelection;
  readonly allowlist: readonly string[];
  readonly excludes: readonly string[];
}

function buildExcludes(): readonly string[] {
  return Object.freeze([...FORBIDDEN_TOOLS]);
}

export const CHILD_PROFILES: readonly ChildProfile[] = Object.freeze([
  Object.freeze({
    id: "explore-research",
    description:
      "Read-only exploration and research. Reads the repo, runs no write tools, never edits.",
    parentModel: Object.freeze({ kind: "inherit" }) satisfies ParentModelSelection,
    allowlist: Object.freeze(["read", "grep", "find", "ls"]),
    excludes: buildExcludes(),
  }),
  Object.freeze({
    id: "plan-analyze",
    description:
      "Plan and analyze. Reads the repo and runs analyze-only commands; never edits or writes.",
    parentModel: Object.freeze({ kind: "inherit" }) satisfies ParentModelSelection,
    allowlist: Object.freeze(["read", "grep", "find", "ls"]),
    excludes: buildExcludes(),
  }),
  Object.freeze({
    id: "implement",
    description:
      "Implements a bounded contract. Has the full baseline allowlist so it can edit, write, and run focused verification commands inside its declared scope.",
    parentModel: Object.freeze({ kind: "inherit" }) satisfies ParentModelSelection,
    allowlist: Object.freeze([...BASELINE_TOOLS]),
    excludes: buildExcludes(),
  }),
  Object.freeze({
    id: "verify-review",
    description:
      "Read-only verify and review. Runs tests and inspects diffs but does not edit source files.",
    parentModel: Object.freeze({ kind: "inherit" }) satisfies ParentModelSelection,
    allowlist: Object.freeze(["read", "bash", "grep", "find", "ls"]),
    excludes: buildExcludes(),
  }),
]);

/**
 * Look up a child profile by id. Throws if the id is not one of the four
 * settled values. The controller should call this just in time when starting
 * a child session; profiles are not dynamic and must not be mutated.
 */
export function getChildProfile(id: ChildProfileId): ChildProfile {
  const profile = CHILD_PROFILES.find((entry) => entry.id === id);
  if (!profile) {
    throw new Error(`unknown child profile id: ${id satisfies string}`);
  }
  return profile;
}
