import { describe, expect, it } from "vite-plus/test";

import {
  derivePanelHandle,
  isPanelPass,
  panelCodeCallouts,
  panelMentionedParticipantIds,
  panelReplyBudget,
  panelTitleSeed,
} from "./panelChat.ts";

describe("derivePanelHandle", () => {
  it("lowercases the source, collapses separators, and falls back for an empty handle", () => {
    expect(derivePanelHandle("  -- Claude (Opus) 4.5! ", new Set())).toBe("claude-opus-4-5");
    expect(derivePanelHandle("!?", new Set())).toBe("model");
  });

  it("caps handles at 16 characters and removes a trailing separator after cutting", () => {
    expect(derivePanelHandle("abcdefghijklmnopqr", new Set())).toBe("abcdefghijklmnop");
    expect(derivePanelHandle("abcdefghijklmno-more", new Set())).toBe("abcdefghijklmno");
  });

  it("numbers taken handles without exceeding the cap", () => {
    const taken = new Set(["abcdefghijklmnop", "abcdefghijklmn-2"]);
    expect(derivePanelHandle("abcdefghijklmnopqr", taken)).toBe("abcdefghijklmn-3");
    expect(derivePanelHandle("abcdefghijklm-word", new Set(["abcdefghijklm-wo"]))).toBe(
      "abcdefghijklm-2",
    );
  });

  it("reserves code for the code agent even when it is missing from the roster", () => {
    expect(derivePanelHandle("CODE", new Set())).toBe("code-2");
    expect(derivePanelHandle("Code", new Set(["code-2"]))).toBe("code-3");
  });
});

describe("isPanelPass", () => {
  it.each(["PASS", "pass.", " Pass "])("recognizes %j as a pass", (text) => {
    expect(isPanelPass(text)).toBe(true);
  });

  it.each(["PASS!", "I pass"])("reads %j as a reply", (text) => {
    expect(isPanelPass(text)).toBe(false);
  });
});

describe("panelMentionedParticipantIds", () => {
  const participants = [
    { id: "p1", role: "panelist", handle: "sol" },
    { id: "p2", role: "panelist", handle: "opus-4-5" },
    { id: "code", role: "code_agent", handle: "code" },
  ] as const;

  it("returns mentioned ids once each, with the code agent first and panelists in roster order", () => {
    expect(
      panelMentionedParticipantIds(
        "@OPUS-4-5! @unknown, @CODE: @sol? @opus-4-5. @SOL;",
        participants,
      ),
    ).toEqual(["code", "p1", "p2"]);
    expect(panelMentionedParticipantIds("Ask @sol)\n@opus-4-5,", participants)).toEqual([
      "p1",
      "p2",
    ]);
    expect(panelMentionedParticipantIds("@sol", participants)).toEqual(["p1"]);
  });

  it("requires complete handles at token boundaries", () => {
    expect(
      panelMentionedParticipantIds(
        "email@sol (@opus-4-5) @sol_extra @sol/ @opus-4-50",
        participants,
      ),
    ).toEqual([]);
  });
});

describe("panelCodeCallouts", () => {
  it("reads the first token of each line case-insensitively and trims the request", () => {
    expect(
      panelCodeCallouts("@code where is the limit?\n \t@CODE: where is it set? \n@code"),
    ).toEqual(["@code where is the limit?", "@CODE: where is it set?", "@code"]);
  });

  it("ignores inline mentions and other tokens that start with @code", () => {
    expect(panelCodeCallouts("Ask @code later\n@code-review\n@code?")).toEqual([]);
  });

  it("ignores both fence kinds until a matching closing fence", () => {
    const text = [
      "````ts",
      "@code inside backticks",
      "```",
      "@code after a shorter backtick fence",
      "~~~",
      "@code after a different fence marker",
      "````",
      "@code outside backticks",
      "~~~text",
      "@code inside tildes",
      "~~~ trailing text",
      "@code before the closing fence",
      "~~~~",
      "@code: outside tildes",
      "```",
      "@code inside an unclosed fence",
    ].join("\r\n");
    expect(panelCodeCallouts(text)).toEqual(["@code outside backticks", "@code: outside tildes"]);
  });
});

describe("panelReplyBudget", () => {
  it("includes one conclusion after the rounds", () => {
    expect(panelReplyBudget(3, 2)).toBe(7);
  });
});

describe("panelTitleSeed", () => {
  it("collapses whitespace and keeps at most the first 60 characters", () => {
    expect(panelTitleSeed("  Should\twe\nsplit the orchestrator?  ")).toBe(
      "Should we split the orchestrator?",
    );
    expect(panelTitleSeed("a".repeat(59) + "\n rest of topic")).toBe("a".repeat(59));
    expect(panelTitleSeed("a".repeat(61))).toBe("a".repeat(60));
  });

  it("uses the default title for a blank topic", () => {
    expect(panelTitleSeed(" \n\t ")).toBe("Panel chat");
  });
});
