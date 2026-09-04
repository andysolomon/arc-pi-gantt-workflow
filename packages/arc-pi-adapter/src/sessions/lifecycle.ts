import { getChildProfile, type ChildProfile, type ChildProfileId } from "./profiles.ts";

/** The deliberately small subset of Pi's SessionManager used by the adapter. */
export interface PersistedPiSession {
  readonly path: string;
  readonly session: unknown;
}

export interface PiSessionFactory<Session = unknown, Options = unknown> {
  create(cwd: string, sessionDir?: string, options?: Options): Promise<PersistedPiSession & { session: Session }> | PersistedPiSession & { session: Session };
  open(path: string, sessionDir?: string, cwdOverride?: string): Promise<Session> | Session;
}

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly workflowSlug: string;
  readonly leaf: string;
  readonly ownerIdentity: string;
  readonly cwd: string;
  readonly profileId: ChildProfileId;
  readonly sessionPath: string;
  readonly archived?: boolean;
}

export interface SessionMetadataStore {
  read(key: string): Promise<SessionRecord | undefined> | SessionRecord | undefined;
  write(key: string, record: SessionRecord): Promise<void> | void;
  /** Optional: archival may annotate metadata, but must not remove the record. */
  archive?(key: string, record: SessionRecord): Promise<void> | void;
}

export interface AcquireInput<Options = unknown> {
  readonly workflowSlug: string;
  readonly leaf: string;
  readonly cwd: string;
  readonly sessionDir?: string;
  readonly profileId: ChildProfileId;
  readonly options?: Options;
}

export interface AcquiredSession<Session = unknown> {
  readonly session: Session;
  readonly record: SessionRecord;
  readonly profile: ChildProfile;
  readonly reused: boolean;
}

export interface SessionLifecycleOptions<Session = unknown, Options = unknown> {
  readonly factory: PiSessionFactory<Session, Options>;
  readonly metadata: SessionMetadataStore;
  /** Defaults to `${workflowSlug}:${leaf}`. */
  readonly ownerIdentity?: (input: AcquireInput<Options>) => string;
}

function keyFor(input: AcquireInput): string {
  return `${input.workflowSlug}\u0000${input.leaf}`;
}

function safePart(value: string, name: string): void {
  if (!value || value === "." || value === ".." || value.includes("\u0000") || value.includes("/") || value.includes("\\")) {
    throw new Error(`unsafe ${name}`);
  }
}

function safePath(path: string, sessionDir?: string): void {
  if (!path || path.includes("\u0000")) throw new Error("unsafe session path");
  // A persisted path must never contain traversal components. The factory is
  // responsible for choosing relative/absolute semantics.
  if (path.split(/[\\/]/).some((part) => part === "..")) throw new Error("unsafe session path");
  if (sessionDir && path.startsWith("/") && !path.startsWith(sessionDir.endsWith("/") ? sessionDir : `${sessionDir}/`) && path !== sessionDir) {
    throw new Error("session path is outside session directory");
  }
}

function assertRecord(record: SessionRecord, input: AcquireInput, owner: string): void {
  if (record.schemaVersion !== 1) throw new Error("unsupported session record");
  if (record.workflowSlug !== input.workflowSlug || record.leaf !== input.leaf) throw new Error("mismatched session record");
  if (record.ownerIdentity !== owner) throw new Error("session record owner mismatch");
  if (record.cwd !== input.cwd) throw new Error("session record cwd mismatch");
  if (record.profileId !== input.profileId) throw new Error("session record profile mismatch");
  safePath(record.sessionPath, input.sessionDir);
}

interface InFlightRequest<Session> {
  readonly owner: string;
  readonly cwd: string;
  readonly profileId: ChildProfileId;
  readonly sessionDir: string | undefined;
  readonly promise: Promise<AcquiredSession<Session>>;
}

function assertInFlightRequest<Options>(request: InFlightRequest<unknown>, input: AcquireInput<Options>, owner: string): void {
  if (request.owner !== owner) throw new Error("in-flight session owner mismatch");
  if (request.cwd !== input.cwd) throw new Error("in-flight session cwd mismatch");
  if (request.profileId !== input.profileId) throw new Error("in-flight session profile mismatch");
  if (request.sessionDir !== input.sessionDir) throw new Error("in-flight session directory mismatch");
}

/**
 * Owns one persisted child session per workflow leaf. The in-flight map is
 * intentionally local to this object: a new object models a process restart,
 * where the metadata store is the source of truth.
 */
export class SessionLifecycle<Session = unknown, Options = unknown> {
  private readonly inFlight = new Map<string, InFlightRequest<Session>>();
  private readonly active = new Map<string, AcquiredSession<Session>>();
  private readonly ownerIdentity: (input: AcquireInput<Options>) => string;
  private readonly deps: SessionLifecycleOptions<Session, Options>;

  constructor(deps: SessionLifecycleOptions<Session, Options>) {
    this.deps = deps;
    this.ownerIdentity = deps.ownerIdentity ?? ((input) => `${input.workflowSlug}:${input.leaf}`);
  }

  async acquire(input: AcquireInput<Options>): Promise<AcquiredSession<Session>> {
    safePart(input.workflowSlug, "workflow slug");
    safePart(input.leaf, "leaf");
    const profile = getChildProfile(input.profileId);
    const key = keyFor(input);
    const owner = this.ownerIdentity(input);
    const active = this.active.get(key);
    if (active) {
      // Validate the caller even when the in-process session is already open.
      assertRecord(active.record, input, owner);
      return active;
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      // A single-flight result belongs to its initiating request. Do not hand
      // it to a caller whose session assumptions were not validated.
      assertInFlightRequest(existing, input, owner);
      return existing.promise;
    }
    const operation = this.acquireOnce(input, profile);
    this.inFlight.set(key, { owner, cwd: input.cwd, profileId: input.profileId, sessionDir: input.sessionDir, promise: operation });
    try {
      const acquired = await operation;
      this.active.set(key, acquired);
      return acquired;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async acquireOnce(input: AcquireInput<Options>, profile: ChildProfile): Promise<AcquiredSession<Session>> {
    const owner = this.ownerIdentity(input);
    const key = keyFor(input);
    const saved = await this.deps.metadata.read(key);
    if (saved) {
      assertRecord(saved, input, owner);
      const session = await this.deps.factory.open(saved.sessionPath, input.sessionDir, input.cwd);
      return { session, record: saved, profile, reused: true };
    }
    const created = await this.deps.factory.create(input.cwd, input.sessionDir, input.options);
    safePath(created.path, input.sessionDir);
    const record: SessionRecord = {
      schemaVersion: 1,
      workflowSlug: input.workflowSlug,
      leaf: input.leaf,
      ownerIdentity: owner,
      cwd: input.cwd,
      profileId: profile.id,
      sessionPath: created.path,
    };
    await this.deps.metadata.write(key, record);
    return { session: created.session, record, profile, reused: false };
  }

  /** Retain-only archival. It never closes, disposes, or deletes a session. */
  async archive(input: Pick<AcquireInput<Options>, "workflowSlug" | "leaf">): Promise<void> {
    const key = keyFor(input as AcquireInput);
    const record = await this.deps.metadata.read(key);
    if (!record) return;
    if (this.deps.metadata.archive) await this.deps.metadata.archive(key, { ...record, archived: true });
  }
}

export function createSessionLifecycle<Session = unknown, Options = unknown>(
  options: SessionLifecycleOptions<Session, Options>,
): SessionLifecycle<Session, Options> {
  return new SessionLifecycle(options);
}
