import {
  CHECKPOINT_STATES,
  presentationFor,
  type CheckpointState,
} from "@arc/workflow-core";
import type { DashboardSnapshot } from "./types.ts";

const MAX_PROGRESS_LENGTH = 160;

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function bounded(value: string, maxLength = MAX_PROGRESS_LENGTH): string {
  const normalized = singleLine(value);
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function countLine(snapshot: DashboardSnapshot): string {
  return CHECKPOINT_STATES.map((state) => {
    const key: keyof Pick<
      DashboardSnapshot["counts"],
      "planned" | "ready" | "completed" | "blocked" | "cancelled" | "needs_replan"
    > = state === "needs-replan" ? "needs_replan" : state;
    return `${state}=${snapshot.counts[key]}`;
  }).join(" ");
}

/** Render a bounded, deterministic dashboard suitable for a TUI host. */
export function renderDashboardTui(snapshot: DashboardSnapshot): string {
  const lines = [
    `Workflow: ${bounded(snapshot.workflow_slug)}`,
    `Repository: ${bounded(snapshot.repository_id)}`,
    `Progress: ${snapshot.counts.completed}/${snapshot.counts.leaves} leaves completed`,
    `Capacity: ${snapshot.counts.active}/${snapshot.concurrency_limit} active (${snapshot.available_slots} available)`,
    `Waiting: ${snapshot.counts.waiting}  Questions: ${snapshot.counts.questions}`,
    `Checkpoints: ${countLine(snapshot)}`,
    "",
    "Items:",
  ];

  if (snapshot.items.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of snapshot.items) {
      const presentation = presentationFor(item.state);
      const flags = [
        item.active ? "running" : undefined,
        item.waiting ? "waiting" : undefined,
        item.question_count > 0 ? `${item.question_count} question${item.question_count === 1 ? "" : "s"}` : undefined,
      ].filter((flag): flag is string => flag !== undefined);
      const suffix = flags.length === 0 ? "" : ` {${flags.join(", ")}}`;
      const progress = item.progress === undefined ? "" : ` — ${bounded(item.progress)}`;
      lines.push(
        `${"  ".repeat(item.nesting_depth)}${presentation.symbol} ${bounded(item.id, 96)} - ${bounded(item.title)} (${presentation.label})${suffix}${progress}`,
      );
    }
  }

  lines.push("", "Questions:");
  if (snapshot.questions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const question of snapshot.questions) {
      lines.push(
        `  ${question.status === "active" ? "*" : "-"} ${bounded(question.question_id, 96)} — ${bounded(question.item_id, 96)} [${question.gate}] (${question.status})`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Render the passive widget: status only, with no controls or prompt text. */
export function renderPassiveWidget(snapshot: DashboardSnapshot): string {
  const selected = snapshot.ui_pick === undefined ? "" : ` · selected ${bounded(snapshot.ui_pick, 64)}`;
  return [
    `arc-workflow ${bounded(snapshot.workflow_slug, 64)}`,
    `${snapshot.counts.completed}/${snapshot.counts.leaves} complete`,
    `${snapshot.counts.active} running`,
    `${snapshot.counts.waiting} waiting`,
    `${snapshot.counts.questions} question${snapshot.counts.questions === 1 ? "" : "s"}`,
    `${snapshot.available_slots} slot${snapshot.available_slots === 1 ? "" : "s"} free`,
  ].join(" · ") + selected;
}

/** Stable checkpoint count projection for hosts that need structured labels. */
export function checkpointCounts(
  snapshot: DashboardSnapshot,
): Readonly<Record<CheckpointState, number>> {
  return {
    planned: snapshot.counts.planned,
    ready: snapshot.counts.ready,
    completed: snapshot.counts.completed,
    blocked: snapshot.counts.blocked,
    cancelled: snapshot.counts.cancelled,
    "needs-replan": snapshot.counts.needs_replan,
  };
}
