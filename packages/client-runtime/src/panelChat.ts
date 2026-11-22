import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2PanelParticipant,
  OrchestrationV2PanelState,
  OrchestrationV2PanelTurn,
  OrchestrationV2Run,
  RunId,
} from "@t3tools/contracts";
import {
  PANEL_CODE_AGENT_REPLY_LIMIT_MS,
  PANEL_PANELIST_REPLY_LIMIT_MS,
  panelMentionedParticipantIds,
  panelReplyBudget,
} from "@t3tools/shared/panelChat";
import * as DateTime from "effect/DateTime";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const idleStatus = {
  agreed: msg("Concluded: everyone agreed"),
  answered: msg("Waiting for you"),
  stopped: msg("Stopped", { $context: "panel status" }),
  interrupted: msg("Interrupted by a restart"),
  no_replies: msg("Stopped: no one could reply"),
};

export type PanelStatusKey =
  | keyof typeof idleStatus
  | "stopping"
  | "concluded"
  | "rounds_done"
  | "reply"
  | "round_reply"
  | "lookup"
  | "round_lookup"
  | "conclusion";

export function panelStatus(
  panel: OrchestrationV2PanelState,
  participants: ReadonlyArray<OrchestrationV2PanelParticipant>,
  stopRequested: boolean,
  resolve: MFunctionType = mFallback,
): {
  key: PanelStatusKey;
  vars: Readonly<Record<string, string | number>>;
  text: string;
  action: "stop" | "continue" | "none";
  tone: "default" | "error";
} {
  const { current, run, idleReason } = panel;
  if (stopRequested || (panel.status === "idle" && current !== null)) {
    return {
      key: "stopping",
      vars: {},
      text: resolve(msg("Stopping…")),
      action: "none",
      tone: "default",
    };
  }
  if (panel.status === "idle") {
    const key = idleReason ?? "answered";
    const count = run?.roundsCompleted ?? 0;
    const vars = { count };
    const text =
      key === "concluded"
        ? resolve(
            msg(
              "Concluded after {count, plural, one {{count} round} other {{count} rounds}}",
              vars,
            ),
          )
        : key === "rounds_done"
          ? resolve(
              msg("Paused after {count, plural, one {{count} round} other {{count} rounds}}", vars),
            )
          : resolve(idleStatus[key]);
    return {
      key,
      vars: key === "concluded" || key === "rounds_done" ? vars : {},
      text,
      action: "continue",
      tone: key === "no_replies" ? "error" : "default",
    };
  }

  const participantId = current?.participantId ?? panel.queue[0]?.participantId;
  const name = participants.find((participant) => participant.id === participantId)?.name ?? "";
  const kind = current?.kind ?? panel.queue[0]?.kind;
  const round = current?.round ?? run?.round ?? 0;
  const total = run?.totalRounds ?? 0;
  let key: PanelStatusKey;
  let vars: Readonly<Record<string, string | number>>;
  let status: string;

  if (kind === "conclusion") {
    key = "conclusion";
    vars = { name };
    status = resolve(msg("{name} is writing the conclusion", { name }));
  } else if (kind === "lookup") {
    key = round > 0 ? "round_lookup" : "lookup";
    vars = round > 0 ? { round, total } : {};
    status =
      round > 0
        ? resolve(msg("Round {round} of {total} · Code agent is looking it up", { round, total }))
        : resolve(msg("Code agent is looking it up"));
  } else {
    key = round > 0 ? "round_reply" : "reply";
    vars = round > 0 ? { round, total, name } : { name };
    status =
      round > 0
        ? resolve(msg("Round {round} of {total} · {name} is replying", { round, total, name }))
        : resolve(msg("{name} is replying", { name }));
  }

  return {
    key,
    vars,
    text:
      panel.pendingPost === null
        ? status
        : resolve(msg("{status} · your message is next", { status })),
    action: "stop",
    tone: "default",
  };
}

export interface PanelTimelineLine {
  readonly label: string;
  readonly detail?: string;
  readonly tone?: "danger";
}

export interface PanelTimelineAnnotation {
  readonly speaker: OrchestrationV2PanelParticipant;
  readonly roundStart?: { readonly round: number; readonly total: number };
  readonly conclusion?: true;
  readonly outcomeLine?: PanelTimelineLine;
  readonly lookupLine?: PanelTimelineLine;
  readonly askedBy?: string;
  readonly passed: boolean;
}

function outcomeLine(
  turn: OrchestrationV2PanelTurn,
  speaker: OrchestrationV2PanelParticipant,
  resolve: MFunctionType,
): PanelTimelineLine | undefined {
  const { name } = speaker;
  const detail = turn.outcomeDetail;
  switch (turn.outcome) {
    case "passed":
      return { label: resolve(msg("{name} passed", { name })) };
    case "failed":
      return {
        label: resolve(msg("{name} could not reply", { name })),
        tone: "danger",
        ...(detail ? { detail } : {}),
      };
    case "limited":
      return {
        label: resolve(msg("{name} hit a usage limit", { name })),
        tone: "danger",
        ...(detail ? { detail } : {}),
      };
    case "unavailable":
      return { label: resolve(msg("{name} is unavailable", { name })), tone: "danger" };
    case "timed_out": {
      const minutes =
        (speaker.role === "code_agent"
          ? PANEL_CODE_AGENT_REPLY_LIMIT_MS
          : PANEL_PANELIST_REPLY_LIMIT_MS) / 60_000;
      return {
        label: resolve(
          msg("{name} was stopped after {minutes, plural, one {# minute} other {# minutes}}", {
            name,
            minutes,
          }),
        ),
      };
    }
    default:
      return undefined;
  }
}

