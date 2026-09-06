import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  extractPlan,
  normalize,
  serializeWorkflowYaml,
  validateWorkflow,
  type Workflow,
} from "@arc/workflow-core";
import { parseDocument } from "yaml";
import { createWorkflowDashboard, type WorkflowDashboard } from "./ui/index.ts";

export const WORKFLOW_COMMAND_NAME = "arc-workflow" as const;

export const WORKFLOW_COMMANDS = Object.freeze([
  "import",
  "open",
  "start",
  "pause",
  "resume",
  "status",
  "answer",
  "replan",
  "cancel",
  "archive",
] as const);

export type WorkflowCommand = (typeof WORKFLOW_COMMANDS)[number];

type NoticeLevel = "info" | "warning" | "error";

/** Minimal structural surface of Pi used by the package entrypoint. */
export interface WorkflowExtensionApi {
  registerCommand(
    name: string,
    command: {
      readonly description: string;
      readonly handler: (
        args: string,
        context: WorkflowExtensionContext,
      ) => Promise<void> | void;
    },
  ): void;
}

export interface WorkflowExtensionUi {
  notify(message: string, level?: NoticeLevel): void;
  setWidget(key: string, content: readonly string[] | undefined): void;
}

export interface WorkflowExtensionContext {
  readonly cwd: string;
  readonly mode?: string;
  readonly hasUI?: boolean;
  readonly ui: WorkflowExtensionUi;
}

export interface ParsedWorkflowCommand {
  readonly command: WorkflowCommand | "help";
  readonly args: readonly string[];
}

