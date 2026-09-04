import {
  EVENT_ENVELOPE_VERSION,
  EVENT_GATES,
  EVENT_KINDS,
  MANDATORY_EVENT_GATES,
  MAX_EVENT_PAYLOAD_BYTES,
  type EventDiagnostic,
  type EventDiagnosticCode,
  type EventEnvelope,
  type EventEnvelopeValidationResult,
  type EventGate,
  type QuestionEventEnvelope,
} from "./types.ts";

type MutableDiagnostic = {
  code: EventDiagnosticCode;
  path: string;
  message: string;
};

type ObjectValue = Record<string, unknown>;

const ENVELOPE_FIELDS = Object.freeze([
  "envelope_version",
  "event_id",
  "workflow_slug",
  "item_id",
  "session_id",
  "emitted_at",
  "kind",
  "payload",
  "provenance",
] as const);

const PAYLOAD_FIELDS = Object.freeze([
  "question_id",
  "text",
  "options",
  "gate",
  "default_on_timeout",
  "summary",
] as const);

const QUESTION_PAYLOAD_FIELDS = Object.freeze([
  "question_id",
  "text",
  "options",
  "gate",
] as const);

const PROVENANCE_FIELDS = Object.freeze(["source", "broker", "copied_to"] as const);

const OPTION_FIELDS = Object.freeze(["label", "description"] as const);

const EVENT_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const WORKFLOW_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// RFC 3339 date-time. Deliberately narrower than the lenient variants some
// validators accept: the separator must be T/t and the offset Z/z or +/-HH:MM.
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

const MIN_QUESTION_OPTIONS = 2;
const MAX_QUESTION_OPTIONS = 5;

const utf8Encoder = new TextEncoder();

function isPlainObject(value: unknown): value is ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addDiagnostic(
  diagnostics: MutableDiagnostic[],
  code: EventDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

/** Counts Unicode code points, matching how JSON Schema measures string length. */
function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isDateTime(value: string): boolean {
  const match = DATE_TIME_PATTERN.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  if (numericMonth < 1 || numericMonth > 12) return false;
  if (numericDay < 1 || numericDay > daysInMonth(numericYear, numericMonth)) {
    return false;
  }
  if (Number(hour) > 23 || Number(minute) > 59) return false;
  // Leap seconds are rejected rather than offset-normalized: emitters use
  // `Date#toISOString`, and accepting them would be looser than the schema.
  if (Number(second) > 59) return false;
  if (offsetHour !== undefined && Number(offsetHour) > 23) return false;
  if (offsetMinute !== undefined && Number(offsetMinute) > 59) return false;
  return true;
}

function validateBoundedString(
  value: unknown,
  path: string,
  minLength: number,
  maxLength: number,
  diagnostics: MutableDiagnostic[],
): void {
  if (typeof value !== "string") {
    addDiagnostic(diagnostics, "invalid_field", path, "Value must be a string.");
    return;
  }
  const length = codePointLength(value);
  if (length < minLength) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      `Value must be at least ${minLength} character(s).`,
    );
    return;
  }
  if (length > maxLength) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      `Value must be at most ${maxLength} character(s).`,
    );
  }
}

function validateUnknownFields(
  value: ObjectValue,
  path: string,
  allowed: readonly string[],
  diagnostics: MutableDiagnostic[],
): void {
  for (const key of Object.keys(value).sort(compareText)) {
    if (!allowed.includes(key)) {
      addDiagnostic(
        diagnostics,
        "unknown_field",
        `${path}.${key}`,
        "Field is not part of the envelope contract.",
      );
    }
  }
}

/**
 * Own keys whose value is defined. `JSON.stringify` drops `undefined` fields, so
 * counting all own keys would hide envelopes that would serialize as empty.
 */
function definedOwnKeys(value: ObjectValue): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/**
 * Reject fields whose value is explicitly `undefined`. Such fields survive
 * `Object.keys` but are dropped by `JSON.stringify`, so they would let an
 * otherwise-invalid envelope pass the module-level checks while still
 * violating the published wire schema.
 */
function rejectUndefinedFields(
  value: ObjectValue,
  path: string,
  diagnostics: MutableDiagnostic[],
): void {
  for (const key of Object.keys(value).sort(compareText)) {
    if (value[key] === undefined) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        `${path}.${key}`,
        "Field is present but undefined; omit it instead so the envelope matches its serialized wire form.",
      );
    }
  }
}

function validateOption(
  option: unknown,
  path: string,
  diagnostics: MutableDiagnostic[],
): void {
  if (!isPlainObject(option)) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      "Option must be a plain object.",
    );
    return;
  }
  validateUnknownFields(option, path, OPTION_FIELDS, diagnostics);
  if (option.label === undefined) {
    addDiagnostic(
      diagnostics,
      "missing_field",
      `${path}.label`,
      "label is required.",
    );
  } else {
    validateBoundedString(option.label, `${path}.label`, 1, 80, diagnostics);
  }
  if (option.description !== undefined) {
    validateBoundedString(
      option.description,
      `${path}.description`,
      0,
      240,
      diagnostics,
    );
  }
}

