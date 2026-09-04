/**
 * Runner binary resolution and invocation.
 *
 * The bridge never re-implements routing or sandboxing. It only decides which
 * binary to exec and what args to pass. Resolution order:
 *   1. `ARC_ORCHESTRATOR_BIN` if set and the file is executable.
 *   2. The ARC Pi wrapper at `<project>/arc-pi/bin/arc-orchestrator` if it exists.
 *   3. `arc-orchestrator` on `PATH`.
 *
 * The arg layout mirrors the runner CLI: `arc-orchestrator run --mode <m>
 * [--phase <p>] --task <text> [--task-slug <slug>] [--workload-class <wc>]`.
 * Extra args are appended after the canonical ones.
 */

import { execFile, execSync } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

import type {
  BridgeContext,
  OrchestratorBridgeOptions,
  RunnerBinaryResolution,
  RunnerInvocation,
  RunnerInvoker,
} from "./types.ts";

const execFileAsync = promisify(execFile);

const WRAPPER_PROJECT_PATH = "arc-pi/bin/arc-orchestrator";

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findWrapperPath(): string | undefined {
  // The wrapper lives in the sibling `arc-pi` checkout. We probe two layouts:
  //   1. A sibling of the current working directory: `<cwd>/../arc-pi/bin/...`
  //   2. A child of the current working directory: `<cwd>/arc-pi/bin/...`
  // The first matches the canonical ARC Pi + workflow layout; the second
  // matches cases where the wrapper was vendored next to the project.
  const cwd = process.cwd();
  const candidates = [
    `${cwd}/../${WRAPPER_PROJECT_PATH}`,
    `${cwd}/${WRAPPER_PROJECT_PATH}`,
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function findPathBinary(): string | undefined {
  const pathSep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH ?? "").split(pathSep);
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    const candidate = `${dir}/arc-orchestrator`;
    if (isExecutable(candidate)) return candidate;
  }
  // `which`-style fallback for PATH layouts the manual walk does not catch.
  try {
    const stdout = execSync("command -v arc-orchestrator", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const trimmed = stdout.trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    // command not found; fall through.
  }
  return undefined;
}

/** Resolve which binary the bridge will exec. Throws when nothing is found. */
export function resolveRunnerBinary(
  env: NodeJS.ProcessEnv = process.env,
): RunnerBinaryResolution {
  const override = env.ARC_ORCHESTRATOR_BIN;
  if (typeof override === "string" && override.length > 0 && isExecutable(override)) {
    return { path: override, source: "ARC_ORCHESTRATOR_BIN" };
  }
  const pathBinary = findPathBinary();
  if (pathBinary !== undefined) {
    return { path: pathBinary, source: "PATH" };
  }
  const wrapper = findWrapperPath();
  if (wrapper !== undefined) {
    return { path: wrapper, source: "wrapper" };
  }
  throw new Error(
    "arc-orchestrator binary not found: set ARC_ORCHESTRATOR_BIN, install arc-pi/bin/arc-orchestrator, or add arc-orchestrator to PATH",
  );
}

/** Build the canonical invocation args for `arc-orchestrator run`. */
export function buildInvocation(
  context: BridgeContext,
  binary: RunnerBinaryResolution,
  input: {
    readonly mode: "analyze" | "implement" | "review";
    readonly phase?: "explore" | "analyze" | "research" | "plan" | "implement" | "verify" | "deploy";
    readonly task: string;
    readonly task_slug?: string;
    readonly workload_class?:
      | "hard-heavy"
      | "hard-medium"
      | "hard-light"
      | "medium-heavy"
      | "medium-medium"
      | "medium-light"
      | "easy-heavy"
      | "easy-medium"
      | "easy-light";
    readonly extraArgs?: readonly string[];
  },
): RunnerInvocation {
  const args: string[] = ["run", "--mode", input.mode];
  if (input.phase !== undefined) args.push("--phase", input.phase);
  if (input.workload_class !== undefined) {
    args.push("--workload-class", input.workload_class);
  }
  if (input.task_slug !== undefined) {
    args.push("--task-slug", input.task_slug);
  }
  args.push("--task", input.task);
  args.push("--workflow-slug", context.workflow_slug);
  args.push("--item-id", context.item_id);
  args.push("--session-id", context.session_id);
  if (input.extraArgs !== undefined) args.push(...input.extraArgs);
  return {
    binary,
    args,
    cwd: process.cwd(),
  };
}

/** Default invoker: shell out via `node:child_process.execFile`. */
export const defaultInvoker: RunnerInvoker = async (invocation) => {
  const result = await execFileAsync(invocation.binary.path, [...invocation.args], {
    cwd: invocation.cwd,
    encoding: "utf8",
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exit_code: 0,
  };
};

export type CreateBridge = (options: OrchestratorBridgeOptions) => {
  readonly resolveBinary: () => RunnerBinaryResolution;
  readonly buildInvocation: OrchestratorBridgeOptions extends never ? never : (
    input: Parameters<typeof buildInvocation>[2],
  ) => RunnerInvocation;
};

export { findPathBinary, findWrapperPath };
