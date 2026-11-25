# Panel chat: feature design

Status: design for review by the director. No product code was changed.
Repository: `E:\t3code`, branch `feat/panel-chat` (from upstream main `9de4ec1bfa`).
Designer model: Claude Fable 5.2, effort high.

**Skills used.** `product-vision-and-ideation` was loaded and applied for the whole design, with its references `owner-patterns.md` and `ui-design.md` (the game-design reference does not apply: this is not a game). The `frontend-design:frontend-design` skill could **not** be loaded through the Skill tool ("Unknown skill"). I read its `SKILL.md` from the installed plugin folder on disk and applied it (subject grounding, two-pass plan and self-critique, restraint, copy rules); section 4.1 shows that pass.

Numbers marked **pilot** are starting values to tune, not settled constants.

---

## 1. Goal and scope

### 1.1 User problem

A T3 Code user wants several different models to discuss a topic with each other in one live conversation, each seeing what the others said, while the user watches and steers. One participant should be able to look things up in the project's code so the discussion stays grounded.

### 1.2 Current behavior (verified)

- A thread talks to one agent. Side chats and subagents are also one user to one agent (`docs/user/thread-sidebar.md`, "Side chats").
- A new thread can send one prompt to several models, but each gets its own separate thread and worktree and they never see each other (`docs/user/thread-sidebar.md`, "Start in the background").
- `@model` mentions in the composer only name a model for the agent; they do not make that model speak (`docs/user/composer.md` line 384, `packages/client-runtime/src/composerModelMentions.ts`).

### 1.3 Intended outcome

A **panel chat** ("panel"): a sub chat attached to a thread in which 2 to 5 models take turns replying to a topic, live, with every message labelled by who wrote it. The user can post at any time, stop it, and continue it later. An optional **code agent** reads the project's code, and only reads, when a model or the user asks it to.

### 1.4 The model in one paragraph

**A panel is a side-chat-class thread whose turns rotate across a roster.** It is one hidden thread attached to its parent. Each reply is one ordinary run in that thread, started in a fresh provider session with the speaker's model, and given a prompt the server composes from the transcript. Everything else (streaming, the timeline, persistence, stop, restart recovery, archive and delete with the parent, opening as a right-panel tab, "Add to chat", mobile listing) is what threads and side chats already do.

### 1.5 Included (v1)

1. Create a panel from a thread: pick 2 to 5 models, an optional code agent, a rounds cap and a topic.
2. Sequential round-robin discussion with a visible cap, live streaming, speaker labels.
3. User posts (open or addressed with `@handle`), Stop, Continue.
4. Code agent call-outs by models (`@code` line) and by the user (`@code` mention).
5. Read-only enforcement for every panel turn, with a per-provider decision.
6. Entry points on web and desktop: `/panel` composer command, right-panel **+** menu and launcher, thread details, `@` mention of a panel in the parent composer, "Add to chat".
7. Mobile minimum: panels listed, readable live with speaker labels, Stop and Continue.
8. Translations in every web and mobile locale; user doc section.

### 1.6 Excluded (v1)

- Exposing panels to agents through MCP tools. Panel operations are service methods so tools can be added later.
- Voice, images and file attachments in panels (text only).
- More than one code agent.
- Editing the roster or the rounds cap after creation (start a new panel; the setup form remembers the last roster).
- Copying the parent thread's conversation into the panel (see open question 1).
- Creating a panel or posting into one from mobile.
- A command-palette command or keybinding (side chats have neither today; verified: no side chat command in `packages/contracts/src/keybindings.ts` or the command palette).
- Drag reordering of the roster; mention chips (handles are plain text).

### 1.7 Constraints

- `AGENTS.md`: performance (no repainting animations, no excess websocket data), remote-ready (all orchestration server-side), multi-surface, contracts in `packages/contracts`, server features are services, `components/ui` exports own their look, plans and specs are not committed.
- Panels must fit orchestration-v2: commands decide events, projections are the UI's source, the effect worker does I/O.

---

## 2. Exact behavior

### 2.1 Terms

| Term | Meaning |
|---|---|
| Panel | The hidden thread that holds the discussion. Lives with its parent thread. |
| Panelist | A model that discusses. 2 to 5 per panel (**pilot** maximum). |
| Code agent | Optional single participant that reads the project's code on request. Handle is always `@code`. |
| Participant | A panelist or the code agent. |
| Handle | The `@name` used to address a participant, unique in the panel, for example `@opus-4-5`. |
| Turn | One participant reply: one run in the panel thread. |
| Round | Each panelist speaking once, in roster order. |
| Rounds cap | How many rounds one user action buys. 1 to 5, default 2 (**pilot**). |
| Run of rounds | The turns one user action started (start, Continue, or a post). The server calls this a "go". |

### 2.2 Turn-taking: the choice

**Chosen: sequential round-robin rounds, capped per user action, with three small extensions: `PASS`, addressed posts, and code call-outs.**

| Option | Why not (or why) |
|---|---|
| **Round-robin rounds (chosen)** | Order is known in advance, cost is `panelists × rounds`, every speaker has read everything before it, one reply streams at a time so it reads like a live chat. |
| Moderator model picks the next speaker | Adds a paid model call per turn and makes order and cost depend on a model's judgment. Not predictable. |
| Reply only when mentioned | Stalls when nobody is mentioned, or turns into two models ping-ponging with no bound. |
| Everyone answers at once each round | Fast, but models do not see each other inside a round, which is the opposite of "go back and forth". |
| Free-running until the models decide to stop | No visible cap; a runaway by construction. |

The three extensions keep the mechanic count low while giving it group-chat behavior:

- **`PASS`** lets a model say nothing instead of filler, and lets a discussion end before the cap when everyone passes.
- **Addressed posts** (`@handle` from the user) make only the addressed participants reply, the group-chat convention, and are the mechanism by which the user calls the code agent.
- **Code call-outs** let a panelist ask the code agent a question between turns.

**Hard guarantees.** No turn starts unless it is in the queue a human action created, or it is a code lookup counted against a per-round limit. Nothing a model writes can add panelist turns. There is no "unlimited" setting.

### 2.3 The algorithm

State kept per panel (persisted with the panel thread):

- `participants`: ordered roster (panelists in speaking order; code agent separate).
- `rounds`: the cap (1 to 5).
- `status`: `running` or `idle`.
- `idleReason` when idle: `rounds_done`, `answered`, `all_passed`, `stopped`, `interrupted`, `no_replies`.
- `queue`: the ordered list of upcoming turns (participant, kind, round number).
- `cursor`: the panelist who spoke last, so the next run of rounds starts with the one after.
- `lookupsThisRound`: code lookups requested by panelists in the current round.

**Starting a run of rounds**

| User action | Queue becomes |
|---|---|
| Start a panel (topic) | `rounds` rounds: each panelist once per round, in roster order. |
| **Continue** | `rounds` rounds, starting with the panelist after `cursor`. |
| Post with no valid `@handle` | Same as Continue: an open run of rounds. |
| Post that mentions one or more participants | One turn per mentioned participant: `@code` first if mentioned, then mentioned panelists in roster order. Then the panel goes idle. |

A post replaces whatever was left in the queue. If a reply is in flight when the post arrives, that reply finishes first (it is not cut off), then the new queue takes over. If several posts arrive during one reply, all appear in the transcript and the last one decides the queue.

**After each turn ends**, the server settles it in this order:

1. **Classify the outcome.**
   - `replied`: the run completed with text.
   - `passed`: the run completed and its whole text, trimmed, is `PASS` (any letter case, optional final period).
   - `failed`, `limited` (usage limit), `unavailable` (provider disabled, missing or signed out at turn time), `timed_out` (reply time limit): the turn is skipped. No retry.
   - `stopped`: the user pressed Stop. The queue is cleared, the panel goes idle with `stopped`, and settling ends here.
2. **Code call-out.** If the turn was a panelist `replied` turn, the panel has a code agent, and the reply contains a line whose first token is `@code` (outside fenced code), then: if `lookupsThisRound < 2` (**pilot**), a code lookup turn is put at the front of the queue and the counter goes up by one; otherwise no lookup runs and the turn is marked "lookup limit reached". One reply triggers at most one lookup, however many `@code` lines it has; the code agent answers them all in one turn.
3. **A pending user post** replaces the queue as described above.
4. **End of a round** (the last panelist turn of a round just settled): `lookupsThisRound` resets. If no panelist in that round `replied`: the queue is cleared and the panel goes idle with `all_passed` when every panelist passed, else `no_replies`.
5. **Next.** If the queue is empty the panel goes idle (`rounds_done` after an open run, `answered` after an addressed one). Otherwise the first queued turn starts.

