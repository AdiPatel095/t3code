# Panel chat: director's acceptance check, round 1 (2026-11-22)

Director: Claude Opus 5.5. Branch `feat/panel-chat` at `b3d01b1986`. Requirement spec: `E:\t3code-specs\panel-chat.md` (now revision 2.1). Implementable spec: `E:\t3code-specs\panel-chat-implementation.md`.

## How it was checked

- Code reading: `PanelScheduler.ts`, `PanelPromptBuilder.ts` against spec 2.3/2.4.
- Live pass on an isolated dev server (`vp run dev --home-dir E:\t3code\.t3`, DB seeded by `migrate-dev-db`), web at 1366×768 and 390×844, real cheap turns: panelists Codex GPT-6-Luna (low) and Claude Haiku 5.5 (low), code agent Claude Haiku 5.5, rounds 1, topic about the panel reply limit, in the T3 Code project. Panel thread id `850f13d3-6194-4a0e-a11e-7abab3845028` (dev DB `E:\t3code\.t3\userdata\statev2.sqlite`, read-only inspection).

## Verified working (live)

- AC 1 (`/panel` slash item with spec description; right-panel + menu "Panel chat G" after "Side chat S"), AC 4 (topic prefilled), AC 5 (Start disabled with 1 model), AC 7 (panel opens as right-panel tab and streams), AC 58 (new slots default to lowest effort; "Up to N replies" counts the conclusion: 3, 5, 3).
- Turn order, `@code` call-out from Haiku → code agent turn "asked by Claude Haiku 5.5" before the conclusion (AC 20), conclusion under a "Conclusion" divider by slot 1 in the required form (AC 53), status "Concluded after 1 round" + Continue.
- Addressed post `@gpt-6-luna …` → only Luna replies, "asked by you", status "GPT-6-Luna is replying" then "Waiting for you" (AC 13 behaviour). `@` menu lists only participants (AC 43).
- Open post after that started with Haiku (panelist after `cursor`) (AC 12 rotation). Stop interrupted the in-flight turn: "Run interrupted · Stopped by user", status "Stopped", Continue offered (AC 16).
- Codex panelist (Luna) ran with no tool items at all; Codex accepted the `CODEX_PANELIST_TOOL_OVERRIDES` in a live session (resolves the lead's open risk). Claude panelist (Haiku) turns had reasoning only, no tools (AC 55). Code agent used only `Grep` and `Read` (AC 27).
- Panel checkpoints are `missing` rows with no git refs, as for side chats (AC 30).
- Roster popover content (AC 41); thread details "Panel chats" section with status "Idle" (4.2c); panel absent from sidebar (AC 36); closing the tab keeps the panel (AC 35); "Add to chat" puts the panel chip into the parent composer (AC 42, client side).
- 390×844: pane fits, no horizontal scroll, status bar wraps.

## Findings to fix

**F1 — requirement change (spec revision 2.1, §2.3 step 4).** An open run whose later round has no replies (and not all passed) must still end with the conclusion turn when any panelist replied earlier in the same run; only a run with no panelist reply at all ends idle `no_replies`. Change `endOfRoundWithoutReplies` in `apps/server/src/orchestration-v2/panel/PanelScheduler.ts` accordingly (the run is not `agreed`; conclusion success → `concluded`) and add scheduler test rows for: (a) round 1 replied, round 2 all failed → conclusion → `concluded`; (b) round 1 all failed → `no_replies`, no conclusion; (c) existing all-passed case unchanged.

**F2 — important, transcript hides the wrong messages (AC 13, 14, 37, 38; spec 4.4 table).** The stored data is correct (messages in order: topic user message `runId=null`; per-run marker user message `message:panel:<thread>:turn:<n>` with empty text; replies). In the web pane:
  - Run 1's panelist reply (Luna: "No. Five minutes is too short for code-heavy replies; make it configurable, with a longer default.") is NOT rendered: its speaker line is followed directly by the next speaker line.
  - User posts made in the panel (`runId=null` user messages, e.g. "@gpt-6-luna in one sentence, what default would you pick?" and "Briefly reconsider: is 10 minutes too long?") are NOT rendered at all. The topic is rendered.
  - Later replies (run 2+, run 5 after a post) render correctly.
  Likely the marker-hiding / annotation logic hides an adjacent row by position or run pairing instead of exactly the marker message ids. Fix so that exactly the marker messages are hidden and every topic, post and reply renders; add regression tests at the lowest failing layer (client-runtime `panelTimelineAnnotations` / `MessagesTimeline.logic`) covering topic + marker + first reply in run 1, and a post (`runId=null`) followed by a marker and reply. Check the mobile transcript (WP6) uses logic that does not have the same bug, and fix it there too if it does.

**F3 — minor, name disambiguation (spec 2.4 "Names and handles").** "Claude Haiku 5.5 · Claude" is shown for the panelist because the code agent uses the same model; the suffix " · Claude" does not distinguish anything. The code agent is labelled "Code agent" everywhere, so it must not count toward name collisions; when two panelists do share a display name, append the label that actually differs (effort if efforts differ, else instance label).

**F4 — minor, setup dialog slot row (spec 4.3 item 2).** In each roster / code-agent row the model name is centered inside the picker trigger instead of sitting left-aligned after the provider icon (icon, name, then effort at the right). Fix with layout on the parent or an existing variant; do not restyle `components/ui` exports.

**F5 — verify, open-in-main-view modifier (spec 2.6, 4.2c).** Ctrl+click on the thread-details "Panel chats" row on Windows opened the panel as a right-panel tab, not in the main view. Compare with a side chat row on the same build: if side chats open in the main view with Ctrl+click, make panels match; if side chats behave identically, no change, and report that.

**F6 — minor accessibility (spec 4.4 "Accessibility").** Each panel reply keeps the visually hidden "T3 Code" author heading, so a screen reader announces "T3 Code" as the author of every participant. In panel threads the reply's accessible author must be the participant's name (or "Code agent").

## Still unverified (not blocking this round)

- AC 33 (restart while streaming), AC 44 (200-reply scroll performance), AC 46–47 on real iOS/Android devices, AC 51 (user without operate scope), Grok/Kiro/fx/Antigravity/Muse/OpenCode live turns (disabled on this machine), the `t3_thread_read` attribution in a real parent-agent read, and the main-view header the lead flagged (blocked on F5 to reach the main view).
