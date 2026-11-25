import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2PanelParticipant,
  OrchestrationV2PanelState,
  OrchestrationV2Run,
  OrchestratorMcpPanelState,
  RunId,
} from "@t3tools/contracts";

export const PANEL_WAIT_RESULT_MAX_CHARS = 4_000;

export function panelSpeakerLabel(participant: OrchestrationV2PanelParticipant): string {
  const name = participant.role === "code_agent" ? "Code agent" : participant.name;
  return `${name} (@${participant.handle})`;
}

export function panelWaitState(panel: OrchestrationV2PanelState): OrchestratorMcpPanelState {
  return panel.status === "running" || panel.current !== null
    ? "running"
    : (panel.idleReason ?? "interrupted");
}

function panelRunText(messages: ReadonlyArray<OrchestrationV2ConversationMessage>, runId: RunId) {
  return messages
    .filter((message) => message.role === "assistant" && message.runId === runId)
    .map((message) => message.text)
    .join("\n\n");
}

export function panelWaitSummary(input: {
  panel: OrchestrationV2PanelState;
  runs: ReadonlyArray<OrchestrationV2Run>;
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): { state: OrchestratorMcpPanelState; result?: string; resultTruncated?: true } {
  const { panel, runs, messages } = input;
  const state = panelWaitState(panel);
  let result: string;
  if (state === "concluded" || state === "agreed") {
    const conclusion = runs
      .filter((run) => run.panelTurn?.kind === "conclusion" && run.panelTurn.outcome === "replied")
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (conclusion === undefined) return { state };
    result = panelRunText(messages, conclusion.id);
  } else if (state === "answered") {
    let newestPostAt = -Infinity;
    for (const message of messages) {
      if (message.role === "user" && message.runId === null && message.panelParticipantId === undefined) {
        newestPostAt = Math.max(newestPostAt, message.createdAt.epochMilliseconds);
      }
    }
    if (newestPostAt === -Infinity) return { state };
    result = runs
      .filter((run) => run.requestedAt.epochMilliseconds >= newestPostAt)
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .flatMap((run) => {
        const turn = run.panelTurn;
        if (turn?.outcome !== "replied") return [];
        const participant = panel.participants.find((entry) => entry.id === turn.participantId);
        const text = panelRunText(messages, run.id);
        return participant === undefined || text === ""
          ? []
          : [`[${panelSpeakerLabel(participant)}] ${text}`];
      })
      .join("\n\n");
  } else {
    return { state };
  }

  if (result === "") return { state };
  if (result.length <= PANEL_WAIT_RESULT_MAX_CHARS) return { state, result };
  const cut = PANEL_WAIT_RESULT_MAX_CHARS;
  const splitsSurrogate = (result.codePointAt(cut - 1) ?? 0) > 0xffff;
  return { state, result: result.slice(0, splitsSurrogate ? cut - 1 : cut), resultTruncated: true };
}