Rules that close loops:

- The code agent's replies never trigger turns. It cannot call itself or call panelists.
- A panelist mentioning another panelist's handle is just text. It does not reorder anything.
- Code lookups the **user** asks for do not count against the per-round limit (the user owns the cost).
- An addressed run counts as one round for the lookup limit.
- Only one turn is in flight per panel. Different panels run independently.

**Stop and Continue**

- **Stop** is the existing `thread.stop` on the panel thread. It interrupts the reply in flight (partial text is kept and marked cut off), clears the queue, and leaves the panel idle with `stopped`. It works at any time the panel is running.
- **Continue** is available only when idle. It starts an open run of rounds from the panelist after `cursor`. A cut-off reply is not redone.
- Posting while idle also continues (it starts a run of rounds as in the table).

**Reply time limit.** A turn that has run for 5 minutes (**pilot**, fixed, both roles) is interrupted, keeps its partial text, is marked `timed_out`, and the panel moves on. This is the cost bound for a model that ignores instructions and goes exploring with read tools.

### 2.4 What each participant is sent

Every turn starts a **fresh provider session** (the existing `freshContext` path on `message.dispatch`, verified at `packages/contracts/src/orchestrationV2.ts:3542` and `apps/server/src/orchestration-v2/Orchestrator.ts:7544`). The participant gets one prompt, composed by the server at turn start from the panel's own transcript. The prompt is not stored as a message and is never sent to clients; the turn's stored message is an empty marker naming the speaker.

Why fresh sessions instead of resuming a provider thread per participant:

- Identical behavior on every provider; no dependence on native resume or on the cross-provider handoff, which is a lossy textual summary (`docs/internals/context-handoffs.md`).
- The same model can sit in a panel twice (different effort) without two participants sharing one native conversation.
- Cost per turn is bounded by a fixed window instead of a growing native context.
- A restart loses nothing: the next prompt is rebuilt from the transcript.

Cost of this choice, stated plainly: each turn is a new native session (startup time, and session files in the provider's own history, as side chats and subagents already create), and the provider's own system prompt is re-sent each turn (normally a prompt-cache hit).

**Panelist prompt** (server-authored, English, per `docs/internals/i18n.md` "What stays English"):

```
You are {name} ({handle}), taking part in a panel discussion inside T3 Code
with other AI models and a human user.

Participants:
- {handle} — {name} (you)
- {handle} — {name}
- @code — code agent: reads this project's code when asked      [only with a code agent]
- The user started this discussion and can post at any time. Their messages take priority.

How to take part:
- Write your own message only. Do not write for other participants and do not start with your name.
- Be direct and specific. Agree, disagree, or build on what was said. Stay under 250 words unless the user asks for more.
- Address others by handle, for example "{other handle}".
- Do not use tools. Do not read or change files, and do not run commands.
- If the discussion needs a fact from the project's code, put it on its own line starting with "@code" followed by your question. The code agent answers before the next participant speaks.     [only with a code agent]
- If you have nothing new to add, reply with exactly: PASS

Discussion so far:
<message from="user">…</message>
<message from="@opus-4-5">…</message>
<message from="@code">…</message>
[@sol passed]
[3 earlier messages omitted]

It is your turn, {handle}.
```

For an addressed turn the last line is: `The user addressed you directly in their latest message. Answer it.`

**Code agent prompt:**

```
You are the code agent (@code) for a panel discussion inside T3 Code.
Your working directory is the project's code.

Answer the requests addressed to @code below. Use only tools that read: open files, search, list.
- Point to evidence as path/to/file.ext:LINE. Quote a few lines at most.
- Report what the code says. Do not take sides in the discussion.
- If you cannot find it, say so.
- Never create, edit or delete files, and never run a command that changes anything.
- Stay under 300 words.

Discussion so far:
…same transcript block…

Requests to answer:
<message from="@sol">@code where is the retry limit set?</message>
```

**Transcript block rules** (**pilot** sizes):

- The topic is always included, up to 8,000 characters.
- Then the most recent entries that fit in 24,000 characters in total. Each message is capped at 6,000 characters in the prompt (middle removed, marked `[…trimmed…]`). Older entries that do not fit are replaced by one line: `[N earlier messages omitted]`.
- A participant's entry is the assistant text of its run (all assistant messages of the run joined by blank lines). Reasoning and tool activity are left out.
- Passes, skipped turns and lookup-limit notes appear as one bracketed line each.
- A cut-off reply is included with ` [cut off]` appended.
- Message bodies are wrapped in `<message from="…">` tags and any literal `</message>` in a body is neutralized, so one model cannot forge another speaker's message or the user's.

**Names and handles.** The name is the model's display name; when two participants share it, the effort or instance label is appended ("Claude Opus 4.5 · high"). The server derives the handle at creation from the model's short name: lower case, letters and digits kept, everything else collapsed to `-`, at most 16 characters, numbered when taken (`-2`). `code` is reserved for the code agent.

### 2.5 Read-only: how participants run

Every panel turn, panelist or code agent, runs under one policy:

- Runtime policy `approvalPolicy: "never"` with `sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }`, runtime mode `approval-required`, interaction mode `default`, working directory = the parent thread's folder (as a side chat has).
  This policy shape already exists and adapters already interpret it (verified: `READ_ONLY_NEVER_POLICY` in `apps/server/src/orchestration-v2/testkit/fixtures/shared.ts:392`; `ProviderAdapterV2RuntimePolicy.sandboxPolicy` in `packages/provider-core/src/server/ProviderAdapter.ts:69`). Today only test harnesses set it (`RuntimePolicy.layerWithOverride`); panels would be its first production use.
- **No T3 MCP server** is given to panel sessions. Otherwise a "read-only" participant could call `delegate_task` or `t3_thread_launch` and start a full-access agent.
- Any approval or question that still reaches T3 during a panel turn is answered by the server: approvals are declined, questions are dismissed. Panel turns never wait for the user.
- Excluded from panel threads: checkpoints (already skipped for side-chat-class threads, `CheckpointCaptureService.ts`), idle compaction, usage-limit auto-resume and snooze, queueing, forking, rollback, model or permission changes.

The two roles differ by prompt, not by policy. Panelists are told not to use tools; where a provider still offers them read tools, a panelist that reads a file does no harm, and the reply time limit bounds the cost. (Removing tools from panelists where an adapter can, for example Claude with an empty tool list, is a later optimization.)

**Two strengths of enforcement**, and what each allows:

- **Enforced**: the provider cannot write even if the model tries. Allowed as panelist and as code agent.
- **Declined**: the provider asks T3 before writing or running a command, and T3 always declines. Allowed as panelist only.
- Neither: not offered in panels.

| Adapter | How the policy lands (verified in code unless marked) | Panelist | Code agent |
|---|---|---|---|
| Codex | Passes approval and sandbox policy to the turn; `readOnly` is Codex's native sandbox (`CodexAdapterV2.ts:783-811`). | Yes | Yes |
| Claude | `dontAsk` permission mode and tools limited to `Read`, `Glob`, `Grep` (`ClaudeAdapterV2.ts:679`, `3484-3595`). No Bash, no edits, no subagents. | Yes | Yes |
| OpenCode 1.x | Permission rules: deny everything, then allow the read-class permissions (`packages/provider-opencode/src/server/adapter.ts:650-735`). | Yes | Yes |
| OpenCode 2.x | `sessionRules` reads only runtime and interaction mode today (`v2/adapter.ts:451-477`). **Required change:** under the read-only policy add deny rules for `shell`, `edit` and `external_directory`. With that: enforced. | Yes | Yes |
| Cursor | The policy only toggles Cursor's workspace sandbox, which still allows writes in the workspace, and turns review off (`packages/provider-cursor/src/server/adapter.ts:190-213`). **Required change:** run panel turns in Cursor's `plan` mode with review on. Assumption: plan mode does not write; not verified for commands. | Yes | No (v1) |
| Grok | Explicit policy launches in ask mode (`grokLaunchRuntimeMode`); the shared ACP policy allows reads and denies the rest (`packages/provider-acp/src/server/clientPolicy.ts:147-185`). Declined. | Yes | No |
| Kiro | Explicit policy keeps autopilot off (`kiroAutopilotValue`); shared ACP policy. Declined. | Yes | No |
| fx | Explicit policy runs `ask` mode (`fxSessionModeForPolicy`); shared ACP policy. Declined. | Yes | No |
| Antigravity | ACP flavor; `approval-required` maps to its supervised mode; shared ACP policy. Declined. | Yes | No |
| Muse | Supervised mode asks T3, which declines. No plan mode (`packages/provider-muse/src/server/adapter.ts:320`). Declined. | Yes | No |
| Pi | Runs the user's own extensions and tools; T3 cannot confirm every write asks first (`docs/internals/providers.md`, "Pi"). | No | No |
| ACP Registry | "Registry agents read files, edit, and run commands themselves, under their own sandbox and approval rules" (`docs/user/providers-acp.md:110`). T3 cannot hold them to reading. | No | No |

Each adapter declares its strength as a capability next to the existing `runtimePolicy.enforcement` (`packages/contracts/src/orchestrationV2.ts:392`), so orchestration and clients read a capability instead of branching on provider names. The server publishes, per provider instance, whether it can be a panelist and whether it can be the code agent; the setup form uses that.

Known limit, to state in the PR: MCP servers the user configured in a provider's own settings are outside T3's control on some adapters. The design requires that panel sessions never auto-approve such tool calls where the adapter decides; the lead must check each "Enforced" adapter for this.

### 2.6 User journeys

**Create.** From a thread that exists on the server: type `/panel` and an optional topic, or choose **Panel chat** in the right panel's **+** menu or launcher. The "New panel chat" dialog opens with the last roster used in this environment (or, the first time, the thread's own model as the only entry), rounds 2, and the topic prefilled from `/panel`. The user adds or changes models, optionally adds a code agent, types the topic and presses **Start panel**. The panel thread, the topic message and the first turn are created together; the panel opens as a right-panel tab and the first model starts replying.

