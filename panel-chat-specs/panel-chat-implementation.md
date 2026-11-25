# Panel chat: implementable specification

Status: written by the lead (Claude Opus 5.5, effort high) on 2026-11-22 from the requirement specification `E:\t3code-specs\panel-chat.md` (Revision 2, acceptance criteria 1–58). This document does not change a requirement. Where the two seem to differ, the requirement specification wins and the implementer raises the conflict. Never copy this file into the repository.

Repository: `E:\t3code`, branch `feat/panel-chat`. All paths below are relative to `E:\t3code`.

---

## 1. Approach

### 1.1 Shape of the solution

A panel is a side-chat-class thread (`lineage.sideChat: true`, `relationshipToParent: "fork"`, `forkedFrom: null`) with a new optional `panel` field on `OrchestrationV2AppThread`. The field holds the roster, the rounds cap and the scheduler state of requirement 2.3. All panel behaviour is reached through that field. Ordinary threads and side chats never see it.

- **Turns are ordinary runs.** The orchestrator starts each turn by calling its existing internal `dispatchMessage` (`apps/server/src/orchestration-v2/Orchestrator.ts:7130`) with a synthesized `message.dispatch` command: `freshContext: true`, the participant's `modelSelection`, `dispatchMode: start_immediately`, `createdBy: "agent"`, `creationSource: "server"`, and an empty-text marker message. The run carries `panelTurn` metadata, and the marker message and its `user_message` turn item carry `panelParticipantId`. Streaming, persistence, Stop, archive/delete cascade, the timeline and the effect worker are all reused.
- **One decide path owns panel state.** The commands `panel.open` (internal, issued by `PanelChatService.create`), `panel.post`, `panel.continue` and `panel.turn.settle` (internal) are decided in `Orchestrator.ts`. Each computes the next panel state with the pure scheduler (`PanelScheduler.ts`). When the scheduler names a next turn, the same decide call starts it through `dispatchMessage`. Panel state and the next run therefore commit in one transaction. No window exists in which the panel is "running" without a run, or a run exists without matching state.
- **A reactor closes the loop.** `PanelTurnReactor` follows `engine.streamDomainEvents`.
  - When a panel run reaches a terminal status, it dispatches `panel.turn.settle` with a command id derived from the run id, so a retry is a receipt replay.
  - It owns the reply time limits (`Effect.sleep` on the Effect clock, so tests use `TestClock`).
  - It auto-answers runtime requests on panel threads.
  - At startup it settles panels left `running` by a restart.
- **The prompt is composed at turn start, never stored.** `ProviderTurnStartService` replaces the marker's empty text with the output of the pure `PanelPromptBuilder` for runs that carry `panelTurn`. The composed text exists only in the provider call. It is not in any message, event or websocket payload (AC 10).
- **Read-only and tool-less sessions.**
  - `RuntimePolicyV2.resolve` returns, for a panel thread, `approvalPolicy: "never"`, `sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }`, `runtimeMode: "approval-required"`, `interactionMode: "default"`, plus a new `panel: { role }` marker on `ProviderAdapterV2RuntimePolicy`.
  - Each eligible adapter maps `panel.role === "panelist"` to "no tools" and `panel` (either role) to "never auto-approve user MCP tools".
  - `ProviderSessionManager.prepareMcpSession` issues no T3 MCP credential for panel threads.
- **Eligibility is a capability.** `OrchestrationV2RuntimePolicyCapabilities` gains an optional `panelChat: { readOnly: "enforced" | "declined", panelistToolsRemoved: boolean }`. Absent means "not offered". The server publishes a derived `panelChat: { panelist, codeAgent, panelistToolsRemoved }` on each `ServerProvider` (`packages/contracts/src/server.ts:230`), which the setup dialog reads.
- **Panel state reaches clients** on a new thread-stream event `panel.updated`, with the whole `OrchestrationV2AppThread` as payload, plus an optional `panel` summary on `OrchestrationV2ThreadShell`. Older clients ignore the event (verified, 1.3 A2) and decode the shell's extra optional field as unknown keys.
- **Clients draw panel rows from data they already receive.**
  - A marker `user_message` item becomes the speaker line.
  - `run.panelTurn` gives round dividers, pass, failure, time-limit and lookup lines, and the conclusion divider.
  - User posts and the topic are ordinary run-less user messages, with the precedent at `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts:257-310`.

### 1.2 Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Create a panel with `thread.fork { sideChat: true }`, then configure it | A fork carries a context transfer and a pending fork handoff, and `dispatchMessage` refuses a fresh session while a fork transfer is pending (`Orchestrator.ts` "A fresh session can't start while a fork or merge is still being applied."). The panel is topic-only (requirement 6.1). It also takes two client round trips and opens a window with a half-made panel. |
| The reactor creates each next run with a public `message.dispatch` | The panel state update and the run creation would be separate transactions, and a crash between them would leave a stuck "running" panel. It would also need `message.dispatch` to stay open on panel threads, which AC 31 forbids for clients. |
| A new `panel.turn.start` command dispatched by the reactor after settle | Same two-transaction gap. A deterministic id makes it idempotent but not atomic. Settle-and-start in one decide is simpler. |
| Store the composed prompt as the run's user message | Violates AC 10 and doubles stored transcript size per turn. |
| New turn-item types for pass, round and failure lines | Requirement 2.9 forbids new turn-item types. Older clients would also drop them. |
| Resume one provider thread per participant | Rejected by requirement 2.4 (fresh sessions). |
| Carry panel state only on `thread.metadata-updated` | It works for older clients too, but requirement 2.9 names `panel.updated`, and assumption A2 holds. A dedicated event keeps panel churn out of the generic metadata path. |
| A new RPC method for panel commands | Requirement 2.8 says to reuse `dispatchCommand`, so the scopes are unchanged. |
| Every adapter decides eligibility from a provider-name table on the server | Requirement 2.5 asks for a capability, so clients and orchestration read data, not names. |

### 1.3 Verified assumptions (A1–A8) and per-adapter tool removal

| # | Result | Evidence and consequence |
|---|---|---|
| A1 | **Holds.** A `freshContext` dispatch to another provider instance builds no handoff. | `canResumeAcrossInstances = !freshContext && …` (`Orchestrator.ts:8413-8417`). The fresh branch runs when `(!isProviderSwitch \|\| freshContext)` (8443-8446) and returns at 8832, before `providerSwitchHandoff` (9158). `ProviderTurnStartService.ts:623` skips the side-chat handoff for fresh runs. Each panel turn rewrites the thread's `modelSelection` through `thread.model-selection-updated` / `thread.provider-switched` (8346-8366). That is harmless, but the client must not draw dividers for it (covered by hiding marker rows). |
| A2 | **Holds for the thread stream. False for the shell stream.** | Unknown thread-stream event types decode to `{kind:"unknown-event"}` and only advance the cursor (`orchestrationV2.ts:4329-4360`, `client-runtime/src/state/threadStream.ts:56`). A new `panel.updated` event is therefore safe. `OrchestrationV2ShellStreamItem` (2525) has no unknown member, so **no new shell item kind is added**. Panel shell state is an optional field on `OrchestrationV2ThreadShell`, and on its JSON form `OrchestrationV2ThreadShellJson` (3024). Struct decoding of unknown keys is relied on already for every optional field added to `OrchestrationV2AppThread` (for example `issues`). WP1 adds a decode test that proves an old-shape decoder accepts the new fields. |
| A3 | **Partly false. Fallback specified.** | After a restart, `ProviderRuntimeRecoveryService.reconcileProjection` (255) writes in-flight runs as `cancelled` (676-684), not `interrupted`. Unstarted runs created by the server or an agent may be **resent** (431-483). Nonterminal runs may get a **restart continuation** (`restartContinuationRun`, 990 and 1205 → `RestartContinuation.ts:237`). **Required (WP4a):** `restartContinuationBlocked` (`RestartContinuation.ts:45`) returns `true` for a thread with `thread.panel !== undefined`. The recovery resend path must cancel panel runs instead of resending them. `PanelTurnReactor.start` runs a startup sweep that settles every panel left `running` with `panel.turn.settle {trigger:{type:"recovery"}}` → idle `interrupted`. The live domain stream does not replay (`Orchestrator.ts:17265`), so the sweep, not replay, provides restart settlement. |
| A4 | **Holds for idle compaction. Titles need one explicit effect.** | `idleCompactionWindow` returns null for unlisted lineages (`IdleCompaction.ts:54`), and a panel keeps `sideChat: true`. Title regeneration stops at `lineage.sideChat` (`ThreadTitleRegenerationService.ts:135`). Panel turns are `createdBy:"agent"` with no `titleSeed`, so they never trigger initial title generation. `panel.open` itself enqueues `pendingThreadTitleGenerationEffect(commandId, threadId, {type:"initial", messageId: topicMessageId})` (`Orchestrator.ts:~733`) so the existing generator replaces the 60-character seed title. **Usage-limit auto-resume and snooze are not excluded today** (`ProjectionStore.getLimitRecoveryCandidates` 4954 has no lineage filter). WP4a excludes panel threads there, and rejects `thread.snooze` on panels. |
| A6 | **Holds** (per `docs/internals/assistant-citations.md`). The code agent's `path:LINE` references go through the normal assistant markdown renderer. No work. | — |
| A7 | **Holds.** A running side chat does not change the parent's sidebar row. Only pending runtime requests roll up (`client-runtime/src/state/threadShell.ts:142-187`). | Panels must never roll up a request: WP5a excludes threads with `shell.panel` from `sideChatRequest`. The server auto-answers requests, so this only covers the moment before the answer lands. |
| A8 | **Holds.** Empty text is accepted. | `text: Schema.String` on the command, the message (1507) and the `user_message` item (1867). The only empty check is for `queued-run.edit` (12254). The marker message therefore has `text: ""`. |

**Fork-transfer cascade (new finding).** Delete, archive and unarchive find side chats through the parent's fork context transfers (`liveSideChatIds`, `Orchestrator.ts:1912-1933`), so a panel must have one. `panel.open` builds the panel thread and its fork transfer with the same planner the side chat uses: `ThreadForkService.plan` with `sideChat: true` and `sourcePoint: {type:"latest_stable"}`, which also enforces the parent rules of AC 2 (`ThreadForkService.ts:81-94`). It then overrides the thread fields (2.1 below). The first turn is a `freshContext` dispatch, so `dispatchMessage` supersedes the pending transfer itself (`supersedesForkTransfer`, 8327; `forkTransferSupersededEvent`, 1406). No parent context is ever delivered, but the transfer record stays and keeps the cascade working.

**Per-adapter tool removal and read-only strength.** Verified in code, plus the locally installed Codex CLI 0.171.0 (`codex features list`, no model call). Each adapter declares the capability `runtimePolicy.panelChat` (WP3).

