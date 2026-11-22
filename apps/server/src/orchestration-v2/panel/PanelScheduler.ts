import type {
  MessageId,
  OrchestrationV2PanelIdleReason,
  OrchestrationV2PanelQueuedTurn,
  OrchestrationV2PanelRequestRef,
  OrchestrationV2PanelRunOfRounds,
  OrchestrationV2PanelState,
  OrchestrationV2PanelTurnKind,
  OrchestrationV2PanelTurnOutcome,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2RunStatus,
  RunId,
} from "@t3tools/contracts";
import { isPanelPass, PANEL_LOOKUPS_PER_ROUND } from "@t3tools/shared/panelChat";

export type PanelSettledTurn = {
  readonly participantId: string;
  readonly kind: OrchestrationV2PanelTurnKind;
  readonly outcome: OrchestrationV2PanelTurnOutcome;
  readonly codeCallout: boolean;
};

export type PanelDecision = {
  readonly state: OrchestrationV2PanelState;
  readonly next: OrchestrationV2PanelQueuedTurn | null;
  readonly lookup?: "requested" | "limit_reached";
};

function takeNext(state: OrchestrationV2PanelState): PanelDecision {
  const [next, ...queue] = state.queue;
  if (next === undefined) return { state, next: null };
  const { run } = state;
  return {
    state: {
      ...state,
      queue,
      run:
        run === null || run.round === next.round
          ? run
          : { ...run, round: next.round, roundReplied: false, roundAllPassed: true },
    },
    next,
  };
}

function endRun(
  state: OrchestrationV2PanelState,
  idleReason: OrchestrationV2PanelIdleReason,
): PanelDecision {
  return {
    state: { ...state, status: "idle", idleReason, queue: [], current: null, pendingPost: null },
    next: null,
  };
}

function startRun(
  state: OrchestrationV2PanelState,
  mode: OrchestrationV2PanelRunOfRounds["mode"],
  queue: ReadonlyArray<OrchestrationV2PanelQueuedTurn>,
): PanelDecision {
  if (state.current !== null) return { state, next: null };
  const isOpen = mode === "open";
  const running: OrchestrationV2PanelState = {
    ...state,
    status: "running",
    idleReason: null,
    run: {
      mode,
      totalRounds: isOpen ? state.rounds : 0,
      round: isOpen ? 1 : 0,
      roundReplied: false,
      roundAllPassed: true,
      agreed: false,
      roundsCompleted: 0,
    },
    queue,
    pendingPost: null,
    lookupsThisRound: 0,
  };
  if (queue.length === 0) return endRun(running, isOpen ? "no_replies" : "answered");
  return takeNext(running);
}

function startOpenRun(state: OrchestrationV2PanelState): PanelDecision {
  const roster = state.participants.filter((participant) => participant.role === "panelist");
  const afterCursor = roster.findIndex((participant) => participant.id === state.cursor) + 1;
  const order = [...roster.slice(afterCursor), ...roster.slice(0, afterCursor)];
  const queue: OrchestrationV2PanelQueuedTurn[] = [];
  for (let round = 1; round <= state.rounds; round++) {
    for (const participant of order) {
      queue.push({ participantId: participant.id, kind: "reply", round });
    }
  }
  return startRun(state, "open", queue);
}

export function openRunOfRounds(state: OrchestrationV2PanelState): PanelDecision {
  return state.status === "idle" ? startOpenRun(state) : { state, next: null };
}

export function addressedRun(
  state: OrchestrationV2PanelState,
  mentionedIds: ReadonlyArray<string>,
  request: OrchestrationV2PanelRequestRef,
): PanelDecision {
  const mentioned = new Set(mentionedIds);
  const targets = state.participants.filter((participant) => mentioned.has(participant.id));
  const code = targets.find((participant) => participant.role === "code_agent");
  const panelists = targets.filter((participant) => participant.role === "panelist");
  const order = code === undefined ? panelists : [code, ...panelists];
  return startRun(
    state,
    "addressed",
    order.map((participant) => ({
      participantId: participant.id,
      kind: participant.role === "code_agent" ? "lookup" : "reply",
      round: 0,
      askedBy: "user",
      request,
    })),
  );
}

function startPost(
  state: OrchestrationV2PanelState,
  post: NonNullable<OrchestrationV2PanelState["pendingPost"]>,
): PanelDecision {
  return post.mentionedParticipantIds.length > 0
    ? addressedRun(state, post.mentionedParticipantIds, {
        type: "message",
        messageId: post.messageId,
      })
    : startOpenRun(state);
}

export function recordPost(
  state: OrchestrationV2PanelState,
  post: { messageId: MessageId; mentionedParticipantIds: ReadonlyArray<string> },
): PanelDecision {
  return state.status === "running" || state.current !== null
    ? { state: { ...state, pendingPost: post }, next: null }
    : startPost(state, post);
}

function queueConclusion(
  state: OrchestrationV2PanelState,
  round: number,
): OrchestrationV2PanelState {
  const writer = state.participants.find((participant) => participant.role === "panelist");
  if (writer === undefined) return state;
  return {
    ...state,
    queue: [...state.queue, { participantId: writer.id, kind: "conclusion", round }],
  };
}