**Watch.** Replies stream one at a time. Each starts with a speaker line. A divider marks each round. The status bar says who is replying and which round it is.

**Interject.** The user types in the panel composer at any time. With no mention, everyone answers for another run of rounds. With `@handle` mentions, only those participants answer.

**Call the code agent.** A model writes a line starting with `@code` and a question; the code agent answers right after that reply. The user types `@code` in a post; only the code agent answers.

**Stop.** **Stop** in the status bar. The current reply is cut off and kept; nothing else runs.

**Continue.** **Continue** in the status bar, or any post.

**Use the result.** **Add to chat** at the top of the panel, or `@` plus a word of its title in the parent thread's composer. The parent thread's next message carries a link to the panel, and its agent reads the transcript with `t3_thread_read`, exactly as for side chats.

**Find it again.** Thread details, **Panel chats** section. It opens like a side chat (tab by default; Cmd/Ctrl-click or middle-click for the main view; the existing "Open subagents and side chats in" setting applies).

**Delete.** **Delete** at the top of the panel, with the existing confirmation setting. Deleting or archiving the parent thread deletes or archives its panels and stops their work; unarchiving brings them back, idle.

### 2.7 Validation

| Input | Rule | Where enforced | Message |
|---|---|---|---|
| Panelists | 2 to 5 | Client and server | "Add at least 2 models." / "A panel has up to 5 models." |
| Duplicate participant | Same instance, model and options may appear once among panelists. Same model with different options is allowed. The code agent may use a panelist's model. | Client and server | "Already in this panel." |
| Provider eligibility | Role must be allowed for that provider instance (2.5) and the instance enabled, installed, signed in, with the model in its catalog (the checks `delegate_task` uses). | Client (picker) and server | "This provider can't join a panel chat." / "This provider can't be limited to reading, so it can't be the code agent." |
| Rounds | Integer 1 to 5 | Client and server | (toggle group; no free input) |
| Topic and posts | Non-empty after trim, at most 8,000 characters, text only | Client and server | "Enter a topic." / "Keep the topic under 8,000 characters." / "Keep panel messages under 8,000 characters." |
| Parent | An existing, unarchived server thread that is not itself a side chat, panel, subagent or delegated thread | Client (entry points hidden or disabled) and server | "Panel chats start after the first message." |
| Continue | Panel idle | Client and server | (button absent while running) |

**Same model twice: decision.** An exact duplicate (same instance, model and options) is rejected: it doubles cost for a near-copy of the same voice. The same model with different options (effort) or on a different instance is allowed, because "does more effort change the answer" is a real question and fresh sessions make it safe.

### 2.8 Permissions

- Panel commands travel on the existing `dispatchCommand` RPC as orchestration-v2 commands, the same path as `thread.fork`. No new RPC method is added, so `CLIENT_GUARDED_RPC_SCOPES` (`packages/contracts/src/clientRpcPermissions.ts`) does not change. The server authorizes them with `AuthOrchestrationOperateScope`, as it does other thread commands.
- UI availability follows the side-chat convention: `useEnvironmentScope(environmentId, AuthOrchestrationOperateScope)` gates Start, Send, Stop, Continue and Delete (as `SideThreadPane.tsx:81` gates Delete). A user without the scope can read a panel.
- If the lead does add an RPC method, it goes into `CLIENT_GUARDED_RPC_SCOPES` with `AuthOrchestrationOperateScope`, its client command uses `createEnvironmentRpcCommand` with `permissionAtom`, and the permission behavior tests are extended.
- A managed policy's permission-mode ceiling is always satisfied: panel turns run at the lowest mode.

### 2.9 Server model

**Contracts** (`packages/contracts`):

- Thread: optional `panel` on `OrchestrationV2AppThread` holding the roster (participant id, role, handle, model selection), `rounds`, and the state in 2.3. A panel thread also carries `lineage.sideChat: true`, `relationshipToParent: "fork"`, `forkedFrom: null`, the parent's project, branch and worktree path, the first panelist's model selection, runtime mode `approval-required`.
- Thread shell: a small `panel` summary (status and idle reason only), enough for tabs and lists.
- Run: optional `panelTurn` holding participant id, kind (`reply` or `lookup`), round number and total, who asked (`user` or a participant id, for lookups and addressed turns), outcome (2.3 step 1) and the lookup flag (`requested` or `limit_reached`). The turn's marker message carries the same participant id so the timeline can label it without joining runs.
- Commands, client-dispatchable: `panel.create` (parent thread id, new thread id, participants with role and model selection, rounds, topic message id and text), `panel.post` (thread id, message id, text), `panel.continue` (thread id). Stop, delete and archive reuse `thread.stop`, `thread.delete`, `thread.archive`.
- Command, server-only (in the internal union, excluded from `dispatchCommand`): `panel.turn.settle`, which records a turn's outcome, updates the panel state and names the next turn.
- Event: `panel.updated` with the panel state. All other changes use existing thread, run, message and turn-item events. No new turn-item type is added: passes, skipped turns, round dividers and lookup notes are drawn by clients from `panelTurn` on runs.
- Environment capability `panelChats: true` beside `sideChats` (`packages/contracts/src/environment.ts:102`), so clients hide entry points on older servers.
- Provider snapshot: per instance, whether it may be a panelist and whether it may be the code agent.

**Why `lineage.sideChat: true` is kept.** About twenty server and client places already treat that flag as "hidden child conversation that lives with its parent": thread lists and search exclude it (`isListedThreadLineage`, `ThreadSearch.ts`), delete, archive and unarchive cascade to it (`Orchestrator.ts:1922`, `15771`), checkpoints are skipped, thread details and mobile list it. A panel wants every one of those. Clients older than this feature see a panel as a side chat they can read. The `panel` field is what makes it a panel.

**Services** (`apps/server/src/orchestration-v2`):

- `PanelChatService`: `create`, `post`, `continue`, plus the pure pieces: the scheduler (next state and next turn from panel state and a settled turn) and the prompt builder. The WebSocket handler decodes, calls one method, maps errors. MCP tools can call the same methods later.
- A panel turn reactor, in the style of `DelegatedTaskQuestionReactor` and `PullRequestWatchReactor`: it follows terminal run events on panel threads (replaying persisted events first, so it also settles after a restart), issues `panel.turn.settle`, and dispatches the next turn. Command ids derive from the panel thread id and turn ordinal, so a retry never starts a turn twice. It also owns the reply time limit and the automatic decline of requests.
- Runtime policy: for a panel thread `RuntimePolicyV2.resolve` returns the read-only policy of 2.5.
- Turn start: for a panel turn, `ProviderTurnStartService` sends the composed prompt in place of the marker message, and the provider session is opened without an MCP credential.
- Command policy: on a panel thread the server rejects client `message.dispatch` (with "Update the app to post in a panel chat."), `thread.fork`, `thread.merge_back`, `checkpoint.rollback`, `provider.switch`, runtime-mode, interaction-mode and model-selection changes, and queue commands.
- `t3_thread_read` on a panel thread leaves the marker messages out and prefixes each participant message with its handle and name, so the parent agent can tell who said what. This is model-facing text; `evals/README.md` applies.

