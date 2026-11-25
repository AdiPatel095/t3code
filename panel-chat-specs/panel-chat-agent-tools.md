# Panel chat for agents: requirement specification

Status: **requirement specification, rev 1** (director, Claude Opus 5.5, 2026-11-24). Authoritative. Derived from the designer's document `E:\t3code-specs\panel-chat-agent-tools-design.md` (Claude Fable 5.2, effort high); sections 1 to 5 below are adopted from it unchanged unless section 6 says otherwise, and section 6 records the director's settled decisions. There are no open questions. Where this file and the design document differ, this file wins.

**User request (verbatim):** "lets have this panel chat be spawnable by agent and have it shipped to t3code on mac and then continue the work on this". Immediate use after delivery: an agent on the user's Mac starts a panel on an Outer Realms strategy topic with a code agent that reads that machine's files.
Repository: `E:\t3code`, branch `feat/panel-chat` (head `be7d897796`). Builds on `E:\t3code-specs\panel-chat.md` (rev 2.1, "the panel spec"). Specs stay outside the repository (`AGENTS.md`, "Plans and work artifacts").

**Skills used.**
- `product-vision-and-ideation`: read with `owner-patterns.md`, `product-looks.md` and `references/ui-design.md`. Applied: reference and delta (section 1.4), the math and exploit pass (2.12), taste (cut list in 1.6, one tool instead of five), pilot/later split (1.5, 1.6), locked decisions checked (section 3). `references/game-design.md` was not read: this is not a game feature.
- `frontend-design`: not in this session's skill list, so it was read from disk (`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md`) and applied to the one UI surface this feature touches (section 4): product continuity first, restraint, and its writing rules for the row wording.