function validateOptions(
  options: unknown,
  path: string,
  diagnostics: MutableDiagnostic[],
): void {
  if (!Array.isArray(options)) {
    addDiagnostic(diagnostics, "invalid_field", path, "options must be an array.");
    return;
  }
  if (options.length < MIN_QUESTION_OPTIONS) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      `options must contain at least ${MIN_QUESTION_OPTIONS} entries.`,
    );
  }
  if (options.length > MAX_QUESTION_OPTIONS) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      `options must contain at most ${MAX_QUESTION_OPTIONS} entries.`,
    );
  }
  for (const [index, option] of options.entries()) {
    validateOption(option, `${path}[${index}]`, diagnostics);
  }
}

function validatePayload(
  payload: ObjectValue,
  kind: unknown,
  diagnostics: MutableDiagnostic[],
): void {
  const path = "$.payload";
  rejectUndefinedFields(payload, path, diagnostics);
  validateUnknownFields(payload, path, PAYLOAD_FIELDS, diagnostics);
  if (definedOwnKeys(payload).length === 0) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      "payload must contain at least one field.",
    );
  }

  if (payload.question_id !== undefined) {
    validateBoundedString(
      payload.question_id,
      `${path}.question_id`,
      1,
      64,
      diagnostics,
    );
  }
  if (payload.text !== undefined) {
    validateBoundedString(payload.text, `${path}.text`, 1, 2000, diagnostics);
  }
  if (payload.options !== undefined) {
    validateOptions(payload.options, `${path}.options`, diagnostics);
  }
  if (
    payload.gate !== undefined &&
    !EVENT_GATES.some((gate) => gate === payload.gate)
  ) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      `${path}.gate`,
      `gate must be one of: ${EVENT_GATES.join(", ")}.`,
    );
  }
  if (payload.default_on_timeout !== undefined) {
    validateBoundedString(
      payload.default_on_timeout,
      `${path}.default_on_timeout`,
      1,
      80,
      diagnostics,
    );
  }
  if (payload.summary !== undefined) {
    validateBoundedString(payload.summary, `${path}.summary`, 1, 32768, diagnostics);
  }

  if (kind === "question") {
    for (const field of QUESTION_PAYLOAD_FIELDS) {
      if (payload[field] === undefined) {
        addDiagnostic(
          diagnostics,
          "missing_field",
          `${path}.${field}`,
          `${field} is required for question envelopes.`,
        );
      }
    }
  }

  // A mandatory gate fails closed, so it may never carry an auto-answer default.
  // A payload with no gate at all is unconstrained here, matching the schema.
  if (
    payload.default_on_timeout !== undefined &&
    typeof payload.gate === "string" &&
    payload.gate !== "none"
  ) {
    addDiagnostic(
      diagnostics,
      "gate_conflict",
      `${path}.default_on_timeout`,
      "default_on_timeout is not allowed when a gate other than \"none\" is set.",
    );
  }
}

function validateProvenance(
  provenance: ObjectValue,
  diagnostics: MutableDiagnostic[],
): void {
  const path = "$.provenance";
  rejectUndefinedFields(provenance, path, diagnostics);
  validateUnknownFields(provenance, path, PROVENANCE_FIELDS, diagnostics);
  if (definedOwnKeys(provenance).length === 0) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      path,
      "provenance must contain at least one field.",
    );
  }
  for (const field of PROVENANCE_FIELDS) {
    if (provenance[field] !== undefined) {
      validateBoundedString(
        provenance[field],
        `${path}.${field}`,
        1,
        64,
        diagnostics,
      );
    }
  }
}

/** Returns the serialized UTF-8 payload size, or 0 when it is not measurable. */
function measurePayloadBytes(payload: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return 0;
  }
  return serialized === undefined ? 0 : utf8ByteLength(serialized);
}

function failure(diagnostics: EventDiagnostic[]): EventEnvelopeValidationResult {
  return { valid: false, payload_bytes: 0, diagnostics };
}

/**
 * Validates a child-to-controller event envelope against the v1 contract in
 * `schema/event-envelope.schema.json`, plus a UTF-8 payload byte bound that is
 * stricter than the schema's code-point `maxLength`.
 *
 * The check is pure: it reads no files, appends no journal records, contacts no
 * broker, and neither copies nor mutates the input.
 */