### 2.10 Persistence and failure handling

| Situation | Behavior |
|---|---|
| Reload, reconnect, another device | The panel is a thread: transcript, roster and state come from projections. |
| Server restart, panel idle | Unchanged. |
| Server restart, reply in flight | Existing recovery retires the lost run. The panel goes idle with `interrupted`; the partial reply stays, marked cut off. Nothing restarts by itself. Continue resumes with the next panelist. |
| Restart between settling a turn and starting the next | Same: idle, `interrupted`. |
| Provider error on a turn | Turn marked `failed` with the provider's message under the speaker's name; the panel moves to the next turn. |
| Usage limit | Turn marked `limited` with the provider's explanation; next turn. No "Resume at reset" and no snooze for panels. |
| Provider or model unavailable at turn time | Turn marked `unavailable`; next turn. |
| Reply exceeds 5 minutes | Interrupted, partial text kept, `timed_out`; next turn. |
| A whole round with no reply | Run of rounds ends: `all_passed` or `no_replies`. |
| Code agent fails | Its turn is skipped like any other; the discussion continues without the answer. |
| Parent thread busy | No effect. The panel runs beside it, as side chats do. The code agent may read files the parent's agent is editing. |
| Parent archived | Panels are archived and their running reply stopped (existing side-chat cascade). Unarchive restores them, idle with `stopped`. |
| Parent deleted | Panels are deleted (existing cascade). |
| Tab or app closed while running | The run of rounds finishes on the server. Thread details shows it as running. |
| `panel.create` fails | Nothing is created; the dialog stays open with the error. |
| Post fails | The text stays in the composer; an error toast shows. |
| Client older than the server | Sees the panel as a side chat it can read; posting is refused with a clear message. |
| Server older than the client | Capability absent: no panel entry points. |

### 2.11 Math and exploit pass

**Per turn** (4 characters ≈ 1 token):

| Part | Size |
|---|---|
| Framing and roster | ≈ 1,500 characters ≈ 400 tokens |
| Transcript window | ≤ 24,000 characters ≈ 6,000 tokens |
| Prompt T3 controls | ≤ ≈ 6,400 tokens |
| Provider's own system prompt and tool list | not controlled by T3; roughly 5k to 20k tokens, usually a cache hit after the first turn |
| Reply | ≈ 350 tokens at 250 words, plus the model's reasoning at its effort level |

**Per user action:**

| Setup | Panelist replies | Code lookups by panelists | T3-controlled prompt tokens, worst case |
|---|---|---|---|
| Default: 3 models × 2 rounds | 6 | ≤ 4 | ≤ ≈ 38k (first run in practice ≈ 12k, the transcript starts small) |
| Smallest: 2 models × 1 round | 2 | ≤ 2 | ≤ ≈ 13k |
| Largest: 5 models × 5 rounds | 25 | ≤ 10 | ≤ ≈ 160k |
| Addressed post to one model | 1 | ≤ 1 | ≤ ≈ 6.4k |

A code lookup is agentic and is the most expensive turn: typically 10k to 60k tokens, bounded by the 5-minute limit. Choosing a small, fast model for the code agent is the user's lever; the setup form makes that a separate choice.

**Exploits and counters:**

| Risk | Counter |
|---|---|
| Models keep each other talking forever | Turns come only from the queue a human action filled. Models cannot add panelist turns. |
| Panelist and code agent ping-pong | The code agent's replies trigger nothing. |
| A panelist spams `@code` | One lookup per reply, two per round. Extra requests are noted, not run. |
| A reply that never ends, or a panelist that explores the repo with read tools | 5-minute reply limit. |
| A participant edits files or runs commands | Read-only policy per adapter (2.5); only "Enforced" providers can be the code agent. |
| A participant starts a full-access agent through T3's tools | Panel sessions get no T3 MCP server. |
| A participant forges another speaker or the user in its text | Message bodies are tagged by the server and closing tags in bodies are neutralized. |
| Text in the repo instructs the code agent to change things | It has no write path. |
| Overnight spending after a usage limit resets | Auto-resume and snooze do not apply to panels. |
| A turn waits forever on an approval | Requests are declined or dismissed by the server. |
| Double start of a turn after a retry or restart | Deterministic command ids; nothing auto-starts after a restart. |
| The user holds down Continue | Continue exists only while idle. |
| Filler replies that burn the cap | `PASS`, and the round that ends early when all pass. |

**Feeling.** The user should feel they are watching a real exchange they control: they always know who speaks next, how much is left, and that one click stops it.

---

## 3. What must be preserved

### 3.1 Verified facts (from the code)

1. Side chats are forks flagged `lineage.sideChat` created by `thread.fork` with `sideChat: true` (`ThreadForkService.ts:118-123`, `packages/client-runtime/src/operations/commands.ts:1135`). A side chat or subagent cannot start a side chat (`ThreadForkService.ts:81-94`).
2. `isListedThreadLineage` hides subagents and side chats from thread lists (`packages/contracts/src/orchestrationV2.ts:179`).
3. Deleting, archiving and unarchiving a thread cascades to its live side chats (`Orchestrator.ts:1922-1930`, `15649-15800`, `16485`).
4. A side chat opens as a right-panel tab through `SideThreadPane`, which embeds the thread's own `ChatView` (`apps/web/src/components/chat/SideThreadPane.tsx`). "Add to chat" adds a thread context record to the parent composer draft (`SideThreadPane.tsx:87-94`).
5. Closing a side chat that never got a message deletes it; `@` mentions offer only side chats with a message (`packages/client-runtime/src/composerThreadItems.ts:49-54`).
6. Thread details lists side chats in their own section through `ThreadRelationshipsPanel` (`ThreadRelationshipsControl.tsx:629-636`, `1126-1145`), toggled by the `sideChats` details item (`threadDetailsItems.ts:27`).
7. The right-panel launcher and **+** menu offer Side chat with shortcut letter `S`; letters `B T F D P L M S` are taken (`RightPanelTabs.tsx:362-434`).
8. `/side` and `/btw` are whole-message composer commands (`packages/shared/src/composerTrigger.ts:154`).
9. Mobile lists a thread's side chats above the composer and opens each as a normal thread (`apps/mobile/src/features/threads/ThreadSideChatsRow.tsx`).
10. A run can carry its own model selection and start a fresh provider session (`message.dispatch` fields `modelSelection`, `freshContext`; `OrchestrationV2Run.freshContext`, `orchestrationV2.ts:829`).
11. A user message row draws a "New session" divider for `freshContext` and a model-switch divider (`TimelineUserMessageRow.tsx:267-279`, `V2LifecycleRow.tsx:645-672`). Panels must not show these on every turn.
12. The model picker supports a disabled reason per model (`ModelPickerContent.tsx:363`, `getModelDisabledReason`).
13. Retained events must stay decodable; changing a schema affects stored history (`docs/internals/overview.md`, "Durable intent and side effects").
14. Text sent to agents and text authored by the server stay English (`docs/internals/i18n.md`).

### 3.2 Must not change

- Side chats: creation, context inheritance, tab behavior, deletion of unused ones, labels, "Add to chat", mobile row.
- Subagents and delegated tasks, including their approval roll-up to the parent.
- Thread lists, sidebar sections, search, pins, settle, snooze: panels never appear there.
- Ordinary threads: `message.dispatch`, queueing, steering, provider switching, checkpoints, permission modes. Panel behavior is reached only through the `panel` field on a thread.
- Existing strings: side-chat wording stays; panel strings are new keys.
- The `sideChats` capability and the meaning of `lineage.sideChat` for clients that do not know panels.
- Permission scopes and `CLIENT_GUARDED_RPC_SCOPES` entries.

### 3.3 Assumptions (to verify during planning)

