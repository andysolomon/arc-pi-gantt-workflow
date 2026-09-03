import type { NormalizeInput } from "../normalize/types.ts";

/**
 * Hook signature for adapter-side model proposals (Phase 8.2).
 * Core never invokes this — it exists only as a type contract.
 */
export interface ModelProposalHook {
  (markdown: string): Promise<NormalizeInput>;
}
