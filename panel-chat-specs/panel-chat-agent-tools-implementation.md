# Panel chat for agents: implementable specification

Status: **rev 1** (lead, Claude Opus 5.5, effort high, 2026-11-24). Implements `E:\t3code-specs\panel-chat-agent-tools.md` (the **requirement spec**, rev 1; authoritative). Section numbers like "R2.3" point into the requirement spec. Repository `E:\t3code`, branch `feat/panel-chat`, base `be7d897796`. All paths below are relative to `E:\t3code`. This file and every other spec stay outside the repository.

---

## 0. Environment for every package

- Shell: Git Bash. Before any `vp`/`node` command:
  `export PATH="/c/Users/adipa/AppData/Local/vite-plus/data/js_runtime/node/24.22.3:/c/Users/adipa/AppData/Local/vite-plus/bin:$PATH"` then `cd /e/t3code`. Check `node --version` prints `v24.22.3`. Node 22 (the system default) breaks the checks and the pre-commit hook.
- Follow `AGENTS.md` (testing rules, no repo-wide checks, Effect conventions, no low-value comments, `Effect.fn("Service.op")` naming).
- Pre-existing Windows failures (68, on the base): storageCleanup 51, ProviderTurnStartService 4, ProviderRegistry 3, ThreadLaunchService 2, Orchestrator.control-reads 2, OpenCode2 2, ServerEnvironment 1, ProjectionStore 1, Claude fork 1, ACP symlink 1. A package must add no failure outside that list.
- `vp run i18n:check` cannot spawn `node_modules/.bin/gt` directly on Windows; run it from a shell where a `gt` wrapper that calls `node_modules\.bin\gt.cmd` (backslash path) is first on PATH, or report the exact error.
- Commit each package on `feat/panel-chat` with a conventional message (`feat(server): …`, `feat(contracts): …`, `feat(client-runtime): …`, `docs: …`, `test(evals): …`). Stage only your own paths (`git add <paths>`), never `git add -A`. Do not push. Do not amend another package's commit.
- Never start a dev server against `~/.t3/userdata`; implementers start no dev server at all (the lead runs the live pass).

## 1. Approach

### 1.1 Shape

1. **Contracts (optional fields only).** Panel commands gain optional agent-attribution fields; the panel state gains an optional run counter; the MCP contracts gain the `t3_panel` input/result, the optional `panel` field on the wait result, and optional `panelRoles` on a capabilities provider.
2. **Orchestrator owns the rules that must be atomic.** Attribution of the topic/post messages, the link origin stamp, and both agent limits are decided inside `dispatchPanelOpen` / `dispatchPanelControl` (`apps/server/src/orchestration-v2/Orchestrator.ts:16009`, `16151`). `panel.open` already holds the parent's lock (`Orchestrator.ts:17155-17160`), so the per-parent limit check is serialized; `panel.post`/`panel.continue` run under the panel thread's lock, so the per-panel counter is serialized. The scheduler (`PanelScheduler.ts`) is untouched: the counter is set on the decision's `state` before `startPanelTurn`.
3. **A client can never claim agent attribution.** `ThreadManagementService.withCreationProvenance` (`ThreadManagementService.ts:88`) strips the new fields from client-dispatched `panel.create`, `panel.post` and `panel.continue`, as it already strips `linkOrigin`/`initialMessage` from `thread.create`. Only the MCP path (which calls `PanelChatService` directly, not `ws.ts`) sets them.
4. **A new thin MCP service** `apps/server/src/mcp/PanelMcpService.ts` with one method `run(scope, input, started?)` and a new toolkit `apps/server/src/mcp/toolkits/panel/{tools.ts,handlers.ts}`. A separate service avoids an import cycle (`PanelChatService` imports from `OrchestratorMcpService.ts`) and keeps the 4k-line `OrchestratorMcpService.ts` out of it. The handler decodes input and calls this one method (AGENTS.md "transports stay thin").
5. **Panel-aware wait** lives in `ThreadManagementService.waitForThread` (event-driven, no polling) and returns the final panel state; `OrchestratorMcpService.waitForThread` turns it into the `panel` field through a pure helper `apps/server/src/orchestration-v2/panel/PanelResult.ts`.
6. **Presentation** follows the existing action-tool pattern (`ACTION_TOOLS`, `T3_MCP_TOOLS`, `t3ToolSentences.ts`, `t3ToolSummary.ts`, `work-log/presentation.ts`).

### 1.2 Access declaration for `t3_panel`

```ts
t3_panel: McpToolAccess.topLevelCallersOnly(
  McpToolAccess.either(
    (input) => input.action === "start",
    McpToolAccess.startsThreads(() => ({}), (input, started) => run(input, started), "stamped"),
    McpToolAccess.writesThreads((input) => [input.threadId ?? undefined], (input) => run(input, undefined)),
  ),
  "Only a top-level thread's agent can run panel chats.",
)
```

