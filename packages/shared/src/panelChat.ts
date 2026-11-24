import type {
  OrchestrationV2PanelParticipant,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";

const PANEL_MIN_PANELISTS = 2;
const PANEL_MAX_PANELISTS = 5;
const PANEL_MIN_ROUNDS = 1;
const PANEL_MAX_ROUNDS = 5;
const PANEL_DEFAULT_ROUNDS = 2;
const PANEL_TEXT_MAX_CHARS = 8_000;
const PANEL_TRANSCRIPT_MAX_CHARS = 16_000;
const PANEL_TRANSCRIPT_MESSAGE_MAX_CHARS = 3_000;
const PANEL_TOPIC_PROMPT_MAX_CHARS = 8_000;
const PANEL_LOOKUPS_PER_ROUND = 2;
const PANEL_PANELIST_REPLY_LIMIT_MS = 120_000;
const PANEL_CODE_AGENT_REPLY_LIMIT_MS = 300_000;
const PANEL_REPLY_WORD_LIMIT = 150;
const PANEL_CODE_AGENT_WORD_LIMIT = 200;
const PANEL_CODE_AGENT_QUOTE_LINES = 3;
const PANEL_HANDLE_MAX_CHARS = 16;
const PANEL_CODE_HANDLE = "code";
const PANEL_TITLE_SEED_CHARS = 60;
const PANEL_AGENT_RUNS_IN_A_ROW = 4;
const PANEL_AGENT_RUNNING_PER_PARENT = 2;

/** @public */
export {
  PANEL_MIN_PANELISTS,
  PANEL_MAX_PANELISTS,
  PANEL_MIN_ROUNDS,
  PANEL_MAX_ROUNDS,
  PANEL_DEFAULT_ROUNDS,
  PANEL_TEXT_MAX_CHARS,
  PANEL_TRANSCRIPT_MAX_CHARS,
  PANEL_TRANSCRIPT_MESSAGE_MAX_CHARS,
  PANEL_TOPIC_PROMPT_MAX_CHARS,
  PANEL_LOOKUPS_PER_ROUND,
  PANEL_PANELIST_REPLY_LIMIT_MS,
  PANEL_CODE_AGENT_REPLY_LIMIT_MS,
  PANEL_REPLY_WORD_LIMIT,
  PANEL_CODE_AGENT_WORD_LIMIT,
  PANEL_CODE_AGENT_QUOTE_LINES,
  PANEL_HANDLE_MAX_CHARS,
  PANEL_CODE_HANDLE,
  PANEL_TITLE_SEED_CHARS,
  PANEL_AGENT_RUNS_IN_A_ROW,
  PANEL_AGENT_RUNNING_PER_PARENT,
};

const PANEL_REASONING_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
  "thought_level",
  "thinking",
]);

export function lowestPanelModelOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ProviderOptionSelection[] | undefined {
  const reasoning = descriptors.find(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" || PANEL_REASONING_OPTION_IDS.has(descriptor.id)),
  );
  const lowest = reasoning?.options[0];
  return reasoning && lowest ? [{ id: reasoning.id, value: lowest.id }] : undefined;
}

export function derivePanelHandle(source: string, taken: ReadonlySet<string>): string {
  const normalized = source
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const characters = Array.from(normalized || "model");
  let handle = characters.slice(0, PANEL_HANDLE_MAX_CHARS).join("").replace(/-$/, "");
  for (let index = 2; handle === PANEL_CODE_HANDLE || taken.has(handle); index++) {
    const suffix = `-${index}`;
    const base = characters
      .slice(0, PANEL_HANDLE_MAX_CHARS - suffix.length)
      .join("")
      .replace(/-$/, "");
    handle = base + suffix;
  }
  return handle;
}

export function isPanelPass(text: string): boolean {
  return /^pass\.?$/i.test(text.trim());
}

export function panelMentionedParticipantIds(
  text: string,
  participants: ReadonlyArray<Pick<OrchestrationV2PanelParticipant, "id" | "role" | "handle">>,
): string[] {
  const handles = new Set(
    Array.from(
      text.toLowerCase().matchAll(/(?:^|\s)@([\p{L}\p{Nd}-]+)(?=$|[\s.,:;!?)])/gu),
      ([, handle]) => handle,
    ),
  );
  const codeAgentIds: string[] = [];
  const panelistIds: string[] = [];
  for (const { id, role, handle } of participants) {
    if (!handles.has(handle.toLowerCase())) continue;
    (role === "code_agent" ? codeAgentIds : panelistIds).push(id);
  }
  return [...new Set([...codeAgentIds, ...panelistIds])];
}

const panelCodeCallout = new RegExp(`^@${PANEL_CODE_HANDLE}(?:[\\s:]|$)`, "i");

export function panelCodeCallouts(text: string): string[] {
  const callouts: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    const marker = /^(?:`{3,}(?=[^`]*$)|~{3,})/.exec(trimmed)?.[0];
    if (fence !== undefined) {
      if (marker?.startsWith(fence) && trimmed === marker) fence = undefined;
    } else if (marker !== undefined) {
      fence = marker;
    } else if (panelCodeCallout.test(trimmed)) {
      callouts.push(trimmed);
    }
  }
  return callouts;
}

export function panelReplyBudget(panelists: number, rounds: number): number {
  return panelists * rounds + 1;
}

export function panelTitleSeed(topic: string): string {
  const title = Array.from(topic.replace(/\s+/g, " "))
    .slice(0, PANEL_TITLE_SEED_CHARS)
    .join("")
    .trim();
  return title || "Panel chat";
}
