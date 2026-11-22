import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2PanelState,
  OrchestrationV2PanelTurn,
  OrchestrationV2Run,
  RunId,
} from "@t3tools/contracts";
import {
  PANEL_CODE_AGENT_REPLY_LIMIT_MS,
  PANEL_CODE_HANDLE,
  PANEL_LOOKUPS_PER_ROUND,
  PANEL_PANELIST_REPLY_LIMIT_MS,
} from "@t3tools/shared/panelChat";

export type PanelTranscriptEntry =
  | {
      readonly type: "message";
      readonly from: string;
      readonly text: string;
      readonly cutOff: boolean;
    }
  | { readonly type: "note"; readonly text: string };

type EntryGroup = {
  readonly createdAt: number;
  readonly ordinal: number;
  readonly entries: ReadonlyArray<PanelTranscriptEntry>;
};

function outcomeNote(from: string, turn: OrchestrationV2PanelTurn): string | undefined {
  switch (turn.outcome) {
    case "passed":
      return `${from} passed`;
    case "failed":
      return `${from} could not reply`;
    case "limited":
      return `${from} hit a usage limit`;
    case "unavailable":
      return `${from} is unavailable`;
    case "timed_out": {
      const limit =
        turn.kind === "lookup" ? PANEL_CODE_AGENT_REPLY_LIMIT_MS : PANEL_PANELIST_REPLY_LIMIT_MS;
      return `${from} was stopped after ${limit / 60_000} minutes`;
    }
    default:
      return undefined;
  }
}

function compareMessages(
  left: OrchestrationV2ConversationMessage,
  right: OrchestrationV2ConversationMessage,
): number {
  return left.createdAt.epochMilliseconds - right.createdAt.epochMilliseconds;
}

export function panelTranscript(input: {
  readonly panel: OrchestrationV2PanelState;
  readonly topicMessageId: MessageId;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly beforeRunId: RunId | null;
}): { readonly topic: string; readonly entries: ReadonlyArray<PanelTranscriptEntry> } {
  const before = input.runs.find((run) => run.id === input.beforeRunId);
  const marker = input.messages.find((message) => message.id === before?.userMessageId);
  const beforeTime = (marker?.createdAt ?? before?.requestedAt)?.epochMilliseconds ?? Infinity;
  const beforeOrdinal = before?.ordinal ?? Infinity;

  let topic = "";
  const groups: EntryGroup[] = [];
  const replies = new Map<RunId, OrchestrationV2ConversationMessage[]>();
  for (const message of input.messages) {
    if (message.panelParticipantId !== undefined) continue;
    if (message.id === input.topicMessageId) {
      topic = message.text;
    } else if (message.role === "user" && message.runId === null) {
      if (message.createdAt.epochMilliseconds <= beforeTime) {
        groups.push({
          createdAt: message.createdAt.epochMilliseconds,
          ordinal: beforeOrdinal,
          entries: [{ type: "message", from: "user", text: message.text, cutOff: false }],
        });
      }
    } else if (message.role === "assistant" && message.runId !== null && message.text.trim()) {
      const parts = replies.get(message.runId);
      if (parts === undefined) {
        replies.set(message.runId, [message]);
      } else {
        parts.push(message);
      }
    }
  }

  const handles = new Map(
    input.panel.participants.map((participant) => [participant.id, participant.handle]),
  );
  for (const run of input.runs) {
    const turn = run.panelTurn;
    if (run.ordinal >= beforeOrdinal || turn === undefined) continue;
    const handle = handles.get(turn.participantId);
    if (handle === undefined) continue;

    const from = `@${handle}`;
    const parts = replies.get(run.id)?.toSorted(compareMessages) ?? [];
    const entries: PanelTranscriptEntry[] = [];
    const { outcome } = turn;
    const cutOff =
      outcome === "timed_out" ||
      outcome === "stopped" ||
      outcome === "interrupted" ||
      (outcome === undefined &&
        (run.status === "interrupted" ||
          run.status === "cancelled" ||
          run.status === "rolled_back"));
    if (parts.length > 0 && (cutOff || outcome === "replied" || outcome === undefined)) {
      entries.push({
        type: "message",
        from,
        text: parts.map((part) => part.text).join("\n\n"),
        cutOff,
      });
    }
    const note = outcomeNote(from, turn);
    if (note !== undefined) entries.push({ type: "note", text: note });
    if (turn.lookup === "limit_reached") {
      entries.push({
        type: "note",
        text: `@${PANEL_CODE_HANDLE} was not called: ${PANEL_LOOKUPS_PER_ROUND} lookups already used this round`,
      });
    }
    if (entries.length > 0) {
      groups.push({
        createdAt: (parts[0]?.createdAt ?? run.completedAt ?? run.requestedAt).epochMilliseconds,
        ordinal: run.ordinal,
        entries,
      });
    }
  }
  groups.sort((left, right) => left.createdAt - right.createdAt || left.ordinal - right.ordinal);
  return { topic, entries: groups.flatMap((group) => group.entries) };
}
