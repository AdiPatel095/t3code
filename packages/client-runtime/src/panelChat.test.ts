import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2PanelParticipant,
  type OrchestrationV2PanelState,
  type OrchestrationV2PanelTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  panelContinueTooltip,
  panelParticipantMenuItems,
  panelSendTooltip,
  panelStatus,
  panelTimelineAnnotations,
} from "./panelChat.ts";

function participant(
  id: string,
  name: string,
  handle: string,
  role: OrchestrationV2PanelParticipant["role"] = "panelist",
): OrchestrationV2PanelParticipant {
  return {
    id,
    name,
    handle,
    role,
    driver: ProviderDriverKind.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: name },
    toolsRemoved: true,
  };
}

const participants = [
  participant("p1", "Opus", "opus"),
  participant("p2", "Sol", "sol"),
  participant("code", "Haiku", "code", "code_agent"),
];

const panel: OrchestrationV2PanelState = {
  participants,
  rounds: 2,
  status: "idle",
  idleReason: "answered",
  run: {
    mode: "open",
    totalRounds: 2,
    round: 2,
    roundReplied: true,
    roundAllPassed: false,
    agreed: false,
    roundsCompleted: 2,
  },
  queue: [],
  current: null,
  pendingPost: null,
  cursor: null,
  lookupsThisRound: 0,
  turnCount: 0,
};

function run(ordinal: number, turn: Partial<OrchestrationV2PanelTurn>) {
  return {
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    requestedAt: DateTime.makeUnsafe(ordinal * 10),
    panelTurn: {
      participantId: "p1",
      kind: "reply",
      round: 1,
      totalRounds: 2,
      ...turn,
    } satisfies OrchestrationV2PanelTurn,
  };
}

describe("panelStatus", () => {
  it.each([
    ["concluded", "Concluded after 2 rounds"],
    ["agreed", "Concluded: everyone agreed"],
    ["rounds_done", "Paused after 2 rounds"],
    ["answered", "Waiting for you"],
    ["stopped", "Stopped"],
    ["interrupted", "Interrupted by a restart"],
    ["no_replies", "Stopped: no one could reply"],
  ] as const)("shows Continue for %s", (idleReason, text) => {
    expect(panelStatus({ ...panel, idleReason }, participants, false)).toMatchObject({
      text,
      key: idleReason,
      action: "continue",
      tone: idleReason === "no_replies" ? "error" : "default",
    });
  });

  it.each([
    ["reply", "p1", 1, "Round 1 of 2 · Opus is replying"],
    ["reply", "p2", 0, "Sol is replying"],
    ["lookup", "code", 2, "Round 2 of 2 · Code agent is looking it up"],
    ["lookup", "code", 0, "Code agent is looking it up"],
    ["conclusion", "p1", 2, "Opus is writing the conclusion"],
  ] as const)("shows Stop for a %s turn in round %s/%s", (kind, participantId, round, text) => {
    const current = { kind, participantId, round, runId: RunId.make("run"), timedOut: false };
    expect(
      panelStatus({ ...panel, status: "running", current }, participants, false),
    ).toMatchObject({
      text,
      action: "stop",
      tone: "default",
    });
  });

  it("announces a queued post and disables actions until the cut-off turn settles", () => {
    const { current, ...state } = {
      ...panel,
      status: "running" as const,
      current: {
        participantId: "p1",
        kind: "reply" as const,
        round: 1,
        runId: RunId.make("run"),
        timedOut: false,
      },
    };
    const pendingPost = { messageId: MessageId.make("queued-post"), mentionedParticipantIds: [] };
    expect(panelStatus({ ...state, current, pendingPost }, participants, false).text).toBe(
      "Round 1 of 2 · Opus is replying · your message is next",
    );
    expect(panelStatus({ ...state, current }, participants, true)).toMatchObject({
      text: "Stopping…",
      action: "none",
    });
    expect(
      panelStatus(
        { ...state, status: "idle", idleReason: "stopped", current },
        participants,
        false,
      ),
    ).toMatchObject({
      text: "Stopping…",
      action: "none",
    });
    expect(
      panelStatus(
        { ...state, status: "idle", idleReason: "stopped", current: null },
        participants,
        false,
      ),
    ).toMatchObject({
      text: "Stopped",
      action: "continue",
    });
  });
});

