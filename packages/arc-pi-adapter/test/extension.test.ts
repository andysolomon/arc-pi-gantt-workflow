import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import registerArcWorkflow, {
  parseWorkflowCommand,
  WORKFLOW_COMMAND_NAME,
  WORKFLOW_COMMANDS,
  workflowHelp,
  type WorkflowExtensionContext,
} from "../src/extension.ts";

interface RegisteredCommand {
  readonly name: string;
  readonly description: string;
  readonly handler: (args: string, context: WorkflowExtensionContext) => Promise<void> | void;
}

function makeRegistration(): {
  readonly commands: RegisteredCommand[];
  readonly notifications: Array<{ message: string; level?: string }>;
  readonly widgets: Array<{ key: string; content: readonly string[] | undefined }>;
  readonly context: WorkflowExtensionContext;
} {
  const commands: RegisteredCommand[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const widgets: Array<{ key: string; content: readonly string[] | undefined }> = [];
  const context: WorkflowExtensionContext = {
    cwd: "/tmp/release-workflow",
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message, level) {
        notifications.push({ message, ...(level === undefined ? {} : { level }) });
      },
      setWidget(key, content) {
        widgets.push({ key, content });
      },
    },
  };
  registerArcWorkflow({
    registerCommand(name, command) {
      commands.push({ name, description: command.description, handler: command.handler });
    },
  });
  return { commands, notifications, widgets, context };
}

describe("Pi package workflow extension", () => {
  it("exports the settled command vocabulary and parses quoted arguments", () => {
    assert.deepEqual(WORKFLOW_COMMANDS, [
      "import", "open", "start", "pause", "resume",
      "status", "answer", "replan", "cancel", "archive",
    ]);
    assert.deepEqual(parseWorkflowCommand('import "plans/my plan.md" demo'), {
      command: "import",
      args: ["plans/my plan.md", "demo"],
    });
    assert.deepEqual(parseWorkflowCommand("--help"), { command: "help", args: [] });
    assert.match(workflowHelp(), /\/arc-workflow archive \[slug\]/);
  });

  it("registers exactly one deterministic /arc-workflow command", () => {
    const registration = makeRegistration();
    assert.equal(registration.commands.length, 1);
    assert.equal(registration.commands[0]?.name, WORKFLOW_COMMAND_NAME);
    assert.match(registration.commands[0]?.description ?? "", /validated ARC workflow/);
  });

  it("shows help and fails closed in print or JSON mode", async () => {
    const registration = makeRegistration();
    const command = registration.commands[0]!;
    await command.handler("help", registration.context);
    assert.match(registration.notifications[0]?.message ?? "", /\/arc-workflow import/);

    const printContext: WorkflowExtensionContext = {
      ...registration.context,
      mode: "print",
    };
    await command.handler("start demo", printContext);
    assert.equal(registration.notifications.at(-1)?.level, "error");
    assert.match(registration.notifications.at(-1)?.message ?? "", /fails closed/);
    assert.equal(registration.widgets.length, 0);
  });

  it("imports and opens a workflow from the documented .arc location", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "arc-workflow-extension-"));
    try {
      await writeFile(join(cwd, "plan.md"), "# Phase 1\n- [ ] Add the first leaf\n", "utf8");
      const registration = makeRegistration();
      const context: WorkflowExtensionContext = { ...registration.context, cwd };
      const command = registration.commands[0]!;

      await command.handler("import plan.md demo", context);
      const workflowPath = join(cwd, ".arc", "workflows", "demo", "workflow.yaml");
      const workflowYaml = await readFile(workflowPath, "utf8");
      assert.match(workflowYaml, /slug: demo/);
      assert.match(registration.notifications.at(-1)?.message ?? "", /Progress: 0\/1 leaves completed/);
      assert.equal(registration.widgets.at(-1)?.key, "arc-workflow");

      await command.handler("open demo", context);
      assert.match(registration.notifications.at(-1)?.message ?? "", /Workflow: demo/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not pretend host-controller operations are available", async () => {
    const registration = makeRegistration();
    const command = registration.commands[0]!;
    await command.handler("start", registration.context);
    assert.equal(registration.notifications.at(-1)?.level, "error");
    assert.match(registration.notifications.at(-1)?.message ?? "", /workflow slug/);
  });
});
