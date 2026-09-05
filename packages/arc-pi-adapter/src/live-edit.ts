/** Thin YAML boundary for workflow-core's pure live-edit analysis. */
import {
  revalidateWorkflowEdit,
  type RevalidateWorkflowEditOptions,
  type WorkflowEditResult,
} from "@arc/workflow-core";
import { parseDocument } from "yaml";

function malformedYaml(message: string): WorkflowEditResult {
  return {
    accepted: false,
    reason: "malformed_yaml",
    diagnostics: [
      {
        source: "yaml",
        code: "malformed_yaml",
        path: "$",
        message,
      },
    ],
  };
}

function parseCandidateYaml(source: string):
  | { readonly parsed: true; readonly value: unknown }
  | { readonly parsed: false; readonly result: WorkflowEditResult } {
  try {
    const document = parseDocument(source, {
      logLevel: "silent",
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      return {
        parsed: false,
        result: malformedYaml(document.errors.map((error) => error.message).join("; ")),
      };
    }
    return {
      parsed: true,
      value: document.toJS({ maxAliasCount: 100 }),
    };
  } catch (error) {
    return {
      parsed: false,
      result: malformedYaml(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Consumes either edited YAML or an already parsed candidate. Parsing and core
 * validation are non-throwing for untrusted edit contents and fail closed.
 */
export function consumeLiveWorkflowEdit(
  currentWorkflow: unknown,
  candidate: unknown,
  options: RevalidateWorkflowEditOptions = {},
): WorkflowEditResult {
  if (typeof candidate !== "string") {
    return revalidateWorkflowEdit(currentWorkflow, candidate, options);
  }
  const parsed = parseCandidateYaml(candidate);
  if (!parsed.parsed) return parsed.result;
  return revalidateWorkflowEdit(currentWorkflow, parsed.value, options);
}
