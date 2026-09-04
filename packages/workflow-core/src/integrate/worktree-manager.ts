/** Generic ports used by the worktree manager. No repository or Pi APIs are assumed. */
export interface WorktreeFileSystem {
  mkdir(path: string): Promise<void>;
}

export interface WorktreeGit {
  createWorktree(path: string, repositoryRoot: string): Promise<void>;
  removeWorktree(path: string, repositoryRoot: string): Promise<void>;
}

export type WorktreeMode = "worktree" | "off";
export type CancelWorktreeDecision = "preserve" | "delete";

export interface WorktreeManagerOptions {
  repositoryRoot: string;
  workflowSlug?: string;
  mode?: WorktreeMode;
  fileSystem: WorktreeFileSystem;
  git: WorktreeGit;
}

export interface WorktreeHandle {
  readonly mode: WorktreeMode;
  readonly path: string | null;
  readonly workflowSlug: string;
  readonly itemId: string;
  readonly reused: boolean;
}

export interface CancelWorktreeRequest {
  workflowSlug?: string;
  itemId: string;
  decision: CancelWorktreeDecision;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
// Item identifiers are deliberately a single path component. Dots support IDs such as 4.1.
const ITEM = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

function checkSlug(value: string): void {
  if (typeof value !== "string" || !SLUG.test(value)) {
    throw new TypeError(`Invalid workflow slug: ${value}`);
  }
}

function checkItem(value: string): void {
  if (typeof value !== "string" || value === "." || value === ".." || !ITEM.test(value)) {
    throw new TypeError(`Invalid workflow item id: ${value}`);
  }
}

function absolute(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new TypeError("Repository root must be an absolute, safe path");
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new TypeError("Repository root must not traverse above its root");
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function childPath(root: string, slug: string, item: string): string {
  const path = `${root === "/" ? "" : root}/.arc/worktrees/${slug}/${item}`;
  // This is intentionally lexical as the filesystem is an injected port. A real adapter
  // must also ensure repositoryRoot is the checkout it intends to operate on.
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new TypeError("Worktree path is outside the repository");
  }
  return path;
}

type Key = string;

/** Creates and owns deterministic per-item worktrees. */
export class WorktreeManager {
  readonly #root: string;
  readonly #defaultSlug: string | undefined;
  readonly #mode: WorktreeMode;
  readonly #fs: WorktreeFileSystem;
  readonly #git: WorktreeGit;
  readonly #owned = new Map<Key, string>();
  readonly #inFlight = new Map<Key, Promise<WorktreeHandle>>();

  constructor(options: WorktreeManagerOptions) {
    this.#root = absolute(options.repositoryRoot);
    this.#defaultSlug = options.workflowSlug;
    if (this.#defaultSlug !== undefined) checkSlug(this.#defaultSlug);
    this.#mode = options.mode ?? "worktree";
    if (this.#mode !== "worktree" && this.#mode !== "off") throw new TypeError("Invalid worktree mode");
    this.#fs = options.fileSystem;
    this.#git = options.git;
    if (!this.#fs || !this.#git) throw new TypeError("Worktree manager requires filesystem and git ports");
  }

  private slug(value?: string): string {
    const slug = value ?? this.#defaultSlug;
    if (slug === undefined) throw new TypeError("Workflow slug is required");
    checkSlug(slug);
    return slug;
  }

  async acquire(itemId: string, workflowSlug?: string): Promise<WorktreeHandle>;
  async acquire(request: { itemId: string; workflowSlug?: string }): Promise<WorktreeHandle>;
  async acquire(itemOrRequest: string | { itemId: string; workflowSlug?: string }, explicitSlug?: string): Promise<WorktreeHandle> {
    const itemId = typeof itemOrRequest === "string" ? itemOrRequest : itemOrRequest.itemId;
    const slug = this.slug(typeof itemOrRequest === "string" ? explicitSlug : itemOrRequest.workflowSlug);
    checkItem(itemId);
    const path = childPath(this.#root, slug, itemId);
    const key = `${slug}\0${itemId}`;
    if (this.#mode === "off") return { mode: "off", path: null, workflowSlug: slug, itemId, reused: false };
    const owned = this.#owned.get(key);
    if (owned !== undefined) return { mode: "worktree", path: owned, workflowSlug: slug, itemId, reused: true };
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const creation = (async (): Promise<WorktreeHandle> => {
      await this.#fs.mkdir(`${this.#root}/.arc/worktrees/${slug}`);
      await this.#git.createWorktree(path, this.#root);
      this.#owned.set(key, path);
      return { mode: "worktree", path, workflowSlug: slug, itemId, reused: false };
    })();
    this.#inFlight.set(key, creation);
    try { return await creation; } finally { this.#inFlight.delete(key); }
  }

  create(itemId: string, workflowSlug?: string): Promise<WorktreeHandle>;
  create(request: { itemId: string; workflowSlug?: string }): Promise<WorktreeHandle>;
  create(value: string | { itemId: string; workflowSlug?: string }, slug?: string): Promise<WorktreeHandle> {
    return typeof value === "string" ? this.acquire(value, slug) : this.acquire(value);
  }

  async cancel(request: CancelWorktreeRequest): Promise<void>;
  async cancel(itemId: string, decision: CancelWorktreeDecision, workflowSlug?: string): Promise<void>;
  async cancel(value: CancelWorktreeRequest | string, decision?: CancelWorktreeDecision, explicitSlug?: string): Promise<void> {
    const request = typeof value === "string" ? { itemId: value, decision, workflowSlug: explicitSlug } : value;
    const slug = this.slug(request.workflowSlug);
    checkItem(request.itemId);
    if (request.decision !== "preserve" && request.decision !== "delete") throw new TypeError("Cancel requires an explicit preserve or delete decision");
    if (this.#mode === "off" || request.decision === "preserve") return;
    const key = `${slug}\0${request.itemId}`;
    const path = this.#owned.get(key);
    if (path === undefined) throw new Error("Refusing to delete an unowned worktree");
    if (path !== childPath(this.#root, slug, request.itemId)) throw new Error("Refusing to delete an unsafe worktree path");
    await this.#git.removeWorktree(path, this.#root);
    this.#owned.delete(key);
  }
}

export function createWorktreeManager(options: WorktreeManagerOptions): WorktreeManager {
  return new WorktreeManager(options);
}
