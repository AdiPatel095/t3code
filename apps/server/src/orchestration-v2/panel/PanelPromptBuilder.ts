import type {
  OrchestrationV2PanelParticipant,
  OrchestrationV2PanelState,
  OrchestrationV2PanelTurn,
} from "@t3tools/contracts";
import {
  PANEL_CODE_AGENT_QUOTE_LINES,
  PANEL_CODE_AGENT_WORD_LIMIT,
  PANEL_CODE_HANDLE,
  PANEL_REPLY_WORD_LIMIT,
  PANEL_TOPIC_PROMPT_MAX_CHARS,
  PANEL_TRANSCRIPT_MAX_CHARS,
  PANEL_TRANSCRIPT_MESSAGE_MAX_CHARS,
  panelCodeCallouts,
} from "@t3tools/shared/panelChat";

import type { PanelTranscriptEntry } from "./PanelTranscript.ts";

const codeHandle = `@${PANEL_CODE_HANDLE}`;
// oxlint-disable-next-line t3code/no-em-dash-copy -- Matches the specified provider prompt.
const rosterSeparator = " — ";
const codeRosterLine = `- ${codeHandle}${rosterSeparator}code agent: reads this project's code when asked`;
const codeCalloutLine = `- If the discussion needs a fact from the project's code, put it on its own line starting with "${codeHandle}" followed by a short, specific question. The code agent answers with a summary before the next participant speaks. Ask only when the answer matters to the conclusion.`;
const addressedEnding = "The user addressed you directly in their latest message. Answer it.";
const trimMarker = "[…trimmed…]";
const speakerPattern = /^(?:user|@[\p{L}\p{Nd}-]+)$/u;

function neutralizeClosingTags(text: string): string {
  return text.replace(/<\/message>/gi, "<\\/message>");
}

function wrapMessage(from: string, body: string): string {
  return `<message from="${from}">${body}</message>`;
}

function trimMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const remaining = limit - trimMarker.length;
  const headLength = Math.ceil(remaining / 2);
  return (
    text.slice(0, headLength) +
    trimMarker +
    text.slice(text.length - (remaining - headLength))
  ).toWellFormed();
}

function discussionBlock(topic: string, entries: ReadonlyArray<PanelTranscriptEntry>): string {
  const topicLine = wrapMessage(
    "user",
    neutralizeClosingTags(topic).slice(0, PANEL_TOPIC_PROMPT_MAX_CHARS).toWellFormed(),
  );
  const validEntries = entries.filter(
    (entry) => entry.type === "note" || speakerPattern.test(entry.from),
  );
  const newestFirst: string[] = [];
  let remaining = PANEL_TRANSCRIPT_MAX_CHARS - topicLine.length;
  for (let index = validEntries.length - 1; index >= 0; index--) {
    const entry = validEntries[index]!;
    const line =
      entry.type === "note"
        ? `[${entry.text}]`
        : wrapMessage(
            entry.from,
            trimMiddle(
              neutralizeClosingTags(entry.text) + (entry.cutOff ? " [cut off]" : ""),
              PANEL_TRANSCRIPT_MESSAGE_MAX_CHARS,
            ),
          );
    if (line.length + 1 > remaining) break;
    newestFirst.push(line);
    remaining -= line.length + 1;
  }

  let omitted = validEntries.length - newestFirst.length;
  if (omitted > 0) {
    let note = `[${omitted} earlier messages omitted]`;
    while (note.length + 1 > remaining) {
      const removed = newestFirst.pop();
      if (removed === undefined) break;
      remaining += removed.length + 1;
      omitted++;
      note = `[${omitted} earlier messages omitted]`;
    }
    newestFirst.push(note);
  }
  return [topicLine, ...newestFirst.reverse()].join("\n");
}

