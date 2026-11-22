import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2PanelParticipant,
  type OrchestrationV2PanelState,
} from "@t3tools/contracts";
import { panelMentionedParticipantIds } from "@t3tools/shared/panelChat";
import { describe, expect, it } from "vite-plus/test";

import {
  addressedRun,
  classifyTurn,
  openRunOfRounds,
  recordPost,
  recover,
  settleTurn,
  type PanelDecision,
  type PanelSettledTurn,
} from "./PanelScheduler.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const driver = ProviderDriverKind.make("codex");
const panelists: OrchestrationV2PanelParticipant[] = ["a", "b", "c"].map((handle, index) => ({
  id: `p${index + 1}`,
  role: "panelist",
  handle,
  name: handle,
  driver,
  modelSelection,
  toolsRemoved: true,
}));
const code: OrchestrationV2PanelParticipant = {
  id: "code",
  role: "code_agent",
  handle: "code",
  name: "Code agent",
  driver,
  modelSelection,
  toolsRemoved: true,
};

function panel(overrides: Partial<OrchestrationV2PanelState> = {}): OrchestrationV2PanelState {
  return {
    participants: panelists,
    rounds: 2,
    status: "idle",
    idleReason: null,
    run: null,
    queue: [],
    current: null,
    pendingPost: null,
    cursor: null,
    lookupsThisRound: 0,
    turnCount: 0,
    ...overrides,
  };
}

function beginTurn({ state, next }: PanelDecision) {
  if (next === null) throw new Error("Expected a next turn");
  const { participantId, kind, round } = next;
  const turnCount = state.turnCount + 1;
  return {
    ...state,
    turnCount,
    current: {
      runId: RunId.make(`run-${turnCount}`),
      participantId,
      kind,
      round,
      timedOut: false,
    },
  };
}

function finish(
  decision: PanelDecision,
  outcome: PanelSettledTurn["outcome"] = "replied",
  codeCallout = false,
) {
  const state = beginTurn(decision);
  const { participantId, kind, runId } = state.current;
  return settleTurn(state, { participantId, kind, outcome, codeCallout }, runId);
}

describe("open runs", () => {
  it("runs every round in roster order and concludes once with slot one", () => {
    let decision = openRunOfRounds(panel({ participants: [...panelists, code] }));
    for (const round of [1, 2]) {
      for (const participantId of ["p1", "p2", "p3"]) {
        expect(decision.next).toEqual({ participantId, kind: "reply", round });
        decision = finish(decision);
      }
    }
    expect(decision.next).toEqual({ participantId: "p1", kind: "conclusion", round: 2 });
    expect(decision.state.run?.roundsCompleted).toBe(2);
    expect(decision.state.queue).toEqual([]);

    decision = finish(decision, "replied", true);
    expect(decision).toMatchObject({
      state: { status: "idle", idleReason: "concluded", queue: [], cursor: "p3" },
      next: null,
    });
    expect(decision.lookup).toBeUndefined();
  });

  it("drops later rounds when everyone passes and ends agreed after the conclusion", () => {
    let decision = openRunOfRounds(panel());
    for (const participantId of ["p1", "p2", "p3"]) {
      expect(decision.next?.participantId).toBe(participantId);
      decision = finish(decision, "passed");
    }
    expect(decision.next).toEqual({ participantId: "p1", kind: "conclusion", round: 1 });
    expect(decision.state.run).toMatchObject({ agreed: true, roundsCompleted: 0 });
    expect(decision.state.queue).toEqual([]);
    expect(finish(decision)).toMatchObject({
      state: { status: "idle", idleReason: "agreed" },
      next: null,
    });
  });

  it.each(["failed", "passed", "timed_out", "unavailable"] as const)(
    "ends rounds_done when the conclusion is %s",
    (outcome) => {
      let decision = openRunOfRounds(panel({ rounds: 1 }));
      for (const result of ["replied", "unavailable", "timed_out"] as const) {
        decision = finish(decision, result);
      }
      expect(decision.next).toMatchObject({ kind: "conclusion", participantId: "p1" });
      expect(finish(decision, outcome)).toMatchObject({
        state: { status: "idle", idleReason: "rounds_done", cursor: "p3" },
        next: null,
      });
    },
  );

  it("ends no_replies for a round with only passes and skipped turns", () => {
    let decision = openRunOfRounds(panel());
    for (const outcome of ["failed", "passed", "limited"] as const) {
      decision = finish(decision, outcome);
    }
    expect(decision).toMatchObject({
      state: { idleReason: "no_replies", status: "idle", queue: [], cursor: "p3" },
      next: null,
    });
  });

  it("ends no_replies without a conclusion after an earlier round had a reply", () => {
    let decision = openRunOfRounds(panel());
    for (const outcome of ["replied", "passed", "failed", "passed", "failed", "passed"] as const) {
      decision = finish(decision, outcome);
    }
    expect(decision).toMatchObject({
      state: {
        idleReason: "no_replies",
        status: "idle",
        queue: [],
        run: { roundsCompleted: 1, agreed: false },
      },
      next: null,
    });
  });

  it("rotates after the cursor and ignores a new Continue while the panel is running", () => {
    const initial = openRunOfRounds(panel({ cursor: "p2" }));
    expect(initial.next).toEqual({ participantId: "p3", kind: "reply", round: 1 });
    expect(initial.state.queue.slice(0, 3)).toEqual([
      { participantId: "p1", kind: "reply", round: 1 },
      { participantId: "p2", kind: "reply", round: 1 },
      { participantId: "p3", kind: "reply", round: 2 },
    ]);
    const inFlight = beginTurn(initial);
    expect(openRunOfRounds(inFlight)).toEqual({ state: inFlight, next: null });
  });
});