export interface WorkflowCommandState {
  readonly workflow?: Workflow;
  readonly dashboard?: WorkflowDashboard;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WORKFLOW_DIRECTORY = [".arc", "workflows"] as const;
const WORKFLOW_FILE = "workflow.yaml";
const WIDGET_KEY = "arc-workflow";

function splitArgs(input: string): readonly string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu;
  for (const match of input.trim().matchAll(tokenPattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) tokens.push(value.replace(/\\([\\"'])/gu, "$1"));
  }
  return tokens;
}

export function parseWorkflowCommand(input: string): ParsedWorkflowCommand {
  const [command, ...args] = splitArgs(input);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", args };
  }
  if ((WORKFLOW_COMMANDS as readonly string[]).includes(command)) {
    return { command: command as WorkflowCommand, args };
  }
  throw new Error(`unknown /${WORKFLOW_COMMAND_NAME} subcommand: ${command}`);
}

export function workflowHelp(): string {
  return [
    "/arc-workflow import <plan.md> [slug]",
    "/arc-workflow open <slug>",
    "/arc-workflow start [slug]",
    "/arc-workflow pause [slug]",
    "/arc-workflow resume [slug]",
    "/arc-workflow status [slug]",
    "/arc-workflow answer <question-id> <answer>",
    "/arc-workflow replan <item-id>",
    "/arc-workflow cancel <item-id>",
    "/arc-workflow archive [slug]",
  ].join("\n");
}

function notify(context: WorkflowExtensionContext, message: string, level: NoticeLevel = "info"): void {
  context.ui.notify(message, level);
}

function isInteractiveMode(context: WorkflowExtensionContext): boolean {
  return context.hasUI !== false && context.mode !== "print" && context.mode !== "json";
}

function requireSlug(value: string | undefined): string {
  if (value === undefined || !SLUG_PATTERN.test(value)) {
    throw new Error("workflow slug must match ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$");
  }
  return value;
}

function workflowPath(cwd: string, slug: string): string {
  return resolve(cwd, ...WORKFLOW_DIRECTORY, slug, WORKFLOW_FILE);
}

function parseWorkflowSource(source: string): Workflow {
  const document = parseDocument(source, {
    logLevel: "silent",
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("; "));
  }
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  const validation = validateWorkflow(value);
  if (!validation.structurally_valid) {
    const diagnostic = validation.diagnostics[0];
    throw new Error(diagnostic?.message ?? "workflow failed structural validation");
  }
  return value as Workflow;
}

async function readWorkflow(cwd: string, slug: string): Promise<Workflow> {
  const source = await readFile(workflowPath(cwd, slug), "utf8");
  return parseWorkflowSource(source);
}

async function writeWorkflow(cwd: string, workflow: Workflow): Promise<void> {
  const directory = resolve(cwd, ...WORKFLOW_DIRECTORY, workflow.slug);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, WORKFLOW_FILE);
  const temporary = resolve(directory, `.${WORKFLOW_FILE}.tmp-${process.pid}`);
  await writeFile(temporary, serializeWorkflowYaml(workflow), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function dashboardFor(workflow: Workflow): WorkflowDashboard {
  return createWorkflowDashboard({
    workflow,
    now: () => new Date(),
  });
}

function showDashboard(context: WorkflowExtensionContext, dashboard: WorkflowDashboard): void {
  const tui = dashboard.renderTui();
  context.ui.setWidget(WIDGET_KEY, dashboard.renderWidget().split("\n"));
  notify(context, tui);
}

function currentSlug(state: WorkflowCommandState, requested: string | undefined): string {
  return requireSlug(requested ?? state.workflow?.slug);
}

async function importWorkflow(
  context: WorkflowExtensionContext,
  sourcePath: string | undefined,
  requestedSlug: string | undefined,
): Promise<Workflow> {
  if (sourcePath === undefined) throw new Error("import requires a markdown plan path");
  const slug = requireSlug(requestedSlug ?? basename(sourcePath).replace(/\.[^.]+$/u, ""));
  const markdown = await readFile(resolve(context.cwd, sourcePath), "utf8");
  const input = extractPlan(markdown, slug, {
    id: basename(context.cwd),
    path: ".",
  });
  const workflow = normalize(input, { updated_at: new Date().toISOString() });
  const validation = validateWorkflow(workflow);
  if (!validation.structurally_valid) {
    const diagnostic = validation.diagnostics[0];
    throw new Error(diagnostic?.message ?? "imported workflow failed validation");
  }
  await writeWorkflow(context.cwd, workflow);
  return workflow;
}

/**
 * Register the source-loaded Pi package entrypoint. File-backed import/open and
 * status are intentionally small and deterministic; lifecycle mutations need
 * the host controller ports and therefore fail closed in a bare package load.
 */
export default function registerArcWorkflow(pi: WorkflowExtensionApi): void {
  let state: WorkflowCommandState = {};

  pi.registerCommand(WORKFLOW_COMMAND_NAME, {
    description: "Import and control a validated ARC workflow DAG",
    async handler(rawArgs, context): Promise<void> {
      if (!isInteractiveMode(context)) {
        notify(context, "/arc-workflow requires TUI or RPC mode; print/JSON mode fails closed", "error");
        return;
      }

      let parsed: ParsedWorkflowCommand;
      try {
        parsed = parseWorkflowCommand(rawArgs);
      } catch (error) {
        notify(context, error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (parsed.command === "help") {
        notify(context, workflowHelp());
        return;
      }

      try {
        if (parsed.command === "import") {
          const workflow = await importWorkflow(context, parsed.args[0], parsed.args[1]);
          const dashboard = dashboardFor(workflow);
          state = { workflow, dashboard };
          showDashboard(context, dashboard);
          return;
        }

        const slug = currentSlug(state, parsed.args[0]);
        if (parsed.command === "open" || parsed.command === "status") {
          const workflow = await readWorkflow(context.cwd, slug);
          const dashboard = dashboardFor(workflow);
          state = { workflow, dashboard };
          showDashboard(context, dashboard);
          return;
        }

        notify(
          context,
          `/${WORKFLOW_COMMAND_NAME} ${parsed.command} requires the host workflow controller; no operation was performed`,
          "warning",
        );
      } catch (error) {
        notify(context, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

export { WORKFLOW_FILE, WORKFLOW_DIRECTORY, WIDGET_KEY };