A1. A `freshContext` dispatch with a different provider instance builds no cross-provider handoff (`Orchestrator.ts` near 8414-8450 suggests so). Panels need none.
A2. Thread streams on older clients tolerate an unknown event type (`panel.updated`). If they do not, carry panel state on an existing thread update event instead.
A3. Recovery after a restart leaves the in-flight run interrupted or failed and does not auto-continue a run created by the server for a panel (restart continuation must be off for panel turns).
A4. Idle compaction and title regeneration treat a `sideChat` thread in a way that suits panels; panels must be excluded from idle compaction.
A5. Cursor's plan mode performs no writes and no mutating commands.
A6. File references written as `path:LINE` in a reply are linked by the existing markdown renderer (`docs/internals/assistant-citations.md`).
A7. A running side-chat-class thread affects the parent's sidebar row the same way a running side chat does today; panels inherit that, with no new notification.
A8. An empty-text marker message is accepted by `message.dispatch` validation; if not, the marker holds a short fixed token.

---

## 4. Exact UI design

### 4.1 Design pass (frontend-design method, product continuity first)

**Subject.** A group conversation among named models inside a dense coding tool whose users watch agents all day. The job of the screen: at a glance, who is speaking, who is next, how much is left; on demand, the full roster and the stop control.

**Tokens (all existing).** Colors: `foreground`, `muted-foreground`, `border`, `accent`, `destructive`, `info`, plus `providerTextColor(driverKind)` for speaker names (`ProviderInstanceIcon.tsx:62`). Type: the app font; `text-xs` for chrome, `text-2xs` for meta, `text-sm` for rows. Shape: `rounded-lg` rows, `h-9` headers and rows, the existing `Button`, `Badge`, `Dialog`, `Popover`, `ToggleGroup`, `Textarea`, `Tooltip`, `Spinner`. Icons: lucide `UsersRound` (panel), `FileSearch` (code agent), `Plus`, `X`, `Trash2`, `Square` (stop).

**First plan, and what I changed.** The first sketch was the standard group-chat look: a colored bubble and an avatar for each model. That is the template any chat app gets, and it breaks continuity: T3 Code's agent messages are unboxed prose in a flat timeline, and its users know that timeline. Revised plan: keep the timeline exactly as it is and spend the one bold move on **a speaker line above each reply plus a round divider**, so order and cap are visible in the transcript itself. No bubbles, no avatars, no new palette, no new motion.

**Principles.** One: the transcript is a thread timeline, unchanged except for who-said-it. Two: the cap is always on screen (round divider, status bar). Three: labels only, no explainer paragraphs. Four: nothing animates on its own.

**Wireframes.**

```
New panel chat                                   Panel pane (right-panel tab)
┌──────────────────────────────────────────┐     ┌────────────────────────────────────────┐
│ New panel chat                           │     │ Split the orchestrator?  [👥4] Add to   │
│                                          │     │                          chat  🗑  ✕   │
│ Models                            3 of 5 │     ├────────────────────────────────────────┤
│ 1  ◆ Claude Opus 4.5 · High       ▾   ✕ │     │                    Should we split the │
│ 2  ◇ GPT-5.1 Sol · Medium         ▾   ✕ │     │                    orchestrator file?  │
│ 3  ○ Gemini 3 Pro                 ▾   ✕ │     │ ─────────── Round 1 of 2 ───────────── │
│ + Add model                              │     │ ◆ Claude Opus 4.5                      │
│                                          │     │ Splitting helps review, but…           │
│ Code agent                               │     │ @code how many lines is Orchestrator.ts│
│ ⌕ Claude Haiku 4.5                ▾   ✕ │     │ ⌕ Code agent · asked by Claude Opus 4.5│
│                                          │     │ 17,304 lines: apps/server/…:1          │
│ Rounds   [1][2][3][4][5]  Up to 6 replies│     │ ◇ GPT-5.1 Sol                          │
│                                          │     │ I disagree with @opus-4-5 on…▍         │
│ ┌──────────────────────────────────────┐ │     ├────────────────────────────────────────┤
│ │ What should they discuss?            │ │     │ Round 1 of 2 · GPT-5.1 Sol is replying │
│ └──────────────────────────────────────┘ │     │                                 [Stop] │
│                     Cancel  [Start panel]│     │ ┌────────────────────────────────────┐ │
└──────────────────────────────────────────┘     │ │ Message the panel, @ to address…  ↑│ │
                                                 │ └────────────────────────────────────┘ │
                                                 └────────────────────────────────────────┘
```

**Self-critique, one thing removed.** A row of provider icons in the pane header (one per participant) was cut in favor of a single roster button with a count: it crowded the header at narrow widths and repeated what the speaker lines already show.

### 4.2 Entry points (web and desktop), in display order

**a. Composer slash command.** In `useComposerMenuItems` built-ins, after `/btw`:

- Label `/panel`. Description: "Start a panel chat where several models discuss a topic".
- Shown only when the environment has the `panelChats` capability and the thread could host a panel. While the thread has no first message the item shows with the description replaced by the disabled reason "Panel chats start after the first message." (the side-chat pattern).
- `/panel` or `/panel <topic>` as the whole message runs locally (like `/side`): it opens the dialog with the topic prefilled and clears the composer text. Attachments in the draft stay in the thread composer.

**b. Right panel launcher (empty state) and + menu.** One new entry after "Side chat", built with the existing `SurfaceMenuItem` and launcher action shape:

- Label "Panel chat". Launcher description: "Have several models discuss a topic." Icon `UsersRound`. Shortcut `G`.
- Disabled reason (menu): "Panel chats start after the first message." Launcher hint: "Available after the first message."
- Absent when the capability is missing or the thread is a side chat, panel or subagent.

**c. Thread details.** A "Panel chats" section directly after "Side chats", built with `ThreadDetailsSection` and the existing relationship row:

- Title "Panel chats", or "Panel chats · {count} running" when any is running.
- Row: `ThreadRelationshipIcon` with fallback icon `UsersRound`, panel title (`text-sm font-medium`, truncated), trailing status label from the existing status labels.
- Tooltip: title, then "Open panel chat".
- Click, Cmd/Ctrl-click, middle-click, Enter and the context menu behave as for side chats (`useSideThreadTrigger`).
- New details item `{ id: "panelChats", label: "Panel chats", defaultVisible: true }` in `threadDetailsItems.ts`, so it can be hidden in Settings → Appearance → Thread details.

**d. `@` in the parent composer.** A panel of this thread appears in thread matches with description "Panel chat" (side chats say "Side chat").

### 4.3 "New panel chat" dialog

Component: `Dialog`, `DialogPopup`, `DialogHeader`, `DialogTitle`, `DialogPanel`, `DialogFooter` from `components/ui/dialog`. Feature component `PanelSetupDialog` in `components/chat`. Width `max-w-lg` (32rem). One screen, no steps.

Display order:

1. **Title.** `DialogTitle`: "New panel chat". No description.
2. **Models section.**
   - Label row, `flex items-center justify-between`: "Models" (`text-xs font-medium text-muted-foreground`) and the count "{count} of 5" (`text-2xs tabular-nums text-muted-foreground`).
   - Roster list, `flex flex-col gap-0.5`. Each row is `flex h-9 items-center gap-2 rounded-lg px-2` (`pointer-coarse:h-11`):
     - Order number, `w-4 text-2xs tabular-nums text-muted-foreground`. It is the speaking order.
     - The existing `ProviderModelPicker` trigger filling the row (`min-w-0 flex-1`): provider icon, model name, effort. Clicking opens the existing picker (model list and effort column) for that slot.
     - Remove button: `Button variant="ghost" size="icon-xs"`, `X` icon, `aria-label="Remove {name}"`.
   - Add button under the list: `Button variant="ghost" size="sm"` with `Plus`: "Add model". It appends a slot and opens that slot's picker. At 5 models it is disabled with tooltip "A panel has up to 5 models."
   - In the picker, `getModelDisabledReason` returns "Already in this panel." for an exact duplicate and "This provider can't join a panel chat." for a provider that cannot be a panelist.
3. **Code agent section.**
   - Label "Code agent" (same label style).
   - Empty: a row `flex h-9 items-center gap-2 px-2` with `Button variant="ghost" size="sm"` and `FileSearch`: "Add code agent", and, right-aligned, `text-2xs text-muted-foreground`: "Reads this project's code when asked".
   - Set: one row like a roster row, with `FileSearch` (`size-3.5`) in place of the order number, the `ProviderModelPicker` trigger, and a remove button `aria-label="Remove code agent"`.
   - Picker disabled reason for providers that cannot be the code agent: "This provider can't be limited to reading, so it can't be the code agent."
