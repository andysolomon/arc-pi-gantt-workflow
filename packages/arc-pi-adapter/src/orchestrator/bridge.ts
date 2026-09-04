/**
 * The orchestrator bridge.
 *
 * The bridge parses `arc-orchestrator` live-activity stderr lines into workflow
 * event envelopes, writes each envelope to the private journal, and offers a
 * thin invocation surface for callers that want to spawn the runner.
 *
 * The bridge is the only component in the adapter that talks to the runner.
 * It does not parse raw provider stdout, does not bypass the runner wrapper,
 * and does not re-implement orchestrator routing or sandboxing.
 */

import { redactJournalValue, safeJournalMetadata } from "@arc/workflow-core";

import { parseLiveActivityLine } from "./live-activity.ts";
import {
  buildInvocation as buildRunnerInvocation,
  defaultInvoker,
  resolveRunnerBinary,
} from "./runner.ts";
import type {
  BridgeContext,
  BridgeJournal,
  LiveActivityParseResult,
  OrchestratorBridge,
  OrchestratorBridgeOptions,
  RunnerBinaryResolution,
  RunnerInvocation,
  RunnerInvoker,
} from "./types.ts";

function buildJournalPayload(result: LiveActivityParseResult, raw: string): unknown {
  if (result.status === "envelope" || result.status === "oversized") {
    return {
      envelope_id: safeJournalMetadata(result.envelope.event_id),
      kind: safeJournalMetadata(result.envelope.kind),
      status: safeJournalMetadata(result.status),
      seq: safeJournalMetadata(String(result.source.seq)),
      raw_kind: safeJournalMetadata(result.source.kind),
      raw_version: safeJournalMetadata(String(result.source.v)),
    };
  }
  if (result.status === "unsupported") {
    return {
      status: safeJournalMetadata("unsupported"),
      raw_kind: safeJournalMetadata(result.kind),
      raw_version: safeJournalMetadata(String(result.version)),
      raw,
    };
  }
  return {
    status: safeJournalMetadata("ignored"),
    reason: safeJournalMetadata(result.reason),
    raw,
  };
}

export function createOrchestratorBridge(
  options: OrchestratorBridgeOptions,
): OrchestratorBridge {
  if (options.context === undefined) {
    throw new TypeError("OrchestratorBridgeOptions.context is required");
  }
  if (options.journal === undefined || typeof options.journal.append !== "function") {
    throw new TypeError("OrchestratorBridgeOptions.journal.append must be a function");
  }
  const context: BridgeContext = options.context;
  const journal: BridgeJournal = options.journal;
  const env = options.env ?? process.env;
  const invoker: RunnerInvoker = options.invoker ?? defaultInvoker;

  let cachedBinary: RunnerBinaryResolution | undefined;
  function resolveBinary(): RunnerBinaryResolution {
    if (cachedBinary === undefined) {
      cachedBinary = resolveRunnerBinary(env);
    }
    return cachedBinary;
  }

  function buildInvocation(
    input: Parameters<OrchestratorBridge["buildInvocation"]>[0],
  ): RunnerInvocation {
    return buildRunnerInvocation(context, resolveBinary(), input);
  }

  async function ingestLine(line: string): Promise<LiveActivityParseResult> {
    const parserOptions: {
      readonly now?: () => Date;
      readonly createEventId?: () => string;
      readonly maxPayloadBytes?: number;
    } = {};
    if (options.now !== undefined) {
      (parserOptions as { now?: () => Date }).now = options.now;
    }
    if (options.createEventId !== undefined) {
      (parserOptions as { createEventId?: () => string }).createEventId = options.createEventId;
    }
    if (options.maxPayloadBytes !== undefined) {
      (parserOptions as { maxPayloadBytes?: number }).maxPayloadBytes = options.maxPayloadBytes;
    }
    const result = parseLiveActivityLine(line, context, parserOptions);
    const payload = buildJournalPayload(result, line);
    const redacted = redactJournalValue(
      payload as unknown as Parameters<typeof redactJournalValue>[0],
    ) as unknown as Record<string, unknown>;
    await journal.append({
      kind: "runner-event",
      itemId: context.item_id,
      sessionId: context.session_id,
      data: redacted,
    });
    return result;
  }

  async function invoke(
    input: Parameters<OrchestratorBridge["buildInvocation"]>[0],
  ): ReturnType<RunnerInvoker> {
    const invocation = buildInvocation(input);
    return invoker(invocation);
  }

  return {
    ingestLine,
    resolveBinary,
    buildInvocation,
    invoke,
  };
}
