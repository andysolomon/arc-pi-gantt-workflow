/**
 * Adapter-side model proposal importer.
 *
 * The injected model hook is an untrusted boundary. Its output is normalized
 * and structurally validated before any operator question is asked. Eligible
 * leaves then pass two independent, ordered confirmations through the shipped
 * question broker. No answer, timeout default, or partial evidence can promote
 * a checkpoint.
 */
import {
  CheckpointState,
  EVENT_ENVELOPE_VERSION,
  normalize,
  validateWorkflow,
  type Leaf,
  type NormalizeInput,
  type QuestionEventEnvelope,
  type Workflow,
  type WorkflowItem,
} from "@arc/workflow-core";
import type { BrokerResult } from "../questions/index.ts";
import {
  MODEL_PROPOSAL_CONFIRM_LABEL,
  MODEL_PROPOSAL_REJECT_LABEL,
  type ImportModelProposalOptions,
  type ModelProposalConfirmation,
  type ModelProposalConfirmationKind,
  type ModelProposalImportFailure,
  type ModelProposalImporter,
  type ModelProposalImportResult,
  type ModelProposalLeafDecision,
} from "./types.ts";

const PROPOSAL_SOURCE = "model-proposal-importer" as const;
const PROPOSAL_BROKER = "arc-pi-adapter" as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal boundary check needed to call the existing normalizer safely. */
function isProposalRoot(value: unknown): value is NormalizeInput {
  if (!isObject(value) || !isObject(value.repository)) return false;
  if (value.form === "phased") return Array.isArray(value.groups);
  if (value.form === "flat") return Array.isArray(value.stories);
  return false;
}

/**
 * Preserve invalid supplied values for structural validation, but represent
 * omitted activation fields with the same empty values used by deterministic
 * importers. This lets an incomplete proposal remain a safe planned leaf.
 */
function canonicalizeMissingActivation(input: NormalizeInput): NormalizeInput {
  function canonicalizeItem(value: unknown): unknown {
    if (!isObject(value)) return value;
    if (value.kind === "group") {
      if (!Array.isArray(value.items)) return value;
      return { ...value, items: value.items.map(canonicalizeItem) };
    }
    if (value.kind !== "leaf") return value;
    return {
      ...value,
      outcome: value.outcome === undefined ? "" : value.outcome,
      scope: value.scope === undefined ? "" : value.scope,
      acceptance_criteria:
        value.acceptance_criteria === undefined ? [] : value.acceptance_criteria,
      preserved_behavior:
        value.preserved_behavior === undefined ? "" : value.preserved_behavior,
    };
  }

  if (input.form === "flat") {
    return {
      ...input,
      stories: input.stories.map(canonicalizeItem),
    } as NormalizeInput;
  }
  return {
    ...input,
    groups: input.groups.map(canonicalizeItem),
  } as NormalizeInput;
}

function failure(
  stage: ModelProposalImportFailure["stage"],
  message: string,
  diagnostics?: ModelProposalImportFailure["diagnostics"],
): ModelProposalImportFailure {
  return {
    ok: false,
    stage,
    message,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function defaultQuestionIdFactory(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `proposal-q-${count}`;
  };
}

function defaultEventIdFactory(now: () => Date): () => string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let count = 0;
  function encode(value: bigint, length: number): string {
    let remaining = value;
    let encoded = "";
    for (let index = 0; index < length; index += 1) {
      encoded = alphabet[Number(remaining % 32n)] + encoded;
      remaining /= 32n;
    }
    return encoded;
  }
  return () => {
    count += 1;
    const timestamp = BigInt(Math.max(0, Math.floor(now().getTime())));
    return `${encode(timestamp, 10)}${encode(BigInt(count), 16)}`;
  };
}

function questionText(kind: ModelProposalConfirmationKind, leaf: Leaf): string {
  if (kind === "dependencies") {
    return `Confirm the declared dependencies for proposed leaf ${leaf.id}: ${leaf.dependencies.join(", ")}.`;
  }
  return `Confirm proposed leaf ${leaf.id} is safe to run in parallel with otherwise-ready work.`;
}

