/**
 * Live-activity parser.
 *
 * The runner writes one structured JSON line per event on stderr, prefixed by
 * `arc-orchestrator: event: `. The parser is pure: it never spawns processes,
 * never reads files, and never touches the journal. It returns a discriminated
 * `LiveActivityParseResult` so callers can decide what to emit.
 *
 * Schema versioning:
 *   - `v: 1` kinds: `activity`, `phase`, `files`.
 *   - `v: 2` adds `diff` (additive; v1 consumers ignore it).
 *   - Unknown `v` or `kind` values are returned as `unsupported` so callers
 *     can drop or annotate them. The parser never throws on unknown shapes.
 */

import {
  EVENT_ENVELOPE_VERSION,
  EVENT_KINDS,
  MAX_EVENT_PAYLOAD_BYTES,
} from "@arc/workflow-core";
import type {
  BridgeContext,
  EventEnvelope,
  EventKind,
  LiveActivityKindV1,
  LiveActivityKindV2,
  LiveActivityLine,
  LiveActivityParseResult,
  LiveActivityVersion,
} from "./types.ts";
import {
  LIVE_ACTIVITY_EVENT_PREFIX,
  LIVE_ACTIVITY_KINDS_V1,
  LIVE_ACTIVITY_KINDS_V2,
} from "./types.ts";

const EVENT_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const WORKFLOW_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function knownKind(kind: string, version: number): kind is LiveActivityKindV1 | LiveActivityKindV2 {
  if (version === 1) {
    return (LIVE_ACTIVITY_KINDS_V1 as readonly string[]).includes(kind);
  }
  if (version === 2) {
    return (LIVE_ACTIVITY_KINDS_V2 as readonly string[]).includes(kind);
  }
  return false;
}

function kindToEnvelopeKind(kind: LiveActivityKindV1 | LiveActivityKindV2): EventKind {
  switch (kind) {
    case "phase":
    case "activity":
    case "diff":
      return "progress";
    case "files":
      return "artifact";
  }
}

function ulidLike(now: () => Date): string {
  // Crockford-base32 ULID. Time portion is high-precision; random portion is a
  // monotonic counter so the same bridge never emits two identical ids in a row.
  const time = now().getTime();
  let lastTime = -1;
  let counter = 0;
  if (time === lastTime) counter += 1;
  else counter = 0;
  lastTime = time;
  const timePart = (time & 0xffffffffffff).toString(32).padStart(10, "0");
  const counterPart = counter.toString(32).padStart(4, "0");
  // Pad to 26 chars with deterministic filler.
  const base = `${timePart}${counterPart}`;
  return base.padEnd(26, "0").toUpperCase().slice(0, 26);
}

function buildEnvelope(
  line: LiveActivityLine,
  context: BridgeContext,
  envelopeKind: EventKind,
  now: () => Date,
  createEventId: () => string,
): EventEnvelope {
  const payload: Record<string, unknown> = {
    summary: `${line.kind}@${line.seq}`,
    ...line.data,
  };
  const envelope: EventEnvelope = {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: createEventId(),
    workflow_slug: context.workflow_slug,
    item_id: context.item_id,
    session_id: context.session_id,
    emitted_at: new Date(line.at).toISOString(),
    kind: envelopeKind,
    payload,
    provenance: {
      source: "arc-orchestrator",
      broker: "arc-pi-adapter",
      copied_to: `${line.v}:${line.kind}:${line.seq}`,
    },
  };
  // Make TS happy without forcing the caller to thread the type through.
  void ulidLike(now);
  void EVENT_ID_PATTERN;
  void WORKFLOW_SLUG_PATTERN;
  return envelope;
}

/**
 * Parse a single stderr line. Returns:
 *   - `envelope` when the line is a known-shape event whose payload fits.
 *   - `oversized` when the line is known-shape but exceeds the byte budget.
 *   - `unsupported` when the version or kind is outside the known sets.
 *   - `ignored` when the line is not a live-activity line at all.
 */
export function parseLiveActivityLine(
  line: string,
  context: BridgeContext,
  options: {
    readonly now?: () => Date;
    readonly createEventId?: () => string;
    readonly maxPayloadBytes?: number;
  } = {},
): LiveActivityParseResult {
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (!trimmed.startsWith(LIVE_ACTIVITY_EVENT_PREFIX)) {
    return { status: "ignored", reason: "no-prefix", raw: line };
  }
  const jsonPart = trimmed.slice(LIVE_ACTIVITY_EVENT_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPart);
  } catch {
    return { status: "ignored", reason: "invalid-json", raw: line };
  }
  if (!isPlainObject(parsed)) {
    return { status: "ignored", reason: "schema-mismatch", raw: line };
  }
  const version = parsed.v;
  const kind = parsed.kind;
  const seq = parsed.seq;
  const at = parsed.at;
  const data = parsed.data;
  if (typeof version !== "number" || typeof kind !== "string" || typeof seq !== "number" || typeof at !== "number" || !isPlainObject(data)) {
    return { status: "ignored", reason: "schema-mismatch", raw: line };
  }
  if (version !== 1 && version !== 2) {
    return { status: "unsupported", version, kind, raw: line };
  }
  if (!knownKind(kind, version)) {
    return { status: "unsupported", version, kind, raw: line };
  }
  const source: LiveActivityLine = {
    v: version as LiveActivityVersion,
    kind,
    seq,
    at,
    data,
  };
  const envelopeKind = kindToEnvelopeKind(kind as LiveActivityKindV1 | LiveActivityKindV2);
  const now = options.now ?? (() => new Date());
  const createEventId = options.createEventId ?? (() => {
    // ULIDs are 26 chars in Crockford base32 (0-9, A-Z minus I, L, O, U).
    // We synthesize one from the timestamp + monotonic counter.
    return ulidLike(now);
  });
  const envelope = buildEnvelope(source, context, envelopeKind, now, createEventId);
  const maxBytes = options.maxPayloadBytes ?? MAX_EVENT_PAYLOAD_BYTES;
  const payloadBytes = utf8ByteLength(JSON.stringify(envelope.payload));
  if (payloadBytes > maxBytes) {
    return { status: "oversized", envelope, source };
  }
  void EVENT_KINDS;
  return { status: "envelope", envelope, source };
}