describe("panelTimelineAnnotations", () => {
  it("marks open rounds, code requests, conclusion, and addressed turns", () => {
    const annotations = panelTimelineAnnotations(
      [
        run(1, { lookup: "requested" }),
        run(2, { participantId: "code", kind: "lookup", askedBy: "p1" }),
        run(3, { participantId: "p2", lookup: "limit_reached" }),
        run(4, { round: 2 }),
        run(5, { round: 2, kind: "conclusion" }),
        run(6, {
          round: 0,
          totalRounds: 0,
          participantId: "code",
          kind: "lookup",
          askedBy: "user",
        }),
        run(7, {}),
      ],
      panel,
    );
    const at = (index: number) => annotations.get(RunId.make(`run-${index}`));
    expect([...annotations.values()].flatMap((annotation) => annotation.roundStart ?? [])).toEqual([
      { round: 1, total: 2 },
      { round: 2, total: 2 },
      { round: 1, total: 2 },
    ]);
    expect(at(2)).toMatchObject({ speaker: participants[2], askedBy: "asked by Opus" });
    expect(at(3)?.lookupLine).toEqual({
      label: "Code agent not called",
      detail: "2 lookups already used this round",
    });
    expect(at(5)?.conclusion).toBe(true);
    expect(at(6)).toMatchObject({ askedBy: "asked by you" });
  });

  it("marks round one again when a post replaces the rest of a running round", () => {
    const annotations = panelTimelineAnnotations(
      [run(1, {}), run(2, { participantId: "p2" })],
      panel,
      undefined,
      [{ role: "user", runId: null, createdAt: DateTime.makeUnsafe(15) }],
    );
    expect(annotations.get(RunId.make("run-2"))?.roundStart).toEqual({ round: 1, total: 2 });
  });

  it.each([
    ["p1", "passed", { label: "Opus passed" }],
    ["p1", "failed", { label: "Opus could not reply", tone: "danger", detail: "Provider detail" }],
    [
      "p1",
      "limited",
      { label: "Opus hit a usage limit", tone: "danger", detail: "Provider detail" },
    ],
    ["p1", "unavailable", { label: "Opus is unavailable", tone: "danger" }],
    ["p1", "timed_out", { label: "Opus was stopped after 2 minutes" }],
    ["code", "timed_out", { label: "Haiku was stopped after 5 minutes" }],
    ["p1", "stopped", undefined],
    ["p1", "interrupted", undefined],
    ["p1", "replied", undefined],
  ] satisfies ReadonlyArray<readonly [string, OrchestrationV2PanelTurn["outcome"], unknown]>)(
    "maps the %s outcome %s to its transcript line",
    (participantId, outcome, expected) => {
      const turn = run(1, { participantId, outcome, outcomeDetail: "Provider detail" });
      expect(panelTimelineAnnotations([turn], panel).get(turn.id)?.outcomeLine).toEqual(expected);
    },
  );
});

it("describes who will receive a post and counts the conclusion in the Continue budget", () => {
  expect(panelSendTooltip("What next?", panel)).toBe("Send to everyone: starts 2 rounds");
  expect(panelSendTooltip("@unknown What next?", { ...panel, rounds: 1 })).toBe(
    "Send to everyone: starts 1 round",
  );
  expect(panelSendTooltip("@sol @opus @SOL What next?", panel)).toBe("Send to Opus, Sol");
  expect(panelSendTooltip("@code What next?", panel)).toBe("Send to Haiku");
  expect(panelContinueTooltip(panel)).toBe("Runs 2 more rounds: up to 5 replies.");
});

it("matches panel participants by name or handle and labels the code agent's role", () => {
  expect(
    panelParticipantMenuItems(panel, "").map((item) => [item.label, item.description]),
  ).toEqual([
    ["Opus", "@opus"],
    ["Sol", "@sol"],
    ["Code agent", "@code"],
  ]);
  expect(panelParticipantMenuItems(panel, "OPU").map((item) => item.participant.id)).toEqual([
    "p1",
  ]);
  expect(panelParticipantMenuItems(panel, "@co").map((item) => item.participant.id)).toEqual([
    "code",
  ]);
  expect(panelParticipantMenuItems(panel, "codex")).toEqual([]);
});