export function validateEventEnvelope(
  input: unknown,
): EventEnvelopeValidationResult {
  if (!isPlainObject(input)) {
    return failure([
      {
        code: "invalid_envelope",
        path: "$",
        message: "Event envelope must be a plain object.",
      },
    ]);
  }

  // Version first: an unknown version means the rest of the shape is unknown too,
  // so reporting field-level diagnostics against v1 rules would be misleading.
  if (input.envelope_version === undefined) {
    return failure([
      {
        code: "missing_field",
        path: "$.envelope_version",
        message: "envelope_version is required.",
      },
    ]);
  }
  if (input.envelope_version !== EVENT_ENVELOPE_VERSION) {
    return failure([
      {
        code: "unsupported_version",
        path: "$.envelope_version",
        message: `envelope_version must be "${EVENT_ENVELOPE_VERSION}".`,
      },
    ]);
  }

  const diagnostics: MutableDiagnostic[] = [];
  validateUnknownFields(input, "$", ENVELOPE_FIELDS, diagnostics);
  for (const field of ENVELOPE_FIELDS) {
    if (input[field] === undefined) {
      addDiagnostic(
        diagnostics,
        "missing_field",
        `$.${field}`,
        `${field} is required.`,
      );
    }
  }

  if (input.event_id !== undefined) {
    if (
      typeof input.event_id !== "string" ||
      !EVENT_ID_PATTERN.test(input.event_id)
    ) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.event_id",
        "event_id must be a 26-character uppercase ULID.",
      );
    }
  }
  if (input.workflow_slug !== undefined) {
    if (
      typeof input.workflow_slug !== "string" ||
      !WORKFLOW_SLUG_PATTERN.test(input.workflow_slug)
    ) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.workflow_slug",
        "workflow_slug must be a lowercase, hyphen-separated slug of 1-64 characters.",
      );
    }
  }
  if (input.item_id !== undefined) {
    validateBoundedString(input.item_id, "$.item_id", 1, 64, diagnostics);
  }
  if (input.session_id !== undefined) {
    validateBoundedString(input.session_id, "$.session_id", 1, 128, diagnostics);
  }
  if (input.emitted_at !== undefined) {
    if (typeof input.emitted_at !== "string" || !isDateTime(input.emitted_at)) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.emitted_at",
        "emitted_at must be an RFC 3339 date-time.",
      );
    }
  }
  if (
    input.kind !== undefined &&
    !EVENT_KINDS.some((kind) => kind === input.kind)
  ) {
    addDiagnostic(
      diagnostics,
      "invalid_field",
      "$.kind",
      `kind must be one of: ${EVENT_KINDS.join(", ")}.`,
    );
  }

  let payloadBytes = 0;
  if (input.payload !== undefined) {
    if (!isPlainObject(input.payload)) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.payload",
        "payload must be a plain object.",
      );
    } else {
      validatePayload(input.payload, input.kind, diagnostics);
      payloadBytes = measurePayloadBytes(input.payload);
      if (payloadBytes > MAX_EVENT_PAYLOAD_BYTES) {
        addDiagnostic(
          diagnostics,
          "payload_too_large",
          "$.payload",
          `payload is ${payloadBytes} UTF-8 bytes, exceeding the maximum of ${MAX_EVENT_PAYLOAD_BYTES}.`,
        );
      }
    }
  }

  if (input.provenance !== undefined) {
    if (!isPlainObject(input.provenance)) {
      addDiagnostic(
        diagnostics,
        "invalid_field",
        "$.provenance",
        "provenance must be a plain object.",
      );
    } else {
      validateProvenance(input.provenance, diagnostics);
    }
  }

  diagnostics.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );

  if (diagnostics.length > 0) {
    return { valid: false, payload_bytes: payloadBytes, diagnostics };
  }
  return {
    valid: true,
    envelope: input as unknown as EventEnvelope,
    payload_bytes: payloadBytes,
    diagnostics,
  };
}

function formatDiagnostics(diagnostics: readonly EventDiagnostic[]): string {
  return diagnostics
    .map(({ code, path, message }) => `${path}: ${code}: ${message}`)
    .join("; ");
}

/** Narrows `input` to a valid v1 envelope, throwing deterministic diagnostics. */
export function assertEventEnvelope(
  input: unknown,
): asserts input is EventEnvelope {
  const result = validateEventEnvelope(input);
  if (!result.valid) {
    throw new TypeError(
      `Invalid event envelope: ${formatDiagnostics(result.diagnostics)}`,
    );
  }
}

/** True when `gate` fails closed and must never be auto-answered on timeout. */
export function isMandatoryEventGate(gate: EventGate): boolean {
  return MANDATORY_EVENT_GATES.some((mandatory) => mandatory === gate);
}

/** Narrows a validated envelope to the question shape the broker consumes. */
export function isQuestionEventEnvelope(
  envelope: EventEnvelope,
): envelope is QuestionEventEnvelope {
  return (
    envelope.kind === "question" &&
    typeof envelope.payload.question_id === "string" &&
    typeof envelope.payload.text === "string" &&
    Array.isArray(envelope.payload.options) &&
    typeof envelope.payload.gate === "string"
  );
}