**Words used here.** *Caller*: the agent that calls the tool. *Parent*: the thread a panel is attached to. *Run*: the turns one action starts (the panel spec's "run of rounds"). *Linked environment*: another machine reached with `environmentId`, here the user's Mac.

---

## 1. Goal and scope

### 1.1 User problem

An agent working in a T3 thread (for example a director researching a game strategy) often needs a second opinion from several models. Today only a person can start a panel, from the UI. The agent must be able to start one itself on a topic it writes, choose the models and the code agent, let it run, read the conclusion, and follow up, on this machine or on a linked one.

### 1.2 Current behavior (verified)

- Panels are created only by the client commands `panel.create`, `panel.post`, `panel.continue` (`packages/contracts/src/orchestrationV2.ts:3390-3415`), served by `PanelChatService.create/post/continue` (`apps/server/src/orchestration-v2/panel/PanelChatService.ts:55-57`). No MCP tool calls them.
- What already works for an agent on a panel thread:
  - `t3_thread_read` is panel-aware: marker messages are hidden and each reply is prefixed `[Name (@handle)]` (`apps/server/src/mcp/OrchestratorMcpService.ts:1608-1616`, `3608-3650`, `1219`).
  - `t3_thread_interrupt` stops a panel: an interrupted panel run settles as `stopped`, which clears the queue (`PanelScheduler.ts:302-305`); with `stop: true` it dispatches `thread.stop`, which sets the panel idle `stopped` (`Orchestrator.ts:14563-14571`).
- What does not work:
  - `t3_thread_send` to a panel is refused with "Update the app to post in a panel chat." (`ThreadManagementService.ts:832-837`), which tells an agent nothing useful.
  - `t3_thread_wait` pins the thread's latest run (`ThreadManagementService.ts:1136-1184`). A panel is many runs in a row, so the wait returns after one reply while the panel keeps going.
  - A default `t3_thread_read` page costs about 1,500 to 3,000 tokens (thread detail, 10 runs, 10 items) and cuts each item at 500 characters (`OrchestratorMcpService.ts:161-163`), so it truncates the conclusion.

### 1.3 Intended outcome

One new tool, `t3_panel`, starts a panel, posts to it and continues it. `t3_thread_wait` becomes panel-aware and returns the conclusion as one small field. Stop and full transcript stay with `t3_thread_interrupt` and `t3_thread_read`. Every tool takes `environmentId` and runs on the Mac the same way.

**Quality bar: token economy on the caller's side too.** A whole panel costs the caller one start call, a few waits and one field of about 250 tokens.

### 1.4 Reference and delta

Reference: `delegate_task` plus `t3_thread_wait` (start work, get an id, wait, read a result). Kept: ids and links, `clientRequestId`, `environmentId`, models from `orchestrator_capabilities`. Different: a panel is not a child agent. It has no tools, never sees the caller's conversation, costs a known number of turns, and its result is a conclusion in a fixed form. The tool therefore returns the conclusion itself, not a transcript to read.

### 1.5 Included (pilot)

1. `t3_panel` with actions `start`, `post`, `continue` (2.2).
2. `t3_thread_wait` on a panel waits for the run to end and returns `panel.state` and `panel.result` (2.3).
3. `t3_thread_send` to a panel answers with a pointer to `t3_panel` (2.4).
4. `orchestrator_capabilities` says which providers can sit in a panel (2.5).
5. Agent attribution on the topic and posts, so the UI shows which thread sent them (2.6, 4.2).
6. Two limits for agent-started runs (2.9).
7. Linked environments through `environmentId` (2.8).
8. Tool-row wording for `t3_panel` in the caller's timeline, in every locale (4.1).
9. Docs and eval cases (2.13).

### 1.6 Excluded

| Cut | Why |
|---|---|
| A completion wake (the panel messages the caller when it ends) | Later. It saves polls (2.12) but adds delivery state, restart rules and a cross-machine relay. See open question 3. |
| Separate `panel_status`, `panel_stop`, `panel_read` tools | `t3_thread_wait` on an idle panel returns at once with its last result; `t3_thread_interrupt` and `t3_thread_read` already work. |
| Listing or deleting panels by tool | The start result and a `clientRequestId` retry give the id. The user deletes panels in the UI. Later. |
| Roster or rounds changes after start, attachments, more than one code agent, an "unlimited" mode | Same as the UI (panel spec 1.6). |
| Any change to panel prompts, the scheduler's decisions, or the panel pane | Not needed. An agent's post reaches panelists exactly as a person's post does. |
| A T3 MCP server for panel sessions | Never (panel spec 2.5). |
| Opening the panel tab automatically when an agent starts one | Would steal focus; delegated tasks do not do it either. |

### 1.7 Constraints

- `AGENTS.md`: an MCP tool decodes input, calls one service method and maps errors; contracts live in `packages/contracts`; user-facing text ships in every locale; model-facing text follows `evals/README.md`.
- Only `McpToolAccess` builds tool declarations (`McpToolAccess.ts:44-50`).
- Every contract addition is optional, so retained events and an older linked environment still decode.
- Delivery (director, later): commit on `feat/panel-chat`, then install the branch build on the Mac. `environmentId` calls need this build on both machines.

---

## 2. Exact behavior

### 2.1 The caller's journey

1. The agent calls `orchestrator_capabilities` (with `environmentId` for the Mac) and picks providers whose `panelRoles` include the role it needs.
2. `t3_panel` `start` with `topic`, `panelists`, optional `codeAgent`, optional `rounds`. It gets `threadId`, `link` and the participants' handles. The first panelist is already replying.
3. `t3_thread_wait` on that `threadId` (`timeoutMs: 45000`), repeated while `timedOut` is true. When the run ends it returns `panel.state` and `panel.result`.
4. Optional: `post` (to all, or to `@handle`s) or `continue`, then wait again.
5. Optional: `t3_thread_interrupt` to stop; `t3_thread_read` for the whole transcript.
6. The agent names the panel by its `link` in its reply. The user opens it from that chip or from **Panel chats** in thread details, and can steer it in the UI at any time.

### 2.2 `t3_panel`

**Description** (exact text):

```
Run a panel chat: 2-5 models debate `topic` in short rounds, then the first writes a conclusion. They see only `topic`, not this thread, and have no tools. start: returns `threadId`. post: `message` to all, or to `@handle`s only. continue: more rounds. Then `t3_thread_wait` until `panel.state` is not running; `panel.result` is the conclusion. Stop: `t3_thread_interrupt`. Models from `orchestrator_capabilities`. In your reply, name it as its `link` verbatim.
```

**Annotations.** Title "Run a panel chat". `Destructive: true`, `OpenWorld: true` (it starts paid model turns, as `t3_thread_send` is marked). Not `Readonly`, not `Idempotent`. `EnabledWhen: McpInvocationContext.hiddenFromSubagents` (`McpInvocationContext.ts:193-197`), so a delegated child does not see it while outside clients and linked environments do.

**Parameters.**

| Name | Type and limits | Used by | Model-visible description (exact) |
|---|---|---|---|
| `action` | `"start" \| "post" \| "continue"`, required | all | (none) |
| `environmentId` | `OrchestratorMcpEnvironmentTarget` | all | (existing text) |
| `threadId` | `ThreadId`, optional | post, continue | `post, continue: the panel.` |
| `parentThreadId` | `ThreadId`, optional | start | `start: thread the panel attaches to. Default: yours. Required outside a thread.` |
| `topic` | string, 1 to 8,000 characters after trim | start | `start: all the panel is told. Make it self-contained. Max 8000 chars.` |
| `panelists` | array of 2 to 5 participants | start | `start: 2 to 5, in speaking order. The first also writes the conclusion.` |
| `codeAgent` | one participant, optional | start | `start: answers the panel's code questions, read-only. Codex, Claude or OpenCode. Costs the most per turn: pick a small model.` |
| `rounds` | integer 1 to 5, default 2 | start | `start: rounds per run, 1 to 5. Default 2.` |
| `message` | string, 1 to 8,000 characters after trim | post | `post: max 8000 chars. "@handle" addresses only those participants; "@code" asks the code agent.` |
| `clientRequestId` | `OrchestratorMcpClientRequestId`, optional | all | (existing text) |

A participant is `{ providerInstanceId: ProviderInstanceId (required), model: string (required), options?: OrchestratorMcpTargetOptions }`, with one description on `options`: `Omit for the lowest reasoning effort.` `panelists` and `codeAgent` also accept their JSON-text form, as `delegate_task.target` does (`orchestratorMcp.ts:173-176`).

Rules:
- `rounds` out of range clamps on decode like other numeric inputs (`clampedPositiveInt`, `orchestratorMcp.ts:349`); 0 or less fails.
- Fields that do not belong to the action are ignored, so a model that sends stray nulls is not charged a retry.
- Omitted `options` resolve to the model's lowest reasoning effort, the rule a new slot uses in the setup dialog (`apps/web/src/components/chat/PanelSetupDialog.logic.ts:46-50`). Given `options` are kept as given.
- `model` accepts a slug or an alias, as `PanelChatService.create` resolves it today (`PanelChatService.ts:172-179`).
- A panel never copies the caller's conversation. The description says so, because an agent's first mistake will be a topic that assumes context.

**Result** (all three actions, one shape):

```
{
  threadId: ThreadId,          // the panel
  link?: string,               // threadLinkFor(scope, threadId, title)
  state: "running" | "concluded" | "agreed" | "rounds_done" | "answered"
       | "stopped" | "interrupted" | "no_replies",
  handles?: string[]           // start only, in roster order, code agent last: ["@opus-4-5", "@sol", "@code"]
}
```

`state` after a successful call is `"running"`. A `clientRequestId` replay returns the panel's current state, which may be an idle one. There is no `next` string: the description already says what to do, and a repeated sentence costs tokens on every call.

**What each action does.**

| Action | Service call | Effect |
|---|---|---|
| `start` | `PanelChatService.create` | Creates the panel under the parent with `createdBy: "agent"`, `creationSource: "mcp"`, and starts an open run (rounds, then the conclusion). |
| `post` | `PanelChatService.post` | Adds the message. No valid `@handle`: an open run. With handles: one turn per addressed participant (`@code` first), no conclusion. A post while a reply is streaming lets that reply finish, then replaces the queue (panel spec 2.3, unchanged). |
| `continue` | `PanelChatService.continue` | Idle panels only. An open run starting after the last speaker. |

Handles are parsed by the existing `panelMentionedParticipantIds` (`packages/shared/src/panelChat.ts`), only in posts. A `topic` is never parsed for mentions.

### 2.3 `t3_thread_wait` on a panel

The tool's description and parameters do not change (no extra tokens for sessions that never use panels).

- **No `runId`, thread is a panel:** the wait ends when the panel is idle and has no turn in flight (`panel.status === "idle"` and `panel.current === null`), or at the timeout. An idle panel returns at once. `untilDelegatedWorkSettled` and `untilOutput` are ignored.
- **With `runId`:** unchanged (waits for that one run).
- The timeout rules do not change: default 30 s, at most 45 s (`OrchestratorMcpService.ts:147-148`), and a forwarded wait is bounded the same way (`PeerForwarding.ts:33-34`, `242-256`).

The result gains one optional field, present whenever the thread is a panel:

```
panel?: {
  state: (same literals as 2.2),
  result?: string,
  resultTruncated?: true
}
```

Annotations (exact): on `state`, `concluded, agreed: result is the conclusion. answered: result is the addressed replies. Others: no result.`; on `result`, `Written by the panel's models.`

| `state` | Meaning | `result` |
|---|---|---|
| `running` | A turn is in flight or queued. With `timedOut: true`, call again. | absent |
| `concluded` | Rounds used, conclusion written. | The text of the newest conclusion turn whose outcome is `replied`, with no prefix. |
| `agreed` | Everyone passed, conclusion written. | Same. |
| `answered` | An addressed post was answered. | The `replied` turns that came after the panel's newest user message, in order, each as `[Name (@handle)] text` (the prefix `t3_thread_read` uses), joined by a blank line. |
| `rounds_done` | Rounds used, but the conclusion turn produced no text. | absent |
| `no_replies` | No panelist could reply. | absent |
| `stopped` | Stopped by a person, an agent, or the parent being archived. | absent |
| `interrupted` | A server restart cut it. | absent |

`result` is at most 4,000 characters (named constant, **pilot**). A longer one is cut at 4,000 with `resultTruncated: true`; `t3_thread_read` has the rest. A panel that is idle with no idle reason (not observable after creation) reports `interrupted`.

The other result fields (`threadId`, `runId`, `status`, `timedOut`) keep their meaning for the latest run. `next` is never set for a panel, so the existing rule "without `next`, call again" applies.

### 2.4 `t3_thread_send` to a panel

Fails with code `invalid_request` and message:

```
Thread <id> is a panel chat. Post to it with `t3_panel` action post.
```

Nothing else about `t3_thread_send` changes. Client `message.dispatch` on a panel keeps its current refusal text for old apps.

### 2.5 How the agent picks models

`orchestrator_capabilities` is the only discovery path.

- Each provider gains optional `panelRoles: ("panelist" | "code_agent")[]`, present only when non-empty. `panelist` when the provider is usable (its `constraints` are empty) and its snapshot says `panelChat.panelist` (`packages/contracts/src/server.ts:245-250`); `code_agent` when it also says `panelChat.codeAgent`. Cursor, Pi and ACP Registry therefore carry no `panelRoles`.
- Its description becomes (exact): ``List providers, models, options, and runtime modes for `delegate_task` and `t3_panel`. Short list. `search` finds others. Any catalog model works.``
- For a linked environment the agent passes the same `environmentId` to both tools; ids are that environment's.

### 2.6 Attribution

- The topic message of an agent-started panel and every agent post are stored with `createdBy: "agent"`, `creationSource: "mcp"`, and `senderThreadId` (a thread caller here) or `linkedSender` (a linked environment's agent, from `T3-Sender-Thread`, `McpInvocationContext.ts:75-80`). Today both are stored as `createdBy: "user"` (`Orchestrator.ts:15900`, `15911`, `16186`).
- A command a client dispatches can never carry agent attribution; only the MCP path sets it.
- The panel thread carries the caller's `linkOrigin` when the caller acts for a link, so a fenced link can post to, continue and stop the panel it started (`mcp/linkOrigin.ts:49-58`).
- **Panelists are not told.** In prompts an agent's topic and posts appear as `<message from="user">`, exactly as a person's do (`PanelTranscript.ts:77-82`). The caller acts for the user, and this keeps every panel prompt byte-for-byte unchanged.

### 2.7 Who may call, and on which threads

**Callers.**

| Caller | `t3_panel` | Why |
|---|---|---|
| Agent in a top-level thread (also one started by `t3_thread_launch` or a scheduled task) | Yes | The intended caller. |
| Agent in a delegated thread (`isDelegatedAppThread`: a subagent, or a task delegated from a linked environment) | Hidden and refused | Proposal, open question 1. A panel must hang off a thread the user can see and steer from; a director with five children would otherwise fan out five times the spend; and the "no panel under a delegated thread" rule is enforced in two server places and the UI today. |
| Agent in a side chat | Refused | A side chat cannot be a parent. |
| A panel participant or the code agent | Never reaches the tool | Panel sessions get no T3 MCP credential (`ProviderSessionManager.ts:609-623`, test at `ProviderSessionManager.test.ts:1357`). As a second lock, a call whose own thread is a panel is refused. |
| Outside MCP client or linked environment, not read-only | Yes, with `parentThreadId` | Same path the Mac link uses. |
| Read-only MCP client or read-only link | Refused | Existing `refuseReadOnlyClient` (`McpToolAccess.ts:121-133`). |

**Mode rule (existing rule, applied unchanged).** A panel thread runs `approval-required` / `default`. Runtime mode is never above any caller's. A caller in **plan** interaction mode is refused on all three actions, as it is when it sends to any default-mode thread. Claude's own plan mode also blocks tools that are not read-only. `t3_thread_wait`, `t3_thread_read` stay available in plan mode.

**Live caller.** A thread caller needs a live run, as every write tool does (`threadAccess.ts:207-218`).

**Parent (start).** The existing rule, unchanged: an existing, unarchived thread that is not a panel, side chat or delegated thread, has at least one message (`PanelChatService.ts:124-133`, `Orchestrator.ts:16038-16048`), and whose worktree is set up (`Orchestrator.ts:16054-16056`). Default: the caller's own thread. An explicit `parentThreadId` must also pass the link fence (a fenced link may only use a thread it started).

**Target (post, continue).** Any panel in the environment, including one a person started, subject to the mode rule and the link fence. The limits in 2.9 apply.

### 2.8 Linked environments

- `t3_panel` takes `OrchestratorMcpEnvironmentTarget`, so `McpToolAccess.routed` forwards it without tool-specific code (`McpToolAccess.ts:403-410`, `427-470`): the caller is checked here, the rest there.
- On the linked environment the caller is a client, not a thread, so `start` needs a `parentThreadId` that exists there: one the agent launched with `t3_thread_launch` and `environmentId`, or found with `t3_thread_list`.
- The panel runs there: that machine's providers, models, project code (for the code agent) and limits. It appears there under the parent's **Panel chats**, with the sender shown as the calling thread on this machine.
- `clientRequestId` is scoped per caller before it leaves (`PeerForwarding.ts:139-143`, `188-190`), so a retry returns the same panel.
- `t3_thread_wait`, `t3_thread_read` and `t3_thread_interrupt` with the same `environmentId` work as today.
- Linked environments off: the existing refusal (`PeerForwarding.ts:83-87`). A link below full access is fenced to threads it started; a read-only link cannot start or post.
- A linked environment on a build without `t3_panel` fails the call. See assumption A2.

### 2.9 Limits

Existing, unchanged: 2 to 5 panelists, at most one code agent, rounds 1 to 5, 8,000 characters per topic and post, 2 lookups per round, 2 and 5 minute reply limits, one turn in flight per panel.

New, for agent calls only (both **pilot**, each one named constant):

| Limit | Value | Rule | Refusal (`invalid_request`) |
|---|---|---|---|
| Agent-started runs in a row, per panel | 4 | `start`, `post` and `continue` by an agent each count 1 (the start is the first). A person's post or Continue in an app resets the count to 0. The count is kept on the panel. | `This panel has had 4 agent-started runs in a row. A person must continue it in T3 Code, or start a new panel.` |
| Running agent-started panels, per parent thread | 2 | Checked at `start`: panels of that parent that were started by an agent and are running. | `This thread already has 2 agent-started panel chats running. Wait for one to finish or stop it.` |

A person's own posts and Continues are never limited. A `clientRequestId` replay does not count twice.

### 2.10 Idempotency

- `clientRequestId` derives the command id, the panel thread id and the topic or post message id from the caller and the key, as `t3_thread_send` does (`OrchestratorMcpService.ts:3769-3783`). `PanelChatService.create` already replays from the command receipt (`PanelChatService.ts:85-88`).
- A replayed `start` returns the same `threadId` and `handles` and starts nothing. A replayed `post` adds no second message. A replayed `continue` starts no second run.
- Without `clientRequestId` every call is new work.

### 2.11 Errors

All are `OrchestratorMcpFailure`. Panel rules keep the service's existing messages so the UI and agents read the same words.

| Situation | Code | Message |
|---|---|---|
| `start` without `topic` or `panelists` | `invalid_request` | ``start needs `topic` and `panelists`.`` |
| `post` without `threadId` or `message` | `invalid_request` | ``post needs `threadId` and `message`.`` |
| `continue` without `threadId` | `invalid_request` | ``continue needs `threadId`.`` |
| Fewer than 2 / more than 5 panelists | `invalid_request` | `Add at least 2 models.` / `A panel has up to 5 models.` |
| Rounds below 1 | `invalid_request` | `Choose between 1 and 5 rounds.` |
| Empty topic / too long | `invalid_request` | `Enter a topic.` / `Keep the topic under 8,000 characters.` |
| Empty post / too long | `invalid_request` | `Enter a message.` / `Keep panel messages under 8,000 characters.` |
| A participant cannot be used | `invalid_request` | `panelists[<index>]: ` or `codeAgent: ` followed by `This provider can't join a panel chat.`, `This provider can't be limited to reading, so it can't be the code agent.`, or `Already in this panel.` Index is zero-based. |
| No parent given outside a thread | `target_required` | `Pass parentThreadId: this MCP client is not running inside a T3 thread.` |
| Parent or panel id not found | `thread_not_found` | The existing `threadNotFound` text and hints (`threadAccess.ts:62-99`). |
| Parent not eligible | `invalid_request` | `Thread <id> cannot hold a panel chat. Use an unarchived top-level thread that has a message.` |
| Parent's worktree still being set up | `invalid_request` | `Start the panel chat once this thread's worktree is set up.` |
| `threadId` is not a panel | `invalid_request` | `Thread <id> is not a panel chat.` |
| Panel archived or deleted | `invalid_request` | `This panel chat is unavailable.` |
| `continue` while running / while stopping | `invalid_request` | `This panel chat is already running.` / `This panel chat is still stopping.` |
| Limits (2.9) | `invalid_request` | As in 2.9. |
| Caller is a delegated thread, side chat or panel | `capability_denied` | `Only a top-level thread's agent can run panel chats.` |
| Caller in plan mode | `interaction_mode_escalation_denied` | start: `Panel chats run in default interaction mode, above this caller's plan mode.`; post, continue: the existing `assertTargetWithinLimits` text. |
| Read-only client, dead caller run, link fence, links off | existing codes | Existing texts, unchanged. |
| Anything else | `orchestration_error` | The existing `dispatchFailure` mapping (`threadAccess.ts:108-124`). |

Failures of a running panel are not tool errors. A failed, limited, unavailable or timed-out turn is skipped (panel spec 2.10) and the wait reports the end state.

### 2.12 Math and exploit pass

**Caller-side tokens per panel** (4 characters ≈ 1 token; ballpark, to measure):

| Step | Input the caller writes | Result it reads |
|---|---|---|
| `start` | ≈ 120 + topic (≤ 2,000) | ≈ 60 |
| each `t3_thread_wait` while running | ≈ 30 | ≈ 50 |
| final `t3_thread_wait` | ≈ 30 | ≈ 50 + conclusion (≈ 250 at 150 words; hard cap ≈ 1,000) |
| compare: default `t3_thread_read` page | ≈ 30 | ≈ 1,500 to 3,000, conclusion cut at 500 characters |

**Waits per panel.** A wait lasts at most 45 s. Each wait is one model round trip that re-reads the caller's context, normally from cache.

| Panel | Turns | Likely duration | Waits |
|---|---|---|---|
| Default, 3 models × 2 rounds | 7 | 1.5 to 3 min | 2 to 4 |
| 2 models × 1 round | 3 | under 1 min | 1 to 2 |
| 5 models × 5 rounds | 26 (+ up to 10 lookups) | 9 min and up | 12 and up |
| Worst case, every reply hits its limit | 26 + 10 | 102 min | 136 |

For a caller holding a 100k-token context, four cached waits cost about as much as the default panel itself. That is the case for the completion wake (open question 3). The pilot keeps waits because they need no new delivery mechanism and work unchanged across machines.

**Tool-list cost.** `t3_panel` adds about 400 tokens (description and schema) to sessions that list every tool. Deferring clients load it only after `tool_search` (`McpToolExposure.ts:7-12`).

**Spend an agent can cause without a person:**

| Scope | Bound |
|---|---|
| One call | One run: at most 25 replies + 1 conclusion + 10 lookups (unchanged). |
| One panel | 4 runs in a row: default roster ≈ 28 turns (≈ 32k T3-controlled prompt tokens in practice); largest roster ≤ 104 panelist turns + 40 lookups. |
| One parent at a time | 2 running agent-started panels. |
| What if the cap were 3 / 6 | Default roster: 21 / 42 turns. |

**Exploits and counters.**

| Risk | Counter |
|---|---|
| A panel starts a panel, delegates, or posts to itself | No MCP credential for panel sessions (verified); a panel-thread caller is refused; a panel cannot be a parent. |
| Agent and panel keep each other going | Every run needs a tool call from the caller's own turn; 4 in a row per panel; the user can stop the caller. |
| Many panels at once (machine load, rate limits) | 2 running per parent. |
| A delegated child spends through panels | Refused and hidden (open question 1). |
| The caller writes `@code` in posts to buy lookups outside the per-round limit | Each such post is one of the 4 runs; one lookup per post. |
| A panelist writes `@handle`s | Unchanged: text only; mentions are parsed in posts alone (`Orchestrator.ts:16191-16194`). |
| A topic or post forges another speaker | Unchanged: bodies are tagged and `</message>` is neutralized (panel spec 2.4). |
| Panel text steers the caller ("now run…") | Residual, stated plainly: `panel.result` is model-written text, the same class as `t3_thread_read` output. Panelists have no tools and the code agent cannot write, so the text is the only channel; the field's annotation names its source. |
| A linked environment's agent reaches threads it should not | Existing fence: below full access it may use only threads its link started; the panel carries the link origin; read-only links cannot start or post. |
| A retry starts a second panel | `clientRequestId`. |
| A plan-mode or read-only caller starts paid work | Refused by the existing mode and access rules. |
| An expensive code agent | The parameter text steers to a small model; omitted `options` mean lowest effort. |

**Feeling.** The agent should feel a panel is a cheap, bounded question: ask, wait, get one paragraph. The user should feel nothing started behind their back: the caller's timeline says "Started a panel chat", the panel sits under **Panel chats**, and the topic shows which thread sent it.

**Cheapest test.** One real run on the dev server: two cheap models, rounds 1, started by an agent thread. Count the waits and compare the caller's token use with and without the panel.

### 2.13 Docs and evals

- `docs/orchestration-v2/orchestrator-mcp-server.md`: a `### t3_panel` section (actions, result, limits, who may call); one paragraph under `### t3_thread_wait` for the panel case; `panelRoles` under `### orchestrator_capabilities`; one bullet in "Policy And Idempotency" for the two limits.
- `docs/user/thread-sidebar.md`, "Panel chats": two sentences. Agents can start a panel when asked, it appears under **Panel chats** with the sending thread named, and after four agent-started runs in a row a person must continue it.
- `docs/user/outside-agents.md`, "What outside agents can call": one bullet (a panel needs `parentThreadId`).
- `docs/orchestration-v2/thread-lineage-and-context-transfer.md`: unchanged; "Panel sessions never receive the T3 MCP server" stays true.
- `evals/mcp-tool-use`: two cases and one control, named as guards for this feature. (a) Asked to have several models debate a question, the agent calls `orchestrator_capabilities`, then `t3_panel` `start` with a self-contained topic and 2 to 5 eligible panelists, waits with `t3_thread_wait`, and reports `panel.result` with the `link`. (b) Told to ask one panelist a follow-up, it posts with that `@handle`. Control: asked to have another agent implement something, it uses `delegate_task`, not `t3_panel`.

---

## 3. What must be preserved

### 3.1 Verified facts

1. `PanelChatService` exposes `create`, `post`, `continue` and holds all creation validation (`PanelChatService.ts:55-57`, `90-114`, `152-200`).
2. The parent rule is enforced in the service and again in `panel.open` (`PanelChatService.ts:124-133`, `Orchestrator.ts:16038-16048`).
3. Panel provider sessions are opened without a T3 MCP credential and a stale one is revoked (`ProviderSessionManager.ts:609-623`; `ProviderSessionManager.test.ts:1357`).
4. Mentions are parsed only for posts; panelist text never changes the queue (`Orchestrator.ts:16191-16194`).
5. On a panel the server refuses `message.dispatch`, fork, merge-back, rollback, provider switch, mode and model changes, queue commands and snooze (`ThreadManagementService.ts:795-872`).
6. `t3_thread_read` labels panel replies and hides markers (`OrchestratorMcpService.ts:1608-1616`, `3608-3650`).
7. An interrupted panel run settles as `stopped`; `thread.stop` sets the panel idle `stopped` (`PanelScheduler.ts:302-305`, `Orchestrator.ts:14563-14571`, `1588-1590`).
8. Tools whose parameters take `OrchestratorMcpEnvironmentTarget` are forwarded generically; `t3_thread_wait` is forwarded in pieces of at most 45 s (`McpToolAccess.ts:403-470`, `PeerForwarding.ts:281-289`).
9. Deferring clients list only `orchestrator_capabilities`, `delegate_task`, `task_status`, `tool_search` until a search loads more (`McpToolExposure.ts:7-12`). Codex's direct server holds only `t3_thread_wait` and `delegate_task` (`docs/orchestration-v2/orchestrator-mcp-server.md:66-68`).
10. The web timeline already renders a user message with `createdBy: "agent"` and a sender as a folded row with the sender's thread title and "Open thread" (`TimelineUserMessageRow.tsx:466-471`, `498`, `853-860`, `963-972`; `packages/client-runtime/src/userMessage.ts:110-116`). Mobile reads the same fields (`apps/mobile/src/features/threads/ThreadFeed.tsx`).
11. A link to a panel thread renders as a panel chip (commit `40ddda0d2f`, `MarkdownThreadLink.browser.test.tsx`).
12. Tool rows get their wording from `T3_MCP_TOOLS` and, for action tools, `ACTION_TOOLS` (`packages/shared/src/t3McpToolPresentation.ts:98-105`, `511-519`), with sentences in `packages/client-runtime/src/work-log/t3ToolSentences.ts` and group summaries in `packages/client-runtime/src/t3ToolSummary.ts`.

### 3.2 Must not change

- Everything a person does with panels in the UI: `/panel`, the setup dialog, the pane, Stop, Continue, posts, `@` addressing, mobile. A person's actions are never counted or limited.
- Panel prompts (`PanelPromptBuilder.ts`), transcript rules and sizes, and every scheduler decision in `PanelScheduler.ts`. The only state added is the agent-run count (2.9).
- The scheduler's hard guarantees, restated with the one amendment this feature requires: **no turn starts unless it is in a queue created by a person's action or by one `t3_panel` call from an agent outside the panel, or it is a code lookup counted against the per-round limit. Nothing a participant writes can add panelist turns. There is no unlimited setting.**
- Panel sessions get no T3 MCP server. No tool is exposed to a participant or to the code agent.
- Existing tools: names, parameters and descriptions of `t3_thread_wait`, `t3_thread_read`, `t3_thread_interrupt`, `t3_thread_send`, `delegate_task`; the direct-tool lists; the access rules in `McpToolAccess`. Additions are optional result fields and the two description edits in 2.5 and below.
- `tool_search` description gains one phrase (exact new text): `Load T3 Code tools you do not have yet, then call them by name. Search by name or purpose: threads (t3_thread_*), panel chats (t3_panel), projects (t3_project_*), worktrees, preview_* browser, device_*, html_preview/html_render, schedule_task, pull requests and guides, attachments, request_secret, environment links. Exact names work too.`
- Retained events stay decodable; an older linked environment still decodes every result (new fields optional).
- Side chats, subagents, delegated tasks, thread lists and search (panels stay hidden there).

### 3.3 Assumptions (lead verifies; each has a fallback)

- **A1.** `McpThreadCaller.subagent` is true for every thread `isDelegatedAppThread` covers, including a task delegated from a linked environment. Fallback: hiding is best effort; the handler's refusal decides from the thread record.
- **A2.** A forwarded call to a linked environment without `t3_panel` returns a typed failure, not a crash. Required either way: the failure names the tool. If it does not today, map it to `invalid_request`: ``The linked environment does not have `t3_panel`. Update T3 Code there.``
- **A3.** Pi's extension keeps its own copy of the direct-tool list and possibly of the `tool_search` text (`McpToolExposure.ts:6`). If so, it gets the same phrase.
- **A4.** Analytics for handoff tools name the receiving thread from a `threadId` in the result (`McpHttpServer.ts:1012-1031`). `t3_panel` should be reported as a handoff the same way; no ids or text leave in analytics.
- **A5.** The existing folded agent-message row renders correctly inside the panel pane (it is the same timeline). If the panel pane uses a different user row, it shows the same sender line.
- **A6.** `lowestPanelModelOptions` can move to shared code so the server and the dialog use one rule.

---

## 4. UI design

### 4.1 Design pass

**Subject.** The caller's timeline in a dense coding tool. The job: tell the user, in one row, that the agent started or steered a panel. Nothing else on screen needs to change, because the panel pane, the **Panel chats** section, the panel chip and the agent-message row already exist (3.1 items 10 to 12).

**Tokens.** All existing: the work-log row, its `t3-code` icon, `text-xs` muted type. No new colour, icon, component or motion.

**First plan, and what I changed.** The first sketch gave agent-started panels their own card in the caller's timeline with the roster and a live status. That is the generic "rich tool card", and it repeats what the pane and thread details already show. Revised: plain work-log rows, worded like every other T3 tool row. The one deliberate choice is the wording: three rows named for what happened, with "panel chat" used as the single name throughout.

**Removed on self-critique.** A "started by an agent" badge on the panel pane header. The folded topic row already names the sending thread, on every surface.

### 4.2 Affected surfaces, in display order

**a. Caller's timeline: tool rows (web, desktop, mobile).** Existing work-log row component, unchanged layout. New entries in `T3_MCP_TOOLS`, resolved by action through `ACTION_TOOLS` (`t3_panel` → `t3_panel_<action>`):

| Key | Labels (action, running, completed, detail) | Summary action | Icon |
|---|---|---|---|
| `t3_panel` (no action known) | Run, Running, Ran, a panel chat | `panel-start` | `t3-code` |
| `t3_panel_start` | Start, Starting, Started, a panel chat | `panel-start` | `t3-code` |
| `t3_panel_post` | Message, Messaging, Messaged, a panel chat | `panel-post` | `t3-code` |
| `t3_panel_continue` | Continue, Continuing, Continued, a panel chat | `panel-continue` | `t3-code` |

Row sentences (exact, by status: in progress, completed, failed, declined, stopped):

| Row | In progress | Completed | Failed | Declined | Stopped |
|---|---|---|---|---|---|
| base | Running a panel chat | Ran a panel chat | Failed to run a panel chat | Declined to run a panel chat | Stopped running a panel chat |
| start | Starting a panel chat | Started a panel chat | Failed to start a panel chat | Declined to start a panel chat | Stopped starting a panel chat |
| post | Messaging a panel chat | Messaged a panel chat | Failed to message a panel chat | Declined to message a panel chat | Stopped messaging a panel chat |
| continue | Continuing a panel chat | Continued a panel chat | Failed to continue a panel chat | Declined to continue a panel chat | Stopped continuing a panel chat |

Group summaries (exact, ICU plural on `count`; "done" when any call completed, else "tried"):

| Summary action | Done | Tried |
|---|---|---|
| `panel-start` | `{count, plural, one {Started {count} panel chat} other {Started {count} panel chats}}` | `{count, plural, one {Tried to start {count} panel chat} other {Tried to start {count} panel chats}}` |
| `panel-post` | `{count, plural, one {Sent {count} panel message} other {Sent {count} panel messages}}` | `{count, plural, one {Tried to send {count} panel message} other {Tried to send {count} panel messages}}` |
| `panel-continue` | `{count, plural, one {Continued {count} panel chat} other {Continued {count} panel chats}}` | `{count, plural, one {Tried to continue {count} panel chat} other {Tried to continue {count} panel chats}}` |

`count` is the number of distinct panels for start and continue, and the number of calls for post. Failed calls are counted as the existing summaries count them. Waits and reads on a panel keep their existing rows ("Waited on 1 thread").

**b. Panel pane and mobile panel screen: the topic and agent posts.** No new component. Because these messages now carry agent attribution (2.6), the existing folded agent-message row shows them: the sending thread's title as the label (or "Agent" when unknown), the one-line summary, expand on click, and "Open thread" when the sender can be opened. A person's posts look as they do today.

**c. Thread details, right-panel tabs, `@` menu, chips.** No change. An agent-started panel is listed under **Panel chats** ("Panel chats · 1 running" while it runs) and opens like any panel. It does not open by itself.

### 4.3 States, responsive, accessibility

- States are the five row statuses above; there is no loading, empty or validation state of its own. A refused call shows the "Failed to…" row; the refusal text is in the row's existing detail.
- Responsive: rows wrap as work-log rows do today. Nothing new at any breakpoint.
- Accessibility: rows are text; no status relies on colour; no new focus stop. The folded row keeps its existing author heading, so a screen reader hears the sending thread's name, not "You".
- Motion: none added.
- Languages: every string in 4.2a in every web and mobile locale (`vp run i18n:generate`, `vp run i18n:check`).

### 4.4 What to inspect at acceptance

Web at 1366×768 and 390×844, and the mobile thread screen:
1. A caller thread after `start`, `post`, `continue`: the three completed rows and one failed row.
2. The group summary after two starts in one turn.
3. The agent-started panel in the pane: folded topic with the sending thread's title, expanded once; an agent post beside a person's post.
4. Thread details showing the panel under **Panel chats** while running.

---

## 5. Acceptance criteria

**Tool and start**

1. `t3_panel` is registered with the exact description, title and annotations of 2.2, and its JSON schema carries the exact parameter descriptions of 2.2.
2. `start` from a top-level thread with 2 eligible panelists and a topic creates one hidden panel thread under the caller's thread, starts the first panelist's turn without further input, and returns `threadId`, `link`, `state: "running"` and `handles` in roster order with `@code` last when there is a code agent.
3. A participant without `options` runs at the lowest reasoning effort its model offers; given `options` are kept.
4. `panelists` and `codeAgent` given as JSON text are accepted.
5. `start` with `parentThreadId` attaches the panel to that thread when it is eligible, and fails with the 2.11 messages when it is missing, archived, a panel, a side chat, a delegated thread, has no message, or its worktree is pending.
6. Each validation failure in 2.11 returns the stated code and exact message; a participant failure names `panelists[<index>]` or `codeAgent`.

**Post, continue, stop**

7. `post` without a handle on an idle panel starts an open run that ends in a conclusion; `post` with two handles makes exactly those two reply once, in roster order, with no conclusion; `post` with `@code` makes only the code agent reply.
8. `post` while a reply is streaming does not cut it and replaces the remaining queue when it ends.
9. `continue` on an idle panel starts an open run after the last speaker; on a running or stopping panel it fails with the stated messages.
10. `post` or `continue` on a thread that is not a panel fails with `Thread <id> is not a panel chat.`
11. `t3_thread_interrupt` on a running panel leaves it idle `stopped` with no further turn; `continue` then works.
12. `t3_thread_send` to a panel fails with the 2.4 message.

**Wait and read**

13. `t3_thread_wait` without `runId` on a running panel does not return when a single reply ends; it returns when the panel is idle with no turn in flight, or at the timeout with `timedOut: true` and `panel.state: "running"`.
14. On an idle panel it returns at once with the last `panel.state`.
15. After a concluded or agreed run, `panel.result` equals the conclusion turn's text with no prefix. After an addressed run, it holds each addressed reply as `[Name (@handle)] text` in order.
16. For `rounds_done`, `no_replies`, `stopped` and `interrupted` there is no `result`.
17. A result longer than 4,000 characters is cut there with `resultTruncated: true`.
18. With `runId`, and on any thread that is not a panel, `t3_thread_wait` behaves and returns exactly as before (no `panel` field).
19. `t3_thread_read` on an agent-started panel returns the topic, posts and labelled replies as it does for any panel.

**Discovery**

20. `orchestrator_capabilities` lists `panelRoles` per provider as in 2.5 (absent for Cursor, Pi, ACP Registry and unusable providers) and carries the new description.
21. `tool_search` with "panel" returns `t3_panel` and lists it to that session; its description is the exact text in 3.2. `t3_panel` is not in the direct-tool list.

**Access and no recursion**

22. A panel participant's and the code agent's provider sessions have no T3 MCP tools; the existing test still passes.
23. A call whose own thread is a panel, a side chat or a delegated thread fails with `Only a top-level thread's agent can run panel chats.`, and a delegated child's tool list does not include `t3_panel`.
24. A caller in plan interaction mode is refused on all three actions; it can still wait on and read a panel.
25. A read-only MCP client is refused; an outside client with write access can start a panel when it passes `parentThreadId`, and gets `target_required` without one.
26. A thread caller without a live run is refused with `parent_not_active` when it targets another thread's panel.

**Limits and idempotency**

27. The fifth agent-started run in a row on one panel is refused with the 2.9 message; after a person posts or continues in an app, an agent call is accepted again.
28. A third `start` under a parent that has two running agent-started panels is refused with the 2.9 message; it succeeds once one of them is idle. Panels a person started do not count.
29. A person's posts and Continues are never refused by either limit.
30. Repeating `start`, `post` or `continue` with the same `clientRequestId` returns the same `threadId`, creates no second panel, message or run, and does not raise the run count.

**Attribution and UI**

31. The topic and posts of an agent call are stored with `createdBy: "agent"`, `creationSource: "mcp"` and the sender (`senderThreadId`, or `linkedSender` for a linked caller); a client-dispatched panel command cannot carry agent attribution.
32. Panelist, conclusion and code agent prompts for an agent-started panel are byte-identical to those for the same panel started by a person; the prompt-builder and scheduler tests pass untouched apart from additions.
33. The caller's timeline shows the rows and summaries of 4.2a with the exact wording, on web and mobile, in every locale; `vp run i18n:check` passes.
34. In the panel pane and on mobile, an agent's topic and posts render as the existing folded agent-message row naming the sending thread; a person's posts are unchanged.
35. Starting a panel by tool opens no tab and moves no focus; the panel is listed under **Panel chats** of its parent and its `link` renders as a panel chip.

**Linked environments**

36. With `environmentId` of a linked environment on this build, `start` with a `parentThreadId` there creates the panel there, using that machine's providers; `t3_thread_wait`, `t3_thread_read`, `t3_thread_interrupt`, `post` and `continue` with the same `environmentId` act on it.
37. A retry of a forwarded `start` with the same `clientRequestId` returns the same panel.
38. A link below full access can start a panel only under a thread it started, and can then post to, continue and stop that panel; it cannot touch a panel the Mac's user started. A read-only link is refused.
39. With linked environments off, an `environmentId` call returns the existing refusal. A linked environment without `t3_panel` returns a typed failure naming the tool.
40. On the linked machine the panel's topic shows the calling thread from this machine as its sender.

**Regressions and docs**

41. Panels started and steered from the UI behave exactly as before (panel spec criteria 9 to 25, 53); the UI entry points, pane and mobile screens are unchanged.
42. `t3_thread_wait`, `t3_thread_read`, `t3_thread_interrupt`, `t3_thread_send` and `delegate_task` are unchanged for threads that are not panels; existing MCP tests pass untouched.
43. Events stored before this change still decode, and a result from a peer that omits the new optional fields decodes.
44. The docs in 2.13 are updated, and the `evals/mcp-tool-use` cases and control exist and pass on the model the eval README names.

---

## 6. Director's decisions (settled; no open questions)

1. **Delegated threads as callers: refused and hidden**, as in 2.7. Panels hang off a thread the user can see; children cannot multiply spend. No ancestor-attachment rule.
2. **Agent limits: kept** at the pilot values 4 agent-started runs in a row per panel and 2 running agent-started panels per parent (2.9, criteria 27 to 29), each a single named constant.
3. **Completion wake: excluded** from this change. Callers poll with `t3_thread_wait` (2.3).
4. **Plan-mode callers: refused** (existing rule, 2.7, criterion 24).
5. **The designer's other calls are accepted as written:** one tool with three actions; panelists see agent posts as the user's; no `next` string; stray fields ignored; `result` capped at 4,000 characters; nothing opens automatically in the UI.
6. **Assumptions A1 to A6 (3.3)** are delegated to the lead to verify. Each listed fallback is pre-approved. Any other deviation goes back to the director.
7. **Evals (2.13, criterion 44):** the two cases and the control must be added. Run them once with the runner and model `evals/README.md` names if that runner works on this Windows machine; if it cannot run here, the lead records the exact blocker and the director decides at acceptance. This is the only criterion that may be reported as "not run".
8. **Validation environment.** Checks run on this Windows checkout with Node 24 (`C:\Users\adipa\AppData\Local\vite-plus\data\js_runtime\node\24.22.3`); Node 22 breaks the checks and the pre-commit hook. The 68 tests that already fail on the base on Windows (storageCleanup 51, ProviderTurnStartService 4, ProviderRegistry 3, ThreadLaunchService 2, control-reads 2, OpenCode2 2, ServerEnvironment 1, ProjectionStore 1, Claude fork 1, ACP symlink 1) are pre-existing; a change must add no new failure. `vp run i18n:check` cannot spawn `node_modules/.bin/gt` directly on Windows and needs a shell with a backslash wrapper.
9. **Live UI and behaviour pass** uses an isolated dev server (`vp run dev --home-dir E:\t3code\.t3`) with the cheapest real models (Luna low or Haiku 5.5 low), never the user's installed app. Criteria 36 to 40 (linked environment) are verified in unit/integration tests here and then live on the Mac after delivery (section 7).

## 7. Delivery (director; not part of the implementation work packages)

- Commits land on `feat/panel-chat` and are pushed to the fork (`fork` remote, PR https://github.com/AdiPatel095/t3code/pull/1). Specs never enter the repository.
- The director then builds the macOS arm64 desktop app from that branch on the Mac (`pnpm dist:desktop:dmg:arm64` after installing the toolchain), backs up `/Applications/T3 Code (Beta).app`, clears the pending official update and pauses auto-update so the build is not replaced, installs it, and restarts it only when no Mac threads are running.
- Live check on the Mac after install: `t3_panel` appears via `tool_search`, and a two-model, one-round panel started by an agent in a Mac thread reaches `concluded`.