function buildEnvelope(
  kind: ModelProposalConfirmationKind,
  workflow: Workflow,
  leaf: Leaf,
  options: ImportModelProposalOptions,
  questionId: string,
  eventId: string,
  now: () => Date,
): QuestionEventEnvelope {
  return {
    envelope_version: EVENT_ENVELOPE_VERSION,
    event_id: eventId,
    workflow_slug: workflow.slug,
    item_id: leaf.id,
    session_id: options.session_id,
    emitted_at: now().toISOString(),
    kind: "question",
    payload: {
      question_id: questionId,
      text: questionText(kind, leaf),
      options: [
        {
          label: MODEL_PROPOSAL_CONFIRM_LABEL,
          description: `Explicitly confirm the proposed ${kind === "dependencies" ? "dependency declaration" : "parallel-safety assessment"}.`,
        },
        {
          label: MODEL_PROPOSAL_REJECT_LABEL,
          description: "Keep this leaf planned for revision.",
        },
      ],
      // Import confirmations are implementation activation gates. Using the
      // mandatory gate also prevents the broker itself from timing out to a
      // configured affirmative default.
      gate: "implement",
    },
    provenance: { source: PROPOSAL_SOURCE, broker: PROPOSAL_BROKER },
  };
}

function notAsked(kind: ModelProposalConfirmationKind): ModelProposalConfirmation {
  return { kind, status: "not_asked" };
}

function sameEnvelopeEvidence(
  actual: QuestionEventEnvelope,
  expected: QuestionEventEnvelope,
): boolean {
  return (
    actual === expected ||
    (actual.envelope_version === expected.envelope_version &&
      actual.event_id === expected.event_id &&
      actual.workflow_slug === expected.workflow_slug &&
      actual.item_id === expected.item_id &&
      actual.session_id === expected.session_id &&
      actual.kind === "question" &&
      actual.payload.question_id === expected.payload.question_id &&
      actual.payload.gate === "implement" &&
      actual.provenance.source === PROPOSAL_SOURCE &&
      actual.provenance.broker === PROPOSAL_BROKER)
  );
}

function interpretBrokerResult(
  kind: ModelProposalConfirmationKind,
  envelope: QuestionEventEnvelope,
  result: BrokerResult,
): ModelProposalConfirmation {
  if (!result.ok) {
    return {
      kind,
      status: "broker_failure",
      envelope,
      broker_code: result.reason.code,
      message: result.reason.message,
    };
  }
  const { resolution } = result;
  if (resolution.used_default) {
    return {
      kind,
      status: "defaulted_answer",
      envelope,
      answer: resolution.answer.answer,
    };
  }
  const answer = resolution.answer.answer;
  const evidenceComplete =
    sameEnvelopeEvidence(resolution.envelope, envelope) &&
    nonEmptyString(resolution.answer.ledger_id) &&
    nonEmptyString(resolution.answer.created_at) &&
    nonEmptyString(resolution.journal_id);
  if (!evidenceComplete) {
    return { kind, status: "missing_evidence", envelope, answer };
  }
  const evidence = {
    kind,
    envelope,
    answer,
    ledger_id: resolution.answer.ledger_id,
    journal_id: resolution.journal_id,
  } as const;
  if (answer === MODEL_PROPOSAL_CONFIRM_LABEL) {
    return { ...evidence, status: "confirmed" };
  }
  if (answer === MODEL_PROPOSAL_REJECT_LABEL) {
    return { ...evidence, status: "denied" };
  }
  return { ...evidence, status: "unknown_answer" };
}

async function askForConfirmation(
  kind: ModelProposalConfirmationKind,
  workflow: Workflow,
  leaf: Leaf,
  options: ImportModelProposalOptions,
  createQuestionId: () => string,
  createEventId: () => string,
  now: () => Date,
): Promise<ModelProposalConfirmation> {
  const envelope = buildEnvelope(
    kind,
    workflow,
    leaf,
    options,
    createQuestionId(),
    createEventId(),
    now,
  );
  try {
    const result = await options.broker.ask(envelope);
    return interpretBrokerResult(kind, envelope, result);
  } catch (error) {
    return {
      kind,
      status: "broker_failure",
      envelope,
      message: errorMessage(error),
    };
  }
}

function promoteLeaf(
  item: WorkflowItem,
  decision: ModelProposalLeafDecision | undefined,
  updatedAt: string,
): WorkflowItem {
  if (item.kind !== "leaf" || decision?.ready !== true) return item;
  const dependencyEvidence = decision.dependencies.journal_id;
  const parallelEvidence = decision.parallel_safety.journal_id;
  if (dependencyEvidence === undefined || parallelEvidence === undefined) return item;
  return {
    ...item,
    checkpoint: {
      state: CheckpointState.ready,
      updated_at: updatedAt,
      evidence_ref: `proposal-confirmations:${dependencyEvidence}:${parallelEvidence}`,
    },
  };
}

