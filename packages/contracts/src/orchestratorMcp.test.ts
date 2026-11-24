import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpPanelInput,
  OrchestratorMcpThreadWaitResult,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadWaitResult = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });

  it("decodes a running-task next written by another version", () => {
    const next = "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
    const result = decodeThreadWaitResult({
      threadId: "thread-child-1",
      runId: "run-child-1",
      status: "running",
      timedOut: true,
      next,
    });
    expect(result.next).toBe(next);
    expect(result).not.toHaveProperty("panel");
  });

  it("decodes a wait result with a panel conclusion", () => {
    const panel = { state: "concluded", result: "Use the first option.", resultTruncated: true };
    const result = decodeThreadWaitResult({
      threadId: "panel-thread",
      runId: "panel-run",
      status: "completed",
      timedOut: false,
      panel,
    });
    expect(result.panel).toEqual(panel);
  });

  it("decodes JSON-text participants and clamps rounds above the panel limit", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpPanelInput);
    const panelists = [
      { providerInstanceId: "codex", model: "sol" },
      { providerInstanceId: "claudeAgent", model: "opus" },
    ];
    const codeAgent = { providerInstanceId: "codex", model: "luna" };
    expect(
      decode({
        action: "start",
        topic: "Compare the two approaches.",
        panelists: JSON.stringify(panelists),
        codeAgent: JSON.stringify(codeAgent),
        rounds: 9,
        threadId: null,
      }),
    ).toEqual({
      action: "start",
      topic: "Compare the two approaches.",
      panelists,
      codeAgent,
      rounds: 5,
      threadId: null,
    });
    expect(decode({ action: "start", panelists, codeAgent, rounds: 0 }).rounds).toBe(0);
  });
});
