import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2PanelState,
  type OrchestrationV2PanelTurn,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { PANEL_WAIT_RESULT_MAX_CHARS, panelWaitState, panelWaitSummary } from "./PanelResult.ts";

const threadId = ThreadId.make("panel-result");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6" };
const participant = { driver: ProviderDriverKind.make("codex"), modelSelection, toolsRemoved: true };
const panel: OrchestrationV2PanelState = {
  participants: [
    { ...participant, id: "p1", role: "panelist", name: "Sol", handle: "sol" },
    { ...participant, id: "code", role: "code_agent", name: "Codex", handle: "code" },
  ],
  status: "idle",
  idleReason: null,
  rounds: 2,
  run: null,
  queue: [],
  current: null,
  cursor: null,
  pendingPost: null,
  lookupsThisRound: 0,
  turnCount: 0,
};

function run(
  ordinal: number,
  turn: Partial<OrchestrationV2PanelTurn> = {},
): OrchestrationV2Run {
  const requestedAt = DateTime.makeUnsafe(ordinal * 10);
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`marker-${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt,
    startedAt: requestedAt,
    completedAt: DateTime.makeUnsafe(ordinal * 10 + 9),
    checkpointId: null,
    contextHandoffId: null,
    panelTurn: {
      participantId: "p1",
      kind: "reply",
      round: 1,
      totalRounds: 2,
      outcome: "replied",
      ...turn,
    },
  };
}

function message(
  id: string,
  timestamp: number,
  text: string,
  runId: RunId | null = null,
  role: OrchestrationV2ConversationMessage["role"] = runId === null ? "user" : "assistant",
): OrchestrationV2ConversationMessage {
  const createdAt = DateTime.makeUnsafe(timestamp);
  return {
    id: MessageId.make(id),
    threadId,
    runId,
    nodeId: null,
    role,
    text,
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    attachments: [],
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

it("reports running while a turn is in flight and interrupted for an unset idle reason", () => {
  expect(panelWaitState({ ...panel, status: "running" })).toBe("running");
  expect(
    panelWaitState({
      ...panel,
      idleReason: "stopped",
      current: {
        runId: RunId.make("run-stopping"),
        participantId: "p1",
        kind: "reply",
        round: 1,
        timedOut: false,
      },
    }),
  ).toBe("running");
  expect(panelWaitState(panel)).toBe("interrupted");
});

it.each(["concluded", "agreed"] as const)("returns the newest replied conclusion for %s", (state) => {
  const old = run(1, { kind: "conclusion" });
  const newest = run(2, { kind: "conclusion" });
  const failed = run(3, { kind: "conclusion", outcome: "failed" });
  const reply = run(4);
  expect(
    panelWaitSummary({
      panel: { ...panel, idleReason: state },
      runs: [failed, newest, reply, old],
      messages: [
        message("old", 11, "An earlier conclusion.", old.id),
        message("first", 21, "First part.", newest.id),
        message("marker", 22, "User marker", newest.id, "user"),
        message("second", 23, "Second part.", newest.id),
        message("failed", 31, "Incomplete text.", failed.id),
        message("reply", 41, "A later reply.", reply.id),
      ],
    }),
  ).toEqual({ state, result: "First part.\n\nSecond part." });
});

it("returns replied turns from the latest addressed post in ordinal order", () => {
  const earlier = run(1);
  const first = run(2);
  const noReply = run(3, { outcome: "passed" });
  const code = run(4, { kind: "lookup", participantId: "code" });
  expect(
    panelWaitSummary({
      panel: { ...panel, idleReason: "answered" },
      runs: [code, noReply, earlier, first],
      messages: [
        message("post", 20, "@sol @code please respond"),
        message("old", 1, "The topic"),
        message("earlier", 22, "A reply to the topic.", earlier.id),
        message("sol", 25, "First reply.", first.id),
        message("pass", 35, "pass", noReply.id),
        message("trigger", 40, "", code.id, "user"),
        { ...message("participant", 41, ""), panelParticipantId: "code" },
        message("code", 45, "Code reply.", code.id),
      ],
    }),
  ).toEqual({
    state: "answered",
    result: "[Sol (@sol)] First reply.\n\n[Code agent (@code)] Code reply.",
  });
});

it.each(["rounds_done", "no_replies", "stopped", "interrupted"] as const)(
  "omits the result for %s even when there are earlier conclusions",
  (state) => {
    const conclusion = run(1, { kind: "conclusion" });
    expect(
      panelWaitSummary({
        panel: { ...panel, idleReason: state },
        runs: [conclusion],
        messages: [message("conclusion", 15, "An earlier conclusion.", conclusion.id)],
      }),
    ).toEqual({ state });
  },
);

it.each([
  ["x".repeat(PANEL_WAIT_RESULT_MAX_CHARS), ""],
  ["x".repeat(PANEL_WAIT_RESULT_MAX_CHARS), " extra"],
  ["x".repeat(PANEL_WAIT_RESULT_MAX_CHARS - 1), "🙂"],
])("caps the result at 4,000 UTF-16 units without breaking a surrogate pair", (prefix, suffix) => {
  const conclusion = run(1, { kind: "conclusion" });
  expect(
    panelWaitSummary({
      panel: { ...panel, idleReason: "concluded" },
      runs: [conclusion],
      messages: [message("conclusion", 15, prefix + suffix, conclusion.id)],
    }),
  ).toEqual({
    state: "concluded",
    result: prefix,
    ...(suffix === "" ? {} : { resultTruncated: true }),
  });
});