4. **Rounds row.** `flex items-center gap-3`: label "Rounds"; `ToggleGroup` single-select with items `1` `2` `3` `4` `5`, default `2`, `aria-label="Rounds"`; then, right-aligned, `text-2xs tabular-nums text-muted-foreground`: "Up to {count, plural, one {{count} reply} other {{count} replies}}", where count is models × rounds, updated as either changes.
5. **Topic.** `Textarea`, 3 rows, grows to 8, `aria-label="Topic"`, placeholder "What should they discuss?". Over 8,000 characters: `text-xs text-destructive` under it, "Keep the topic under 8,000 characters."
6. **Footer.** `DialogFooter`, right-aligned: `Button variant="ghost"` "Cancel"; `Button` (default variant) "Start panel".

States and interaction:

- **Defaults.** Roster = the last roster started in this environment from this client (a per-client preference), minus models no longer available. First time: the thread's current model as slot 1. Rounds: last used, else 2. Topic: from `/panel`, else empty.
- **Draft.** Closing with Cancel or Esc keeps roster, rounds and topic in memory for that thread until a panel starts or the page reloads.
- **Initial focus.** The topic when the roster has 2 or more models, else "Add model".
- **Keyboard.** Tab order follows display order. In the topic, Enter starts the panel when valid and Shift+Enter adds a line. Esc closes.
- **Disabled.** "Start panel" is disabled until there are 2 or more models and a topic; its tooltip gives the first unmet reason: "Add at least 2 models." or "Enter a topic.". Without the operate scope the entry points are disabled, so the dialog does not open.
- **Loading.** After Start: the button shows `Spinner` and "Starting…", all controls disabled.
- **Success.** The dialog closes, the panel opens as a right-panel tab (or the main view, per the existing setting) and focus moves to the panel composer.
- **Error.** The dialog stays open; a toast (`toastManager`, type error) titled "Could not start the panel chat" carries the server's message.
- **Empty provider list.** If fewer than 2 eligible models exist in the environment, the Models section shows `text-xs text-muted-foreground`: "Connect at least two models to start a panel chat." and Start stays disabled.
- **Responsive.** Under 640px viewport width the dialog takes the full width with 16px side margins (existing `DialogPopup` behavior); the Rounds summary drops to its own line under the toggle group.

### 4.4 Panel pane (right-panel tab)

**Tab.** Icon `UsersRound` (`size-3`) in place of the side-chat icon; the existing static dot while running; title = the panel title. Accessible name: "{title}, running" while running. The tab context menu is unchanged ("Open in main view", close actions).

**Pane.** `PanelThreadPane`, or a panel branch of `SideThreadPane`, with `data-side-chat-pane` kept so pane-scoped shortcuts behave as in side chats. `flex h-full min-h-0 flex-col`. Regions top to bottom:

**1. Header.** Same bar as the side chat: `flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3`.

- Title: `h2`, `min-w-0 flex-1 truncate text-xs font-medium`.
- Roster button: `Button variant="ghost" size="xs"`, `UsersRound` and the participant count, `aria-label="Participants"`. Opens a `Popover` (`w-72`):
  - Heading "Participants" (`text-xs font-medium`).
  - One row per panelist, `flex h-8 items-center gap-2`: order number, `ProviderInstanceIcon` (`size-4`), name (`text-sm truncate`), handle (`text-2xs text-muted-foreground`).
  - Code agent row last: `FileSearch`, name, `@code`, and `Badge variant="outline" size="sm"`: "Code".
  - Footer line, `text-2xs text-muted-foreground`: "Rounds: {rounds}".
- "Add to chat": `Button variant="ghost" size="xs"`. Tooltip: "Adds this panel chat to the main thread's next message."
- Delete: `Button variant="ghost" size="icon-xs"`, `Trash2`, `aria-label="Delete panel chat"`. Disabled without the operate scope or while deleting.
- Close: `Button variant="ghost" size="icon-xs"`, `X`, `aria-label="Close panel chat"`. Closing never stops or deletes a panel.

Delete confirmation (when the existing "confirm thread delete" setting is on): `Delete panel chat "{title}"?` and the existing line "This permanently clears its conversation history.", destructive variant. Failure toast: "Could not delete the panel chat".

**2. Transcript.** The thread's own timeline through the embedded `ChatView` (virtualized list, markdown, streaming, minimap, copy, timestamps: all existing). Panel-specific row rules:

| Entry | Rendering |
|---|---|
| Topic and user posts | The existing user message row. No "New session" divider and no model-switch divider. |
| Round start (open runs only) | `TimelineSystemDivider`, neutral: "Round {round} of {total}". |
| Participant turn | A **speaker line**, then the existing assistant rows for that run. The marker message itself is never shown. |
| Code agent turn | Speaker line with `FileSearch`, then existing rows, including the existing collapsed tool-activity rows that show what it read. |
| Pass | `TimelineSystemDivider`, neutral: "{name} passed". No body. |
| Failed turn | `TimelineSystemDivider`, tone danger: "{name} could not reply", detail = the provider's message. |
| Usage limit | Tone danger: "{name} hit a usage limit", detail = the provider's explanation. |
| Unavailable | Tone danger: "{name} is unavailable". |
| Time limit | Neutral, after the partial reply: "{name} was stopped after 5 minutes". |
| Stopped by the user | The partial reply with the existing interrupted status badge. |
| Lookup limit | Neutral, after the asking reply: "Code agent not called", detail "2 lookups already used this round". |

**Speaker line** (`PanelSpeakerRow`, a feature component in `components/chat`): `flex items-center gap-1.5 px-1 pt-3 pb-1`.

- `ProviderInstanceIcon`, `size-3.5` (code agent: `FileSearch`, `size-3.5`, `text-muted-foreground`).
- Name: `text-xs font-medium`, colored with `providerTextColor(driverKind)`; falls back to `text-foreground`. The code agent's name reads "Code agent" followed by its model name in `text-2xs text-muted-foreground`.
- Suffix, `text-2xs text-muted-foreground`, only when someone asked: "asked by {name}" or "asked by you".
- The line appears when the turn starts, so with the existing working row under it the user sees who is about to reply before the first word.

Assistant message actions in a panel: copy and timestamp stay; the fork action and the quote-reply action are hidden.

Loading, missing and archived states are the thread's existing ones. Deleted panel: `p-3 text-xs text-muted-foreground`, "This panel chat was deleted."

**3. Status bar.** `PanelStatusBar`, composed from the `ComposerBanner` slots (the documented pattern for composer notices, `docs/internals/web-ui.md`), neutral variant, compact density, with `role="status"` and `aria-live="polite"`. Text left, one action right.

| State | Text | Action |
|---|---|---|
| Running, open run, panelist | "Round {round} of {total} · {name} is replying" | **Stop** |
| Running, code lookup | "Round {round} of {total} · Code agent is looking it up" | **Stop** |
| Running, addressed run | "{name} is replying" (code agent: "Code agent is looking it up") | **Stop** |
| Running, user post waiting | the running text, then " · your message is next" | **Stop** |
| Stop pressed | "Stopping…" | button disabled with `Spinner` |
| Idle, `rounds_done` | "Paused after {count, plural, one {{count} round} other {{count} rounds}}" | **Continue** |
| Idle, `answered` | "Waiting for you" | **Continue** |
| Idle, `all_passed` | "Settled: everyone passed" | **Continue** |
| Idle, `stopped` | "Stopped" | **Continue** |
| Idle, `interrupted` | "Interrupted by a restart" | **Continue** |
| Idle, `no_replies` (danger variant) | "Stopped: no one could reply" | **Continue** |

- Stop: `Button variant="ghost-destructive" size="xs"` with `Square` (`size-3 fill-current`) and the label "Stop".
- Continue: `Button variant="ghost" size="xs"`, label "Continue". Tooltip: "Runs {rounds, plural, one {{rounds} more round} other {{rounds} more rounds}}: up to {count, plural, one {{count} reply} other {{count} replies}}."
- Without the operate scope both are disabled with tooltip "You don't have permission to run agents in this environment."
- A failed Stop or Continue shows a toast: "Could not stop the panel chat" / "Could not continue the panel chat".

**4. Panel composer.** The existing composer surface and prompt editor, reduced to text:

