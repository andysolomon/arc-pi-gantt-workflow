import type {
  WorkflowDashboard,
  WorkflowRpcFailure,
  WorkflowRpcHandler,
  WorkflowRpcRequest,
  WorkflowRpcResponse,
  WorkflowRpcSuccess,
} from "./types.ts";

export const MAX_WORKFLOW_RPC_REQUEST_BYTES = 8 * 1024;
export const MAX_WORKFLOW_RPC_RESPONSE_BYTES = 64 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).length;
  } catch {
    return null;
  }
}

function failure(
  code: WorkflowRpcFailure["error"]["code"],
  message: string,
): WorkflowRpcFailure {
  return { ok: false, error: { code, message } };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function isWorkflowRpcRequest(value: unknown): value is WorkflowRpcRequest {
  if (!isPlainObject(value) || typeof value.method !== "string") return false;
  if (value.method === "status" || value.method === "widget") {
    return exactKeys(value, ["method"]);
  }
  return (
    value.method === "pick-question" &&
    exactKeys(value, ["method", "question_id"]) &&
    typeof value.question_id === "string" &&
    value.question_id.length > 0
  );
}

function boundedSuccess(success: WorkflowRpcSuccess): WorkflowRpcResponse {
  const bytes = byteLength(success);
  return bytes !== null && bytes <= MAX_WORKFLOW_RPC_RESPONSE_BYTES
    ? success
    : failure("response_too_large", "workflow RPC response exceeds the size limit");
}

/** Handle one bounded JSON-like RPC request without opening a network socket. */
export function handleWorkflowRpc(
  dashboard: WorkflowDashboard,
  request: unknown,
): WorkflowRpcResponse {
  const requestBytes = byteLength(request);
  if (requestBytes === null) {
    return failure("invalid_request", "workflow RPC request must be JSON-safe");
  }
  if (requestBytes > MAX_WORKFLOW_RPC_REQUEST_BYTES) {
    return failure("request_too_large", "workflow RPC request exceeds the size limit");
  }
  if (!isPlainObject(request) || typeof request.method !== "string") {
    return failure("invalid_request", "workflow RPC request is invalid");
  }
  if (request.method !== "status" && request.method !== "widget" && request.method !== "pick-question") {
    return failure("unknown_method", "workflow RPC method is not supported");
  }
  if (!isWorkflowRpcRequest(request)) {
    return failure("invalid_request", "workflow RPC request has invalid fields");
  }

  try {
    switch (request.method) {
      case "status":
        return boundedSuccess({ ok: true, result: dashboard.snapshot() });
      case "widget":
        return boundedSuccess({ ok: true, result: { widget: dashboard.renderWidget() } });
      case "pick-question":
        return boundedSuccess({
          ok: true,
          result: {
            selected_question_id: request.question_id,
            status: dashboard.pickQuestion(request.question_id),
          },
        });
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return failure("invalid_request", error.message);
    }
    return failure("unknown_question", "workflow RPC question is not pending");
  }
}

/** Create a host-neutral RPC handler around one dashboard controller. */
export function createWorkflowRpc(dashboard: WorkflowDashboard): WorkflowRpcHandler {
  if (
    dashboard === null ||
    typeof dashboard !== "object" ||
    typeof dashboard.snapshot !== "function" ||
    typeof dashboard.renderWidget !== "function" ||
    typeof dashboard.pickQuestion !== "function"
  ) {
    throw new TypeError("WorkflowRpcHandler requires a workflow dashboard");
  }
  return {
    handle(request: unknown): WorkflowRpcResponse {
      return handleWorkflowRpc(dashboard, request);
    },
  };
}