describe("posts and lookups", () => {
  it("starts an open run after the cursor when an idle post mentions nobody", () => {
    const state = panel({ cursor: "p2" });
    const post = {
      messageId: MessageId.make("open-post"),
      mentionedParticipantIds: panelMentionedParticipantIds(
        "@unknown, any thoughts?",
        state.participants,
      ),
    };
    expect(recordPost(state, post)).toEqual(openRunOfRounds(state));
  });

  it("serves only the addressed panelists in roster order, even if none replies", () => {
    const state = panel({ cursor: "p1" });
    const request = { type: "message", messageId: MessageId.make("addressed-post") } as const;
    const mentioned = panelMentionedParticipantIds("@b @a @b", state.participants);
    const first = addressedRun(state, mentioned, request);
    expect(first.next).toEqual({
      participantId: "p1",
      kind: "reply",
      round: 0,
      askedBy: "user",
      request,
    });
    expect(first.state.run).toMatchObject({ mode: "addressed", round: 0, totalRounds: 0 });
    const second = finish(first, "passed");
    expect(second.next).toEqual({ ...first.next, participantId: "p2" });
    expect(finish(second, "failed")).toMatchObject({
      state: { status: "idle", idleReason: "answered", cursor: "p2" },
      next: null,
    });
  });

  it("uses the last pending post after the current reply, ahead of the call-out and round end", () => {
    const initial = openRunOfRounds(panel({ rounds: 1, participants: [...panelists, code] }));
    const inFlight = beginTurn(finish(finish(initial, "passed"), "failed"));
    const firstPost = { messageId: MessageId.make("first-post"), mentionedParticipantIds: [] };
    const lastPost = { messageId: MessageId.make("last-post"), mentionedParticipantIds: ["p2"] };
    const first = recordPost(inFlight, firstPost);
    const last = recordPost(first.state, lastPost);
    expect(first).toEqual({ state: { ...inFlight, pendingPost: firstPost }, next: null });
    expect(last).toEqual({ state: { ...inFlight, pendingPost: lastPost }, next: null });
    const decision = settleTurn(
      last.state,
      { participantId: "p3", kind: "reply", outcome: "replied", codeCallout: true },
      inFlight.current.runId,
    );
    expect(decision).toMatchObject({
      state: { pendingPost: null, cursor: "p3", queue: [], lookupsThisRound: 0 },
      next: {
        participantId: "p2",
        kind: "reply",
        request: { type: "message", messageId: lastPost.messageId },
      },
      lookup: "requested",
    });
    expect(finish(decision).state.idleReason).toBe("answered");
  });

  it("places the user's code lookup first without spending the addressed round's lookup budget", () => {
    const state = panel({ participants: [...panelists, code], lookupsThisRound: 2 });
    const messageId = MessageId.make("code-post");
    const start = recordPost(state, {
      messageId,
      mentionedParticipantIds: ["p3", "code", "p2", "p1"],
    });
    expect(start.next).toEqual({
      participantId: "code",
      kind: "lookup",
      round: 0,
      askedBy: "user",
      request: { type: "message", messageId },
    });
    expect(start.state.lookupsThisRound).toBe(0);
    const p1 = finish(start, "replied", true);
    expect(p1.lookup).toBeUndefined();
    expect(p1.next?.participantId).toBe("p1");
    expect(p1.state.cursor).toBeNull();
    const firstLookup = finish(p1, "replied", true);
    expect(firstLookup.next).toMatchObject({ kind: "lookup", askedBy: "p1", round: 0 });
    const p2 = finish(firstLookup);
    expect(p2.next?.participantId).toBe("p2");
    const secondLookup = finish(p2, "replied", true);
    expect(secondLookup.next).toMatchObject({ kind: "lookup", askedBy: "p2", round: 0 });
    const p3 = finish(secondLookup);
    expect(p3.next?.participantId).toBe("p3");
    expect(finish(p3, "replied", true)).toMatchObject({
      lookup: "limit_reached",
      state: { status: "idle", idleReason: "answered", lookupsThisRound: 0 },
      next: null,
    });

    const codeOnly = recordPost(state, { messageId, mentionedParticipantIds: ["code"] });
    expect(finish(codeOnly).state.idleReason).toBe("answered");
  });

  it("queues one lookup per eligible reply and caps the round at two before resetting", () => {
    const initial = openRunOfRounds(panel({ participants: [...panelists, code] }));
    const first = finish(initial, "replied", true);
    expect(first.lookup).toBe("requested");
    expect(first.state.lookupsThisRound).toBe(1);
    expect(first.next).toEqual({
      participantId: "code",
      kind: "lookup",
      round: 1,
      askedBy: "p1",
      request: { type: "run", runId: RunId.make("run-1") },
    });

    const second = finish(finish(first), "replied", true);
    expect(second.state.lookupsThisRound).toBe(2);
    expect(second.next).toMatchObject({ participantId: "code", askedBy: "p2", round: 1 });
    const nextRound = finish(finish(second, "failed"), "replied", true);
    expect(nextRound.lookup).toBe("limit_reached");
    expect(nextRound.next).toEqual({ participantId: "p1", kind: "reply", round: 2 });
    expect(nextRound.state.lookupsThisRound).toBe(0);
    expect(finish(nextRound, "replied", true).next).toMatchObject({ kind: "lookup", round: 2 });
  });

  it("runs the final panelist's lookup before the conclusion", () => {
    const first = openRunOfRounds(panel({ rounds: 1, participants: [...panelists, code] }));
    const lookup = finish(finish(finish(first)), "replied", true);
    expect(lookup.state.lookupsThisRound).toBe(0);
    expect(lookup.next).toMatchObject({ participantId: "code", kind: "lookup", askedBy: "p3" });
    expect(lookup.state.queue).toEqual([{ participantId: "p1", kind: "conclusion", round: 1 }]);
    expect(finish(lookup, "replied", true).next).toMatchObject({ kind: "conclusion" });
  });

  it("ignores a call-out when there is no code agent or the reply did not complete with text", () => {
    const withoutCode = finish(openRunOfRounds(panel()), "replied", true);
    const timedOut = finish(
      openRunOfRounds(panel({ participants: [...panelists, code] })),
      "timed_out",
      true,
    );
    for (const decision of [withoutCode, timedOut]) {
      expect(decision.lookup).toBeUndefined();
      expect(decision.next).toMatchObject({ participantId: "p2", kind: "reply" });
    }
  });
});

