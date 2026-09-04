/**
 * Public types for the orchestrator bridge.
 *
 * The bridge wraps the `arc-orchestrator` runner's live-activity stderr events
 * into workflow event envelopes, invokes the runner CLI via `ARC_ORCHESTRATOR_BIN`
 * or the ARC Pi wrapper, and emits envelopes to the private journal. Runner
 * routing, sandboxing, and fallback are owned by the runner; the bridge never
 * re-implements them.
 */

import type { EventEnvelope, EventKind, EventProvenance } from "@arc/workflow-core";

export type { EventEnvelope, EventKind, EventProvenance };

/** Prefix the runner writes before every live-activity line. */
export const LIVE_ACTIVITY_EVENT_PREFIX = "arc-orchestrator: event: " as const;

/** Protocol versions this build understands. Newer versions are additive. */
export const LIVE_ACTIVITY_KNOWN_VERSIONS = Object.freeze([1, 2] as const);
export type LiveActivityVersion = (typeof LIVE_ACTIVITY_KNOWN_VERSIONS)[number];

/** v1 + v2 event kinds we know how to wrap. Anything else is `unsupported`. */
export const LIVE_ACTIVITY_KINDS_V1 = Object.freeze([
  "activity",
  "phase",
  "files",
] as const);
export const LIVE_ACTIVITY_KINDS_V2 = Object.freeze([
  ...LIVE_ACTIVITY_KINDS_V1,
  "diff",
] as const);
export type LiveActivityKindV1 = (typeof LIVE_ACTIVITY_KINDS_V1)[number];
export type LiveActivityKindV2 = (typeof LIVE_ACTIVITY_KINDS_V2)[number];

/** Raw shape emitted on the runner stderr stream. */
export interface LiveActivityLine {
  readonly v: number;
  readonly kind: string;
  readonly seq: number;
  readonly at: number;
  readonly data: Record<string, unknown>;
}

export type LiveActivityParseResult =
  | {
      readonly status: "envelope";
      readonly envelope: EventEnvelope;
      readonly source: LiveActivityLine;
    }
  | {
      readonly status: "ignored";
      readonly reason: "no-prefix" | "invalid-json" | "schema-mismatch";
      readonly raw: string;
    }
  | {
      readonly status: "unsupported";
      readonly version: number | string;
      readonly kind: string;
      readonly raw: string;
    }
  | {
      readonly status: "oversized";
      readonly envelope: EventEnvelope;
      readonly source: LiveActivityLine;
    };

/** Decision: which binary the bridge will exec for a runner invocation. */
export interface RunnerBinaryResolution {
  readonly path: string;
  readonly source: "ARC_ORCHESTRATOR_BIN" | "wrapper" | "PATH";
}

/** Minimal invocation shape so the bridge can be tested without spawning. */
export interface RunnerInvocation {
  readonly binary: RunnerBinaryResolution;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Inputs the bridge needs to wrap a live-activity line into an envelope. */
export interface BridgeContext {
  readonly workflow_slug: string;
  readonly item_id: string;
  readonly session_id: string;
}

/** Pluggable journal reference. Tests inject an in-memory implementation. */
export interface BridgeJournal {
  append(entry: {
    readonly kind: string;
    readonly itemId?: string;
    readonly sessionId?: string;
    readonly data?: unknown;
  }): Promise<{ readonly id: string }>;
}

/** Pluggable runner invoker. Tests inject a recorder; production uses `execFile`. */
export type RunnerInvoker = (invocation: RunnerInvocation) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code: number;
}>;

export interface OrchestratorBridgeOptions {
  readonly context: BridgeContext;
  readonly journal: BridgeJournal;
  readonly invoker?: RunnerInvoker;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly createEventId?: () => string;
  readonly maxPayloadBytes?: number;
}

export interface OrchestratorBridge {
  /** Parse one stderr line and (if it is an event) emit it to the journal. */
  ingestLine(line: string): Promise<LiveActivityParseResult>;
  /** Resolve the binary the bridge would invoke for the configured context. */
  resolveBinary(): RunnerBinaryResolution;
  /** Build the canonical invocation args for `arc-orchestrator run`. */
  buildInvocation(input: {
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
  }): RunnerInvocation;
  /** Invoke the runner once. Production wiring only. */
  invoke(input: Parameters<OrchestratorBridge["buildInvocation"]>[0]): ReturnType<RunnerInvoker>;
}
