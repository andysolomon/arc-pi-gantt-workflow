export const PACKAGE_NAME = "@arc/pi-workflow";

export {
  CHILD_PROFILES,
  CHILD_PROFILE_IDS,
  WORKFLOW_EXTENSION_ID,
  getChildProfile,
} from "./sessions/index.ts";
export type {
  ChildProfile,
  ChildProfileId,
  ParentModelSelection,
  AcquireInput,
  AcquiredSession,
  PersistedPiSession,
  PiSessionFactory,
  SessionLifecycleOptions,
  SessionMetadataStore,
  SessionRecord,
} from "./sessions/index.ts";
export {
  SessionLifecycle,
  createSessionLifecycle,
} from "./sessions/index.ts";