function endOfRoundWithoutReplies(
  state: OrchestrationV2PanelState,
  run: OrchestrationV2PanelRunOfRounds,
): PanelDecision {
  if (!run.roundAllPassed && run.roundsCompleted === 0) return endRun(state, "no_replies");
  const concluding = { ...state, run: { ...run, agreed: run.roundAllPassed }, queue: [] };
  return takeNext(queueConclusion(concluding, run.round));
}

function advance(
  state: OrchestrationV2PanelState,
  settled: PanelSettledTurn,
  panelistReply: boolean,
  round: number,
): PanelDecision {
  if (state.pendingPost !== null) return startPost(state, state.pendingPost);
  const { run } = state;
  if (settled.kind === "conclusion") {
    return endRun(
      state,
      settled.outcome === "replied" ? (run?.agreed ? "agreed" : "concluded") : "rounds_done",
    );
  }
  if (run === null) return endRun(state, "no_replies");
  if (run.mode === "addressed") {
    return state.queue.length > 0
      ? takeNext(state)
      : endRun({ ...state, lookupsThisRound: 0 }, "answered");
  }
  if (!panelistReply) return takeNext(state);

  const roundRun = {
    ...run,
    roundReplied: run.roundReplied || settled.outcome === "replied",
    roundAllPassed: run.roundAllPassed && settled.outcome === "passed",
  };
  const withOutcome = { ...state, run: roundRun };
  const nextReply = state.queue.find((turn) => turn.kind === "reply");
  if (nextReply?.round === round) return takeNext(withOutcome);

  const endOfRound = { ...withOutcome, lookupsThisRound: 0 };
  if (!roundRun.roundReplied) return endOfRoundWithoutReplies(endOfRound, roundRun);
  const completed = {
    ...endOfRound,
    run: { ...roundRun, roundsCompleted: roundRun.roundsCompleted + 1 },
  };
  return takeNext(nextReply === undefined ? queueConclusion(completed, round) : completed);
}

function isPanelistReply(
  state: OrchestrationV2PanelState,
  turn: Pick<PanelSettledTurn, "kind" | "participantId">,
): boolean {
  return (
    turn.kind === "reply" &&
    state.participants.some(
      (participant) => participant.id === turn.participantId && participant.role === "panelist",
    )
  );
}

export function settleTurn(
  state: OrchestrationV2PanelState,
  settled: PanelSettledTurn,
  settledRunId: RunId,
): PanelDecision {
  if (state.current?.runId !== settledRunId) return { state, next: null };
  const { round } = state.current;
  const panelistReply = isPanelistReply(state, settled);
  let afterTurn = {
    ...state,
    cursor: panelistReply ? settled.participantId : state.cursor,
    current: null,
  };
  if (state.status === "idle") {
    return afterTurn.pendingPost !== null
      ? startPost(afterTurn, afterTurn.pendingPost)
      : { state: afterTurn, next: null };
  }
  if (settled.outcome === "stopped") return endRun(afterTurn, "stopped");

  let lookup: PanelDecision["lookup"];
  if (panelistReply && settled.outcome === "replied" && settled.codeCallout) {
    const code = state.participants.find((participant) => participant.role === "code_agent");
    if (code !== undefined) {
      if (state.lookupsThisRound >= PANEL_LOOKUPS_PER_ROUND) {
        lookup = "limit_reached";
      } else {
        lookup = "requested";
        afterTurn = {
          ...afterTurn,
          lookupsThisRound: state.lookupsThisRound + 1,
          queue: [
            {
              participantId: code.id,
              kind: "lookup",
              round,
              askedBy: settled.participantId,
              request: { type: "run", runId: settledRunId },
            },
            ...state.queue,
          ],
        };
      }
    }
  }
  const decision = advance(afterTurn, settled, panelistReply, round);
  return lookup === undefined ? decision : { ...decision, lookup };
}

export function recover(state: OrchestrationV2PanelState): OrchestrationV2PanelState {
  if (state.status === "idle") return state;
  const cursor =
    state.current !== null && isPanelistReply(state, state.current)
      ? state.current.participantId
      : state.cursor;
  return endRun({ ...state, cursor }, "interrupted").state;
}

export function classifyTurn(input: {
  readonly kind: OrchestrationV2PanelTurnKind;
  readonly runStatus: OrchestrationV2RunStatus;
  readonly timedOut: boolean;
  readonly assistantText: string;
  readonly failure: {
    readonly class: OrchestrationV2ProviderFailureClass;
    readonly code: string | null;
    readonly message: string;
  } | null;
}): { readonly outcome: OrchestrationV2PanelTurnOutcome; readonly detail?: string } {
  if (input.timedOut) return { outcome: "timed_out" };
  switch (input.runStatus) {
    case "completed":
      if (isPanelPass(input.assistantText)) return { outcome: "passed" };
      return { outcome: input.assistantText.trim() ? "replied" : "failed" };
    case "failed":
      if (input.failure?.class === "usage_limit") {
        return { outcome: "limited", detail: input.failure.message };
      }
      if (input.failure?.code === "panel_participant_unavailable") {
        return { outcome: "unavailable" };
      }
      return input.failure === null
        ? { outcome: "failed" }
        : { outcome: "failed", detail: input.failure.message };
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return { outcome: "stopped" };
    default:
      return { outcome: "failed" };
  }
}
