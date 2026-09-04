/** The only child-to-controller envelope version this build understands. */
export const EVENT_ENVELOPE_VERSION = "1.0.0" as const;

/** The complete, ordered set of envelope kinds. */
export const EVENT_KINDS = Object.freeze([
  "question",
  "progress",
  "artifact",
  "verify",
  "error",
  "done",
] as const);

export type EventKind = (typeof EVENT_KINDS)[number];

/** The complete, ordered set of question gates. */
export const EVENT_GATES = Object.freeze([
  "none",
  "implement",
  "integration",
  "release",
  "deploy",
] as const);

export type EventGate = (typeof EVENT_GATES)[number];

/**
 * Gates that must fail closed: a human answers them, so an envelope may never
 * carry a timeout default that would auto-answer on the operator's behalf.
 */
export const MANDATORY_EVENT_GATES = Object.freeze([
  "implement",
  "integration",
  "release",
  "deploy",
] as const);

export type MandatoryEventGate = (typeof MANDATORY_EVENT_GATES)[number];

/**
 * Maximum serialized payload size, measured in UTF-8 bytes. This is stricter
 * than the schema's `maxLength` bounds, which count code points.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 32768;

export interface EventQuestionOption {
  label: string;
  description?: string;
}

export interface EventPayload {
  question_id?: string;
  text?: string;
  options?: readonly EventQuestionOption[];
  gate?: EventGate;
  default_on_timeout?: string;
  summary?: string;
}

/** The payload shape a `question` envelope is required to carry. */
export interface EventQuestionPayload extends EventPayload {
  question_id: string;
  text: string;
  options: readonly EventQuestionOption[];
  gate: EventGate;
}

export interface EventProvenance {
  source?: string;
  broker?: string;
  copied_to?: string;
}

export interface EventEnvelope {
  envelope_version: typeof EVENT_ENVELOPE_VERSION;
  event_id: string;
  workflow_slug: string;
  item_id: string;
  session_id: string;
  emitted_at: string;
  kind: EventKind;
  payload: EventPayload;
  provenance: EventProvenance;
}

export interface QuestionEventEnvelope extends EventEnvelope {
  kind: "question";
  payload: EventQuestionPayload;
}

export type EventDiagnosticCode =
  | "gate_conflict"
  | "invalid_envelope"
  | "invalid_field"
  | "missing_field"
  | "payload_too_large"
  | "unknown_field"
  | "unsupported_version";

export interface EventDiagnostic {
  readonly code: EventDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface EventEnvelopeValidationSuccess {
  readonly valid: true;
  /** The same object that was passed in; validation never copies or mutates. */
  readonly envelope: EventEnvelope;
  readonly payload_bytes: number;
  readonly diagnostics: readonly EventDiagnostic[];
}

export interface EventEnvelopeValidationFailure {
  readonly valid: false;
  /** UTF-8 payload size when it was measurable, otherwise 0. */
  readonly payload_bytes: number;
  readonly diagnostics: readonly EventDiagnostic[];
}

export type EventEnvelopeValidationResult =
  | EventEnvelopeValidationSuccess
  | EventEnvelopeValidationFailure;