export function panelTimelineAnnotations(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "panelTurn" | "requestedAt">>,
  panel: Pick<OrchestrationV2PanelState, "participants">,
  resolve: MFunctionType = mFallback,
  posts: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "role" | "runId" | "createdAt">
  > = [],
): ReadonlyMap<RunId, PanelTimelineAnnotation> {
  const participants = new Map(
    panel.participants.map((participant) => [participant.id, participant]),
  );
  const panelistCount = panel.participants.filter(
    (participant) => participant.role === "panelist",
  ).length;
  const annotations = new Map<RunId, PanelTimelineAnnotation>();
  const postTimes = posts
    .filter((post) => post.role === "user" && post.runId === null)
    .map((post) => DateTime.toEpochMillis(post.createdAt))
    .sort((left, right) => left - right);
  let postIndex = 0;
  let previousRequestedAt = -Infinity;
  let previous: OrchestrationV2PanelTurn | undefined;
  let repliesInRound = 0;
  for (const run of [...runs].sort((left, right) => left.ordinal - right.ordinal)) {
    const turn = run.panelTurn;
    if (turn === undefined) continue;
    const requestedAt = DateTime.toEpochMillis(run.requestedAt);
    let newPost = false;
    while (postIndex < postTimes.length) {
      const postAt = postTimes[postIndex]!;
      if (postAt > requestedAt) break;
      postIndex++;
      if (postAt > previousRequestedAt) newPost = true;
    }
    previousRequestedAt = requestedAt;
    const isReply = turn.kind === "reply" && turn.totalRounds > 0 && turn.round > 0;
    const roundStart =
      isReply &&
      (previous?.round !== turn.round ||
        previous.kind === "conclusion" ||
        previous.outcome === "stopped" ||
        previous.outcome === "interrupted" ||
        repliesInRound === panelistCount ||
        newPost);
    if (roundStart) repliesInRound = 0;
    if (isReply) repliesInRound++;
    previous = turn;
    const speaker = participants.get(turn.participantId);
    if (speaker === undefined) continue;
    const outcome = outcomeLine(turn, speaker, resolve);
    const askingParticipant =
      turn.askedBy === undefined ? undefined : participants.get(turn.askedBy);
    const askedBy =
      turn.askedBy === "user"
        ? resolve(msg("asked by you"))
        : askingParticipant === undefined
          ? undefined
          : resolve(msg("asked by {name}", { name: askingParticipant.name }));
    annotations.set(run.id, {
      speaker,
      passed: turn.outcome === "passed",
      ...(roundStart ? { roundStart: { round: turn.round, total: turn.totalRounds } } : {}),
      ...(turn.kind === "conclusion" ? { conclusion: true } : {}),
      ...(outcome === undefined ? {} : { outcomeLine: outcome }),
      ...(askedBy === undefined ? {} : { askedBy }),
      ...(turn.lookup === "limit_reached"
        ? {
            lookupLine: {
              label: resolve(msg("Code agent not called")),
              detail: resolve(msg("2 lookups already used this round")),
            },
          }
        : {}),
    });
  }
  return annotations;
}

export function panelContinueTooltip(
  { participants, rounds }: Pick<OrchestrationV2PanelState, "participants" | "rounds">,
  resolve: MFunctionType = mFallback,
): string {
  const count = panelReplyBudget(
    participants.filter((participant) => participant.role === "panelist").length,
    rounds,
  );
  return resolve(
    msg(
      "Runs {rounds, plural, one {{rounds} more round} other {{rounds} more rounds}}: up to {count, plural, one {{count} reply} other {{count} replies}}.",
      { rounds, count },
    ),
  );
}

export function panelSendTooltip(
  text: string,
  { participants, rounds }: Pick<OrchestrationV2PanelState, "participants" | "rounds">,
  resolve: MFunctionType = mFallback,
): string {
  const addressedIds = panelMentionedParticipantIds(text, participants);
  const names = addressedIds
    .flatMap((id) => {
      const participant = participants.find((candidate) => candidate.id === id);
      return participant === undefined ? [] : [participant.name];
    })
    .join(", ");
  return names
    ? resolve(msg("Send to {names}", { names }))
    : resolve(
        msg(
          "Send to everyone: starts {rounds, plural, one {{rounds} round} other {{rounds} rounds}}",
          { rounds },
        ),
      );
}

export function panelParticipantMenuItems(
  panel: Pick<OrchestrationV2PanelState, "participants">,
  query: string,
  resolve: MFunctionType = mFallback,
) {
  const search = query.trim().toLowerCase();
  return panel.participants.flatMap((participant) => {
    const label = participant.role === "code_agent" ? resolve(msg("Code agent")) : participant.name;
    const description = `@${participant.handle}`;
    return description.toLowerCase().includes(search) || label.toLowerCase().includes(search)
      ? [
          {
            id: `panel-participant:${participant.id}`,
            type: "panel-participant" as const,
            participant,
            label,
            description,
          },
        ]
      : [];
  });
}
