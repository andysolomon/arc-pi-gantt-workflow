/**
 * The versioned child-to-controller event envelope and its pure validator.
 *
 * This module owns envelope shape only: it performs no filesystem work, appends
 * no journal records, asks no questions, and starts no sessions.
 */
export {
  EVENT_ENVELOPE_VERSION,
  EVENT_GATES,
  EVENT_KINDS,
  MANDATORY_EVENT_GATES,
  MAX_EVENT_PAYLOAD_BYTES,
  type EventDiagnostic,
  type EventDiagnosticCode,
  type EventEnvelope,
  type EventEnvelopeValidationFailure,
  type EventEnvelopeValidationResult,
  type EventEnvelopeValidationSuccess,
  type EventGate,
  type EventKind,
  type EventPayload,
  type EventProvenance,
  type EventQuestionOption,
  type EventQuestionPayload,
  type MandatoryEventGate,
  type QuestionEventEnvelope,
} from "./types.ts";
export {
  assertEventEnvelope,
  isMandatoryEventGate,
  isQuestionEventEnvelope,
  validateEventEnvelope,
} from "./validate.ts";
