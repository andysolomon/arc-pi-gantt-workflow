import { resolve } from "node:path";

export const REDACTED_VALUE = "[REDACTED]" as const;

export type JournalPrimitive = boolean | null | number | string;
export type JournalValue =
  | JournalPrimitive
  | JournalValue[]
  | { [key: string]: JournalValue };

declare const SAFE_JOURNAL_METADATA_BRAND: unique symbol;

export interface SafeJournalMetadata {
  readonly [SAFE_JOURNAL_METADATA_BRAND]: true;
}

export type JournalInputValue =
  | JournalPrimitive
  | SafeJournalMetadata
  | JournalInputValue[]
  | { [key: string]: JournalInputValue };

export interface JournalEntry {
  kind: string;
  itemId?: string;
  sessionId?: string;
  data?: JournalInputValue;
}

export interface JournalRecord {
  id: string;
  recorded_at: string;
  workflow_slug: string;
  kind: string;
  item_id?: string;
  session_id?: string;
  data?: JournalValue;
}

export interface JournalFileSystem {
  mkdir(
    path: string,
    options: { mode: number; recursive: true },
  ): Promise<string | undefined | void>;
  chmod(path: string, mode: number): Promise<void>;
  appendFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<void>;
}

export interface RuntimeJournalOptions {
  workflowSlug: string;
  rootDirectory?: string;
  fileSystem: JournalFileSystem;
  now?: () => Date;
  createId?: () => string;
}

export interface RuntimeJournal {
  readonly path: string;
  append(entry: JournalEntry): Promise<JournalRecord>;
}

const WORKFLOW_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const SECRET_KEY_MARKERS = [
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "apikey",
  "accesskey",
  "accesstoken",
  "refreshtoken",
  "auth",
  "token",
  "privatekey",
  "cookie",
] as const;

const TRANSCRIPT_KEY_MARKERS = [
  "transcript",
  "history",
  "prompt",
  "response",
  "completion",
  "conversation",
  "dialogue",
  "rawcontent",
  "message",
] as const;

const OUTPUT_KEY_MARKERS = [
  "output",
  "outputs",
  "stdout",
  "stderr",
  "log",
  "logs",
] as const;

const ENVIRONMENT_KEYS = new Set([
  "env",
  "environment",
  "environmentvariable",
  "environmentvariables",
]);

const MESSAGE_IDENTITY_KEYS = new Set(["author", "role", "speaker", "type"]);

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i,
  /\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[a-z0-9_-]{8,}/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|token(?:[_-]?value)?|password|passwd|passphrase|secret|credential|private[_-]?key|cookie)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)/i,
  /\b(?:glpat-|npm_|AIza|sk_(?:live|test)_)[a-z0-9_-]{8,}/i,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i,
  /\b(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/,
] as const;

const ROLE_PREFIX_PATTERN =
  /^\s*(?:assistant|author|operator|reviewer|speaker|system|tool|user|worker)\s*:/i;
const SAFE_METADATA_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const safeMetadataValues = new WeakMap<object, string>();

function compactKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isSecretKey(key: string): boolean {
  const compact = compactKey(key);
  // `author` is safe message metadata, not an authentication field.
  return (
    compact !== "author" &&
    SECRET_KEY_MARKERS.some((marker) => compact.includes(marker))
  );
}

function isTranscriptKey(key: string): boolean {
  const compact = compactKey(key);
  return TRANSCRIPT_KEY_MARKERS.some((marker) => compact.includes(marker));
}

function isOutputKey(key: string): boolean {
  const compact = compactKey(key);
  return OUTPUT_KEY_MARKERS.some(
    (marker) => compact === marker || compact.endsWith(marker),
  );
}

function isEnvironmentKey(key: string): boolean {
  return ENVIRONMENT_KEYS.has(compactKey(key));
}

function isSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isValidSafeMetadataString(value: string): boolean {
  return (
    SAFE_METADATA_VALUE_PATTERN.test(value) &&
    !ROLE_PREFIX_PATTERN.test(value) &&
    !isSecretValue(value)
  );
}

export function safeJournalMetadata(value: string): SafeJournalMetadata {
  if (typeof value !== "string" || !isValidSafeMetadataString(value)) {
    throw new TypeError("Invalid safe journal metadata");
  }

  const metadata = Object.freeze({}) as SafeJournalMetadata;
  safeMetadataValues.set(metadata, value);
  return metadata;
}

function assertJsonSafeJournalInput(
  value: unknown,
  ancestors: Set<object> = new Set(),
): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Journal values must contain only finite numbers");
    }
    return;
  }

  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new TypeError(`Unsupported journal value: ${typeof value}`);
  }

  if (value === null || typeof value !== "object" || safeMetadataValues.has(value)) {
    return;
  }

  if (ancestors.has(value)) {
    throw new TypeError("Journal values must not contain circular references");
  }
  ancestors.add(value);

  if (
    Object.getOwnPropertySymbols(value).some((key) =>
      Object.prototype.propertyIsEnumerable.call(value, key),
    )
  ) {
    throw new TypeError("Unsupported journal property key: symbol");
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("Journal arrays must not use custom prototypes");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("Journal arrays must not contain sparse holes");
      }
    }
    for (const key of Object.keys(value)) {
      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      ) {
        throw new TypeError(
          "Journal arrays must not contain enumerable non-index properties",
        );
      }
      assertJsonSafeJournalInput(
        (value as unknown as Record<string, unknown>)[key],
        ancestors,
      );
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Journal values must contain only plain objects");
    }
    for (const key of Object.keys(value)) {
      assertJsonSafeJournalInput(
        (value as Record<string, unknown>)[key],
        ancestors,
      );
    }
  }

  ancestors.delete(value);
}