| Adapter | `readOnly` | `panelistToolsRemoved` | How (code agent / panelist) | Live-unverified risk |
|---|---|---|---|---|
| Claude (`ClaudeAdapterV2.ts`) | `enforced` | `true` | Code agent: existing read-only mapping (`tools: ["Read","Glob","Grep"]`, `dontAsk`, 3533-3595) **plus `strictMcpConfig: true`**, so the user's own MCP servers and their allow rules never load (the research found the user's `.mcp.json` and `permissions.allow` load today). Panelist: `tools: []` (the SDK documents `[]` as "disable all built-in tools", `ClaudeAgentSdkQueryTools` 672-677) plus `strictMcpConfig: true`. Both: no T3 MCP session (`claudeMcpQueryOverrides` sees none). | Low. |
| Codex (`CodexAdapterV2.ts`) | `enforced` | `true` | Both roles: `turn/start` already carries `approvalPolicy`/`sandboxPolicy` (862-971). Every user MCP server named in the `config/read` response is disabled per thread with `mcp_servers.<name>.enabled = false` (the adapter already lists stdio names, 1609-1622; extend this to every name). Panelist only: per-thread `config` overrides in `codexThreadRuntimeParams` (1624) — `features.shell_tool=false`, `features.unified_exec=false`, `features.view_image=false`, `features.multi_agent=false`, `features.image_generation=false`, `features.browser_use=false`, `features.computer_use=false`, `features.in_app_browser=false`, `features.apps=false`, `features.tool_suggest=false`, `features.skill_search=false`, `features.sleep_tool=false`, `web_search="disabled"`, `"tools.update_plan.enabled"=false`. All flag names were confirmed with `codex features list` on 0.171.0. Codex reads files only through its shell, so a turn without the shell, exec and view_image cannot read. | Medium. Overrides are only proven to be accepted by a live `thread/start`. If a live turn rejects a key, the director falls back to `panelistToolsRemoved: false` for Codex ("May read files"), which requirement 2.5 permits. Record this in the PR. |
| OpenCode 1.x (`provider-opencode/src/server/adapter.ts`) | `enforced` | `true` | Code agent: the existing never+readOnly ruleset (651-760; `*` deny covers user MCP tools). Panelist: return only the deny rules (`*` plus the restricted list) and skip the read allow-list (693-705). | Low. |
| OpenCode 2.x (`v2/adapter.ts`) | `enforced` | `true` | Widen `RulesPolicy` (402-405) to include `approvalPolicy`, `sandboxPolicy` and `panel`. Under the read-only policy add deny rules for `shell`, `edit` and `external_directory` (requirement 2.5). For panel sessions also deny MCP (`mcpRules` must not re-allow anything). Panelist: `rule("*","deny")` last. The implementer verifies the 2.x rule semantics in `sessionRules` (449-476) and states in the report which rule wins. | Medium (2.x rule precedence); covered by an adapter test. |
| Grok, Kiro, fx, Antigravity (shared `provider-acp`) | `declined` | **`false`** ("May read files") | ACP agents read files natively without asking T3, so read tools **cannot be removed** (research finding). Both roles: `acpMcpToolApprovalElicitationDisposition` (`clientPolicy.ts:204-218`) must return `"deny"` for panel sessions (today it **auto-allows** under `approvalPolicy:"never"`). Panelist: `acpOperationDisposition` denies every kind, including read, search and think, and the client fs read hook (`adapter.ts:502-511`, Antigravity's `readTextFile`) refuses. Fallback per 2.5: read-only sandbox, prompt, 2-minute limit. | None for writes. Reads are possible: disclosed by "May read files". |
| Muse (`provider-muse`) | `declined` | **`false`** ("May read files") | Muse asks T3 before writing (`promptUnmatched` / `:ask-me`, `sdk.ts:137-144`). Panel sessions: every request is declined by the adapter's request handler (both roles), including reads for panelists. Muse reads files natively; its `--disable-shell --disable-write` launch (`sdk.ts:146-165`) is per process and still allows reads, so tools are not removable. | Reads possible: disclosed. |
| Cursor, Pi, ACP Registry | — (capability absent) | — | Not offered (requirement 1.6, 2.5). No adapter change. | — |

**Known limitation (WP3a review).** Codex's two "thread not found" resume recovery paths (`CodexAdapterV2.ts`, `readThreadMcpServerOverrides(appThreadId)` without a runtime policy) do not reapply the panel overrides. A panelist resumed that way would regain the shell. The turn's read-only sandbox still applies. Every panel turn starts a fresh thread, so this needs a resume inside one turn. It is recorded for the PR.

**Consequence for the director's live UI pass.** The free `Replay (dev)` provider is an `acpRegistry` driver instance (`apps/server/src/provider/ProviderInstanceRegistryHydration.ts:89-127`). Under requirement 2.5 it cannot join a panel, so a live UI pass needs Codex, Claude or OpenCode. This is recorded as a question for the director in the final report. This plan does not change eligibility.

### 1.4 Other decisions the lead made within the requirements

1. **Turn starting is atomic with settling** (1.1).
2. **Run-less user posts.** The topic and every post are `message.updated` (`role:"user"`, `runId:null`, `nodeId:null`, `createdBy:"user"`) plus a `user_message` turn item (`runId:null`, `inputIntent:"turn_start"`, `status:"completed"`). The precedent is `LegacyV1ThreadImporter.ts:257-310`. They render as ordinary user rows and are read by `t3_thread_read`.
3. **Marker messages are the speaker lines.** The marker message and its `user_message` turn item carry `panelParticipantId`. Clients render a `user_message` item that has `panelParticipantId` as the speaker line, and never as a user bubble. Because the marker row is replaced, the "New session" and model-switch dividers attached to it (`TimelineUserMessageRow.tsx:267-279`) disappear with it (AC 38).
4. **Outcome storage.** `run.panelTurn.outcome` (plus `outcomeDetail` and `lookup`) is written by `panel.turn.settle` with a `run.updated` built from the **current** projected run. Like `run.output` (`client-runtime/src/state/orchestrationV2Projection.ts` `run.updated` case), the server projection and the client reducer keep a known `panelTurn.outcome` when a later `run.updated` lacks it.
5. **Unavailable participants.** A disabled, uninstalled or signed-out instance, or a model missing from its catalog, still has an adapter (`ProviderAdapterRegistry.getMetadata` exposes `enabled`). The run is therefore created, and `ProviderTurnStartService` fails it before opening a session. It uses `settleRunBeforeStart` with failure `{class:"provider_error", code:"panel_participant_unavailable", message:<reason>}`, and settle classifies that as `unavailable`. If the instance was **removed from settings** (no adapter at all), `dispatchMessage` cannot create a run. The decide then skips the turn as `unavailable` without a run, so no line is drawn. This known gap is recorded in the PR.
6. **Classification** (in `PanelScheduler.classifyTurn`, using the run, its error turn item via `latestRootProviderFailure` from `packages/shared/src/orchestrationV2ThreadError.ts:14`, and the assistant text):
   - `panel.current.timedOut === true` → `timed_out`.
   - status `completed`: joined assistant text matches `isPanelPass` → `passed`. Empty text → `failed` (no detail). Otherwise `replied`. For a `conclusion` turn, `passed` counts as no text.
   - `failed` with failure class `usage_limit` → `limited`. With code `panel_participant_unavailable` → `unavailable`. Otherwise `failed` (detail = failure message).
   - `interrupted`, `cancelled` or `rolled_back` → `stopped`. The panel was already set idle `stopped` by the Stop, archive or recovery path that caused it; recovery sets `interrupted` itself.
7. **Settle triggers only on terminal run statuses** (`completed`, `failed`, `cancelled`, `interrupted`, `rolled_back`; `isTerminalRunStatus`, `ThreadManagementService.ts:580`). A finished turn first passes through `waiting` before checkpoint capture moves it to `completed` (`RunExecutionService.ts:849-857`). Side-chat-class threads skip the capture work but still reach `completed`.
8a. **Settling a turn after Stop or archive.** The panel is already idle, but `panel.current` still names the run. `settleTurn` therefore records the outcome. For a panelist `reply` turn it **moves `cursor` to that participant**: a cut-off reply counts as spoken and is not redone (requirement 2.3, "Continue"). It then clears `current` and starts nothing. Settling an idle panel never changes `status`, `idleReason`, `queue` or `pendingPost`.
8b. **Pending director decision (requirement §2.3 step 4 vs AC 53).** The case: an open run in which an earlier round had replies and a later round had no replies and was not unanimous. This plan implements §2.3 literally: idle `no_replies`, no conclusion. The behavior is isolated in one branch of `settleTurn` (`endOfRoundWithoutReplies`) so it can be flipped to "queue the conclusion when `run.roundsCompleted > 0`".
8. **Stop** is `thread.stop` on the panel thread. In `dispatchThreadStop` (`Orchestrator.ts:14333`), a thread with `panel.status === "running"` additionally emits `panel.updated` with `status:"idle"`, `idleReason:"stopped"`, `queue:[]` and `pendingPost:null`. `current` stays until the run ends, so settle can record its outcome. Archive of a panel thread does the same before detaching its sessions, so unarchive restores the panel idle with `stopped` (requirement 2.10).
9. **Time limit.** The reactor, at the start of a panel run (`run.updated` with `startedAt` set and a nonterminal status), schedules `Effect.sleep(limit)`: 2 min for `reply`/`conclusion`, 5 min for `lookup`. The sleep is keyed by run id and interrupted when the run ends. On expiry it dispatches `panel.turn.settle {trigger:{type:"time_limit", runId}}`. That decide sets `current.timedOut = true` and calls `dispatchRunInterrupt` with reason `"Panel reply time limit"` (no `holdQueue`). The run's terminal event then settles it as `timed_out`, and the panel moves on.
10. **Command ids.**
    - The settle id for a run ending is `panel:<threadId>:settle:<runId>`; for a time limit, `panel:<threadId>:time-limit:<runId>`; for recovery, `panel:<threadId>:recovery:<turnCount>`.
    - The synthesized marker dispatch inside a decide uses message id `message:panel:<threadId>:turn:<turnCount>`.
    - Run ids come from the existing deterministic allocator.
12. **Where refusals live (WP4a review).** Client-supplied `creationSource` is not trusted: `ws.ts` keeps it, and the fork schemas accept `"server"`. The step-9 refusals are therefore enforced in `ThreadManagementService.dispatch` (`ThreadManagementService.ts:843`), which every client and MCP dispatch passes through, for every listed command whose thread (or fork source or target) is a panel. Server code that calls `OrchestratorV2.dispatch` directly (reactors, panel decides) bypasses it. In addition, the Orchestrator's public `case "message.dispatch"` refuses panel threads unconditionally.
13. **No provider-switch planning for panel turns (WP4a review).** `dispatchMessage` with the internal `panel` argument skips `providerSwitchService.plan` (`ProviderSwitchService.ts:152` rejects disabled targets before a run exists). A panel turn is always a fresh session with no native context to transition. Every live provider session of the panel thread is released as `sessionsReleasedByFreshContext` releases them: the panel's previous provider session(s) are detached unless still running background work, which a panel never has. The run is then created even for a disabled instance, and WP4b's turn-start check fails it as `unavailable`. If `providerAdapters.get` fails (instance removed), the 1.4 item 5 no-run skip applies.
14. **Error type names (WP4a review).** The orchestrator dispatch error type is `OrchestratorV2Error` (`Orchestrator.ts:432`). `userFacingDispatchErrorMessage` already forwards non-generic messages, so `PanelChatError` needs no allowlist entry. The test only asserts that the message reaches `OrchestrationV2DispatchCommandError.detail`.
11. **Unknown-adapter safety.** Panel decide paths never call `refuseNativeSubagentMessage`. Clients' `message.dispatch` on a panel thread is refused in the orchestrator switch (`case "message.dispatch"`) when `thread.panel !== undefined`, with `OrchestratorDispatchError` cause `"Update the app to post in a panel chat."`. The server's own panel turns call `dispatchMessage` directly and so bypass that case.

---

## 2. Implementation boundaries

### 2.1 Data contracts (`packages/contracts`)

All new fields are optional, so stored events and older peers decode (requirement 3.1 fact 13). The exact shapes follow.

In `packages/contracts/src/orchestrationV2.ts`:

```ts
export const OrchestrationV2PanelRole = Schema.Literals(["panelist", "code_agent"]);
export const OrchestrationV2PanelTurnKind = Schema.Literals(["reply", "lookup", "conclusion"]);
export const OrchestrationV2PanelTurnOutcome = Schema.Literals([
  "replied", "passed", "failed", "limited", "unavailable", "timed_out", "stopped", "interrupted",
]);
export const OrchestrationV2PanelIdleReason = Schema.Literals([
  "concluded", "agreed", "rounds_done", "answered", "stopped", "interrupted", "no_replies",
]);
// Participant ids are "p1".."p5" for panelists in roster order and "code" for the code agent.
// "user" is never a participant id, so `askedBy: "user"` is unambiguous.
export const OrchestrationV2PanelParticipant = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: OrchestrationV2PanelRole,
  handle: TrimmedNonEmptyString,          // without "@": "opus-4-5", "code"
  name: TrimmedNonEmptyString,            // display name, disambiguated (requirement 2.4)
  driver: ProviderDriverKind,             // icon and color on clients
  modelSelection: ModelSelection,
  toolsRemoved: Schema.Boolean,           // false → "May read files"; always true for the code agent
});
export const OrchestrationV2PanelRequestRef = Schema.Union([
  Schema.Struct({ type: Schema.Literal("run"), runId: RunId }),          // a panelist reply asked
  Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }), // a user post asked
]);
export const OrchestrationV2PanelQueuedTurn = Schema.Struct({
  participantId: TrimmedNonEmptyString,
  kind: OrchestrationV2PanelTurnKind,
  round: NonNegativeInt,                  // 0 for addressed turns
  askedBy: Schema.optional(TrimmedNonEmptyString), // "user" or a participant id
  request: Schema.optional(OrchestrationV2PanelRequestRef), // lookups and addressed turns
});
export const OrchestrationV2PanelRunOfRounds = Schema.Struct({
  mode: Schema.Literals(["open", "addressed"]),
  totalRounds: NonNegativeInt,            // open: the cap; addressed: 0
  round: NonNegativeInt,                  // 1-based current round; 0 when addressed
  roundReplied: Schema.Boolean,
  roundAllPassed: Schema.Boolean,
  agreed: Schema.Boolean,
  roundsCompleted: NonNegativeInt,        // for "Concluded after N rounds" / "Paused after N rounds"
});
export const OrchestrationV2PanelCurrentTurn = Schema.Struct({
  runId: RunId,
  participantId: TrimmedNonEmptyString,
  kind: OrchestrationV2PanelTurnKind,
  round: NonNegativeInt,
  timedOut: Schema.Boolean,
});
export const OrchestrationV2PanelState = Schema.Struct({
  participants: Schema.Array(OrchestrationV2PanelParticipant), // panelists in order, code agent last
  rounds: PositiveInt,                    // 1..5, checked by `panel.open`
  status: Schema.Literals(["running", "idle"]),
  idleReason: Schema.NullOr(OrchestrationV2PanelIdleReason),
  run: Schema.NullOr(OrchestrationV2PanelRunOfRounds), // kept after going idle
  queue: Schema.Array(OrchestrationV2PanelQueuedTurn),
  current: Schema.NullOr(OrchestrationV2PanelCurrentTurn),
  pendingPost: Schema.NullOr(Schema.Struct({
    messageId: MessageId,
    mentionedParticipantIds: Schema.Array(TrimmedNonEmptyString),
  })),
  cursor: Schema.NullOr(TrimmedNonEmptyString), // last panelist who spoke in a reply turn
  lookupsThisRound: NonNegativeInt,
  turnCount: NonNegativeInt,              // turns started so far; seeds deterministic ids
});
export const OrchestrationV2PanelTurn = Schema.Struct({
  participantId: TrimmedNonEmptyString,
  kind: OrchestrationV2PanelTurnKind,
  round: NonNegativeInt,
  totalRounds: NonNegativeInt,
  askedBy: Schema.optional(TrimmedNonEmptyString),
  outcome: Schema.optional(OrchestrationV2PanelTurnOutcome),
  outcomeDetail: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  lookup: Schema.optional(Schema.Literals(["requested", "limit_reached"])),
});
export const OrchestrationV2PanelShellSummary = Schema.Struct({
  status: Schema.Literals(["running", "idle"]),
  idleReason: Schema.NullOr(OrchestrationV2PanelIdleReason),
});
```

Field additions:

- `OrchestrationV2AppThread.panel: Schema.optional(OrchestrationV2PanelState)`
- `OrchestrationV2Run.panelTurn: Schema.optional(OrchestrationV2PanelTurn)`
- `OrchestrationV2ConversationMessage.panelParticipantId: Schema.optional(TrimmedNonEmptyString)`
- The `user_message` member of `OrchestrationV2TurnItem` **and** of `OrchestrationV2TurnItemJson` (1858 and 2755): `panelParticipantId: Schema.optional(TrimmedNonEmptyString)`
- `OrchestrationV2ThreadShell.panel` **and** `OrchestrationV2ThreadShellJson.panel`: `Schema.optional(OrchestrationV2PanelShellSummary)`
- `OrchestrationV2RuntimePolicyCapabilities.panelChat: Schema.optional(Schema.Struct({ readOnly: Schema.Literals(["enforced","declined"]), panelistToolsRemoved: Schema.Boolean }))`
- Domain event: add `"panel.updated"` to the literal list of thread events whose payload is `OrchestrationV2AppThread` (2131-2158), in both `OrchestrationV2DomainEvent` and `OrchestrationV2DomainEventJson`, and to `knownDomainEventTypes` if that set is maintained by hand.

Commands, client-dispatchable (`OrchestrationV2Command`):

```ts
Schema.Struct({
  type: Schema.Literal("panel.create"),
  ...OrchestrationV2CreationFields,
  commandId: CommandId,
  parentThreadId: ThreadId,
  threadId: ThreadId,                     // the new panel thread
  participants: Schema.Array(Schema.Struct({ role: OrchestrationV2PanelRole, modelSelection: ModelSelection })),
  rounds: PositiveInt,
  topicMessageId: MessageId,
  topic: Schema.String,
  createdAt: Schema.optional(Schema.DateTimeUtc),
}),
Schema.Struct({ type: Schema.Literal("panel.post"), commandId: CommandId, threadId: ThreadId, messageId: MessageId, text: Schema.String }),
Schema.Struct({ type: Schema.Literal("panel.continue"), commandId: CommandId, threadId: ThreadId }),
```

Commands, internal (`OrchestrationV2InternalCommand`):

```ts
Schema.Struct({
  type: Schema.Literal("panel.open"),     // issued only by PanelChatService.create, same commandId as panel.create
  ...OrchestrationV2CreationFields,
  commandId: CommandId,
  parentThreadId: ThreadId,
  threadId: ThreadId,
  participants: Schema.Array(OrchestrationV2PanelParticipant),
  rounds: PositiveInt,
  topicMessageId: MessageId,
  topic: Schema.String,
  createdAt: Schema.optional(Schema.DateTimeUtc),
}),
Schema.Struct({
  type: Schema.Literal("panel.turn.settle"),
  commandId: CommandId,
  threadId: ThreadId,
  trigger: Schema.Union([
    Schema.Struct({ type: Schema.Literal("run_ended"), runId: RunId }),
    Schema.Struct({ type: Schema.Literal("time_limit"), runId: RunId }),
    Schema.Struct({ type: Schema.Literal("recovery") }),
  ]),
}),
```

In `packages/contracts/src/environment.ts`: `panelChats: Schema.optionalKey(Schema.Boolean)` beside `sideChats` (101).

In `packages/contracts/src/server.ts`, on `ServerProvider` (230): `panelChat: Schema.optional(Schema.Struct({ panelist: Schema.Boolean, codeAgent: Schema.Boolean, panelistToolsRemoved: Schema.Boolean }))`. Absent means not offered. `ServerProviderDelta` inherits it.

In `packages/provider-core/src/server/ProviderAdapter.ts`, on `ProviderAdapterV2RuntimePolicy` (64): `panel: Schema.optional(Schema.Struct({ role: Schema.Literals(["panelist","code_agent"]) }))`. Set only for panel turns.

### 2.2 Shared pure helpers (`packages/shared/src/panelChat.ts`, new subpath export `./panelChat`)

Named constants (requirement: every pilot number is one named constant):

```ts
export const PANEL_MIN_PANELISTS = 2;
export const PANEL_MAX_PANELISTS = 5;
export const PANEL_MIN_ROUNDS = 1;
export const PANEL_MAX_ROUNDS = 5;
export const PANEL_DEFAULT_ROUNDS = 2;
export const PANEL_TEXT_MAX_CHARS = 8_000;            // topic and posts
export const PANEL_TRANSCRIPT_MAX_CHARS = 16_000;
export const PANEL_TRANSCRIPT_MESSAGE_MAX_CHARS = 3_000;
export const PANEL_TOPIC_PROMPT_MAX_CHARS = 8_000;
export const PANEL_LOOKUPS_PER_ROUND = 2;
export const PANEL_PANELIST_REPLY_LIMIT_MS = 120_000;
export const PANEL_CODE_AGENT_REPLY_LIMIT_MS = 300_000;
export const PANEL_REPLY_WORD_LIMIT = 150;
export const PANEL_CODE_AGENT_WORD_LIMIT = 200;
export const PANEL_CODE_AGENT_QUOTE_LINES = 3;
export const PANEL_HANDLE_MAX_CHARS = 16;
export const PANEL_CODE_HANDLE = "code";
export const PANEL_TITLE_SEED_CHARS = 60;
```

Functions (all pure, each with unit tests in `packages/shared/src/panelChat.test.ts`):

- `derivePanelHandle(source: string, taken: ReadonlySet<string>): string`: lower case; letters and digits kept; every other run collapsed to `-`; leading and trailing `-` trimmed; at most 16 characters (trimmed again after cutting); `code` is reserved; `-2`, `-3`… is appended when taken, staying within 16 characters by trimming the base. An empty result falls back to `model`.
- `isPanelPass(text: string): boolean`: trimmed text matches `/^pass\.?$/i`.
- `panelMentionedParticipantIds(text, participants): string[]`: tokens `@handle` at the start of the text or after whitespace, ending at whitespace, end of text or one of `.,:;!?)`, compared case-insensitively. Unknown handles are ignored. The result is ordered with the code agent first (if mentioned), then panelists in roster order, without duplicates.
- `panelCodeCallouts(text): string[]`: lines outside fenced code blocks (``` or ~~~ fences) whose first token, after leading whitespace, is exactly `@code` (case-insensitive) followed by whitespace, `:` or end of line. It returns those lines trimmed. An empty array means no call-out.
- `panelReplyBudget(panelists: number, rounds: number): number` = `panelists * rounds + 1`.
- `panelTitleSeed(topic: string): string`: whitespace collapsed, first 60 characters, trimmed; falls back to `"Panel chat"` only when empty, which validation already prevents.

In `packages/shared/src/composerTrigger.ts`: add `parsePanelCommand(text): { topic: string } | null` matching `/^\/panel(?:\s+([\s\S]*))?$/i` (the `/side` pattern at 153-157). The result's topic is trimmed.

### 2.3 Server (`apps/server`)

New files:

- `apps/server/src/orchestration-v2/panel/PanelScheduler.ts`: pure scheduler (WP2).
- `apps/server/src/orchestration-v2/panel/PanelTranscript.ts`: pure transcript extraction from a projection (WP2).
- `apps/server/src/orchestration-v2/panel/PanelPromptBuilder.ts`: pure prompt builder (WP2).
- `apps/server/src/orchestration-v2/panel/PanelChatService.ts`: the `create` / `post` / `continue` service (WP4a).
- `apps/server/src/orchestration-v2/panel/PanelTurnReactor.ts`: the reactor (WP4b).
- Tests beside each.

Changed files and what may change:

- `Orchestrator.ts`
  - Decide cases for `panel.create` (refuse: "Panel chats are created through PanelChatService."), `panel.open`, `panel.post`, `panel.continue` and `panel.turn.settle`; `commandThreadId` cases (`panel.open` and `panel.create` → `threadId`).
  - A `startPanelTurn` helper that calls `dispatchMessage` with an internal extra argument.
  - `dispatchThreadStop` and archive panel handling.
  - Refusals on panel threads.
  - Locks in `dispatchWithReceipt`: `panel.open` also takes the parent's lock, like a fork.
- `ProjectionStore.ts`: the `panel.updated` projection (same as other AppThread-payload events), shell `panel` summary in `shellFromState` (2238), keeping `panelTurn.outcome` on `run.updated`, and excluding panels from `getLimitRecoveryCandidates`.
- `AgentAwarenessRelay.ts` (exhaustive event switch) and `testkit/OrchestratorScenario.ts` (exhaustive command switch): add the cases.
- `ThreadMessageIntake.ts`: route `panel.create` / `panel.post` / `panel.continue` to `PanelChatService`.
- `ThreadManagementService.ts` (`assertDispatchTargetEnabled`): no target check for panel commands. `PanelChatService` checks eligibility itself.
- `ws.ts`: the span annotation (`panel.create` → `threadId`) and `commandFeatureUsage` if it is exhaustive.
- `RuntimePolicy.ts`: the panel branch in `layerFromProjectStore.resolve`, and in `layer` for tests; a new optional input `panelTurnKind`.
- `ProviderSessionManager.ts`: `prepareMcpSession` issues no credential for a thread with `panel` (586-668).
- `ProviderTurnStartService.ts`: the composed prompt for panel runs, the availability pre-check, and passing `panelTurnKind` to `resolve`.
- `RestartContinuation.ts`, `ProviderRuntimeRecoveryService.ts`: no continuation or resend for panel runs; unstarted panel runs are cancelled.
- `UsageLimitRecoveryWorker.ts` / ProjectionStore candidates: exclude panels.
- `apps/server/src/environment/ServerEnvironment.ts`: `panelChats: true`.
- Provider snapshot publication: fill `ServerProvider.panelChat` from the instance's adapter capability where `ServerProvider` is assembled (`packages/provider-core/src/server/snapshotProbe.ts:290-334` `buildServerProvider`, or the server-side registry that merges snapshots; the implementer picks the single place every snapshot passes through and names it in the report).
- `apps/server/src/mcp/OrchestratorMcpService.ts`: `readThread` labels panel speakers (2.6).
- `apps/server/src/server.ts`: provide and start `PanelChatService` and `PanelTurnReactor` beside `DelegatedTaskQuestionReactor` (739-755).
- `apps/server/src/mcp/OrchestratorMcpService.ts`: export `providerConstraints`, or move it with `requireAdvertisedModel` into a small shared module, for `PanelChatService` eligibility.

Adapter files (WP3a and WP3b): listed per package below.

### 2.4 Clients

- `packages/client-runtime`:
  - commands `createPanelChat`, `postToPanel`, `continuePanel` in `src/operations/commands.ts`, exposed on `threadEnvironment` (`src/state/threadCommands.ts`);
  - the projection reducer case `panel.updated` and `panelTurn.outcome` preservation (`src/state/orchestrationV2Projection.ts`);
  - `sideChatsAtom` excludes panels, and a new `panelChatsAtom`, in `src/state/threadShell.ts`;
  - `sideChatRequest` excludes panels;
  - `sideThreadKindOf` gains `"panel"` (`src/sideThread.ts`);
  - `matchComposerThreadItems` gives the description "Panel chat";
  - new `src/panelChat.ts` (+ test) with pure presentation logic shared by web and mobile (3, WP5a).
- `apps/web`: new `components/chat/PanelSetupDialog.tsx`, `PanelThreadPane.tsx` (or a panel branch inside `SideThreadPane.tsx`), `PanelSpeakerRow.tsx`, `PanelStatusBar.tsx`, `PanelComposer` mode, timeline row kinds, entry points, details section and i18n.
- `apps/mobile`: `ThreadPanelChatsRow.tsx`, transcript rows in `ThreadFeed.tsx` / `threadActivity.ts`, the control bar in `ThreadDetailScreen.tsx`, and i18n.

### 2.5 Behavior that must be preserved (requirement 3.2)

Side chats (`/side`, `/btw`, fork, context inheritance, tab, unused deletion, Add to chat, details section, mobile row) stay unchanged. So do subagents and delegated tasks, thread lists, search and sidebar, ordinary `message.dispatch`, queueing, steering, provider switching, checkpoints, `CLIENT_GUARDED_RPC_SCOPES`, existing strings and the `sideChats` capability. Every server change is gated on `thread.panel !== undefined` or `run.panelTurn !== undefined`. Existing orchestration tests must pass untouched (AC 49).

### 2.6 `t3_thread_read` labelling (model-facing text)

In `OrchestratorMcpService.timelineItem` (1204), for a thread with `panel`:

- Drop `user_message` items with `panelParticipantId` (markers).
- Prefix the text of each assistant item whose run has `panelTurn` with `[<name> (@<handle>)] `, where the code agent's name is `Code agent`.

The contract `OrchestratorMcpThreadTimelineItem` does not change. This is model-facing text: evals (`evals/README.md`, `mcp-tool-use`) need paid model calls, which this task may not make. The implementer adds no eval, and the lead reports this as unverified for the director to decide.

---

## 3. Work packages

Common rules for every implementer, repeated in each brief:

- Read `E:\t3code\AGENTS.md`, `E:\t3code-specs\panel-chat.md` (requirements) and this file.
- Work in `E:\t3code` on `feat/panel-chat`. Do not commit, push, or start delegates.
- Never start a dev server. Never touch `~/.t3`. Never kill processes by name. Never set `VITE_HTTP_URL` / `VITE_WS_URL`. Never make a paid provider call.
- Tests follow AGENTS.md: `it.effect` with `TestClock`, drain the worker, no sleeps, polling or timeouts.
- Use `Effect.fn("Service.operation")` for service functions.
- Write no comments except for constraints (a four-line cap).
- `components/ui` is never restyled.
- Report the changed files and the actual output of every check you ran. Raise ambiguities instead of inventing.

### WP1: Contracts and shared helpers

- **Requirements:** foundations for every AC; directly 5 (validation constants), 15 and 21 (mention and call-out parsing), 26 (capability shape), 57 (constants), 58 (reply budget).
- **Depends on:** nothing.
- **Files:**
  - `packages/contracts/src/orchestrationV2.ts`, `environment.ts`, `server.ts`;
  - `packages/contracts/src/orchestrationV2.test.ts` (extend);
  - `packages/provider-core/src/server/ProviderAdapter.ts`;
  - `packages/shared/src/panelChat.ts` (new), `panelChat.test.ts` (new), `composerTrigger.ts`, plus its test if one exists, and `packages/shared/package.json` (subpath export `./panelChat`, same shape as the others).
- **Steps:**
  1. Add every schema and field of 2.1 **except** the new command union members and the `panel.updated` event literal, which WP4a adds with their handlers so typecheck stays green.
  2. Add `panelChats` and `ServerProvider.panelChat`.
  3. Add `ProviderAdapterV2RuntimePolicy.panel`.
  4. Add the 2.2 helpers and `parsePanelCommand`.
  5. Tests:
     - contracts decode tests (an AppThread, Run, shell and message without the new fields still decode; with them they round-trip; a shell JSON with an unknown extra key decodes);
     - helper tests (handles: collapse, 16-character cap, numbering, `code` reserved; PASS variants `PASS`, `pass.`, ` Pass ` true and `PASS!`, `I pass` false; mentions: order, unknown handles, punctuation, case; call-outs: line start, indented, inside a sentence → none, inside ``` and ~~~ fences → none; reply budget 3×2 → 7; `/panel` and `/panel topic text` parsing).
- **Must not:** touch server or client code beyond what typecheck forces, or change existing fields.
- **Done checks** (from `E:\t3code`, vp env active):
  - `vp test run packages/shared/src/panelChat.test.ts packages/contracts/src/orchestrationV2.test.ts`
  - `vp run typecheck` (it caches per package; affected packages must pass)
  - `vp run check:changed`

### WP2: Pure server core (scheduler, transcript, prompt builder)

- **Requirements:** 9, 11–15, 17, 19–25 (logic), 53, 54, 57.
- **Depends on:** WP1. It may run **in parallel with WP3a and WP3b** (disjoint files).
- **Files (new only):** `apps/server/src/orchestration-v2/panel/PanelScheduler.ts`, `PanelTranscript.ts`, `PanelPromptBuilder.ts` and their `*.test.ts`.
- **Interfaces:**

```ts
// PanelScheduler.ts — no Effect, no I/O.
export type PanelSettledTurn = {
  readonly participantId: string;
  readonly kind: OrchestrationV2PanelTurnKind;
  readonly outcome: OrchestrationV2PanelTurnOutcome;
  readonly codeCallout: boolean;          // replied panelist reply with ≥1 @code line (computed by caller)
};
export type PanelDecision = {
  readonly state: OrchestrationV2PanelState;   // next state (status/idleReason/queue/cursor/... updated)
  readonly next: OrchestrationV2PanelQueuedTurn | null; // turn to start now (already removed from queue)
  readonly lookup?: "requested" | "limit_reached";      // to record on the settled run
};
export function openRunOfRounds(state: OrchestrationV2PanelState): PanelDecision;
// Start / Continue / unaddressed post: `rounds` rounds from the panelist after `cursor` (slot 1 if null), then conclusion.
export function addressedRun(state: OrchestrationV2PanelState, mentionedIds: ReadonlyArray<string>, request: OrchestrationV2PanelRequestRef): PanelDecision;
// @code first (askedBy "user", does not count against lookups), then mentioned panelists in roster order; no conclusion.
export function recordPost(state: OrchestrationV2PanelState, post: { messageId: MessageId; mentionedParticipantIds: ReadonlyArray<string> }): PanelDecision;
// idle → starts the run (open or addressed) immediately; running → stores pendingPost (last wins), next: null.
export function settleTurn(state: OrchestrationV2PanelState, settled: PanelSettledTurn, settledRunId: RunId): PanelDecision;
// Requirement 2.3 steps 1-6 exactly, in order. `stopped` outcome: queue cleared, idle "stopped" (no-op if already idle).
export function recover(state: OrchestrationV2PanelState): OrchestrationV2PanelState;
// running → idle "interrupted", queue/current/pendingPost cleared; idle → unchanged.
export function classifyTurn(input: {
  readonly kind: OrchestrationV2PanelTurnKind;
  readonly runStatus: OrchestrationV2RunStatus;
  readonly timedOut: boolean;
  readonly assistantText: string;
  readonly failure: { readonly class: OrchestrationV2ProviderFailureClass; readonly code: string | null; readonly message: string } | null;
}): { readonly outcome: OrchestrationV2PanelTurnOutcome; readonly detail?: string };
```

  Scheduler rules to encode, from requirement 2.3 and 1.4 above:
  - Round bookkeeping lives in `state.run`.
  - `cursor` moves only on settled `reply` turns of panelists, whatever their outcome (the turn was "spoken").
  - A conclusion turn never moves `cursor`.
  - A code `lookup` is queued at the front with `round` equal to the asking turn's round, `askedBy` the asker, and `request {type:"run", runId}`. At most one per reply. `lookupsThisRound < PANEL_LOOKUPS_PER_ROUND`, else `lookup:"limit_reached"`. Never for `conclusion` turns or when there is no code agent.
  - At the end of a round (the last panelist reply of that round settled), `lookupsThisRound` resets to 0, then:
    - no panelist replied and all passed → `agreed = true`, the remaining reply turns of the queue are dropped, and the conclusion is queued;
    - no panelist replied and not all passed → idle `no_replies`, queue cleared;
    - otherwise `roundsCompleted += 1` and the next round's first turn follows.
  - When an open run has no panelist reply turns left, one `conclusion` turn for roster slot 1 is queued (once per run).
  - Conclusion settled: `replied` → idle `agreed` if `run.agreed` else `concluded`; anything else → idle `rounds_done`.
  - Addressed run with an empty queue → idle `answered`. An addressed run counts as one round for the lookup limit (`lookupsThisRound` resets when it starts).
  - Pending post (step 3) replaces the queue after the settle, before end-of-round processing. A post with mentions → `addressedRun`; without → `openRunOfRounds`.
  - Stop → no further turn.

  ```ts
  // PanelTranscript.ts
  export type PanelTranscriptEntry =
    | { readonly type: "message"; readonly from: string /* "user" | "@handle" */; readonly text: string; readonly cutOff: boolean }
    | { readonly type: "note"; readonly text: string /* e.g. "@sol passed", "@code was not called: 2 lookups already used this round", "@sol could not reply", "@sol was stopped after 2 minutes" */ };
  export function panelTranscript(input: {
    readonly panel: OrchestrationV2PanelState;
    readonly topicMessageId: MessageId;     // first user message of the panel
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly beforeRunId: RunId | null;     // entries strictly before this run (the turn being prompted)
  }): { readonly topic: string; readonly entries: ReadonlyArray<PanelTranscriptEntry> };
  ```

  Transcript rules:
  - Ordering is by message `createdAt`, then by turn order.
  - User posts become `from:"user"`.
  - A participant's entry is all `role:"assistant"` messages of its run joined by blank lines.
  - Passed, failed, limited, unavailable, timed-out and lookup-limit outcomes become one note each (timed-out keeps the partial text as a message with `cutOff:true`, then its note).
  - Stopped and interrupted runs keep their partial text with `cutOff:true`.
  - Marker messages are excluded.

  ```ts
  // PanelPromptBuilder.ts
  export function buildPanelPrompt(input: {
    readonly panel: OrchestrationV2PanelState;
    readonly participant: OrchestrationV2PanelParticipant;
    readonly turn: OrchestrationV2PanelTurn;          // kind, round, totalRounds, askedBy
    readonly topic: string;
    readonly entries: ReadonlyArray<PanelTranscriptEntry>;
    readonly requests?: ReadonlyArray<{ readonly from: string; readonly text: string }>; // lookup turns
  }): string;
  ```

  Builder rules:
  - Reproduce the three prompts of requirement 2.4 **verbatim**: panelist, conclusion and code agent, including the bracketed conditional lines, the final-round suffix, and the addressed last line "The user addressed you directly in their latest message. Answer it."
  - Without a code agent, omit both `@code` lines (AC 25).
  - "{other handle}" in the instructions is the first other panelist's handle.
  - The transcript block:
    - the topic as the first `<message from="user">`, capped at `PANEL_TOPIC_PROMPT_MAX_CHARS`;
    - then the newest entries that fit `PANEL_TRANSCRIPT_MAX_CHARS` in total, each message capped at `PANEL_TRANSCRIPT_MESSAGE_MAX_CHARS` with the middle replaced by `[…trimmed…]`;
    - older entries replaced by one `[N earlier messages omitted]` line, placed where they were;
    - ` [cut off]` appended to cut-off messages;
    - notes rendered as `[note]` lines;
    - every literal `</message>` in a body (case-insensitive) neutralized as `<\/message>`;
    - attribute values are handles or `user` only.
  - Lookup requests: the asking reply's `@code` lines (via `panelCodeCallouts`), or the user's post text.
  - The output is English, with no locale.
- **Tests:**
  - **scheduler:** AC 9 order (3 panelists × 2 → 1,2,3,1,2,3, conclusion by p1, `concluded`, `roundsCompleted 2`); conclusion failure → `rounds_done`; all-pass round 1 → conclusion then `agreed`; mixed fail/no reply → `no_replies`; Continue after cursor p2 starts at p3; conclusion does not move cursor; post while running last-wins and replaces the queue after the current turn; addressed post `@a @b` → exactly those two, roster order, then `answered`; `@code` user post → lookup askedBy user, not counted; panelist `@code` → lookup next, `askedBy`, counter; third request → `limit_reached`; reset next round; code agent reply never queues; conclusion with `@code` → no lookup; stop → idle `stopped`; recover.
  - **transcript:** ordering, joining, notes, cut-off.
  - **prompt builder:** each prompt shape (snapshot-free: assert key lines with `toContain`), 150-word line, PASS line, round line, final-round suffix, no `@code` without a code agent, conclusion form, code agent 200 words and 3 lines, window limits and `[N earlier messages omitted]`, per-message trim marker, topic cap, `</message>` neutralization, the composed prompt names the participant itself (AC 10, 54, 57).
- **Must not:** import services or touch `Orchestrator.ts`.
- **Done checks:**
  - `vp test run apps/server/src/orchestration-v2/panel`
  - `vp run typecheck`
  - `vp run check:changed`

### WP3a: Claude and Codex adapters

- **Requirements:** 26, 27, 29 (adapter side), 55, 56 (capability).
- **Depends on:** WP1. Parallel with WP2 and WP3b.
- **Files:** `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `CodexAdapterV2.ts`, and their existing test files (extend the nearest existing policy tests).
- **Steps:**
  1. Declare `capabilities.runtimePolicy.panelChat` (Claude 663, Codex 389): `{ readOnly: "enforced", panelistToolsRemoved: true }`.
  2. Claude: in `claudeRuntimeQueryPolicyForRuntimePolicy` (3551), when `runtimePolicy.panel` is set, add `strictMcpConfig: true` (add the field to `ClaudeRuntimeQueryPolicy`, `makeClaudeQueryOptions` and `claudeRuntimeQueryPolicyKey`), and for `role: "panelist"` set `tools: []` and no `allowedTools`.
  3. Codex: in `codexThreadRuntimeParams` (1624):
     - with `runtimePolicy.panel` set, disable every user MCP server (names from the `config/read` response the adapter already fetches; extend `codexStdioMcpServerNames` or add a sibling that returns every server name) with `mcp_servers.<name>.enabled: false`;
     - for `role:"panelist"`, merge the override map listed in 1.3, as one exported constant `CODEX_PANELIST_TOOL_OVERRIDES`.
     - Confirm the T3 MCP server is already absent when there is no `mcpSession` (1636-1643).
- **Tests:**
  - Claude: policy → query options for panelist (`tools: []`, `strictMcpConfig: true`, `permissionMode` `dontAsk`) and code agent (`tools` = read-only list, `strictMcpConfig`).
  - Codex: thread params for a panelist include every override and the MCP disables; code agent gets only the MCP disables; a non-panel policy is unchanged (regression).
  - AC 27: the existing read-only policy tests cover write and shell refusal; add assertions only if missing.
- **Must not:** change behavior for non-panel policies, or touch other adapters.
- **Done checks:**
  - `vp test run <the two adapter test files touched>`
  - `vp run typecheck`
  - `vp run check:changed`

### WP3b: OpenCode, ACP family and Muse adapters

- **Requirements:** 26, 27, 28, 55, 56 (capability).
- **Depends on:** WP1. Parallel with WP2 and WP3a.
- **Files:**
  - `packages/provider-opencode/src/server/adapter.ts`, `v2/adapter.ts`;
  - `packages/provider-acp/src/server/clientPolicy.ts`, `adapter.ts`;
  - flavor overrides `packages/provider-grok/src/server/adapter.ts`, `provider-kiro/src/server/acpSupport.ts`, `provider-fx/src/server/acpSupport.ts`, `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`;
  - `packages/provider-muse/src/server/adapter.ts`;
  - their tests.
- **Steps:**
  1. Capabilities:
     - OpenCode 1.x and 2.x: `{ readOnly:"enforced", panelistToolsRemoved:true }`.
     - The shared ACP adapter declares **no** panelChat by default, and each eligible flavor (Grok, Kiro, fx, Antigravity) declares `{ readOnly:"declined", panelistToolsRemoved:false }` through a flavor-level capability override (add one if none exists), so ACP Registry stays ineligible.
     - Muse: `{ readOnly:"declined", panelistToolsRemoved:false }`.
     - Cursor and Pi: untouched.
  2. OpenCode 1.x `openCodePermissionRules`: panelist → deny-only ruleset.
  3. OpenCode 2.x `sessionRules`: widen `RulesPolicy`; read-only policy → deny `shell`, `edit`, `external_directory`; panel → MCP denied; panelist → deny `*` last. Verify precedence from the code and state it in the report.
  4. ACP: `acpMcpToolApprovalElicitationDisposition` returns `"deny"` (extend the return type) when `runtimePolicy.panel` is set; panelist → `acpOperationDisposition` denies all kinds, and client fs read/write handlers refuse.
  5. Muse: panel sessions decline every permission request (both roles).
- **Tests:** rule and disposition unit tests for panelist, code agent and non-panel (regression), per package. AC 28 also needs: under a panel policy no request returns `"ask"`.
- **Must not:** change Cursor, Pi or ACP Registry eligibility, or non-panel behavior.
- **Done checks:**
  - `vp test run <touched test files>`
  - `vp run typecheck`
  - `vp run check:changed`

### WP4a: Orchestrator integration, service and projections

- **Requirements:** 2, 5, 7 (server), 9, 11–17, 19–25 (wired), 30, 31, 32, 34, 36, 49, 50, 51 (server), 53.
- **Depends on:** WP1, WP2.
- **Files:**
  - `packages/contracts/src/orchestrationV2.ts` (the command and event union members of 2.1, `knownDomainEventTypes`);
  - `apps/server/src/orchestration-v2/Orchestrator.ts`, `ProjectionStore.ts`, `ThreadMessageIntake.ts`, `ThreadManagementService.ts`, `AgentAwarenessRelay.ts`, `testkit/OrchestratorScenario.ts`;
  - `RestartContinuation.ts`, `ProviderRuntimeRecoveryService.ts`, `UsageLimitRecoveryWorker.ts`;
  - new `panel/PanelChatService.ts` (+ test);
  - `apps/server/src/ws.ts` (annotation and feature usage only);
  - `apps/server/src/environment/ServerEnvironment.ts`;
  - `apps/server/src/mcp/OrchestratorMcpService.ts` (export `providerConstraints` / `requireAdvertisedModel` only);
  - `apps/server/src/server.ts` (provide `PanelChatService`);
  - new `panel/PanelOrchestration.test.ts` (or extend an existing orchestrator test file) using `testkit/OrchestratorScenario.ts` or `ProviderReplayHarness.ts`.
- **Interfaces:**

```ts
export class PanelChatService extends Context.Service<PanelChatService, {
  readonly create: (command: Extract<OrchestrationV2Command, { type: "panel.create" }>) => Effect.Effect<OrchestratorV2DispatchResult, PanelChatError | OrchestratorDispatchFailure>;
  readonly post: (command: Extract<OrchestrationV2Command, { type: "panel.post" }>) => Effect.Effect<OrchestratorV2DispatchResult, PanelChatError | OrchestratorDispatchFailure>;
  readonly continue: (command: Extract<OrchestrationV2Command, { type: "panel.continue" }>) => Effect.Effect<OrchestratorV2DispatchResult, PanelChatError | OrchestratorDispatchFailure>;
}>()("t3/orchestration-v2/panel/PanelChatService") {}
export class PanelChatError extends Schema.TaggedError<PanelChatError>()("PanelChatError", {
  commandId: CommandId, message: TrimmedNonEmptyString,
}) {}
```

  `PanelChatError.message` carries the user-visible English refusal from requirement 2.7, and `userFacingDispatchErrorMessage` must pass it through, so add its tag to the user-facing list (`UserFacingErrors.ts:140`).

- **Steps:**
  1. **Contracts.** Add the union members and the event (2.1). Fix every exhaustive switch the compiler reports.
  2. **`PanelChatService.create`.**
     - Validate per requirement 2.7: 2–5 panelists ("Add at least 2 models." / "A panel has up to 5 models."); at most one code agent; rounds 1–5; topic trimmed non-empty ("Enter a topic.") and ≤ 8,000 characters ("Keep the topic under 8,000 characters."); exact duplicate panelist (same instance, model and options, order-insensitive) → "Already in this panel."
     - Each participant's provider must exist and be available (`providerConstraints` + `requireAdvertisedModel`), else "This provider can't join a panel chat.". The adapter capability `panelChat` must be present for a panelist; a code agent needs `readOnly === "enforced"`, else "This provider can't be limited to reading, so it can't be the code agent.".
     - The parent must exist, be unarchived, not deleted, with `panel` absent, not a side chat, subagent or delegated thread, and have at least one message ("Panel chats start after the first message." for the no-message case; for the kind cases reuse the fork planner's refusal or the same message).
     - Resolve each participant:
       - `id`: `p1`…`p5` in the given order, `code`;
       - `name` from the catalog model `name`; when two participants share it, append ` · <effort label>` (the reasoning option's choice label) or, if the options are equal, ` · <instance displayName>`;
       - `handle` = `derivePanelHandle(shortName ?? name ?? slug)` (code agent: `code`);
       - `driver`;
       - `toolsRemoved` from the capability (always `true` for the code agent).
     - Dispatch `panel.open` with the same `commandId` and creation fields.
  3. **`panel.open` decide.**
     - Plan the thread with `ThreadForkService.plan({ sideChat:true, sourcePoint:{type:"latest_stable"}, ... })`.
     - Override `title = panelTitleSeed(topic)`, `titleRenamed:false`, `forkedFrom:null`, `modelSelection` / `providerInstanceId` = first panelist's, `runtimeMode:"approval-required"`, `interactionMode:"default"`, and `panel` = initial idle state.
     - Emit `thread.created` and the fork `context-transfer.created` (as `dispatchThreadFork` does), the run-less topic message plus its `user_message` turn item, and the title-generation effect.
     - Then apply `openRunOfRounds` and `startPanelTurn`. All of this is in one decide.
  4. **`startPanelTurn(projectionThread, decision, events, effects)`.**
     - Emit `panel.updated` with the decided state, then call `dispatchMessage` with the synthesized command of 1.1.
     - Pass a new optional internal parameter `panel: { participantId, panelTurn }` that sets `run.panelTurn`, `message.panelParticipantId` and the `user_message` item's `panelParticipantId`, and suppresses the initial title effect for that dispatch.
     - Set `panel.current` and `turnCount + 1` in the same `panel.updated`, which must name the run id. Derive it with `idAllocator.derive.run({threadId, ordinal: nextRunOrdinal})`, or emit `panel.updated` after `dispatchMessage` returns, reading the run from pending events. The implementer picks one and documents it in a one-line comment.
     - If the participant's instance has no adapter, record the outcome as `unavailable` and continue with `settleTurn` without a run (1.4 item 5).
  5. **`panel.post` decide** (validation as requirement 2.7: non-empty and ≤ 8,000, "Keep panel messages under 8,000 characters.").
     - Emit the run-less user message plus item, and compute mentions with `panelMentionedParticipantIds`.
     - Idle → `recordPost` starts a run; running → `pendingPost`.
     - Only when `panel` exists and the thread is not archived or deleted.
  6. **`panel.continue` decide:**
     - Idle only; otherwise refuse with "This panel chat is already running.".
     - Refuse while `panel.current !== null` (a stopped turn has not settled yet) with "This panel chat is still stopping.".
     - Then `openRunOfRounds` + start.
     - A **post** while stopping is accepted: the scheduler keeps it as `pendingPost` and starts it when the cut-off turn settles.
  7. **`panel.turn.settle` decide.**
     - `run_ended`: ignore when `panel.current?.runId !== runId`, except to write a missing `panelTurn.outcome` on that run. Otherwise classify (1.4 item 6), compute `codeCallout` with `panelCodeCallouts` on the assistant text (panelist `reply` + `replied` only), call `settleTurn`, write `run.updated` with `panelTurn.outcome` / `outcomeDetail` / `lookup`, then `startPanelTurn` or emit the idle `panel.updated`.
     - `time_limit`: if `current.runId` matches and the run is nonterminal, set `timedOut` and `dispatchRunInterrupt` (reason `"Panel reply time limit"`).
     - `recovery`: `recover(state)`.
     - Never start a turn on an archived or deleted thread.
  8. **Stop and archive.** `dispatchThreadStop` and archive of a running panel set idle `stopped` (1.4 item 8).
  9. **Refusals on panel threads.** Client `message.dispatch` ("Update the app to post in a panel chat."), `thread.fork` and `thread.merge_back` with the panel as source or target, `checkpoint.rollback`, `provider.switch`, `thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.model-selection.set`, every `queued-*` / `queue.*` command, and `thread.snooze`. Use `OrchestratorDispatchError` with a short English cause. The refusal applies only to commands whose `creationSource` is not `server`, except `message.dispatch`, which is refused for all because server panel turns never use the public case.
  10. **Projection.**
      - `panel.updated` projects like `thread.metadata-updated`.
      - `shellFromState` copies `{status, idleReason}` into `shell.panel`.
      - `run.updated` keeps a known `panelTurn.outcome` / `lookup` when the incoming payload lacks them.
  11. **Recovery and limits.**
      - `restartContinuationBlocked` → `true` for panel threads.
      - Recovery cancels (does not resend) unstarted panel runs.
      - `getLimitRecoveryCandidates` excludes threads with `$.panel`.
  12. **Capability.** `ServerEnvironment` `panelChats: true`.
  13. **Routing.** `ThreadMessageIntake.dispatchCommand` routes `panel.create/post/continue` to `PanelChatService`. `ws.ts` passes them through unchanged otherwise.
- **Tests** (orchestrator-level, deterministic; turns completed through the testkit's fake adapter, worker drained; no sleeps):
  - create → one hidden thread (`lineage.sideChat`, not listed), topic message, first run with `panelTurn`, marker `panelParticipantId`, `freshContext`;
  - settle chain for 2 panelists × 1 round → p1, p2, conclusion p1, idle `concluded`;
  - post while running → `pendingPost`, then replaced queue;
  - Stop → idle `stopped`, no new run;
  - Continue refused while running;
  - client `message.dispatch` refused with the message;
  - validation refusals (each message);
  - archive parent → panel archived and idle `stopped`;
  - delete parent → panel deleted;
  - restart continuation blocked for a panel run (unit test on `restartContinuationBlocked`);
  - limit-recovery candidates exclude panels;
  - outcome preserved across a later `run.updated`;
  - composed prompt not present in any stored message (AC 10, server half).
- **Must not:** change behavior for non-panel threads; existing tests must pass untouched.
- **Done checks:**
  - `vp test run apps/server/src/orchestration-v2/panel apps/server/src/orchestration-v2/RestartContinuation.test.ts apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts packages/contracts/src/orchestrationV2.test.ts`
  - the touched files' sibling tests
  - `vp run typecheck`
  - `vp run check:changed`

### WP4b: Reactor, turn start, runtime policy, MCP omission, provider publication, thread read

- **Requirements:** 10, 18, 19, 27–30, 33, 42 (server), 55 (wiring).
- **Depends on:** WP4a, WP3a, WP3b.
- **Files:**
  - `apps/server/src/orchestration-v2/panel/PanelTurnReactor.ts` (+ test);
  - `RuntimePolicy.ts` (+ test);
  - `ProviderSessionManager.ts` (+ test);
  - `ProviderTurnStartService.ts` (+ test);
  - `apps/server/src/server.ts`;
  - the provider snapshot assembly file (2.3);
  - `apps/server/src/mcp/OrchestratorMcpService.ts` (+ test).
- **Interfaces:**

```ts
export class PanelTurnReactor extends Context.Service<PanelTurnReactor, {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  readonly sweep: Effect.Effect<void>;   // startup recovery; exposed for tests
}>()("t3/orchestration-v2/panel/PanelTurnReactor") {}
// RuntimePolicyV2Shape.resolve input gains: readonly panelTurnKind?: OrchestrationV2PanelTurnKind
```

- **Steps:**
  1. **Reactor** (pattern: `DelegatedTaskQuestionReactor.ts`, `KeyedLock` per panel thread, `forkParked(Stream.runForEach(engine.streamDomainEvents, …))`).
     - `run.updated` on a run with `panelTurn`:
       - terminal → `panel.turn.settle {run_ended}`;
       - `startedAt` set and nonterminal → (re)start the time-limit fiber for that run id, unless one already exists; the fiber is interrupted on terminal or when the thread is archived or deleted.
     - `runtime-request.updated` pending on a panel thread → `runtime-request.respond {decision:"decline"}` for approvals, `thread.user-input.dismiss` for `kind:"user_input"`.
     - `start` runs `sweep` first, over every thread with `panel.status === "running"` (add `ProjectionStore.listRunningPanelThreadIds()` with a JSON query on the thread payload): `panel.turn.settle {recovery}`.
     - Ids are as in 1.4 item 10. Dispatch through `engine.dispatch` with `createdBy:"agent"`, `creationSource:"server"` where the command has creation fields.
  2. **`RuntimePolicyV2.resolve`.** When `input.thread.panel !== undefined`, return the base policy overridden with the read-only policy of requirement 2.5 and `panel: { role: input.panelTurnKind === "lookup" ? "code_agent" : "panelist" }`; no `panelTurnKind` → `code_agent` (rollback and other callers). Apply this in `layerFromProjectStore` and `layer`.
  3. **`ProviderSessionManager.prepareMcpSession`.** If the thread has `panel`, clear and return `{ mcpCredentialId: undefined, issued: false }` (as the `configureMcp === false` branch).
  4. **`ProviderTurnStartService`**, for a run with `panelTurn`:
     - resolve the policy with `panelTurnKind`;
     - before opening a session, check the participant's availability (instance enabled via `getMetadata`, snapshot installed, auth not `unauthenticated`, model advertised) and otherwise `settleRunBeforeStart` with the failure of 1.4 item 5;
     - replace `providerMessage.text` (before the length and slash guards, 709-834) with `buildPanelPrompt(panelTranscript(...))` read from the projection; lookup turns pass the asking reply's or post's request text;
     - never pass `appContext` or a context handoff for panel runs.
  5. **Provider publication.** Set `ServerProvider.panelChat = { panelist: cap !== undefined, codeAgent: cap?.readOnly === "enforced", panelistToolsRemoved: cap?.panelistToolsRemoved === true }`, absent when `cap` is absent.
  6. **`t3_thread_read`** labelling (2.6).
- **Tests:**
  - reactor: settle dispatched once per terminal run (replayed receipts on duplicates); time limit with `TestClock.adjust(PANEL_PANELIST_REPLY_LIMIT_MS)` → interrupt → `timed_out` → next turn; code agent 5 min; approval auto-declined; question dismissed; sweep → idle `interrupted`, no new run;
  - runtime policy: panel thread panelist and code agent shapes; non-panel unchanged;
  - MCP: no credential for panel threads;
  - turn start: the composed prompt sent to the fake adapter contains the topic and earlier replies by handle; the stored message stays empty; unavailable participant → failed run with code `panel_participant_unavailable`;
  - publication mapping;
  - thread read: markers dropped, speakers prefixed.
- **Must not:** change non-panel turns.
- **Done checks:**
  - `vp test run apps/server/src/orchestration-v2/panel apps/server/src/orchestration-v2/RuntimePolicy.test.ts apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts apps/server/src/orchestration-v2/ProviderSessionManager.test.ts` (plus the MCP service test touched)
  - `vp run typecheck`
  - `vp run check:changed`

### WP5a: Client runtime and the web panel pane

- **Requirements:** 7 (opens tab), 12–14 and 16 (client), 37–44, 48 (no regressions), 50, 51 (UI), 53 (display).
- **Depends on:** WP4b.
- **Files:**
  - `packages/client-runtime/src/operations/commands.ts`, `state/threadCommands.ts`, `state/orchestrationV2Projection.ts`, `state/threadShell.ts`, `sideThread.ts`, `composerThreadItems.ts`, new `panelChat.ts` + `panelChat.test.ts`;
  - `apps/web/src/components/chat/PanelThreadPane.tsx` (new), `PanelSpeakerRow.tsx` (new), `PanelStatusBar.tsx` (new), `SideThreadPane.tsx` (route panels to the panel pane), `RightPanelTabs.tsx` (tab icon, running label), `ChatView.tsx`, `ChatComposer.tsx` / `useComposerMenuItems.ts` / `useComposerSend.ts` (panel mode), `MessagesTimeline.logic.ts` + `MessagesTimeline.tsx` (row kinds), `TimelineAssistantRows.tsx` (hide fork and reply in panels via ChatView not passing the handlers), the parent-link icon in `MessagesTimeline.tsx:1237`;
  - `apps/web/src/i18n/translations/en.json` via `vp run i18n:generate` (other locales in WP7).
- **Client-runtime logic (`panelChat.ts`, pure, tested):**
  - `panelStatus(panel, participants, stopRequested): { key: PanelStatusKey; vars; action: "stop" | "continue" | "none"; tone: "default" | "error" }` covering every row of requirement 4.4's table, including "your message is next" and "Stopping…".
    - "Stopping…" (disabled button with `Spinner`) shows while a Stop is in flight, or while `panel.status === "idle"` and `panel.current !== null`.
    - Continue is offered only when `status === "idle"` and `current === null`.
  - `panelTimelineAnnotations(runs, panel) → Map<runId, { speaker; roundStart?: {round,total}; conclusion?: boolean; outcomeLine?: {...} ; lookupLine?: {...}; askedBy? }>`. Round dividers appear only for open runs at the first reply turn of each round.
  - `panelSendTooltip(text, panel)`.
  - `panelParticipantMenuItems(panel, query)`.
  - Reuse `panelMentionedParticipantIds` and `panelReplyBudget` from shared.
- **Web steps:**
  - **Timeline.** The marker `user_message` (has `panelParticipantId`) becomes a `panel-speaker` row. New row kinds `panel-speaker` and `panel-divider` go in `deriveMessagesTimelineRows`, so virtualization and minimap counts stay right. Outcome lines come from annotations using `TimelineSystemDivider` with the exact strings and tones of 4.4.
  - **Pane.** The header (title, roster button and popover, Add to chat, Delete with confirmation, Close), the embedded ChatView with panel mode, `PanelStatusBar` built from `ComposerBanner` slots (the requirement's "neutral" maps to variant `default`, "danger" to `error`; densities `default`; `role="status"` `aria-live="polite"`), and the composer in panel mode:
    - text only: no model picker, effort, permission, plan, attachments, voice, stash, queue or slash commands;
    - Send always, tooltip per 4.4;
    - `@` lists participants only and inserts `@handle `;
    - an 8,000-character notice.
    - A panel opened in the main view gets the same.
  - Approval or question UI never renders on panel threads.
  - Stop → `thread.stop`, Continue → `panel.continue`, Send → `panel.post`, each with the toasts of 4.4.
  - Gating: `useEnvironmentScope(environmentId, AuthOrchestrationOperateScope)` and the permission tooltip.
- **Tests:**
  - `panelChat.test.ts` (status for every state, annotations, mention tooltip);
  - `MessagesTimeline.logic` test rows for marker → speaker, dividers, no fresh or model-switch rows;
  - one browser test only if a behavior needs the real DOM (none expected).
- **Must not:** change side-chat behavior or restyle `components/ui`.
- **Done checks:**
  - `vp test run packages/client-runtime/src/panelChat.test.ts apps/web/src/components/chat/MessagesTimeline.logic.test.ts` (plus touched tests)
  - `vp run i18n:generate` in `apps/web`
  - `vp run typecheck`
  - `vp run check:changed`

### WP5b: Web setup dialog and entry points

- **Requirements:** 1, 3, 4, 5 (client), 6, 8, 26 (picker), 35, 36, 42, 48, 56, 58.
- **Depends on:** WP5a.
- **Files:**
  - `apps/web/src/components/chat/PanelSetupDialog.tsx` (new) + `PanelSetupDialog.logic.ts` (+ test);
  - `useComposerMenuItems.ts` / `useComposerSend.ts` / `ChatComposer.tsx` (`/panel`);
  - `packages/client-runtime/src/state/composerDispatch.ts` (`composerRunsDraftLocally` for `/panel`);
  - `RightPanelTabs.tsx` (launcher and + menu, shortcut `G`);
  - `ThreadRelationshipsControl.tsx`, `threadDetailsItems.ts`, `ThreadDetailsPanel.tsx`;
  - `ThreadContextChip.tsx` + `ThreadContextDragGhost.tsx` + `CollapsedComposerPromptPreview.tsx` + `MarkdownThreadLink.tsx` (`UsersRound` for panels);
  - `ChatView.tsx` (wiring);
  - `en.json` via generate.
- **Steps:**
  - **Dialog** exactly per requirement 4.3:
    - roster slots with `ProviderModelPicker` per slot and a per-slot `getModelDisabledReason` (duplicate / ineligible / code-agent-ineligible, from `ServerProvider.panelChat`);
    - new slots default to the lowest reasoning choice (`options[0]` of the reasoning select; `PanelSetupDialog.logic.ts` tests this per descriptor shape);
    - "May read files" when `panelistToolsRemoved === false`;
    - rounds `ToggleGroup`;
    - "Up to N replies" from `panelReplyBudget`;
    - topic validation;
    - footer;
    - loading, error toast and success (opens the tab through `useRightPanelStore.getState().openThread`, or the main view per the existing setting, and focuses the composer);
    - the per-thread in-memory draft;
    - the last roster and rounds in `localStorage` keyed by environment id (`useLocalStorage`, key `t3code:panel-roster:v1`), minus unavailable models;
    - first use: the thread's model in slot 1;
    - "Connect at least two models…" state;
    - responsive below 640px.
  - **Entry points:**
    - the `/panel` slash item after `/btw`, with disabled reason, running locally and clearing the composer text;
    - the launcher and + menu item "Panel chat", `G`, `UsersRound`, with the reasons and hints of 4.2;
    - hidden without the capability, on side chats, panels and subagents (AC 2, 3).
  - **Thread details:** a "Panel chats" section after "Side chats", plus the details item `panelChats`. The side-chat section excludes panels.
  - **`@` in the parent composer:** description "Panel chat". Chips use `UsersRound`.
- **Tests:** `PanelSetupDialog.logic.test.ts` (validation reasons, duplicate detection, lowest-effort default, reply budget, remembered roster filtering); the `parsePanelCommand` integration through `composerRunsDraftLocally` if logic.
- **Done checks:**
  - `vp test run apps/web/src/components/chat/PanelSetupDialog.logic.test.ts` (plus touched tests)
  - `vp run i18n:generate` in `apps/web`
  - `vp run typecheck`
  - `vp run check:changed`

### WP6: Mobile

- **Requirements:** 46, 47, 48 (mobile row), 50.
- **Depends on:** WP5a (client-runtime logic). May run **in parallel with WP5b** (mobile files vs web files; neither touches `packages/client-runtime` — if WP6 needs a client-runtime change, it stops and reports instead).
- **Files:**
  - `apps/mobile/src/features/threads/ThreadPanelChatsRow.tsx` (new), `ThreadDetailScreen.tsx`;
  - `ThreadFeed.tsx` and `apps/mobile/src/lib/threadActivity.ts` (speaker lines, dividers, outcome lines, markers hidden, no fresh-session or model-switch dividers on panels);
  - a `PanelControlBar` in `features/threads`;
  - `apps/mobile/src/state/entities.ts` (expose `panelChatsAtom`);
  - `en.json` via generate.
- **Steps:**
  - per requirement 4.7: the row (`person.3`, "Panel chats", chips, accessibility labels), reading, and the control bar replacing the composer (Stop/Continue, scope-gated, status text from `panelStatus`);
  - no create, no post, no `/panel`;
  - the side-chats row excludes panels.
- **Tests:** `threadActivity` logic test for panel feed entries if the derivation lives there (pure).
- **Done checks:**
  - `vp test run <touched mobile tests>`
  - `vp run i18n:generate` in `apps/mobile`
  - `vp run typecheck`
  - `vp run check:changed`

### WP7: Translations and docs

- **Requirements:** 45, 52, internal doc (requirement 4.9).
- **Depends on:** WP5b, WP6.
- **Files:**
  - every locale JSON in `apps/web/src/i18n/translations/` and `apps/mobile/src/i18n/translations/` (de, es, fr, ja, ko, pt-BR, ru, sv, zh);
  - `docs/user/thread-sidebar.md`;
  - `docs/orchestration-v2/thread-lineage-and-context-transfer.md` ("Data Ownership").
- **Steps:**
  - translate every new key (respecting `$context`, plurals and placeholders);
  - user doc text verbatim from requirement 4.9, plus the sentence change in "Open a thread beside the one you are in";
  - one internal paragraph.
- **Done checks:**
  - `vp run i18n:check` (repo root)
  - `vp run check:changed`

---

## 4. Order

```
WP1 ─┬─ WP2 ──┐
     ├─ WP3a ─┼─ WP4a ─ WP4b ─ WP5a ─┬─ WP5b ─┬─ WP7
     └─ WP3b ─┘                      └─ WP6 ──┘
```

- WP2, WP3a and WP3b run in parallel (disjoint files). WP4a needs only WP2, but it runs after WP3a and WP3b finish so `check:changed` runs against a quiet tree.
- WP5b and WP6 run in parallel (web vs mobile files; each runs `i18n:generate` only in its own app).
- The lead reviews and commits each package before starting dependants. Parallel packages are committed separately by path.

---

## 5. Validation plan

| AC | Covered by (package: check) | Director's live check |
|---|---|---|
| 1 | WP5b: entry wiring; disabled reasons from logic | Yes: slash, launcher, + menu, draft thread |
| 2 | WP4a: create refusal test; WP5b: entry gating | Yes |
| 3 | WP5b: capability gating | Optional |
| 4 | WP1: `parsePanelCommand` test; WP5b: wiring | Yes |
| 5 | WP4a: server refusals test; WP5b: dialog logic test | Yes: tooltips |
| 6 | WP4a: names and handles in create test; WP1: handle test | Yes |
| 7 | WP4a: create test; WP5b: opens tab | Yes |
| 8 | WP5b: remembered roster logic test | Yes |
| 9 | WP2: scheduler test; WP4a: settle chain test | Yes |
| 10 | WP4b: turn-start prompt test; WP4a: stored message empty | — |
| 11 | WP2: all-pass test; WP5a: pass line annotation | Yes |
| 12 | WP2: Continue cursor test; WP5a: status action | Yes |
| 13 | WP2: post tests | Yes |
| 14 | WP2: pending post; WP4a: integration; WP5a: status "your message is next" | Yes |
| 15 | WP1 mentions; WP2 (panelist handles inert) | — |
| 16 | WP4a: stop test; WP5a: status | Yes |
| 17 | WP2: classification and no_replies; WP4b: unavailable | Partial (failure lines) |
| 18 | WP4b: TestClock time-limit test | — |
| 19 | WP2 + WP4b: no turn without action; sweep | — |
| 20–25 | WP1 call-outs; WP2 lookup tests; WP2 prompt without code agent | Yes (20, 23) |
| 26 | WP3a/WP3b capabilities; WP4a create refusal; WP5b picker reasons | Yes |
| 27 | WP3a/WP3b adapter policy tests | — |
| 28 | WP3b dispositions; WP4b reactor auto-decline; WP5a no approval UI | — |
| 29 | WP4b MCP omission test; WP3a Codex/Claude (no T3 server, strict MCP) | — |
| 30 | Inherited checkpoint skip (side-chat class); WP4b auto-decline; WP5a UI | — |
| 31 | WP4a refusals test | — |
| 32 | WP4a projection; persistence by construction | Yes (reload) |
| 33 | WP4b sweep test; WP4a continuation blocked | Yes if feasible (restart dev server) |
| 34 | WP4a cascade tests | Yes |
| 35 | WP5b details section | Yes |
| 36 | Inherited (`isListedThreadLineage`); WP4a assertion | Yes |
| 37–39 | WP5a timeline logic test | Yes |
| 40 | WP5a `panelStatus` test | Yes |
| 41 | WP5a popover | Yes |
| 42 | WP5b Add to chat; WP4b thread-read labelling test | Yes |
| 43 | WP5a participant menu logic | Yes |
| 44 | No animation added (review); virtualized timeline reused | Yes: a 200-reply scroll |
| 45 | WP7 `vp run i18n:check` | — |
| 46–47 | WP6 | Yes (iOS and Android) |
| 48 | WP5a/WP5b/WP6 regressions; existing tests | Yes |
| 49 | Existing orchestration suites untouched (`check:changed` runs the tests beside changes) | — |
| 50 | WP4a `message.dispatch` refusal; A2 decode test (WP1) | Optional |
| 51 | WP4a: scope unchanged (dispatchCommand); WP5a/WP5b gating | Yes (a scoped session if available) |
| 52 | WP7 docs | — |
| 53 | WP2 conclusion tests; prompt builder | Yes |
| 54 | WP2 prompt builder tests | — |
| 55 | WP3a/WP3b adapter tests; WP4b policy wiring | Codex live-unverified (1.3) |
| 56 | WP3 capabilities + WP4b publication + WP5b row | Yes |
| 57 | WP1 constants + WP2 builder tests | — |
| 58 | WP1 budget + WP5b default-effort logic | Yes |

**Director's rendered inspection** (requirement 4.10):

- Viewports: desktop 1920×1080 and 1366×768 (right panel at default and minimum width), web 390×844, one iOS and one Android layout.
- States:
  - dialog: first use, remembered roster, 5 models, validation errors, starting, start error, no eligible models;
  - pane: running open run, running lookup, queued user post, each idle reason, stopping, deleted, archived, no permission;
  - transcript: round dividers, two same-provider speakers, code agent with tool activity, pass, failed, usage limit, time limit, lookup limit, 200-message scroll;
  - the thread-details section with a running panel;
  - the mobile row, transcript and control bar.
- **Blocker to note:** the free Replay (dev) provider is ineligible (1.3), so a live pass needs a Codex, Claude or OpenCode instance and paid turns at the cheapest model, or a director decision to allow the dev replay instance.

---

## 6. Acceptance fixes round 1 (lead, 2026-11-22)

Source: `E:\t3code-specs\panel-chat-acceptance-1.md` (F1–F6) and requirement revision 2.1. Decision 1.4 item 8b is **superseded** by AF1 below. Three packages, disjoint files, run in parallel.

### AF1 (server): F1 and F3

- **F1.** In `PanelScheduler.ts` `endOfRoundWithoutReplies`: when the round did not all pass, and `run.roundsCompleted > 0` (a round only counts as completed when a panelist replied in it, and any round with no reply ends the run, so `roundsCompleted > 0` ⇔ a panelist replied earlier in this run), clear the queue and queue the conclusion (`queueConclusion(…, run.round)`) **without** setting `agreed`; otherwise idle `no_replies` as today. Conclusion `replied` → `concluded`, other outcome → `rounds_done` (existing `advance` branch). The status line then reads "Concluded after {roundsCompleted} rounds" (counts rounds that had a reply). Tests in `PanelScheduler.test.ts`: (a) round 1 replied, round 2 all failed → conclusion queued by slot 1 → `concluded` (and `rounds_done` when the conclusion fails); (b) round 1 all failed → `no_replies`, no conclusion turn; (c) the existing all-passed case unchanged (`agreed`). Adjust any `PanelOrchestration.test.ts` expectation that encoded the old rule.
- **F3.** In `PanelChatService.ts` create: the code agent never takes part in name collisions (it is shown as "Code agent"), so peers are panelists only and the code agent's `name` is left as the model name. Among panelists sharing a display name, append ` · <effort label>` when the participant has an effort label that differs from every same-named peer's effort label; otherwise append ` · <instance display name>`. Tests: a panelist and the code agent on the same model → panelist name unsuffixed; two panelists same model, different effort → effort suffix; same name, same effort, different instances → instance suffix (existing row at `PanelOrchestration.test.ts` ~1104 stays valid).

### AF2 (client transcript): F2, F6, mobile check

- **F2.** Exactly the marker messages (a `user_message` item / message with `panelParticipantId`, ids `message:panel:<thread>:turn:<n>`) are hidden; every topic, user post (`runId=null`) and reply renders. Reproduce first with a fixture shaped like the director's repro thread (read-only from the dev DB): topic (runId null) → marker run 1 → reply run 1 → … → post (runId null) → marker → reply. Fix the root cause in `apps/web/src/components/chat/MessagesTimeline.logic.ts` (`panelTimelineEntries` / `insertPanelRows` / `activeTurnHeaderIndex`, or wherever rows are dropped, including turn folds and response-boundary grouping) and/or `packages/client-runtime/src/panelChat.ts`. Regression tests at the lowest failing layer: topic + marker + first reply in run 1 all render the right rows; a post followed by marker and reply renders the post as a user row. Apply the same check to `apps/mobile/src/lib/threadActivity.ts` / `ThreadFeed.tsx` and fix it there with a test if it drops the same rows.
- **F6.** In panel threads, the visually hidden author heading of a participant's reply (`TimelineAssistantRows.tsx` `MessageAuthorHeading`, currently "T3 Code") is the participant's display name, or "Code agent" for the code agent (existing translated string). Non-panel threads unchanged. Thread the speaker through the row data (e.g. from the panel annotation by run id) rather than new lookups in render.

### AF3 (web setup dialog and thread details): F4, F5

- **F4.** `PanelSetupDialog.tsx` roster and code-agent rows: provider icon, then model name left-aligned, effort at the right (spec 4.3 item 2). Fix with layout classes on the parent/trigger content or an existing variant; no change to `components/ui` exports.
- **F5.** Panel and side-chat rows in thread details share one handler (`useSideThreadTrigger` → `openSideThreadRow` → `openSideThread`; Ctrl on Windows/Linux, Cmd on macOS → `alternate` → main view when the preference is panel). Verify with a browser test in `ThreadRelationshipsControl.browser.test.tsx` that Ctrl+click on a side-chat row and on a panel row produce the same target (also check `startPanelDrag` on `onPointerDown` and the main-view route for a panel thread do not divert it). Change code only if panels behave differently from side chats; report the result.

### AF2b (F2 root cause, server and client): supersedes AF2's client-side timestamp ordering

**Root cause (verified in the dev DB repro thread `850f13d3-…`).** `TurnItemPositionStore.allocate` puts every runless turn item in the prelude range `0…999_999`; run items use `runOrdinal × 1_000_000 + n`. The topic got ordinal 1 (correct, it precedes run 1), but the two posts made after run 4 got ordinals 2 and 3, so they sort before every run. The client projection (`packages/client-runtime/src/state/orchestrationV2Projection.ts` `shouldDropMissingPartialTurnItem` → `isBelowPartialWindow`) then drops them as unloaded history, and server history paging would only deliver them at the very beginning. A client-side timestamp sort cannot fix paging, so the ordinal must be right at the source. Decision 1.4 item 2 is amended accordingly.

**Fix.**
1. Server: a runless `user_message` turn item of a **panel** thread whose thread already has at least one run gets its position in the range of the thread's latest run (highest run ordinal), appended (`max + 1` in that range), so it sorts after every item that run had at post time and before the next run's items. The topic (no run yet) stays in the prelude range. Non-panel threads and every other runless item keep today's allocation. Later items of an in-flight run may get ordinals after the post; clients already keep each run's rows together where the run first appears, so the post shows after that run.
2. Client: remove AF2's `orderPanelTranscript` timestamp sort (web `MessagesTimeline.logic.ts`, mobile `threadActivity.ts`, client-runtime `panelChat.ts`) and return to ordinal order with run grouping; keep F6. Update AF2's regression tests to use server-shaped ordinals (posts inside the previous run's range), and keep the cases: topic + marker + first reply in run 1; post followed by marker and reply; working and idle.
3. Client projection test: a live post event arriving with partial history enabled is kept (not dropped by the partial window) once its ordinal is in the latest run's range.
4. Run 1's missing reply: replay the stored `orchestration_v2_events` of the repro thread through the client reducer and row derivation, with the initial bounded snapshot taken at each candidate point (right after create, mid run 1, after run 1, and so on), and find what drops run 1's `assistant_message`. Fix it with a failing test at the lowest layer, or report that it cannot be reproduced and what was tried.
