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

import { buildPanelPrompt } from "./PanelPromptBuilder.ts";
import { panelTranscript } from "./PanelTranscript.ts";

const threadId = ThreadId.make("panel-transcript");
const instanceId = ProviderInstanceId.make("codex");
const topicMessageId = MessageId.make("topic");
const modelSelection = { instanceId, model: "gpt-6" };
const participant = {
  driver: ProviderDriverKind.make("codex"),
  modelSelection,
  toolsRemoved: true,
};
const panel: OrchestrationV2PanelState = {
  participants: [
    { ...participant, id: "p1", role: "panelist", name: "Sol", handle: "sol" },
    { ...participant, id: "p2", role: "panelist", name: "Opus", handle: "opus-4-5" },
    { ...participant, id: "code", role: "code_agent", name: "Code agent", handle: "code" },
  ],
  status: "idle",
  idleReason: "stopped",
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
  panelTurn: Partial<OrchestrationV2PanelTurn> = {},
  status: OrchestrationV2Run["status"] = "completed",
): OrchestrationV2Run {
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
    status,
    requestedAt: DateTime.makeUnsafe(ordinal * 10),
    startedAt: DateTime.makeUnsafe(ordinal * 10),
    completedAt: status === "running" ? null : DateTime.makeUnsafe(ordinal * 10 + 9),
    checkpointId: null,
    contextHandoffId: null,
    panelTurn: { participantId: "p1", kind: "reply", round: 1, totalRounds: 2, ...panelTurn },
  };
}

function message(
  id: string,
  createdAt: number,
  text: string,
  runId: RunId | null = null,
  role: OrchestrationV2ConversationMessage["role"] = runId === null ? "user" : "assistant",
): OrchestrationV2ConversationMessage {
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
    createdAt: DateTime.makeUnsafe(createdAt),
    updatedAt: DateTime.makeUnsafe(createdAt),
  };
}

it("orders entries by message time then turn ordinal, with one entry per participant run", () => {
  const first = run(1, { outcome: "replied" });
  const second = run(2, { participantId: "p2", outcome: "replied" });
  const current = run(3, {}, "running");
  const future = run(4, { outcome: "replied" });
  const messages = [
    message("after-turn", 31, "A later post."),
    message("last", 15, "Second part.", first.id),
    message("opus", 12, "Opus reply.", second.id),
    {
      ...message(current.userMessageId, 30, "Marker", current.id, "user"),
      panelParticipantId: "p1",
    },
    message("future", 29, "Future turn.", future.id),
    message("current", 30, "Current turn.", current.id),
    message("action-post", 30, "The post that started this turn."),
    message("topic", 0, "What should we build?"),
    message("earlier-post", 5, "Consider this first."),
    message("tool-status", 13, "Tool status.", first.id, "system"),
    { ...message("old-marker", 10, "Old marker", first.id, "user"), panelParticipantId: "p1" },
    message("initial", 12, "First part.", first.id),
  ];

  expect(
    panelTranscript({
      panel,
      topicMessageId,
      messages,
      runs: [future, second, current, first],
      beforeRunId: current.id,
    }),
  ).toEqual({
    topic: "What should we build?",
    entries: [
      { type: "message", from: "user", text: "Consider this first.", cutOff: false },
      { type: "message", from: "@sol", text: "First part.\n\nSecond part.", cutOff: false },
      { type: "message", from: "@opus-4-5", text: "Opus reply.", cutOff: false },
      { type: "message", from: "user", text: "The post that started this turn.", cutOff: false },
    ],
  });
});

it("builds the same panelist prompt for agent and person attribution", () => {
  const messages = [
    message("topic", 0, "What should we build?"),
    message("post", 5, "Consider the existing implementation."),
  ];
  const current = run(1, {}, "running");
  const prompt = (messages: ReadonlyArray<OrchestrationV2ConversationMessage>) =>
    buildPanelPrompt({
      ...panelTranscript({
        panel,
        topicMessageId,
        messages,
        runs: [current],
        beforeRunId: current.id,
      }),
      panel,
      participant: panel.participants[0]!,
      turn: current.panelTurn!,
    });
  const agentMessages = messages.map((message): OrchestrationV2ConversationMessage => ({
    ...message,
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: ThreadId.make("agent-sender"),
  }));
  expect(prompt(agentMessages)).toBe(prompt(messages));
});

it("adds outcome notes and retains timed-out, stopped and interrupted partial replies", () => {
  const runs = [
    run(1, { outcome: "passed" }),
    run(2, { outcome: "failed", outcomeDetail: "Provider detail" }, "failed"),
    run(3, { outcome: "limited" }, "failed"),
    run(4, { outcome: "unavailable" }, "failed"),
    run(5, { outcome: "replied", lookup: "limit_reached" }),
    run(6, { participantId: "p2", outcome: "timed_out" }, "interrupted"),
    run(7, { participantId: "code", kind: "lookup", outcome: "timed_out" }, "interrupted"),
    run(8, { outcome: "stopped" }, "interrupted"),
    run(9, { outcome: "interrupted" }, "interrupted"),
    run(10, { participantId: "p2" }, "interrupted"),
  ];
  const messages = [
    message("topic", 0, "Topic"),
    message("pass", 11, "PASS", RunId.make("run-1")),
    message("failure", 23, "Failed partial text.", RunId.make("run-2")),
    message("reply", 55, "@code look this up", RunId.make("run-5")),
    message("panelist-partial", 65, "A partial reply", RunId.make("run-6")),
    message("stop", 82, "Stopped", RunId.make("run-8")),
    message("restart", 91, "Interrupted", RunId.make("run-9")),
    message("unannotated", 101, "Interrupted during recovery", RunId.make("run-10")),
  ];
  expect(
    panelTranscript({ panel, topicMessageId, messages, runs, beforeRunId: null }).entries,
  ).toEqual([
    { type: "note", text: "@sol passed" },
    { type: "note", text: "@sol could not reply" },
    { type: "note", text: "@sol hit a usage limit" },
    { type: "note", text: "@sol is unavailable" },
    { type: "message", from: "@sol", text: "@code look this up", cutOff: false },
    { type: "note", text: "@code was not called: 2 lookups already used this round" },
    { type: "message", from: "@opus-4-5", text: "A partial reply", cutOff: true },
    { type: "note", text: "@opus-4-5 was stopped after 2 minutes" },
    { type: "note", text: "@code was stopped after 5 minutes" },
    { type: "message", from: "@sol", text: "Stopped", cutOff: true },
    { type: "message", from: "@sol", text: "Interrupted", cutOff: true },
    { type: "message", from: "@opus-4-5", text: "Interrupted during recovery", cutOff: true },
  ]);
});