function isMessageContentObject(value: {
  [key: string]: JournalInputValue;
}): boolean {
  const keys = Object.keys(value).map(compactKey);
  return (
    keys.includes("content") &&
    keys.some((key) => MESSAGE_IDENTITY_KEYS.has(key))
  );
}

function redactJournalValueForKey(value: JournalInputValue): JournalValue {
  if (typeof value === "string") {
    return REDACTED_VALUE;
  }

  if (typeof value === "number") {
    return Object.is(value, -0) ? 0 : value;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const safeMetadata = safeMetadataValues.get(value);
  if (safeMetadata !== undefined) {
    return safeMetadata;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactJournalValueForKey(item));
  }

  const objectValue = value as { [key: string]: JournalInputValue };
  const messageContentObject = isMessageContentObject(objectValue);
  const redacted: { [key: string]: JournalValue } = {};
  for (const key of Object.keys(objectValue).sort()) {
    const compact = compactKey(key);
    const redactedKey = isSecretValue(key) ? REDACTED_VALUE : key;
    const redactedValue =
      isSecretKey(key) ||
      isTranscriptKey(key) ||
      isOutputKey(key) ||
      isEnvironmentKey(key) ||
      (messageContentObject && compact === "content")
        ? REDACTED_VALUE
        : redactJournalValueForKey(objectValue[key] as JournalInputValue);
    Object.defineProperty(redacted, redactedKey, {
      configurable: true,
      enumerable: true,
      value: redactedValue,
      writable: true,
    });
  }
  return redacted;
}

export function redactJournalValue(value: JournalInputValue): JournalValue {
  assertJsonSafeJournalInput(value);
  return redactJournalValueForKey(value);
}

function stableStringify(value: JournalValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(value[key] as JournalValue)}`,
    )
    .join(",")}}`;
}

function assertWorkflowSlug(workflowSlug: string): void {
  if (!WORKFLOW_SLUG_PATTERN.test(workflowSlug)) {
    throw new TypeError(`Invalid workflow slug: ${workflowSlug}`);
  }
}

export function getDefaultJournalPath(
  rootDirectory: string,
  workflowSlug: string,
): string {
  assertWorkflowSlug(workflowSlug);
  return resolve(
    rootDirectory,
    ".arc",
    "runtime",
    "workflows",
    workflowSlug,
    "journal.ndjson",
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createRuntimeJournal(
  options: RuntimeJournalOptions,
): RuntimeJournal {
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const path = getDefaultJournalPath(rootDirectory, options.workflowSlug);
  const directory = resolve(path, "..");
  const fileSystem = options.fileSystem;
  if (fileSystem === undefined) {
    throw new TypeError("Runtime journal requires an injected fileSystem");
  }
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  let writeTail: Promise<void> = Promise.resolve();

  return {
    path,
    async append(entry): Promise<JournalRecord> {
      assertJsonSafeJournalInput(entry);

      if (typeof entry.kind !== "string") {
        throw new TypeError("Journal entry kind must be a string");
      }
      if (entry.kind.length === 0) {
        throw new TypeError("Journal entry kind must not be empty");
      }
      if (entry.itemId !== undefined && typeof entry.itemId !== "string") {
        throw new TypeError("Journal entry itemId must be a string");
      }
      if (
        entry.sessionId !== undefined &&
        typeof entry.sessionId !== "string"
      ) {
        throw new TypeError("Journal entry sessionId must be a string");
      }

      const id = createId();
      if (typeof id !== "string") {
        throw new TypeError("Journal record id must be a string");
      }

      const record: JournalRecord = {
        id,
        recorded_at: now().toISOString(),
        workflow_slug: options.workflowSlug,
        kind: entry.kind,
        ...(entry.itemId === undefined ? {} : { item_id: entry.itemId }),
        ...(entry.sessionId === undefined
          ? {}
          : { session_id: entry.sessionId }),
        ...(entry.data === undefined
          ? {}
          : { data: redactJournalValue(entry.data) }),
      };
      assertJsonSafeJournalInput(record);
      const serializedRecord = `${stableStringify(
        record as unknown as JournalValue,
      )}\n`;

      const write = writeTail.then(async () => {
        await fileSystem.mkdir(directory, {
          recursive: true,
          mode: DIRECTORY_MODE,
        });
        await fileSystem.chmod(directory, DIRECTORY_MODE);

        try {
          await fileSystem.chmod(path, FILE_MODE);
        } catch (error) {
          if (!isMissingFile(error)) {
            throw error;
          }
        }

        await fileSystem.appendFile(
          path,
          serializedRecord,
          { encoding: "utf8", mode: FILE_MODE },
        );
        await fileSystem.chmod(path, FILE_MODE);
      });
      writeTail = write.catch(() => undefined);
      await write;
      return record;
    },
  };
}