function lookupPrompt(
  discussion: string,
  requests: ReadonlyArray<{ readonly from: string; readonly text: string }>,
): string {
  const messages: string[] = [];
  for (const request of requests) {
    if (!speakerPattern.test(request.from)) continue;
    const text =
      request.from === "user" ? request.text : panelCodeCallouts(request.text).join("\n");
    if (text) messages.push(wrapMessage(request.from, neutralizeClosingTags(text)));
  }
  return [
    `You are the code agent (${codeHandle}) for a panel discussion inside T3 Code.`,
    "Your working directory is the project's code.",
    "",
    `Answer the requests addressed to ${codeHandle} below with a short summary of what the code does. The panel cannot see the code; your summary is all they get, so make it self-contained.`,
    "Use only tools that read: open files, search, list. Read only what you need to answer; do not survey the codebase.",
    "- Summarize in plain prose or a short list; point to evidence as path/to/file.ext:LINE.",
    `- Quote at most ${PANEL_CODE_AGENT_QUOTE_LINES} lines of code in total.`,
    "- Report what the code says. Do not take sides in the discussion.",
    "- If you cannot find it, say so.",
    "- Never create, edit or delete files, and never run a command that changes anything.",
    `- Stay under ${PANEL_CODE_AGENT_WORD_LIMIT} words.`,
    "",
    "Discussion so far:",
    discussion,
    "",
    "Requests to answer:",
    ...messages,
  ].join("\n");
}

export function buildPanelPrompt(input: {
  readonly panel: OrchestrationV2PanelState;
  readonly participant: OrchestrationV2PanelParticipant;
  readonly turn: OrchestrationV2PanelTurn;
  readonly topic: string;
  readonly entries: ReadonlyArray<PanelTranscriptEntry>;
  readonly requests?: ReadonlyArray<{ readonly from: string; readonly text: string }>;
}): string {
  const { panel, participant, turn } = input;
  const discussion = discussionBlock(input.topic, input.entries);
  if (turn.kind === "lookup") return lookupPrompt(discussion, input.requests ?? []);

  const handle = `@${participant.handle}`;
  const others = panel.participants.filter(
    (member) => member.role === "panelist" && member.id !== participant.id,
  );
  const otherHandle = `@${others[0]?.handle ?? participant.handle}`;
  const hasCode = panel.participants.some((member) => member.role === "code_agent");
  const lines = [
    `You are ${participant.name} (${handle}), taking part in a panel discussion inside T3 Code`,
    "with other AI models and a human user.",
    "",
    "Participants:",
    `- ${handle}${rosterSeparator}${participant.name} (you)`,
    ...others.map((other) => `- @${other.handle}${rosterSeparator}${other.name}`),
    ...(hasCode ? [codeRosterLine] : []),
    "- The user started this discussion and can post at any time. Their messages take priority.",
    "",
    "Goal: reach a conclusion on the topic together, using as few words as possible.",
    "",
  ];
  const addressed = turn.kind === "reply" && turn.askedBy === "user";
  if (turn.kind === "conclusion") {
    lines.push(
      `The discussion is over. Write the panel's conclusion, at most ${PANEL_REPLY_WORD_LIMIT} words, in this form:`,
      "",
      "Conclusion: <the panel's answer to the topic, one to three sentences>",
      "Agreed:",
      "- <point everyone accepted>",
      "Open:",
      '- <point still disputed, naming who holds which view by handle> (omit "Open" if none)',
      "",
      "Report what the panel concluded, not only your own view. Do not add new arguments. You have no tools.",
      "",
    );
  } else {
    lines.push(
      "How to take part:",
      "- Write your own message only. Do not write for other participants and do not start with your name.",
      `- Be brief: at most ${PANEL_REPLY_WORD_LIMIT} words. Make one or two points, not a survey. Do not repeat what others said; say "agree with ${otherHandle}" instead.`,
      "- Agree, disagree, or build on what was said, and move toward a shared answer.",
      `- Address others by handle, for example "${otherHandle}".`,
      "- You have no tools. Do not try to read files or run commands.",
      ...(hasCode ? [codeCalloutLine] : []),
      "- If you agree with where the discussion has landed and have nothing new to add, reply with exactly: PASS. If everyone passes, the discussion ends.",
      "",
    );
    if (!addressed) {
      const finalRound =
        turn.round === turn.totalRounds
          ? " This is the final round: state your final position in one or two sentences."
          : "";
      lines.push(`This is round ${turn.round} of ${turn.totalRounds}.${finalRound}`, "");
    }
  }
  return [
    ...lines,
    "Discussion so far:",
    discussion,
    "",
    addressed ? addressedEnding : `It is your turn, ${handle}.`,
  ].join("\n");
}
