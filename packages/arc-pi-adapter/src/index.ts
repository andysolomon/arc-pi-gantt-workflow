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

export {
  createQuestionBroker,
  EVENT_ENVELOPE_VERSION,
  isMandatoryBrokerGate,
  MANDATORY_BROKER_GATES,
} from "./questions/index.ts";
export type {
  AskOperatorFn,
  AskOperatorInput,
  BrokerAnswer,
  BrokerFailure,
  BrokerFailureReason,
  BrokerJournal,
  BrokerResolution,
  BrokerResult,
  BrokerSuccess,
  EventEnvelope,
  EventGate,
  MandatoryBrokerGate,
  QuestionBroker,
  QuestionBrokerConfig,
  QuestionBrokerOptions,
  QuestionEventEnvelope,
} from "./questions/index.ts";
