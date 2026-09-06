export const PACKAGE_NAME = "@arc/pi-workflow";

export { consumeLiveWorkflowEdit } from "./live-edit.ts";
export type {
  RevalidateWorkflowEditOptions,
  WorkflowEditDiagnostic,
  WorkflowEditImpact,
  WorkflowEditResult,
} from "@arc/workflow-core";

export {
  createModelProposalImporter,
  importModelProposal,
  MODEL_PROPOSAL_CONFIRM_LABEL,
  MODEL_PROPOSAL_REJECT_LABEL,
} from "./import/index.ts";
export type {
  ImportModelProposalOptions,
  ModelProposalConfirmation,
  ModelProposalConfirmationKind,
  ModelProposalConfirmationStatus,
  ModelProposalImporter,
  ModelProposalImportFailure,
  ModelProposalImportFailureStage,
  ModelProposalImportResult,
  ModelProposalImportSuccess,
  ModelProposalLeafDecision,
} from "./import/index.ts";

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
  createQuestionQueue,
  DEFAULT_MAX_QUEUED_QUESTIONS,
  MAX_QUEUED_QUESTIONS,
  DEFAULT_MAX_PENDING_QUESTIONS_PER_ITEM,
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
  EventGate,
  MandatoryBrokerGate,
  QuestionBroker,
  QuestionBrokerConfig,
  QuestionBrokerOptions,
  QuestionEventEnvelope,
  QuestionQueue,
  QuestionQueueEntry,
  QuestionQueueEntryStatus,
  QuestionQueueOptions,
} from "./questions/index.ts";

export {
  createOrchestratorBridge,
  parseLiveActivityLine,
  resolveRunnerBinary,
  buildInvocation,
  defaultInvoker,
  LIVE_ACTIVITY_EVENT_PREFIX,
  LIVE_ACTIVITY_KNOWN_VERSIONS,
  LIVE_ACTIVITY_KINDS_V1,
  LIVE_ACTIVITY_KINDS_V2,
} from "./orchestrator/index.ts";
export type {
  OrchestratorBridge,
  OrchestratorBridgeOptions,
  BridgeContext,
  BridgeJournal,
  LiveActivityLine,
  LiveActivityParseResult,
  LiveActivityVersion,
  LiveActivityKindV1,
  LiveActivityKindV2,
  RunnerBinaryResolution,
  RunnerInvocation,
  RunnerInvoker,
  EventKind,
  EventProvenance,
} from "./orchestrator/index.ts";

// EventEnvelope is re-exported from both modules, but the underlying type is
// the same. Export it once from the questions module so adapter callers see
// a single canonical name.
export type { EventEnvelope } from "./questions/index.ts";

export {
  createCancelController,
  createCancellationController,
  createRestartReconciler,
  createRestartRecovery,
  findRestartDiscrepancies,
} from "./recovery/index.ts";
export type {
  CancellationController,
  CancellationSessionPort,
  CancellationWorktreePort,
  CancelOptions,
  CancelResult,
  RestartCheckpointPort,
  RestartDiscrepancy,
  RestartDiscrepancyKind,
  RestartFailure,
  RestartJournalCheckpoint,
  RestartOptions,
  RestartReconciler,
  RestartResolution,
  RestartResult,
  RestartWorktree,
} from "./recovery/index.ts";

export {
  createFsAtomicWorkflowWriter,
  executeCompletion,
  noRiskReview,
} from "./complete/index.ts";
export type {
  AtomicWriteContents,
  AtomicWriteResult,
  AtomicWorkflowWriter,
  CompletionDecision,
  CompletionFileSystem,
  ExecuteCompletionOptions,
  RiskReviewInput,
  RiskReviewOutcome,
  RiskReviewPort,
  WorkflowPaths,
} from "./complete/index.ts";

export {
  default as registerArcWorkflow,
  WORKFLOW_COMMAND_NAME,
  WORKFLOW_COMMANDS,
  parseWorkflowCommand,
  workflowHelp,
} from "./extension.ts";
export type {
  ParsedWorkflowCommand,
  WorkflowCommand,
  WorkflowCommandState,
  WorkflowExtensionApi,
  WorkflowExtensionContext,
  WorkflowExtensionUi,
} from "./extension.ts";

export {
  createArchive,
  createArchiveController,
} from "./archive/index.ts";
export type {
  ArchiveController,
  ArchiveFailure,
  ArchiveFailureCode,
  ArchiveFailureResult,
  ArchiveJournalTarget,
  ArchiveOptions,
  ArchiveResourcePort,
  ArchiveRetention,
  ArchiveResult,
  ArchiveSessionTarget,
  ArchiveSuccess,
} from "./archive/index.ts";

export {
  createParallelRunner,
  DEFAULT_PARALLEL_RUNNER_CONCURRENCY,
} from "./run-parallel.ts";
export type {
  ParallelRunner,
  ParallelRunnerLeafOutcome,
  ParallelRunnerLeafStatus,
  ParallelRunnerOptions,
  ParallelRunnerOutcome,
  ParallelRunnerPaths,
  ParallelWorker,
} from "./run-parallel.ts";

export {
  CHECKPOINT_KEYS,
  checkpointCounts,
  createWorkflowDashboard,
  createWorkflowRpc,
  handleWorkflowRpc,
  MAX_WORKFLOW_RPC_REQUEST_BYTES,
  MAX_WORKFLOW_RPC_RESPONSE_BYTES,
  renderDashboardTui,
  renderPassiveWidget,
} from "./ui/index.ts";
export type {
  DashboardCounts,
  DashboardItem,
  DashboardRuntimeState,
  DashboardSnapshot,
  QuestionQueueLike,
  WorkflowDashboard,
  WorkflowDashboardOptions,
  WorkflowRpcFailure,
  WorkflowRpcHandler,
  WorkflowRpcRequest,
  WorkflowRpcResponse,
  WorkflowRpcSuccess,
  WorkflowSource,
} from "./ui/index.ts";