describe("stopping and recovery", () => {
  const stopped: PanelSettledTurn = {
    participantId: "p1",
    kind: "reply",
    outcome: "stopped",
    codeCallout: false,
  };

  it("clears upcoming work when a running turn is stopped", () => {
    const inFlight = beginTurn(openRunOfRounds(panel()));
    const posted = recordPost(inFlight, {
      messageId: MessageId.make("cancelled-post"),
      mentionedParticipantIds: ["p2"],
    });
    const decision = settleTurn(posted.state, stopped, inFlight.current.runId);
    expect(decision).toMatchObject({
      state: {
        status: "idle",
        idleReason: "stopped",
        cursor: "p1",
        current: null,
        pendingPost: null,
        queue: [],
      },
      next: null,
    });
  });

  it("settles p1 after Stop and starts the next Continue with p2", () => {
    const inFlight = beginTurn(openRunOfRounds(panel()));
    const stoppedPanel: OrchestrationV2PanelState = {
      ...inFlight,
      status: "idle",
      idleReason: "stopped",
      queue: [],
      pendingPost: null,
    };
    expect(openRunOfRounds(stoppedPanel)).toEqual({ state: stoppedPanel, next: null });
    const settled = settleTurn(stoppedPanel, stopped, inFlight.current.runId);
    expect(settled).toEqual({
      state: { ...stoppedPanel, cursor: "p1", current: null },
      next: null,
    });
    expect(openRunOfRounds(settled.state).next).toEqual({
      participantId: "p2",
      kind: "reply",
      round: 1,
    });
  });

  const messageId = MessageId.make("post-while-stopping");
  it.each([
    {
      mode: "open",
      text: "Any thoughts?",
      next: { participantId: "p2", kind: "reply", round: 1 },
    },
    {
      mode: "addressed",
      text: "@c, any thoughts?",
      next: {
        participantId: "p3",
        kind: "reply",
        round: 0,
        askedBy: "user",
        request: { type: "message", messageId },
      },
    },
  ])("starts an $mode run for a post made while stopping", ({ mode, text, next }) => {
    const inFlight = beginTurn(openRunOfRounds(panel()));
    const stopping: OrchestrationV2PanelState = {
      ...inFlight,
      status: "idle",
      idleReason: "stopped",
      queue: [],
      pendingPost: null,
    };
    const post = {
      messageId,
      mentionedParticipantIds: panelMentionedParticipantIds(text, stopping.participants),
    };
    const posted = recordPost(stopping, post);
    expect(posted).toEqual({ state: { ...stopping, pendingPost: post }, next: null });

    const settled = settleTurn(posted.state, stopped, inFlight.current.runId);
    expect(settled.state).toMatchObject({
      status: "running",
      idleReason: null,
      current: null,
      cursor: "p1",
      pendingPost: null,
      run: { mode },
    });
    expect(settled.next).toEqual(next);
  });

  it("ignores duplicate or stale settlements while a later turn is in flight", () => {
    const first = openRunOfRounds(panel());
    const inFlight = beginTurn(finish(first));
    const decision = settleTurn(inFlight, stopped, beginTurn(first).current.runId);
    expect(decision).toEqual({ state: inFlight, next: null });
  });

  it("recovers into interrupted, drops all work, and remembers the cut-off speaker", () => {
    const inFlight = beginTurn(openRunOfRounds(panel()));
    const { state } = recordPost(inFlight, {
      messageId: MessageId.make("lost-post"),
      mentionedParticipantIds: [],
    });
    const recovered = recover(state);
    expect(recovered).toMatchObject({
      status: "idle",
      idleReason: "interrupted",
      queue: [],
      pendingPost: null,
      current: null,
      cursor: "p1",
    });
    expect(recover(recovered)).toBe(recovered);
    expect(openRunOfRounds(recovered).next?.participantId).toBe("p2");
  });
});