- Placeholder: "Message the panel, @ to address a model".
- Removed in panels: model picker, effort, permission mode, plan mode, attachments, voice, stash, queue controls, slash commands (a leading `/` is plain text).
- Primary action is always Send, also while a reply is running (Stop lives in the status bar). Send tooltip: with no mention, "Send to everyone: starts {rounds, plural, one {{rounds} round} other {{rounds} rounds}}"; with mentions, "Send to {names}".
- Enter sends, Shift+Enter adds a line, following the user's existing composer send setting.
- `@` opens the existing command menu listing participants only: icon, name, and the handle as description; the code agent shows "Code agent" and "@code". Choosing one inserts the handle and a space as plain text.
- Disabled send: empty text. Over 8,000 characters: the existing prompt-length notice style with "Keep panel messages under 8,000 characters."
- Send failure: toast "Could not send to the panel"; the text stays.
- Archived panel or no operate scope: the existing read-only treatment in place of the composer.

**Responsive.** The right panel is resizable. Under 360px pane width: the title truncates first; "Add to chat" keeps its label; the status bar wraps to two lines (text, then the action) as `ComposerBanner` already does. No horizontal scrolling at any width.

**Keyboard and focus.** Tab order: header controls, transcript, status-bar action, composer. Opening a panel focuses its composer. Pane-scoped shortcuts follow the side-chat rules (`useChatShortcuts`). Esc in the roster popover returns focus to its button.

**Accessibility.** Speaker name and role are text, never color alone. The status bar announces changes politely; one announcement per turn boundary, none per token. Icons-only buttons have the labels above. Divider rows are text. Nothing new animates, so reduced motion needs no extra rule.

### 4.5 Main view

A panel opened in the main view (Cmd/Ctrl-click, middle-click, or the existing setting) is the same thread in the main `ChatView`: the same transcript rules, status bar and panel composer. The existing parent link shown for side chats is shown with the `UsersRound` icon. Header actions are limited as for side chats, plus the roster button and "Add to chat".

### 4.6 In the parent thread

- The thread context chip for a panel uses `UsersRound` and the panel's title.
- A sent message's link to a panel opens it like a side-chat link.

### 4.7 Mobile (minimum)

1. **List.** A second row above the composer, same layout as `ThreadSideChatsRow`, shown only when the thread has panels: symbol `person.3` (size 12), label "Panel chats", one chip per panel with its title. Accessibility label: "Open panel chat {title}" or "Open panel chat {title}, running". Tapping opens the panel as a thread (inspector where the layout has one, else full screen), as side chats do.
2. **Read.** The thread screen for a panel shows the transcript live with the same row rules: a speaker line (provider icon and name; code agent with the `doc.text.magnifyingglass` symbol), round dividers, pass and failure lines with the same strings. Marker messages are not shown.
3. **Control.** The composer is replaced by a bar: lead "Panel chat", the status text from 4.4, and one button, **Stop** while running or **Continue** while idle, gated by the operate scope.
4. **Not on mobile in v1:** creating a panel, posting, the roster list, `/panel` in the command menu.

Older mobile builds list a panel as a side chat and can read it; sending from them is refused with "Update the app to post in a panel chat."

### 4.8 Every new string (English source)

Web and desktop:

| Where | String |
|---|---|
| Slash item | `Start a panel chat where several models discuss a topic` |
| Launcher and menu label | `Panel chat` |
| Launcher description | `Have several models discuss a topic.` |
| Disabled reason | `Panel chats start after the first message.` |
| Launcher hint | `Available after the first message.` (existing key) |
| Details section | `Panel chats` · `Panel chats · {count} running` |
| Row hint | `Open panel chat` |
| Mention description | `Panel chat` |
| Dialog | `New panel chat` · `Models` · `{count} of 5` · `Add model` · `Remove {name}` · `A panel has up to 5 models.` · `Already in this panel.` · `This provider can't join a panel chat.` · `Code agent` · `Add code agent` · `Reads this project's code when asked` · `Remove code agent` · `This provider can't be limited to reading, so it can't be the code agent.` · `Rounds` · `Up to {count, plural, one {{count} reply} other {{count} replies}}` · `Topic` · `What should they discuss?` · `Keep the topic under 8,000 characters.` · `Cancel` · `Start panel` · `Starting…` · `Add at least 2 models.` · `Enter a topic.` · `Connect at least two models to start a panel chat.` · `Could not start the panel chat` |
| Header | `Participants` · `Code` · `Rounds: {rounds}` · `Add to chat` (existing) · `Adds this panel chat to the main thread's next message.` · `Delete panel chat` · `Close panel chat` · `Delete panel chat "{title}"?` · `Could not delete the panel chat` · `This panel chat was deleted.` |
| Transcript | `Round {round} of {total}` · `asked by {name}` · `asked by you` · `Code agent` · `{name} passed` · `{name} could not reply` · `{name} hit a usage limit` · `{name} is unavailable` · `{name} was stopped after 5 minutes` · `Code agent not called` · `2 lookups already used this round` |
| Status bar | `Round {round} of {total} · {name} is replying` · `Round {round} of {total} · Code agent is looking it up` · `{name} is replying` · `Code agent is looking it up` · `{status} · your message is next` · `Stopping…` · `Paused after {count, plural, one {{count} round} other {{count} rounds}}` · `Waiting for you` · `Settled: everyone passed` · `Stopped` · `Interrupted by a restart` · `Stopped: no one could reply` · `Stop` · `Continue` · `Runs {rounds, plural, one {{rounds} more round} other {{rounds} more rounds}}: up to {count, plural, one {{count} reply} other {{count} replies}}.` · `You don't have permission to run agents in this environment.` · `Could not stop the panel chat` · `Could not continue the panel chat` |
| Composer | `Message the panel, @ to address a model` · `Send to everyone: starts {rounds, plural, one {{rounds} round} other {{rounds} rounds}}` · `Send to {names}` · `Keep panel messages under 8,000 characters.` · `Could not send to the panel` |
| Tab | `{title}, running` |

Mobile: `Panel chats` · `Open panel chat {title}` · `Open panel chat {title}, running` · `Panel chat` · the transcript and status strings above · `Stop` · `Continue`.

Short labels that need `$context`: `Code` (badge: role of the code agent), `Stop` and `Continue` (buttons: the panel discussion), `Stopped` (panel status), `Rounds` (noun: discussion rounds), `Models` (noun: AI models in the panel).

Stay English (not translated): prompts, `PASS`, handles, model and provider names, provider error text, the server's refusal messages. The panel's first title is the first 60 characters of the topic until the existing title generator replaces it, so no fixed English title is stored.

### 4.9 Languages and docs

- After wrapping strings: `vp run i18n:generate` in `apps/web` and `apps/mobile`, translate the new keys in every locale file under `apps/{web,mobile}/src/i18n/translations`, and pass `vp run i18n:check`. No marketing-site copy changes.
- `docs/user/thread-sidebar.md`:
  - In "Open a thread beside the one you are in", name panel chats beside side chats in the first sentence, and say the "Open subagents and side chats in" setting covers them.
  - New section after "Side chats":

    > ## Panel chats
    >
    > A panel chat lets several models discuss a topic while you watch and steer. It belongs to the thread you start it from and does not add to that thread.
    >
    > On web and desktop, type `/panel` and your topic, or choose **Panel chat** from the **+** menu in the right panel. Pick two to five models, set how many rounds they get, and start. In each round every model replies once, in order. The panel pauses when the rounds are used up; choose **Continue** for more, or **Stop** at any time.
    >
    > Send a message to the panel to steer it. Everyone answers a plain message. Start it with `@` and a model's name to have only that model answer.
    >
    > Add a **Code agent** to let the panel check the project's code. It only reads. A model asks it by starting a line with `@code`, and you can ask it the same way. Codex, Claude and OpenCode can be the code agent.
    >
    > Models in a panel cannot edit files or run commands, and they do not see the thread's conversation: put what they need in the topic. Pi and ACP Registry agents cannot join a panel.
    >
    > To use the result, choose **Add to chat** at the top of the panel. Find a panel again under **Panel chats** in thread details. Deleting or archiving the thread does the same to its panels.
    >
    > On mobile you can read a thread's panels and stop or continue them.

- Internal docs: one short paragraph where thread lineage is described (`docs/orchestration-v2/thread-lineage-and-context-transfer.md`, "Data Ownership") stating that a panel is a side-chat-class thread with a roster, that its turns are fresh sessions fed a server-composed prompt, and that panel sessions never receive the T3 MCP server. Nothing else needs an internal page.

### 4.10 What to inspect at acceptance

Viewports: desktop 1920×1080 and 1366×768 with the right panel at its default width and at its minimum; web at 390×844 (dialog and pane); mobile on one iOS and one Android layout.