async function runImport(
  markdown: string,
  options: ImportModelProposalOptions,
): Promise<ModelProposalImportResult> {
  let pending: ReturnType<ImportModelProposalOptions["hook"]>;
  try {
    pending = options.hook(markdown);
  } catch (error) {
    return failure("hook_invocation", errorMessage(error));
  }

  let proposal: unknown;
  try {
    proposal = await pending;
  } catch (error) {
    return failure("hook_rejection", errorMessage(error));
  }

  try {
    if (!isProposalRoot(proposal)) {
      return failure(
        "malformed_proposal",
        "Model proposal must be a phased or flat NormalizeInput with a repository object and item array.",
      );
    }
  } catch (error) {
    return failure("malformed_proposal", errorMessage(error));
  }

  let normalized: Workflow;
  try {
    normalized = normalize(canonicalizeMissingActivation(proposal), {
      updated_at: options.updated_at,
    });
  } catch (error) {
    return failure("normalization", errorMessage(error));
  }

  let validation: ReturnType<typeof validateWorkflow>;
  try {
    validation = validateWorkflow(normalized, options.validation);
  } catch (error) {
    return failure("validation", errorMessage(error));
  }
  if (!validation.structurally_valid) {
    return failure(
      "validation",
      "Normalized model proposal failed structural validation.",
      validation.diagnostics,
    );
  }

  const now = options.now ?? (() => new Date());
  const createQuestionId = options.createQuestionId ?? defaultQuestionIdFactory();
  const createEventId = options.createEventId ?? defaultEventIdFactory(now);
  const readinessById = new Map(
    validation.readiness.map((entry) => [entry.leaf_id, entry]),
  );
  const decisions: ModelProposalLeafDecision[] = [];

  for (const item of normalized.items) {
    if (item.kind !== "leaf") continue;
    const readiness = readinessById.get(item.id);
    const activationComplete = readiness?.ready === true;
    let dependencies = notAsked("dependencies");
    let parallelSafety = notAsked("parallel_safety");
    if (activationComplete) {
      dependencies = await askForConfirmation(
        "dependencies",
        normalized,
        item,
        options,
        createQuestionId,
        createEventId,
        now,
      );
      if (dependencies.status === "confirmed") {
        parallelSafety = await askForConfirmation(
          "parallel_safety",
          normalized,
          item,
          options,
          createQuestionId,
          createEventId,
          now,
        );
      }
    }
    decisions.push({
      leaf_id: item.id,
      activation_complete: activationComplete,
      missing_fields: readiness?.missing_fields ?? [],
      ready:
        dependencies.status === "confirmed" &&
        parallelSafety.status === "confirmed",
      dependencies,
      parallel_safety: parallelSafety,
    });
  }

  const decisionById = new Map(decisions.map((decision) => [decision.leaf_id, decision]));
  return {
    ok: true,
    workflow: {
      ...normalized,
      repository: { ...normalized.repository },
      items: normalized.items.map((item) =>
        promoteLeaf(item, decisionById.get(item.id), options.updated_at),
      ),
    },
    validation,
    leaves: decisions,
  };
}

function validateOptions(options: ImportModelProposalOptions): void {
  if (typeof options.hook !== "function") {
    throw new TypeError("ImportModelProposalOptions.hook must be a function");
  }
  if (typeof options.broker?.ask !== "function") {
    throw new TypeError("ImportModelProposalOptions.broker.ask must be a function");
  }
  if (!nonEmptyString(options.session_id)) {
    throw new TypeError("ImportModelProposalOptions.session_id must be a non-empty string");
  }
  if (!nonEmptyString(options.updated_at)) {
    throw new TypeError("ImportModelProposalOptions.updated_at must be a non-empty string");
  }
}

export async function importModelProposal(
  markdown: string,
  options: ImportModelProposalOptions,
): Promise<ModelProposalImportResult> {
  validateOptions(options);
  return runImport(markdown, options);
}

export function createModelProposalImporter(
  options: ImportModelProposalOptions,
): ModelProposalImporter {
  validateOptions(options);
  const now = options.now ?? (() => new Date());
  // Keep generated ids unique across repeated imports through one importer.
  // The shipped broker remembers question ids for its full lifecycle.
  const resolvedOptions: ImportModelProposalOptions = {
    ...options,
    now,
    createQuestionId: options.createQuestionId ?? defaultQuestionIdFactory(),
    createEventId: options.createEventId ?? defaultEventIdFactory(now),
  };
  return {
    import(markdown: string): Promise<ModelProposalImportResult> {
      return runImport(markdown, resolvedOptions);
    },
  };
}