- `startsThreads(() => ({}), …, "stamped")`: refuses read-only clients, loads the caller, requires a live caller run, and hands the handler `StartedModes` (the caller's own runtime/interaction modes and `linkOrigin` = `callerLinkOrigin(caller)`). Requesting no modes means it never fails on modes itself; the service refuses a `plan` caller with the exact R2.11 start text. Its remote check (`writingCaller` + `started`) runs before a forwarded call leaves.
- `writesThreads([threadId])` for post/continue: existing target mode check (`assertTargetWithinLimits`, R2.11 "existing text") and link fence (`assertSameLink`), plus `DispatchModeLimit`.
- **New wrapper `topLevelCallersOnly(declaration, message)`** in `McpToolAccess.ts`, built like `afterForwarding` (same file, lines 316-324): it runs `assertTopLevelCaller(message)` before both the local handler and the remote check, and keeps the declaration's `forwarded`. `assertTopLevelCaller` does nothing for a client caller (`scope.thread === undefined`); for a thread caller it loads the caller shell (`ThreadManagementService.getThreadShell`) and fails `capability_denied` with `message` when the shell has `panel !== undefined`, `lineage.sideChat === true`, or `isDelegatedAppThread(shell)`. This is a new builder; no existing builder or access rule changes (R3.2).

**Rejected:** a tagged-union input schema per action (would turn "start needs `topic` and `panelists`." into a schema error, violating R2.11); `writesThreads` on `parentThreadId` for start (adds a parent mode check R2.7 does not have); putting the tool in `OrchestratorMcpService` (import cycle with `PanelChatService`); counting runs in `PanelScheduler` (R3.2 forbids scheduler changes); polling the panel state in the wait (AGENTS.md forbids it).

### 1.3 Assumptions A1–A6 (verified)

| | Result | Consequence |
|---|---|---|
| A1 | **False.** `McpThreadCaller.subagent` is set only from `lineage.relationshipToParent === "subagent"` (`ProviderSessionManager.ts:641`, `679`); a task delegated from a linked environment (`delegatedFrom != null`) is not hidden. | Pre-approved fallback: `EnabledWhen: hiddenFromSubagents` is best effort; `topLevelCallersOnly` refuses from the thread record (`isDelegatedAppThread`), including before forwarding. |
| A2 | **Typed, but the text is the peer's.** A forwarded call goes through `PeerForwarding.call` → `forward` → `peers.call` (`apps/server/src/peer/PeerForwarding.ts:166-210`, `266-285`), whose error channel is `OrchestratorMcpFailure`; a peer without the tool answers with its own "unknown tool" error text, not one naming the cause. `PeerForwarding` already special-cases one older-peer refusal by regex (`BEFORE_POSITION_REFUSAL`, line 99). | Pre-approved fallback: in `PeerForwarding.call`, for `tool.name === "t3_panel"` only, map the peer's unknown-tool failure to `invalid_request` ``The linked environment does not have `t3_panel`. Update T3 Code there.`` (WP4 step 6). The implementer finds the exact unknown-tool shape in the peer client used by `peers.call` and matches it narrowly. |
| A3 | **Holds, no change.** Pi copies only the direct-tool list (`packages/provider-pi/src/server/mcpExtensionSource.ts:399`), not the `tool_search` text; `t3_panel` is not direct. | Nothing to change in Pi. |
| A4 | **Holds.** `HANDOFF_TOOLS` (`McpHttpServer.ts:1012`) names the target from `threadId` in the result (`handoffTargetIds` → `resultThreadIds`). | Add `"t3_panel"` to `HANDOFF_TOOLS`. Analytics carry no ids or text (existing rule). |
| A5 | **Holds (to confirm live).** The panel pane renders through `MessagesTimeline` (`apps/web/src/components/chat/MessagesTimeline.tsx`), whose user rows are `TimelineUserMessageRow`; mobile reads the same fields. | No UI component change; confirmed in the live pass (4.4 item 3). |
| A6 | **Holds.** `lowestPanelModelOptions` (`apps/web/src/components/chat/PanelSetupDialog.logic.ts:46`) depends only on `isReasoningSelect`, whose id set equals the server's `REASONING_OPTION_IDS` in `PanelChatService.ts:64` (both: `reasoningEffort, effort, reasoning, variant, reasoning_effort, thinking_level, thought_level, thinking`, or `role === "reasoning"`). | Move it to `packages/shared/src/panelChat.ts` with its own reasoning check; web and server import it. |

### 1.4 Small decisions inside the requirement (no requirement change)

- **Null-tolerant optional inputs.** R2.2 "stray nulls are not charged a retry": every action-specific field is `Schema.optional(Schema.NullOr(X))`; null is treated as absent. `advertisedJsonSchema` already drops the `null` branch of optional properties (`apps/server/src/mcp/advertisedJsonSchema.ts:104-111`), so this costs no tokens.
- **No schema length checks** on `panelists`, `topic`, `message`, so the service's exact messages (R2.11) are returned. `topic`/`message` are `Schema.String.check(Schema.isMaxLength(120_000))` (transport guard only).
- **`rounds`** decodes as `Schema.Int` with a decode-only clamp to 5 (same transformation shape as `clampedPositiveInt`, `orchestratorMcp.ts:345-355`, but without the positive check), so 0 or less reaches the handler and fails with `Choose between 1 and 5 rounds.` (R2.2 rule + R2.11 row both hold).
- **Stable ids from `clientRequestId`:** command `stableCommandId({scope, requestKey, operation: "panel-start" | "panel-post" | "panel-continue"})`; panel thread `stableThreadId({scope, requestKey: \`panel-start:${key}\`, index: 0})` (the prefix keeps it apart from `create_threads` ids made from the same key); topic/post message `stableOperationMessageId({scope, requestKey, operation: "panel-start" | "panel-post"})`. These helpers are module-private in `OrchestratorMcpService.ts:815-880`; export them (no behavior change) so `PanelMcpService` reuses them.
- **Replay detection:** `OrchestratorV2DispatchResult.replayed === true` (`Orchestrator.ts:421-426`). Not replayed → result `state: "running"`. Replayed → read the panel thread and report its current state (R2.2).
- **"Newest user message" of a panel** = newest message with `role === "user"`, `runId === null`, `panelParticipantId === undefined` (the topic or a post; the empty per-turn trigger messages have a `runId`). Matches `PanelTranscript.ts:73-77`.
- **`answered` result runs** = runs with `panelTurn.outcome === "replied"` whose `requestedAt` is not before that message's `createdAt`, ordered by `ordinal`. Text of a run = its assistant messages' text joined by `"\n\n"` (as `dispatchPanelSettle` does, `Orchestrator.ts:16236`). Label = `code_agent` → `Code agent`, else `participant.name`, then ` (@handle)` — the same label `t3_thread_read` builds (`OrchestratorMcpService.ts:3647-3649`); extract it into `PanelResult.ts` as `panelSpeakerLabel(participant)` and use it in both places.

---

## 2. Implementation boundaries

### 2.1 Files that change

| Area | Files |
|---|---|
| Contracts | `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/orchestratorMcp.ts`, their existing tests (`orchestrationV2.test.ts`, an `orchestratorMcp` test if present) |
| Shared | `packages/shared/src/panelChat.ts` (+ `panelChat.test.ts`), `packages/shared/src/t3McpToolPresentation.ts` (+ its test if present) |
| Web (helper move only) | `apps/web/src/components/chat/PanelSetupDialog.logic.ts` (+ `.logic.test.ts`) |
| Server orchestration | `apps/server/src/orchestration-v2/Orchestrator.ts`, `ThreadManagementService.ts`, `panel/PanelChatService.ts`, new `panel/PanelResult.ts` (+ test), tests in `panel/PanelOrchestration.test.ts`, `panel/PanelChatService*.test.ts` (whichever exists), `ThreadManagementService*.test.ts` |
| Server MCP | new `apps/server/src/mcp/PanelMcpService.ts` (+ test), new `apps/server/src/mcp/toolkits/panel/{tools.ts,handlers.ts}`, `McpToolAccess.ts` (+ `McpToolAccess.test.ts`), `McpHttpServer.ts` (registration, `HANDOFF_TOOLS`), `OrchestratorMcpService.ts` (wait panel field, send refusal, `panelRoles`, export stable-id helpers, shared speaker label), `toolkits/orchestrator/tools.ts` (capabilities description), `toolkits/toolSearch/tools.ts` (description), any budget/snapshot test that lists every tool (e.g. `AgentContextBudget.test.ts`, `toolkits/core.test.ts`) |
| Client runtime | `packages/client-runtime/src/work-log/t3ToolSentences.ts`, `packages/client-runtime/src/t3ToolSummary.ts`, `packages/client-runtime/src/work-log/presentation.ts` (+ their existing tests: add rows) |
| i18n | `apps/web/src/i18n/translations/*.json`, `apps/mobile/src/i18n/translations/*.json` (10 locales each) |
| Docs | `docs/orchestration-v2/orchestrator-mcp-server.md`, `docs/user/thread-sidebar.md`, `docs/user/outside-agents.md` |
| Evals | `evals/mcp-tool-use/cases/panel-chats.ndjson` (new), `evals/mcp-tool-use/README.md` only if it lists case files |

### 2.2 Must not change

Panel prompts (`PanelPromptBuilder.ts`), `PanelTranscript.ts` logic, every decision in `PanelScheduler.ts`, panel UI components, the setup dialog's behavior, the existing access builders in `McpToolAccess.ts`, names/parameters/descriptions of `t3_thread_wait`, `t3_thread_read`, `t3_thread_interrupt`, `t3_thread_send`, `delegate_task`; direct-tool lists (`McpToolExposure.ts:7-12`, Pi); `ProviderSessionManager.ts` MCP credential rules; the client `message.dispatch` refusal text "Update the app to post in a panel chat."; analytics content rules. No dependency bumps, no unrelated refactors.

### 2.3 Exact interfaces

**Contracts — `orchestrationV2.ts`.**

```ts
// OrchestrationV2PanelState: add
agentRunsInARow: Schema.optional(NonNegativeInt), // runs agents started in a row; a person's post/continue resets it

// OrchestrationV2Command "panel.create": add (server-only; ws strips them)
senderThreadId: Schema.optional(ThreadId),
linkedSender: Schema.optional(OrchestrationV2LinkedSender),
linkOrigin: Schema.optional(OrchestrationV2LinkOrigin),

// OrchestrationV2Command "panel.post" and "panel.continue": add (server-only; ws strips them)
createdBy: Schema.optional(OrchestrationV2Actor),
senderThreadId: Schema.optional(ThreadId),
linkedSender: Schema.optional(OrchestrationV2LinkedSender),

// Internal "panel.open": add the same senderThreadId, linkedSender, linkOrigin (optional)
```

One short doc comment per added group, as on `thread.create.linkOrigin` (`orchestrationV2.ts:3440-3442`): "Only the server sets this."

**Contracts — `orchestratorMcp.ts`.**

```ts
export const OrchestratorMcpPanelState = Schema.Literals([
  "running", "concluded", "agreed", "rounds_done", "answered", "stopped", "interrupted", "no_replies",
]);

const OrchestratorMcpPanelParticipant = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optional(OrchestratorMcpTargetOptions.annotate({ description: "Omit for the lowest reasoning effort." })),
});

export const OrchestratorMcpPanelInput = Schema.Struct({
  action: Schema.Literals(["start", "post", "continue"]),
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(Schema.NullOr(ThreadId).annotate({ description: "post, continue: the panel." })),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId).annotate({ description: "start: thread the panel attaches to. Default: yours. Required outside a thread." })),
  topic: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(120_000))).annotate({ description: "start: all the panel is told. Make it self-contained. Max 8000 chars." })),
  panelists: Schema.optional(Schema.NullOr(Schema.Union([
    Schema.Array(OrchestratorMcpPanelParticipant),
    Schema.fromJsonString(Schema.Array(OrchestratorMcpPanelParticipant)),
  ])).annotate({ description: "start: 2 to 5, in speaking order. The first also writes the conclusion." })),
  codeAgent: Schema.optional(Schema.NullOr(Schema.Union([
    OrchestratorMcpPanelParticipant,
    Schema.fromJsonString(OrchestratorMcpPanelParticipant),
  ])).annotate({ description: "start: answers the panel's code questions, read-only. Codex, Claude or OpenCode. Costs the most per turn: pick a small model." })),
  rounds: Schema.optional(Schema.NullOr(OrchestratorMcpPanelRounds).annotate({ description: "start: rounds per run, 1 to 5. Default 2." })),
  message: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(120_000))).annotate({ description: 'post: max 8000 chars. "@handle" addresses only those participants; "@code" asks the code agent.' })),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
// OrchestratorMcpPanelRounds: Schema.Int decoded through a transform min(value, 5); no lower bound in the schema.

export const OrchestratorMcpPanelResult = Schema.Struct({
  threadId: ThreadId,
  link: Schema.optional(Schema.String),
  state: OrchestratorMcpPanelState,
  handles: Schema.optional(Schema.Array(Schema.String)),
});

// OrchestratorMcpThreadWaitResult: add
panel: Schema.optional(Schema.Struct({
  state: OrchestratorMcpPanelState.annotate({ description: "concluded, agreed: result is the conclusion. answered: result is the addressed replies. Others: no result." }),
  result: Schema.optional(Schema.String.annotate({ description: "Written by the panel's models." })),
  resultTruncated: Schema.optional(Schema.Literal(true)),
})),

// OrchestratorMcpProviderCapability: add
panelRoles: Schema.optional(Schema.Array(Schema.Literals(["panelist", "code_agent"]))),
```

The descriptions are exact R2.2/R2.3 text. Where the annotation must sit so the advertised JSON schema shows it (on the inner type vs on the `optional`) follows what the existing inputs do; the done-check prints the advertised schema.

**Shared — `packages/shared/src/panelChat.ts`.**

```ts
const PANEL_AGENT_RUNS_IN_A_ROW = 4;       // pilot (R2.9)
const PANEL_AGENT_RUNNING_PER_PARENT = 2;  // pilot (R2.9)
export function lowestPanelModelOptions(descriptors: ReadonlyArray<ProviderOptionDescriptor>): ProviderOptionSelection[] | undefined
```

`lowestPanelModelOptions` = moved body; its reasoning check is `descriptor.type === "select" && (descriptor.role === "reasoning" || PANEL_REASONING_OPTION_IDS.has(descriptor.id))` with the id set from A6. Export the two constants in the existing `/** @public */ export { … }` block.

**Server — `PanelResult.ts`.**

```ts
export const PANEL_WAIT_RESULT_MAX_CHARS = 4_000; // pilot (R2.3)
export function panelSpeakerLabel(participant: OrchestrationV2PanelParticipant): string;
export function panelWaitState(panel: OrchestrationV2PanelState): OrchestratorMcpPanelState;
  // status running or current !== null → "running"; else idleReason ?? "interrupted"
export function panelWaitSummary(input: {
  panel: OrchestrationV2PanelState;
  runs: ReadonlyArray<OrchestrationV2Run>;
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): { state; result?: string; resultTruncated?: true };
```

`result` rules per R2.3 table and 1.4 above; truncation cuts at 4,000 UTF-16 units without splitting a surrogate pair.

**Server — `ThreadManagementService.waitForThread`.** Result type gains `panel?: OrchestrationV2PanelState` (the state when the wait ended). Branch at the start: when `input.runId === undefined` and the thread record has `panel !== undefined`, ignore `untilDelegatedWorkSettled`/`untilOutput`; settled = `panel.status === "idle" && panel.current === null`; return at once when settled; otherwise subscribe from `afterSequence` (taken first, as today) to `panel.updated`, `run.updated` and `thread.deleted`, re-read the thread on each and stop at the first settled state, with the same `Effect.timeoutOption` and the same final re-read. `run`/`timedOut` keep their meaning (latest run; `timedOut` = not settled). The non-panel path is byte-for-byte unchanged.

**Server — `OrchestratorMcpService.waitForThread`.** When the service result carries `panel`, load `getThreadRecords(threadId, ["runs", "messages"], { messageRoles: ["user", "assistant"] })` once (only when the state is `concluded`, `agreed` or `answered`) and add `panel: panelWaitSummary(...)`. Never set `next` for a panel. Non-panel results unchanged.

**Server — `PanelChatService`.** `PanelChatError` gains `participant: Schema.optional(Schema.Struct({ role: OrchestrationV2PanelRole, index: NonNegativeInt }))` (index within its role, input order). Set it on the per-participant rejections: provider unusable, code agent not read-only, `Already in this panel.` (the later duplicate). In `create`, when `command.createdBy === "agent"` and a participant's `modelSelection.options === undefined`, the resolved selection gets `options: lowestPanelModelOptions(descriptors)` (omit the key when that is `undefined`). A person's selections are not touched.

**Server — `PanelMcpService`.**

```ts
export class PanelMcpService extends Context.Service<PanelMcpService, {
  readonly run: (
    scope: McpInvocationScope,
    input: OrchestratorMcpPanelInput,      // environmentId already removed by routing
    started: McpToolAccess.StartedModes | undefined, // defined for start
  ) => Effect.Effect<OrchestratorMcpPanelResult, OrchestratorMcpFailure>;
}>()("t3/mcp/PanelMcpService") {}
```

`start`: validate presence (`start needs \`topic\` and \`panelists\`.`); plan caller (`started.interactionMode === "plan"`) → `interaction_mode_escalation_denied`, `Panel chats run in default interaction mode, above this caller's plan mode.`; resolve parent (`parentThreadId ?? caller thread`; none → `target_required`, `Pass parentThreadId: this MCP client is not running inside a T3 thread.`); parent shell missing/deleted → `threadNotFound(...)` with "The thread was not found."; explicit parent → `assertSameLink(caller, parent)`; parent archived/panel/side chat/delegated → `invalid_request` `Thread <id> cannot hold a panel chat. Use an unarchived top-level thread that has a message.`; build `panel.create` with `createdBy: "agent"`, `creationSource: "mcp"`, `senderThreadId` (thread caller) or `linkedSender` (`scope.client.senderThread`), `linkOrigin: started.linkOrigin` (when defined), participants (panelists then code agent, `modelSelection = { instanceId: providerInstanceId, model, options? }`), `rounds ?? PANEL_DEFAULT_ROUNDS`, stable ids; call `PanelChatService.create`; result `{ threadId, link: threadLinkFor(scope, threadId, title), state, handles }` with handles `@` + participant.handle in roster order (code agent last).
`post`: presence (`post needs \`threadId\` and \`message\`.`); target shell missing → `threadNotFound`; not a panel → `invalid_request` `Thread <id> is not a panel chat.`; dispatch `panel.post` with `createdBy: "agent"`, sender fields, stable ids. `continue`: presence (`continue needs \`threadId\`.`); same target checks; dispatch `panel.continue` with `createdBy: "agent"` and sender fields.
Error mapping: `PanelChatError` → `invalid_request`, message prefixed `panelists[<index>]: ` / `codeAgent: ` when `participant` is set; the service's `Panel chats start after the first message.` → the parent-not-eligible text above; `OrchestratorDispatchError` with a string `cause` from a panel command (`commandType` `panel.open`/`panel.post`/`panel.continue`) → `invalid_request` with that cause; anything else → `dispatchFailure` (`threadAccess.ts:108`).

**Server — Orchestrator.**
- `emitPanelUserMessage` gains `createdBy`, `senderThreadId?`, `linkedSender?` in its message argument and writes them on the `message.updated` payload (`createdBy`, sender fields) and the `turn-item.updated` payload (`createdBy`), mirroring how `dispatchMessage` stores them (`Orchestrator.ts` around 6577-6598). Person path: `createdBy: "user"` and the current `creationSource` values (`command.creationSource` for the topic, `"server"` for posts) — unchanged bytes.
- `dispatchPanelOpen`: when `command.createdBy === "agent"`, before emitting, count `liveSideChatIds(parent.id)` whose thread has `panel?.status === "running"` and `createdBy === "agent"`; `>= PANEL_AGENT_RUNNING_PER_PARENT` → reject `This thread already has 2 agent-started panel chats running. Wait for one to finish or stop it.`. Initial panel state gets `agentRunsInARow: 1` for an agent open (omit the key for a person). The thread gets `linkOrigin: command.linkOrigin` when given (otherwise it inherits the parent's, as today). The topic message carries the agent attribution.
- `dispatchPanelControl`: `agent = command.createdBy === "agent"`. Agent and `(panel.agentRunsInARow ?? 0) >= PANEL_AGENT_RUNS_IN_A_ROW` → reject `This panel has had 4 agent-started runs in a row. A person must continue it in T3 Code, or start a new panel.` (checked after the existing unavailable/running/stopping checks so those keep priority). Apply `agentRunsInARow` to the decision's `state` before `startPanelTurn`: agent → previous + 1; person → omit the key when it was absent, else 0. Post messages carry the attribution.
- Receipt replays never reach these functions, so a replay never counts twice.

**Server — `ThreadManagementService.withCreationProvenance`.** `panel.create`: drop `senderThreadId`, `linkedSender`, `linkOrigin`, then apply provenance (as today). `panel.post` / `panel.continue`: drop `createdBy`, `senderThreadId`, `linkedSender`. Add a one-line comment like the `thread.create` case.

**Server — `t3_thread_send`.** In `OrchestratorMcpService.sendToThread`, right after `loadScopedThread`, when `target.thread.panel !== undefined` fail `invalid_request` with ``Thread <id> is a panel chat. Post to it with `t3_panel` action post.``.

**Server — capabilities.** In the provider map (`OrchestratorMcpService.ts:2840-2890`): `roles = constraints.length === 0 ? [provider.panelChat?.panelist && "panelist", provider.panelChat?.panelist && provider.panelChat?.codeAgent && "code_agent"].filter(Boolean) : []`; add `panelRoles` only when non-empty. Description (exact): ``List providers, models, options, and runtime modes for `delegate_task` and `t3_panel`. Short list. `search` finds others. Any catalog model works.``

**Server — `tool_search` description** (exact, R3.2): `Load T3 Code tools you do not have yet, then call them by name. Search by name or purpose: threads (t3_thread_*), panel chats (t3_panel), projects (t3_project_*), worktrees, preview_* browser, device_*, html_preview/html_render, schedule_task, pull requests and guides, attachments, request_secret, environment links. Exact names work too.`

**`t3_panel` tool declaration** (`toolkits/panel/tools.ts`): `Tool.make("t3_panel", { description: <R2.2 exact text>, parameters: OrchestratorMcpPanelInput, success: OrchestratorMcpPanelResult, failure: OrchestratorMcpFailure, failureMode: "return", dependencies: [McpInvocationContext, ThreadManagementService, PanelMcpService] })` `.annotate(Tool.Title, "Run a panel chat")` `.annotate(Tool.Destructive, true)` `.annotate(Tool.OpenWorld, true)` `.annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromSubagents)`. Not `Readonly`, not `Idempotent`.

**Presentation** (`packages/shared/src/t3McpToolPresentation.ts`): summary actions `"panel-start" | "panel-post" | "panel-continue"` added to `T3McpToolSummaryAction`; `T3_MCP_TOOLS` entries:
```ts
t3_panel: tool(["Run", "Running", "Ran", "a panel chat"], "panel-start"),
t3_panel_start: tool(["Start", "Starting", "Started", "a panel chat"], "panel-start"),
t3_panel_post: tool(["Message", "Messaging", "Messaged", "a panel chat"], "panel-post"),
t3_panel_continue: tool(["Continue", "Continuing", "Continued", "a panel chat"], "panel-continue"),
```
`ACTION_TOOLS.t3_panel = (action) => \`t3_panel_${action}\``. Sentences (R4.2a table) in `t3ToolSentences.ts` with the existing `{status, select, …}` pattern; summaries (R4.2a, exact ICU) in `t3ToolSummary.ts`: `panel-start` and `panel-continue` count `countEntities(threadIds)`, `panel-post` counts `selected.length`; add the three actions to the summary switch in `work-log/presentation.ts` next to `thread-send`.

---

## 3. Work packages

Every package: implement exactly what is listed; do not redesign; raise material ambiguities to the lead instead of inventing; preserve unrelated work; report changed files and the real output of each done-check.

### WP1 — Contracts and shared helper (R: 2.2 schema, 2.3 result field, 2.5 field, 2.9 constants, A6; criteria 1 (schema part), 3 (helper), 43)

- Depends on: nothing.
- Files: `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/orchestratorMcp.ts`, contract tests, `packages/shared/src/panelChat.ts`, `packages/shared/src/panelChat.test.ts`, `apps/web/src/components/chat/PanelSetupDialog.logic.ts`, `apps/web/src/components/chat/PanelSetupDialog.logic.test.ts`.
- Steps:
  1. Add the `orchestrationV2.ts` fields of 2.3.
  2. Add `OrchestratorMcpPanelState`, `OrchestratorMcpPanelParticipant`, `OrchestratorMcpPanelRounds`, `OrchestratorMcpPanelInput`, `OrchestratorMcpPanelResult` (+ `type` exports), the wait-result `panel` field and `panelRoles`, with the exact descriptions.
  3. Move `lowestPanelModelOptions` to `panelChat.ts` with its own reasoning check; add the two limit constants. Web imports it from `@t3tools/shared/panelChat`; move its test cases (`PanelSetupDialog.logic.test.ts:60-67`) to `panelChat.test.ts`.
  4. Tests (extend existing files): a panel thread payload without `agentRunsInARow` decodes; `panel.post` without the new fields decodes; a wait result without `panel` decodes; `OrchestratorMcpPanelInput` decodes `panelists` as JSON text and `codeAgent` as JSON text, decodes `rounds: 9` as 5, keeps `rounds: 0` (for the handler), accepts `threadId: null`.
- Must not: touch server code; change any existing field.
- Done-checks:
  - `vp test run packages/contracts/src/orchestrationV2.test.ts packages/shared/src/panelChat.test.ts apps/web/src/components/chat/PanelSetupDialog.logic.test.ts` (+ the orchestratorMcp contract test file you touched)
  - `vp run typecheck` (affected packages must pass; server may show errors only if it consumed changed types — it should not)
  - `vp run check:changed`
- Commit: `feat(contracts): add panel chat agent fields and t3_panel schemas`.

### WP2 — Orchestrator attribution, limits, lowest options, client stripping (R2.6, 2.9, 2.2 options rule, 2.11 participant index; criteria 3, 27-32 (orchestrator level), 29, 31)

- Depends on: WP1.
- Files: `apps/server/src/orchestration-v2/Orchestrator.ts`, `apps/server/src/orchestration-v2/ThreadManagementService.ts` (`withCreationProvenance` only), `apps/server/src/orchestration-v2/panel/PanelChatService.ts`, tests: `panel/PanelOrchestration.test.ts`, the PanelChatService test file (find it; extend), the existing test that covers `withCreationProvenance` (find with `git grep -n withCreationProvenance -- '*.test.ts'`; extend it, or `ws.test.ts` if that is where client provenance is tested).
- Steps: implement the Orchestrator, `withCreationProvenance` and `PanelChatService` items of 2.3. `PanelChatService` may reuse the shared reasoning check instead of its own `REASONING_OPTION_IDS` only if behavior is identical; otherwise leave it.
- Tests to add (extend existing cases where one fits; drain the effect worker, no sleeps):
  - agent `panel.open` stores topic with `createdBy: "agent"`, `creationSource: "mcp"`, `senderThreadId`; a person's open is unchanged (`createdBy: "user"`).
  - agent post stores `createdBy: "agent"`, `creationSource: "mcp"`, `linkedSender`.
  - counter: open (1) + 3 agent posts/continues accepted, the 5th agent run refused with the exact text; a person post resets; then an agent continue is accepted.
  - per-parent: two running agent panels → third agent open refused (exact text); a person-started running panel does not count; after one goes idle the open succeeds.
  - a person's post/continue is never refused by either limit (with the counter at 4).
  - `linkOrigin` on `panel.open` is stamped on the panel thread.
  - `withCreationProvenance` drops the new fields from client `panel.create`/`panel.post`/`panel.continue` (criterion 31 second half).
  - `PanelChatService.create`: agent participant without `options` gets the lowest reasoning option; with `options` kept; person path unchanged; per-participant `PanelChatError` carries `{ role, index }`.
  - criterion 32: one assertion that the panelist prompt for an agent-attributed topic/post equals the prompt for the same panel with person attribution (in the existing prompt/transcript test file, as an added case; existing tests untouched).
- Must not: change `PanelScheduler.ts`, `PanelPromptBuilder.ts`, `PanelTranscript.ts`, or any existing test assertion.
- Done-checks:
  - `vp test run apps/server/src/orchestration-v2/panel` plus the touched provenance test file
  - `vp run typecheck`
  - `vp run check:changed`
- Commit: `feat(server): attribute and limit agent-started panel runs`.

### WP3 — Panel-aware wait, send refusal, discovery text (R2.3, 2.4, 2.5, 3.2 tool_search; criteria 12-18, 20, 21 (description), 42)

- Depends on: WP1 (WP2 for the full test of attribution-free behavior is not needed).
- Files: `apps/server/src/orchestration-v2/ThreadManagementService.ts` (`waitForThread` only), new `apps/server/src/orchestration-v2/panel/PanelResult.ts` + `PanelResult.test.ts`, `apps/server/src/mcp/OrchestratorMcpService.ts` (wait panel field, send refusal, `panelRoles`, speaker label reuse, export stable-id helpers for WP4), `apps/server/src/mcp/toolkits/orchestrator/tools.ts` (capabilities description), `apps/server/src/mcp/toolkits/toolSearch/tools.ts`, tests in `OrchestratorMcpService.test.ts` and the ThreadManagementService wait test file.
- Steps: implement the items of 2.3 for these files.
- Tests:
  - `PanelResult.test.ts` (pure): state mapping (running when `current !== null` even if idle; `interrupted` when idle with null reason); concluded/agreed → newest replied conclusion text, no prefix; answered → only replies after the newest user post, `[Name (@handle)] text`, code agent labelled `Code agent (@code)`, blank-line join, ordinal order; rounds_done/no_replies/stopped/interrupted → no result; 4,000 cut + `resultTruncated`, no split surrogate.
  - wait (service level): on a running panel the wait does not end when one reply's run completes while the panel stays running; ends when `panel.updated` makes it idle with `current === null`; times out with `timedOut: true` and panel running; idle panel returns at once; with `runId` and on a non-panel thread the result is unchanged and has no `panel` (extend existing wait cases with a `panel` absence assertion).
  - `t3_thread_send` to a panel → `invalid_request` with the exact text.
  - capabilities: `panelRoles` per provider (panelist only; panelist + code_agent; absent when `panelChat` missing or constraints non-empty).
- Must not: change any existing tool's parameters or descriptions other than the two descriptions named; change the non-panel wait path.
- Done-checks:
  - `vp test run apps/server/src/orchestration-v2/panel/PanelResult.test.ts apps/server/src/mcp/OrchestratorMcpService.test.ts <ThreadManagementService wait test file>`
  - `vp run typecheck`
  - `vp run check:changed`
- Commit: `feat(server): panel-aware thread wait and panel discovery`.

### WP4 — The `t3_panel` tool (R2.2, 2.7, 2.8, 2.10, 2.11, A2, A4; criteria 1, 2, 4-11, 19, 21-26, 30, 36-40)

- Depends on: WP1, WP2, WP3.
- Files: new `apps/server/src/mcp/PanelMcpService.ts` + `PanelMcpService.test.ts`, new `apps/server/src/mcp/toolkits/panel/tools.ts` + `handlers.ts`, `apps/server/src/mcp/McpToolAccess.ts` (+ `McpToolAccess.test.ts`), `apps/server/src/mcp/McpHttpServer.ts` (toolkit registration in `layerTools`, `PanelMcpService.layer` provision like `layerOrchestratorToolkit`, `HANDOFF_TOOLS`), `apps/server/src/peer/PeerForwarding.ts` (+ its test; A2 mapping only), whatever wiring provides `PanelChatService` to the MCP layer (check `apps/server/src/server.ts:761`), tool-list tests that enumerate every tool (update their expected lists/budgets only as needed, and report the token delta).
- Steps:
  1. `McpToolAccess.topLevelCallersOnly` (1.2).
  2. `PanelMcpService` (2.3), using exported stable-id helpers, `threadLinkFor`, `threadNotFound`, `assertSameLink`, `PanelChatService`.
  3. Toolkit `tools.ts`/`handlers.ts` with the declaration of 1.2 (`run` gets `started` for start, `undefined` otherwise).
  4. Register: `layerPanelToolkit = toolkitRegistration(PanelToolkit, PanelHandlers.layer).pipe(Layer.provide(PanelMcpService.layer))`, added to `layerTools`.
  5. `HANDOFF_TOOLS.add("t3_panel")`.
  6. A2: in `apps/server/src/peer/PeerForwarding.ts` `call`, for `tool.name === "t3_panel"` only, map the peer's unknown-tool failure (find its exact shape in the peer client behind `peers.call`; match narrowly, like `BEFORE_POSITION_REFUSAL`) to `invalid_request` ``The linked environment does not have `t3_panel`. Update T3 Code there.``; add a case to the existing PeerForwarding test file.
- Tests (lowest failing layer; extend existing tables where they exist, e.g. `McpToolAccess.test.ts`, `toolkits/core.test.ts`, `OrchestratorMcpToolkit.integration.test.ts`):
  - registration: exact description, title, annotations; advertised JSON schema has the exact parameter descriptions; hidden for a subagent caller; visible for a top-level thread and an outside client; not in the direct list; `tool_search` "panel" lists it.
  - start from a top-level thread: one panel under the caller, first turn started, result `{threadId, link, state:"running", handles}` with `@code` last.
  - `parentThreadId` eligible / missing / archived / panel / side chat / delegated / no message / worktree pending → exact codes and texts; outside client without parent → `target_required`; outside write client with parent succeeds; read-only client refused.
  - every R2.11 validation row (presence messages, 1/6 panelists, rounds 0, empty/long topic and post, participant index prefix for `panelists[1]` and `codeAgent`).
  - caller is a panel / side chat / delegated (`delegatedFrom` set, `subagent` false) → `capability_denied` exact text, also when `environmentId` is given (refused before forwarding).
  - plan-mode caller: start refused with the exact start text; post/continue refused with the existing limits text; `t3_thread_wait`/`t3_thread_read` on a panel still work.
  - thread caller without a live run targeting another thread's panel → `parent_not_active`.
  - post/continue on a non-panel → exact text; continue while running/stopping → exact texts.
  - idempotency: same `clientRequestId` on start/post/continue → same `threadId`, no second panel/message/run, counter not raised.
  - linked: `environmentId` start forwards (caller checked here), the peer receives `parentThreadId` and `clientRequestId` scoped as for `t3_thread_send`; links off → existing refusal; a peer without `t3_panel` → the A2 text; a fenced link can start only under a thread it started and then post/continue/stop that panel, not a user's panel; the panel stores `linkedSender` from `T3-Sender-Thread` (criterion 40 at the receiving side).
  - interrupt: `t3_thread_interrupt` on a running agent panel leaves it idle `stopped`; `continue` then works (criterion 11; extend an existing panel interrupt case if one exists).
  - `t3_thread_read` on an agent-started panel shows topic, posts and labelled replies (criterion 19).
- Must not: change existing builders' behavior, existing tool declarations, or `PeerForwarding` behavior for other tools beyond the A2 mapping.
- Done-checks:
  - `vp test run apps/server/src/mcp/PanelMcpService.test.ts apps/server/src/mcp/McpToolAccess.test.ts <every other test file touched>`
  - `vp test run apps/server/src/mcp apps/server/src/orchestration-v2/panel` (report counts; only pre-existing failures allowed)
  - `vp test run apps/server/src/orchestration-v2/ProviderSessionManager.test.ts -t "panel"` (criterion 22 untouched; report the run)
  - `vp run typecheck`
  - `vp run check:changed`
- Commit: `feat(server): let agents run panel chats with t3_panel`.

### WP5 — Tool rows and summaries in every locale (R4.2a, 4.3; criterion 33)

- Depends on: nothing (disjoint files); runs in parallel with WP2.
- Files: `packages/shared/src/t3McpToolPresentation.ts` (+ test), `packages/client-runtime/src/work-log/t3ToolSentences.ts`, `packages/client-runtime/src/t3ToolSummary.ts`, `packages/client-runtime/src/work-log/presentation.ts` (+ their existing tests), `apps/web/src/i18n/translations/*.json`, `apps/mobile/src/i18n/translations/*.json`.
- Steps: presentation entries (2.3); four sentence rows (exact R4.2a text); three summary cases (exact R4.2a ICU); `presentation.ts` switch; `vp run i18n:generate` in `apps/web` and in `apps/mobile`; translate every new key into de, es, fr, ja, ko, pt-BR, ru, sv, zh (keep ICU syntax and `{count}` intact; "panel chat" translated consistently with the existing panel keys in each locale file — reuse their term).
- Tests: extend the existing presentation/summary tests with one row each: `t3_panel` with `{action:"post"}` resolves to `t3_panel_post` labels; two starts on two panels summarize as "Started 2 panel chats"; a failed start summarizes as "Tried to start 1 panel chat".
- Must not: touch server code, change other tools' strings.
- Done-checks:
  - `vp test run <presentation/summary test files touched>`
  - `vp run i18n:check` (Windows wrapper note in section 0)
  - `vp run typecheck`
  - `vp run check:changed` (WP2's files may appear in the changed set while it runs; report, do not touch them)
- Commit: `feat(client-runtime): show t3_panel calls in the work log`.

### WP6 — Docs and evals (R2.13; criterion 44)

- Depends on: WP4 (the eval imports the live tool text).
- Files: `docs/orchestration-v2/orchestrator-mcp-server.md`, `docs/user/thread-sidebar.md`, `docs/user/outside-agents.md`, `evals/mcp-tool-use/cases/panel-chats.ndjson` (new; follow `McpToolUseCase` in `evals/mcp-tool-use/run.ts` and the README's case rules), README case list if one exists.
- Steps:
  1. Docs exactly as R2.13 (one `### t3_panel` section; one paragraph under `### t3_thread_wait`; `panelRoles` under `### orchestrator_capabilities`; one bullet under "Policy And Idempotency"; two sentences in "Panel chats"; one bullet in "What outside agents can call"). Follow AGENTS.md documentation rules: no field catalogs.
  2. Cases: `kind: "guard"` (a) debate → `orchestrator_capabilities`, then `t3_panel` `action:"start"` with a topic and 2-5 panelists, then `t3_thread_wait`, final text contains the `link` and the conclusion (mock the tool results with `mocks`); (b) "ask @sol a follow-up" with a prior panel → `t3_panel` `action:"post"` with `message` matching `re:@sol`; control: "have another agent implement X" → `delegate_task`, `callsMustNot` `t3_panel`. `source`: this feature (requirement spec R2.13). Authored Acme data only.
  3. `pnpm mcp-tool-use --dry-run --case <ids>` from `evals/` must build. Then try a real run: `pnpm mcp-tool-use --case <ids> --samples 2 --out runs/panel` with the model the README names. If no API key/proxy is available here, record the exact error and stop (director decides, R6.7). Never print or commit a key.
- Done-checks: `vp run check:changed`; the dry run output; the real run summary or the exact blocker.
- Commit: `docs: describe panel chats for agents` and `test(evals): add t3_panel guard cases` (two commits).

### WP7 — Live pass (lead; not delegated as code)

Lead runs it after WP4/WP5 (section 5).

## 4. Order

1. WP1 (alone).
2. WP2 ‖ WP5 (disjoint: server vs shared-presentation/client-runtime/i18n). Each commits only its own paths.
3. WP3.
4. WP4.
5. WP6.
6. Lead: full review, live pass (WP7), report.

The lead reviews each package's diff and runs its checks before starting dependants.

## 5. Validation plan

### 5.1 Criteria → packages and checks

| # | Package(s) | Check |
|---|---|---|
| 1 | WP1, WP4 | registration test: description, title, annotations; advertised schema descriptions |
| 2 | WP4 | start test (result shape, handles, first turn started); live pass |
| 3 | WP1, WP2 | `lowestPanelModelOptions` tests; PanelChatService agent options test |
| 4 | WP1, WP4 | JSON-text decode tests; handler accepts |
| 5 | WP4 | parent eligibility table test |
| 6 | WP4 (+WP2 index) | R2.11 table test |
| 7 | WP4 (existing scheduler semantics) | post open / two handles / `@code` (MCP-level test driving `panel.post`); live pass |
| 8 | existing panel tests (unchanged behavior) + WP4 | post during streaming via tool follows the same command; existing `PanelOrchestration.test.ts` case passes |
| 9 | WP4 | continue idle / running / stopping |
| 10 | WP4 | non-panel post/continue |
| 11 | WP4 | interrupt then continue; live pass |
| 12 | WP3 | send refusal test |
| 13 | WP3 | wait not ending on one reply; timeout state |
| 14 | WP3 | idle returns at once |
| 15 | WP3 | `PanelResult` concluded/agreed/answered |
| 16 | WP3 | `PanelResult` no-result states |
| 17 | WP3 | truncation |
| 18 | WP3 | `runId` / non-panel unchanged, no `panel` field |
| 19 | WP4 | read of agent-started panel |
| 20 | WP3 | capabilities `panelRoles` + description |
| 21 | WP3, WP4 | `tool_search` text; search lists `t3_panel`; not direct |
| 22 | existing | `ProviderSessionManager.test.ts` panel case run in WP4 |
| 23 | WP4 | caller-kind refusal incl. forwarded; hidden for subagent |
| 24 | WP4 | plan-mode refusal on all actions; wait/read allowed |
| 25 | WP4 | read-only refused; outside client with/without parent |
| 26 | WP4 | `parent_not_active` |
| 27 | WP2, WP4 | 5th agent run refused; person resets |
| 28 | WP2 | per-parent limit; person panels not counted |
| 29 | WP2 | person never refused |
| 30 | WP4 (+WP2 receipt) | `clientRequestId` replays |
| 31 | WP2 | stored attribution; client strip |
| 32 | WP2 | prompt equality assertion; prompt/scheduler tests untouched (diff shows additions only) |
| 33 | WP5 | presentation tests; `vp run i18n:check`; live UI rows |
| 34 | lead live pass | folded agent rows in panel pane (web) |
| 35 | WP4 + live | no tab opened (nothing in the server opens UI); panel listed under **Panel chats**; link chip |
| 36-40 | WP4 | forwarding tests (here); live on the Mac after delivery (director, R6.9) |
| 41 | all | existing panel suites pass untouched; live UI-started panel still works |
| 42 | WP3, WP4 | existing MCP tests pass untouched |
| 43 | WP1 | decode tests |
| 44 | WP6 | docs diff; eval dry run + real run or exact blocker |

### 5.2 Lead's final checks

- `vp run typecheck`
- `vp test run apps/server/src/mcp apps/server/src/orchestration-v2/panel packages/contracts packages/shared/src/panelChat.test.ts packages/client-runtime/src` (counts vs the 68 known failures)
- `vp run i18n:check`
- `vp run check:changed` over the whole branch diff vs `be7d897796`

### 5.3 Live pass (R4.4)

Isolated dev server: `vp run dev --home-dir E:\t3code\.t3` (never the installed app or its ports; read real ports from the `[dev-runner]` line; stop it by the tracked task at the end). Cheapest real models (Codex Luna low / Claude Haiku 5.5 low). An agent thread on a cheap model is asked to: start a two-model, one-round panel; wait until concluded; post with an `@handle`; continue; interrupt; and hit the 5th-run limit (or the lead drives the MCP calls from that thread). Evidence: tool results, wait counts, panel state.

Rendered states, web at 1366×768 and 390×844:
1. Caller thread after start, post, continue: three completed rows and one failed row.
2. Group summary after two starts in one turn.
3. Agent-started panel in the pane: folded topic naming the sending thread, expanded once; an agent post beside a person's post.
4. Thread details showing the panel under **Panel chats** while running.

Mobile thread screen: covered by the shared client-runtime rows and i18n keys; a mobile client run is not available on this Windows machine and is reported as unverified if it cannot be run.