States: dialog (first use, remembered roster, 5 models, validation errors, starting, start error, no eligible models); pane (running open run, running lookup, running with a queued user post, each idle reason, stopping, deleted, archived, no permission); transcript (round dividers, speaker lines for two models of the same provider, code agent turn with tool activity, pass, failed, usage limit, time limit, lookup limit, a 200-message transcript scrolling smoothly); thread details section with a running panel; mobile list row, transcript and control bar.

---

## 5. Acceptance criteria

**Creation and entry points**

1. With the `panelChats` capability, a server thread with at least one message offers `/panel` in the composer slash menu, "Panel chat" in the right-panel launcher (shortcut `G`) and **+** menu. A draft thread shows them disabled with "Panel chats start after the first message."
2. Side chats, panels, subagent threads and delegated threads offer no panel entry point, and the server rejects `panel.create` with such a parent.
3. On a server without the capability, no panel entry point appears.
4. `/panel some topic` opens the dialog with "some topic" in the topic field and clears the composer text.
5. "Start panel" is disabled with fewer than 2 models or an empty topic, with the stated tooltip. The server rejects fewer than 2 or more than 5 panelists, more than one code agent, rounds outside 1 to 5, an empty or over-8,000-character topic, an exact duplicate panelist, and an ineligible provider for a role.
6. The same model with a different effort can be added twice; the two get different handles and distinguishable names.
7. Starting a panel creates one hidden thread, opens it as a right-panel tab, and the first panelist's reply begins streaming without further input.
8. The next time the dialog opens in that environment, it is prefilled with the roster and rounds last started.

**Turn-taking**

9. With 3 panelists and rounds 2, exactly 6 panelist turns run in roster order (1, 2, 3, 1, 2, 3), then the panel is idle with "Paused after 2 rounds".
10. Each participant's prompt contains the topic and the earlier replies of the others, labelled by handle, and names the participant itself. The composed prompt appears in no stored message and no websocket payload sent to clients.
11. A reply that is exactly `PASS` shows "{name} passed" and no message body. When all panelists pass in one round, the panel becomes idle with "Settled: everyone passed" and later queued turns do not run.
12. Continue from idle runs `rounds` more rounds starting with the panelist after the last one who spoke. Continue is not offered while running.
13. A post without mentions made while idle starts `rounds` rounds. A post that mentions two panelists makes exactly those two reply once each, in roster order, then the panel is idle with "Waiting for you".
14. A post made while a reply is streaming appears at once, does not cut the reply off, and replaces the remaining queue when that reply ends; the status bar shows "your message is next" meanwhile.
15. A panelist mentioning another panelist's handle changes no turn order.
16. Stop cuts the streaming reply, keeps its partial text, runs no further turn, and leaves the panel idle with "Stopped". Continue then works.
17. A turn that fails, hits a usage limit, or whose provider is unavailable shows the matching line with the participant's name, and the next queued turn runs. A round in which no panelist replies ends the run with "Stopped: no one could reply".
18. A turn still running after 5 minutes is interrupted, shows its partial text and "{name} was stopped after 5 minutes", and the next turn runs.
19. No panel turn ever starts without a preceding user action (start, Continue, post), except a code lookup requested inside such a run.

**Code agent**

20. In a panel with a code agent, a panelist reply containing a line that starts with `@code` is followed immediately by one code agent turn labelled "asked by {name}", before the next panelist.
21. `@code` inside a sentence (not at the start of a line) or inside a fenced code block triggers nothing.
22. A third panelist request in the same round runs no lookup and shows "Code agent not called · 2 lookups already used this round". The count resets in the next round.
23. A user post mentioning `@code` makes only the code agent reply, labelled "asked by you", and does not count against the per-round limit.
24. The code agent's reply never triggers another turn, even if it contains `@code` or a panelist handle.
25. In a panel without a code agent, panelist prompts do not mention `@code`, and `@code` lines trigger nothing.
26. Only Codex, Claude and OpenCode instances can be chosen as code agent; others show the stated disabled reason. Pi and ACP Registry instances cannot be chosen for either role.

**Read-only**

27. During any panel turn on Codex, Claude and OpenCode (1.x and 2.x), an attempt to edit a file or run a shell command fails without asking the user, and the workspace is unchanged (covered by adapter-level tests of the read-only policy per adapter).
28. During a panel turn on Grok, Kiro, fx, Antigravity, Muse and Cursor, every write or command request that reaches T3 is declined automatically and no approval prompt appears anywhere in the UI.
29. Panel provider sessions are opened without the T3 MCP server: `delegate_task`, `t3_thread_launch` and the other T3 tools are not available to participants.
30. No checkpoint is captured for a panel thread, and a panel thread never shows approval or question prompts.
31. On a panel thread the server rejects client `message.dispatch`, fork, merge-back, rollback, provider switch, and model, permission-mode and interaction-mode changes.

**Persistence and lifecycle**

32. After a page reload and after a server restart, an idle panel shows the same transcript, roster and status.
33. After a server restart during a streaming reply, the panel is idle with "Interrupted by a restart", the partial reply is kept, and no turn starts until the user continues.
34. Deleting the parent thread deletes its panels. Archiving the parent archives them and stops a running reply; unarchiving restores them idle.
35. Closing the panel tab neither stops nor deletes the panel; thread details still lists it, with "running" while it runs.
36. Panels never appear in the sidebar, thread search or message search.

**Transcript and UI**

37. Every participant reply is preceded by a speaker line with the provider icon and the participant's name; code agent turns show the `FileSearch` icon and "Code agent". No reply can be read without its speaker being visible directly above it.
38. A panel transcript shows no "New session" divider and no model-switch divider, and never shows the marker messages.
39. Open runs show "Round {n} of {total}" at each round start; addressed runs show none.
40. The status bar text and action match the table in 4.4 for every state, and change only at turn boundaries.
41. The roster popover lists every participant with order, name and handle, marks the code agent, and shows the rounds cap.
42. "Add to chat" adds the panel to the parent composer; after sending, the parent's agent can read the transcript with each message attributed to its speaker.
43. The `@` menu in the panel composer lists only this panel's participants and inserts the handle as text.
44. A transcript of 200 replies scrolls without dropped frames on the reference desktop viewport, and the feature adds no continuously running animation.
45. Every string in 4.8 is present and translated in every web and mobile locale, and `vp run i18n:check` passes.

**Mobile**

46. On mobile, a thread with panels shows a "Panel chats" row; tapping a chip opens the panel with speaker lines, live streaming and a Stop or Continue button that works.
47. Mobile offers no way to create a panel or post into one, and the app does not crash or mislabel when a thread has both side chats and panels.

**Regressions**

48. Side chats behave exactly as before: `/side`, `/btw`, context inheritance, tab, unused deletion, "Add to chat", the "Side chats" details section (which lists no panels), and the mobile "Side chats" row (which lists no panels).
49. Ordinary threads, subagents, delegated tasks, queueing, steering and provider switching are unchanged; existing orchestration tests pass untouched.
50. A client that predates the feature can open a panel as a side chat and read it without errors; its attempt to send is refused with "Update the app to post in a panel chat."
51. A user without the orchestration operate scope can read a panel but cannot start, post, stop, continue or delete one, in the UI and at the server.
52. `docs/user/thread-sidebar.md` contains the "Panel chats" section and the updated "Open a thread beside the one you are in" sentence.

---

## 6. Open questions

1. **Should participants start with the parent thread's conversation?**
   Designed: no, topic only. Reasons: cost stays predictable (a thread's context can be far larger than a panel's whole window, multiplied by every turn of every model); all participants start equal (only the model sharing the parent's provider could get the real context, the rest a lossy summary); and the user's request already names the grounding mechanism, the code agent.
   **Recommendation:** ship topic-only. If users ask, add one switch in the dialog later, "Include this thread's recent messages", that puts a bounded digest (about 8,000 characters, the size side chats use) into the shared briefing.

2. **Providers left out of panels in v1.**
   Designed: Pi and ACP Registry agents cannot join at all; Cursor, Grok, Kiro, fx, Antigravity and Muse can be panelists but not the code agent; the code agent is Codex, Claude or OpenCode.
   **Recommendation:** accept this conservative set. The requirement is that participants cannot change the workspace, and these are the cases where T3 cannot guarantee it (or, for Cursor, where the guarantee is unverified). Widen per provider when the lead or a later change proves enforcement.

3. **Mobile scope.**
   Designed: list, read live, Stop and Continue; no creating and no posting.
   **Recommendation:** accept for v1. Reading and stopping cover the remote-control need (cost control from the phone). Posting needs a panel composer on mobile and is the natural next step.