describe("turn classification", () => {
  type Input = Parameters<typeof classifyTurn>[0];
  const base: Input = {
    kind: "reply",
    runStatus: "completed",
    timedOut: false,
    assistantText: "A reply.",
    failure: null,
  };
  const failure = { class: "provider_error", code: null, message: "Provider failed." } as const;
  const cases: ReadonlyArray<readonly [string, Partial<Input>, ReturnType<typeof classifyTurn>]> = [
    ["replied", {}, { outcome: "replied" }],
    ["passed", { assistantText: " \tpaSs. " }, { outcome: "passed" }],
    ["pass as conclusion", { kind: "conclusion", assistantText: "PASS" }, { outcome: "passed" }],
    ["blank", { assistantText: "  \n" }, { outcome: "failed" }],
    [
      "failure with detail",
      { runStatus: "failed", failure },
      { outcome: "failed", detail: failure.message },
    ],
    ["failure without detail", { runStatus: "failed" }, { outcome: "failed" }],
    [
      "limited",
      { runStatus: "failed", failure: { ...failure, class: "usage_limit" } },
      { outcome: "limited", detail: failure.message },
    ],
    [
      "unavailable",
      { runStatus: "failed", failure: { ...failure, code: "panel_participant_unavailable" } },
      { outcome: "unavailable" },
    ],
    ["interrupted", { runStatus: "interrupted" }, { outcome: "stopped" }],
    ["cancelled", { runStatus: "cancelled" }, { outcome: "stopped" }],
    ["rolled back", { runStatus: "rolled_back" }, { outcome: "stopped" }],
    [
      "timeout before status",
      { runStatus: "interrupted", timedOut: true },
      { outcome: "timed_out" },
    ],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(classifyTurn({ ...base, ...input })).toEqual(expected);
  });
});
