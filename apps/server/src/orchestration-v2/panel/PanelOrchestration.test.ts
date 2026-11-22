import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  EventId,
  isListedThreadLineage,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  RuntimeRequestId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  PANEL_CODE_AGENT_REPLY_LIMIT_MS,
  PANEL_MAX_PANELISTS,
  PANEL_PANELIST_REPLY_LIMIT_MS,
  PANEL_TEXT_MAX_CHARS,
} from "@t3tools/shared/panelChat";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecovery from "../ProviderRuntimeRecoveryService.ts";
import { restartContinuationBlocked } from "../RestartContinuation.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";
import * as ThreadMessageIntake from "../ThreadMessageIntake.ts";
import { userFacingDispatchErrorMessage } from "../UserFacingErrors.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as PanelChat from "./PanelChatService.ts";
import * as PanelTurnReactor from "./PanelTurnReactor.ts";

const parentThreadId = ThreadId.make("thread:panel-parent");
const panelThreadId = ThreadId.make("thread:panel");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const model = "panel-model";
const alternateModel = "alternate-panel-model";
const selection = (instanceId: ProviderInstanceId, effort: string) => ({
  instanceId,
  model,
  options: [{ id: "reasoningEffort", value: effort }],
});

const panelist = (modelSelection: OrchestrationV2Run["modelSelection"]) => ({
  role: "panelist" as const,
  modelSelection,
});
const codeAgent = (modelSelection: OrchestrationV2Run["modelSelection"]) => ({
  role: "code_agent" as const,
  modelSelection,
});

const createPanel: Extract<OrchestrationV2Command, { type: "panel.create" }> = {
  type: "panel.create",
  commandId: CommandId.make("command:open-panel"),
  parentThreadId,
  threadId: panelThreadId,
  participants: [panelist(selection(codex, "low")), panelist(selection(codex, "high"))],
  rounds: 1,
  topicMessageId: MessageId.make("message:panel-topic"),
  topic: "  How should we simplify the queue?  ",
  createdBy: "user",
  creationSource: "web",
};

const providerSnapshot = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: string,
): ServerProvider => ({
  instanceId,
  driver,
  displayName,
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  version: null,
  models: [
    {
      slug: model,
      name: "Panel Model",
      shortName: "Panel Model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            type: "select",
            id: "reasoningEffort",
            label: "Effort",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
    { slug: alternateModel, name: "Alternate Panel Model", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
});

type Reply =
  | { readonly text: string }
  | { readonly failure: OrchestrationV2ProviderFailure }
  | { readonly wait: true };

type SeenTurns = Ref.Ref<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>;

function fakeAdapter(
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  capabilities: OrchestrationV2ProviderCapabilities,
  reply: Ref.Ref<Reply>,
  seenTurns: SeenTurns,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        let threadOrdinal = 0;
        const held = new Map<
          ProviderTurnId,
          {
            readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
            readonly providerTurn: OrchestrationV2ProviderTurn;
          }
        >();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? process.cwd(),
            model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.sync(() => {
              const nativeId = `${input.providerSessionId}:${++threadOrdinal}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              };
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* Ref.update(seenTurns, (turns) => [...turns, turn]);
              const response = yield* Ref.get(reply);
              const completedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
              const turnFields = {
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
              };
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: providerTurnId,
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${turn.attemptId}`,
                  strength: "strong",
                },
                ordinal: turn.providerTurnOrdinal,
                status:
                  "wait" in response ? "running" : "failure" in response ? "failed" : "completed",
                startedAt: now,
                completedAt: "wait" in response ? null : completedAt,
              };
              yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
              if ("wait" in response) {
                held.set(providerTurnId, { input: turn, providerTurn });
                return;
              }
              if ("failure" in response) {
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  ...turnFields,
                  runOrdinal: turn.runOrdinal,
                  failureItemOrdinal: 1,
                  status: "failed",
                  failure: response.failure,
                  threadDisposition: "reusable",
                });
                return;
              }
              const messageId = MessageId.make(`message:${turn.runId}:assistant`);
              yield* Queue.offerAll(events, [
                {
                  type: "message.updated",
                  driver,
                  message: {
                    id: messageId,
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    role: "assistant",
                    createdBy: "agent",
                    creationSource: "provider",
                    text: response.text,
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: completedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:${turn.runId}:assistant`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "completed",
                    title: null,
                    startedAt: now,
                    completedAt,
                    updatedAt: completedAt,
                    type: "assistant_message",
                    messageId,
                    text: response.text,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  ...turnFields,
                  runOrdinal: turn.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.die("unexpected steer"),
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              const turn = held.get(providerTurnId);
              if (turn === undefined) return;
              held.delete(providerTurnId);
              yield* Queue.offerAll(events, [
                {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    ...turn.providerTurn,
                    status: "interrupted",
                    completedAt: yield* DateTime.now,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerTurn.providerThreadId,
                  providerTurnId,
                  runOrdinal: turn.input.runOrdinal,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unexpected snapshot read"),
          rollbackThread: () => Effect.die("unexpected rollback"),
          forkThread: () => Effect.die("unexpected native fork"),
        };
      }),
  };
}

type Availability =
  | "ready"
  | "disabled"
  | "removed"
  | "uninstalled"
  | "signed-out"
  | "model-removed";

const panelFixture = Effect.gen(function* () {
  const cwd = yield* checkpointWorkspace("panel-chat");
  const reply = yield* Ref.make<Reply>({ text: "Keep one queue for the application." });
  const availability = yield* Ref.make<Availability>("ready");
  const seenTurns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
  const codexAdapter = fakeAdapter(
    codex,
    ProviderDriverKind.make("codex"),
    CodexProviderCapabilitiesV2,
    reply,
    seenTurns,
  );
  const claudeAdapter = fakeAdapter(
    claude,
    ProviderDriverKind.make("claudeAgent"),
    {
      ...ClaudeProviderCapabilitiesV2,
      runtimePolicy: {
        ...ClaudeProviderCapabilitiesV2.runtimePolicy,
        panelChat: { readOnly: "declined", panelistToolsRemoved: false },
      },
    },
    reply,
    seenTurns,
  );
  const codexSnapshot = providerSnapshot(codex, codexAdapter.driver, "Codex");
  const claudeSnapshot = providerSnapshot(claude, claudeAdapter.driver, "Claude");
  const registry = ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: (instanceId) =>
      Ref.get(availability).pipe(
        Effect.flatMap((state) => {
          if (instanceId === claude) return Effect.succeed(claudeAdapter);
          if (instanceId === codex && state !== "removed") return Effect.succeed(codexAdapter);
          return Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          );
        }),
      ),
    list: () =>
      Ref.get(availability).pipe(
        Effect.map((state) => (state === "removed" ? [claude] : [codex, claude])),
      ),
    getMetadata: (instanceId) =>
      Effect.gen(function* () {
        const adapter = yield* registry.get(instanceId);
        const capabilities = yield* adapter.getCapabilities().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRegistry.ProviderAdapterRegistryMetadataError({
                instanceId,
                cause,
              }),
          ),
        );
        return {
          driver: adapter.driver,
          continuationKey: instanceId,
          enabled: instanceId !== codex || (yield* Ref.get(availability)) !== "disabled",
          capabilities,
        };
      }),
  });
  const adapterLayer = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, registry);
  const database = SqlitePersistence.layerMemory;
  const snapshotLayer = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Ref.get(availability).pipe(
      Effect.map((state) => [
        {
          ...codexSnapshot,
          enabled: state !== "disabled",
          installed: state !== "uninstalled",
          auth:
            state === "signed-out" ? { status: "unauthenticated" as const } : codexSnapshot.auth,
          models: state === "model-removed" ? [] : codexSnapshot.models,
        },
        claudeSnapshot,
      ]),
    ),
  });
  const dependencies = Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry({ name: "panel-chat" }, adapterLayer, {
      databaseLayer: database,
      runEffectWorker: false,
      providerRegistryLayer: snapshotLayer,
    }),
    adapterLayer,
    snapshotLayer,
    CommandReceiptStore.layer.pipe(Layer.provide(database)),
    ProjectionStore.layer.pipe(Layer.provide(database)),
    ProjectStore.layer.pipe(Layer.provide(database)),
    IdAllocator.layer,
    ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
    NodeServices.layer,
    ServerConfig.layerTest(cwd, { prefix: "t3-panel-intake-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.mock(DocumentText.DocumentText)({}),
  );
  const layer = Layer.mergeAll(
    PanelChat.layer,
    PanelTurnReactor.layer,
    ProviderRuntimeRecovery.layer,
  ).pipe(Layer.provideMerge(ThreadManagement.layer), Layer.provideMerge(dependencies));
  return { cwd, layer, reply, availability, seenTurns };
}).pipe(Effect.provide(NodeServices.layer));

const dispatchClient = (command: OrchestrationV2Command) =>
  ThreadMessageIntake.dispatchCommand(command, { managesProviders: false });

const sendParentMessage = (commandId: string): OrchestrationV2Command => ({
  type: "message.dispatch",
  commandId: CommandId.make(commandId),
  threadId: parentThreadId,
  messageId: MessageId.make(`message:${commandId}`),
  text: "Parent conversation",
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
});

const createParent = Effect.fn("PanelTest.createParent")(function* (cwd: string, send = true) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("command:create-parent"),
    threadId: parentThreadId,
    projectId: ProjectId.make("project:panel"),
    title: "Parent",
    modelSelection: selection(codex, "low"),
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "panel-branch",
    worktreePath: cwd,
    createdBy: "user",
    creationSource: "web",
  });
  if (!send) return;
  yield* orchestrator.dispatch(sendParentMessage("command:parent-topic"));
  const { runs } = yield* orchestrator.getThreadProjection(parentThreadId);
  yield* finishRun(parentThreadId, runs[0]!.id);
});

const finishRun = Effect.fn("PanelTest.finishRun")(function* (threadId: ThreadId, runId: RunId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const sink = yield* EventSink.EventSinkV2;
  const afterSequence = yield* sink.latestSequence();
  const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
  const run = runs[0]!;
  if (ThreadManagement.isTerminalRunStatus(run.status)) return run;
  const awaitRunStatus = Effect.fn("PanelTest.awaitRunStatus")(function* (includeWaiting: boolean) {
    const stored = yield* sink.stream({ afterSequence, threadId }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          (ThreadManagement.isTerminalRunStatus(event.payload.status) ||
            (includeWaiting && event.payload.status === "waiting")),
      ),
      Stream.runHead,
    );
    const event = stored._tag === "Some" ? stored.value.event : undefined;
    if (event?.type !== "run.updated") throw new Error("Missing run status event.");
    return event.payload;
  });
  yield* worker.drain();
  yield* TestClock.adjust(0);
  const ended = yield* awaitRunStatus(true);
  if (ended.status !== "waiting") return ended;
  yield* worker.drain();
  return yield* awaitRunStatus(false);
});

const settleCurrent = Effect.fn("PanelTest.settleCurrent")(function* (finish = true) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const { thread } = yield* orchestrator.getThreadRecords(panelThreadId, []);
  const runId = thread.panel!.current!.runId;
  if (finish) yield* finishRun(panelThreadId, runId);
  return yield* orchestrator.dispatch({
    type: "panel.turn.settle",
    commandId: CommandId.make(`panel:${panelThreadId}:settle:${runId}`),
    threadId: panelThreadId,
    trigger: { type: "run_ended", runId },
  });
});

const continuePanel = (id: string) =>
  dispatchClient({
    type: "panel.continue",
    commandId: CommandId.make(id),
    threadId: panelThreadId,
  });

const postPanel = (id: string, text: string) =>
  dispatchClient({
    type: "panel.post",
    commandId: CommandId.make(id),
    threadId: panelThreadId,
    messageId: MessageId.make(id),
    text,
  });

const awaitPanelEvent = Effect.fn("PanelTest.awaitPanelEvent")(function* (
  afterSequence: number,
  matches: (event: OrchestrationV2DomainEvent) => boolean,
) {
  const sink = yield* EventSink.EventSinkV2;
  const stored = yield* sink.stream({ threadId: panelThreadId, afterSequence }).pipe(
    Stream.filter(({ event }) => matches(event)),
    Stream.runHead,
  );
  if (stored._tag === "None") return yield* Effect.die("Expected a persisted panel event.");
  return stored.value.event;
});

const panelTurns = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.map(({ panelTurn }) => [
    panelTurn?.participantId,
    panelTurn?.kind,
    panelTurn?.outcome,
  ]);

it.effect(
  "creates a hidden panel with a topic, fork transfer, title effect, and first fresh run",
  () =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* createParent(fixture.cwd);
        const opened = yield* dispatchClient(createPanel);
        const projection = yield* orchestrator.getThreadProjection(panelThreadId);
        const { thread } = projection;
        assert.isFalse(isListedThreadLineage(thread.lineage));
        assert.include(thread.lineage, {
          sideChat: true,
          parentThreadId,
          relationshipToParent: "fork",
        });
        assert.include(thread, {
          forkedFrom: null,
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreePath: fixture.cwd,
          branch: "panel-branch",
          title: "How should we simplify the queue?",
          titleRenamed: false,
        });
        assert.deepEqual(
          thread.panel?.participants.map(({ id, handle, name }) => ({ id, handle, name })),
          [
            { id: "p1", handle: "panel-model", name: "Panel Model · Low" },
            { id: "p2", handle: "panel-model-2", name: "Panel Model · High" },
          ],
        );
        assert.lengthOf(projection.runs, 1);
        const run = projection.runs[0]!;
        assert.equal(thread.panel?.current?.runId, run.id);
        assert.equal(thread.panel?.turnCount, 1);
        assert.isTrue(run.freshContext);
        assert.isNull(run.contextHandoffId);
        assert.deepEqual(run.panelTurn, {
          participantId: "p1",
          kind: "reply",
          round: 1,
          totalRounds: 1,
        });
        assert.deepEqual(
          projection.messages.map(({ id, text, runId, panelParticipantId }) => ({
            id,
            text,
            runId,
            panelParticipantId,
          })),
          [
            {
              id: createPanel.topicMessageId,
              text: createPanel.topic.trim(),
              runId: null,
              panelParticipantId: undefined,
            },
            { id: run.userMessageId, text: "", runId: run.id, panelParticipantId: "p1" },
          ],
        );
        const items = projection.turnItems.filter((item) => item.type === "user_message");
        assert.lengthOf(items, 2);
        assert.include(items[0], {
          runId: null,
          createdBy: "user",
          text: createPanel.topic.trim(),
        });
        assert.include(items[1], {
          messageId: run.userMessageId,
          text: "",
          panelParticipantId: "p1",
        });
        assert.deepEqual((yield* orchestrator.getThreadShell(panelThreadId))?.panel, {
          status: "running",
          idleReason: null,
        });
        assert.isTrue(
          opened.storedEvents.some(({ event }) => event.type === "context-transfer.created"),
        );
        assert.equal(projection.contextTransfers[0]?.status, "superseded");
        const titleJobs = (yield* outbox.listByCommandId(createPanel.commandId)).filter(
          ({ request }) => request.type === "thread-title.generate",
        );
        assert.lengthOf(titleJobs, 1);
        yield* Ref.set(fixture.availability, "disabled");
        const replay = yield* dispatchClient(createPanel);
        assert.isTrue(replay.replayed);
        assert.equal(replay.sequence, opened.sequence);
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect("settles two panelist replies and the first panelist's conclusion", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createParent(fixture.cwd);
      yield* dispatchClient(createPanel);
      for (const participantId of ["p1", "p2", "p1"]) {
        const { thread } = yield* orchestrator.getThreadRecords(panelThreadId, []);
        assert.equal(thread.panel?.current?.participantId, participantId);
        yield* settleCurrent();
      }
      const projection = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.deepEqual(panelTurns(projection), [
        ["p1", "reply", "replied"],
        ["p2", "reply", "replied"],
        ["p1", "conclusion", "replied"],
      ]);
      assert.include(projection.thread.panel, {
        status: "idle",
        idleReason: "concluded",
        current: null,
        cursor: "p2",
      });
      assert.equal(new Set(projection.runs.map((run) => run.providerThreadId)).size, 3);
      assert.isTrue(
        projection.messages
          .filter((message) => message.role === "user" && message.runId !== null)
          .every((message) => message.text === ""),
      );
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("keeps just the latest post as the next queue while storing every post", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createParent(fixture.cwd);
      yield* dispatchClient(createPanel);
      const refused = yield* continuePanel("command:continue-running").pipe(Effect.flip);
      assert.equal(userFacingDispatchErrorMessage(refused), "This panel chat is already running.");
      yield* postPanel("message:open-post", "Continue in order.");
      yield* postPanel("message:addressed-post", " @panel-model-2 What about retries? ");
      const pending = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.lengthOf(pending.runs, 1);
      assert.deepEqual(pending.thread.panel?.pendingPost, {
        messageId: MessageId.make("message:addressed-post"),
        mentionedParticipantIds: ["p2"],
      });

      yield* settleCurrent();
      const next = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.deepEqual(next.runs[1]?.panelTurn, {
        participantId: "p2",
        kind: "reply",
        round: 0,
        totalRounds: 0,
        askedBy: "user",
      });
      assert.isNull(next.thread.panel?.pendingPost);
      assert.sameMembers(
        next.messages
          .filter((message) => message.role === "user" && message.runId === null)
          .map((message) => message.text),
        [createPanel.topic.trim(), "Continue in order.", "@panel-model-2 What about retries?"],
      );
      yield* settleCurrent();
      const answered = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.lengthOf(answered.runs, 2);
      assert.equal(answered.thread.panel?.idleReason, "answered");
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("stops the queue, keeps the cutoff cursor, and accepts a post while stopping", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const stop = (id: string) =>
        orchestrator.dispatch({
          type: "thread.stop",
          threadId: panelThreadId,
          commandId: CommandId.make(id),
        });
      yield* createParent(fixture.cwd);
      yield* dispatchClient(createPanel);
      yield* stop("command:first-stop");
      const stopping = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.include(stopping.thread.panel, {
        status: "idle",
        idleReason: "stopped",
        pendingPost: null,
      });
      assert.deepEqual(stopping.thread.panel?.queue, []);
      assert.equal(stopping.thread.panel?.current?.runId, stopping.runs[0]?.id);
      const refused = yield* continuePanel("command:continue-stopping").pipe(Effect.flip);
      assert.equal(userFacingDispatchErrorMessage(refused), "This panel chat is still stopping.");
      yield* settleCurrent(false);

      const stopped = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.deepEqual(panelTurns(stopped), [["p1", "reply", "stopped"]]);
      assert.include(stopped.thread.panel, { current: null, cursor: "p1", idleReason: "stopped" });
      yield* continuePanel("command:continue-idle");
      assert.equal(
        (yield* orchestrator.getThreadRecords(panelThreadId, [])).thread.panel?.current
          ?.participantId,
        "p2",
      );

      yield* stop("command:second-stop");
      yield* postPanel("message:post-during-stop", "@panel-model Answer this.");
      assert.lengthOf((yield* orchestrator.getThreadRecords(panelThreadId, ["runs"])).runs, 2);
      yield* settleCurrent(false);
      const posted = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.deepEqual(panelTurns(posted), [
        ["p1", "reply", "stopped"],
        ["p2", "reply", "stopped"],
        ["p1", "reply", undefined],
      ]);
      assert.equal(posted.runs[2]?.panelTurn?.askedBy, "user");
      assert.isNull(posted.thread.panel?.pendingPost);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("interrupts the matching timed-out turn and schedules its successor on settlement", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createParent(fixture.cwd);
      yield* dispatchClient(createPanel);
      const { thread } = yield* orchestrator.getThreadRecords(panelThreadId, []);
      yield* orchestrator.dispatch({
        type: "panel.turn.settle",
        commandId: CommandId.make("command:time-limit"),
        threadId: panelThreadId,
        trigger: { type: "time_limit", runId: thread.panel!.current!.runId },
      });
      const interrupted = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.isTrue(interrupted.thread.panel?.current?.timedOut);
      assert.equal(interrupted.runs[0]?.status, "interrupted");
      assert.include(
        interrupted.turnItems.find((item) => item.type === "run_interrupt_request"),
        {
          message: "Panel reply time limit",
        },
      );
      yield* settleCurrent(false);
      assert.deepEqual(panelTurns(yield* orchestrator.getThreadProjection(panelThreadId)), [
        ["p1", "reply", "timed_out"],
        ["p2", "reply", undefined],
      ]);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("archives and restores the stopped panel with its parent and cascades deletion", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createParent(fixture.cwd);
      yield* dispatchClient(createPanel);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        threadId: parentThreadId,
        commandId: CommandId.make("command:archive-parent"),
      });
      const archived = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.isNotNull(archived.thread.archivedAt);
      assert.include(archived.thread.panel, {
        status: "idle",
        idleReason: "stopped",
        pendingPost: null,
      });
      assert.deepEqual(archived.thread.panel?.queue, []);
      assert.equal(archived.runs[0]?.status, "interrupted");
      yield* settleCurrent(false);
      const refused = yield* postPanel("message:archived", "Can you respond?").pipe(Effect.flip);
      assert.equal(userFacingDispatchErrorMessage(refused), "This panel chat is unavailable.");
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        threadId: parentThreadId,
        commandId: CommandId.make("command:unarchive-parent"),
      });
      const restored = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.isNull(restored.thread.archivedAt);
      assert.equal(restored.thread.panel?.idleReason, "stopped");
      assert.lengthOf(restored.runs, 1);
      yield* orchestrator.dispatch({
        type: "thread.delete",
        threadId: parentThreadId,
        commandId: CommandId.make("command:delete-parent"),
      });
      const store = yield* ProjectionStore.ProjectionStoreV2;
      assert.isNotNull((yield* store.findThread(panelThreadId))?.deletedAt);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect(
  "rejects ordinary sends and client thread controls on a panel regardless of provenance",
  () =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createParent(fixture.cwd);
        yield* dispatchClient(createPanel);
        const { thread } = yield* orchestrator.getThreadRecords(panelThreadId, []);
        const { runId } = thread.panel!.current!;
        const send = {
          type: "message.dispatch",
          commandId: CommandId.make("command:legacy-send"),
          threadId: panelThreadId,
          messageId: MessageId.make("message:legacy-send"),
          text: "Send directly",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        } as const satisfies OrchestrationV2Command;
        for (const error of [
          yield* threads.dispatch(send).pipe(Effect.flip),
          yield* orchestrator.dispatch(send).pipe(Effect.flip),
        ]) {
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.equal(
            userFacingDispatchErrorMessage(error),
            "Update the app to post in a panel chat.",
          );
        }
        const base = {
          threadId: panelThreadId,
          commandId: CommandId.make("command:blocked-control"),
        };
        const fork = {
          commandId: base.commandId,
          createdBy: "agent",
          creationSource: "server",
          sourcePoint: { type: "latest_stable" },
        } as const;
        const commands: ReadonlyArray<OrchestrationV2Command> = [
          {
            ...fork,
            type: "thread.fork",
            sourceThreadId: panelThreadId,
            targetThreadId: ThreadId.make("thread:other"),
          },
          {
            ...fork,
            type: "thread.fork",
            sourceThreadId: parentThreadId,
            targetThreadId: panelThreadId,
          },
          {
            ...fork,
            type: "thread.merge_back",
            sourceThreadId: panelThreadId,
            targetThreadId: parentThreadId,
          },
          {
            ...fork,
            type: "thread.merge_back",
            sourceThreadId: parentThreadId,
            targetThreadId: panelThreadId,
          },
          {
            ...base,
            type: "checkpoint.rollback",
            checkpointId: CheckpointId.make("checkpoint:panel"),
            scopeId: CheckpointScopeId.make("scope:panel"),
          },
          { ...base, type: "provider.switch", modelSelection: selection(claude, "low") },
          { ...base, type: "thread.runtime-mode.set", runtimeMode: "full-access" },
          { ...base, type: "thread.interaction-mode.set", interactionMode: "plan" },
          { ...base, type: "thread.model-selection.set", modelSelection: selection(codex, "high") },
          {
            ...base,
            type: "queued-message.promote-to-steer",
            queuedRunId: runId,
            targetRunId: runId,
          },
          { ...base, type: "queued-run.start", runId },
          { ...base, type: "queued-run.reorder", runId, beforeRunId: null },
          { ...base, type: "queued-run.cancel", runId },
          { ...base, type: "queued-run.edit", runId, text: "retry" },
          { ...base, type: "queue.resume" },
          { ...base, type: "thread.snooze", snoozedUntil: "2026-12-01T00:00:00.000Z" },
        ];
        for (const command of commands) {
          const error = yield* threads.dispatch(command).pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError", command.type);
          assert.equal(
            userFacingDispatchErrorMessage(error),
            "This command isn't available in panel chats.",
            command.type,
          );
        }
        const ordinaryFork = yield* threads.dispatch({
          ...fork,
          type: "thread.fork",
          sourceThreadId: parentThreadId,
          targetThreadId: ThreadId.make("thread:ordinary-fork"),
        });
        assert.isTrue(
          ordinaryFork.storedEvents.some(({ event }) => event.type === "thread.created"),
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect("returns specific setup and post validation errors through intake", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const refuseCreate = Effect.fn("PanelTest.refuseCreate")(function* (
        patch: Partial<typeof createPanel>,
        message: string,
      ) {
        const error = yield* dispatchClient({ ...createPanel, ...patch }).pipe(Effect.flip);
        assert.equal(error._tag, "PanelChatError");
        assert.equal(userFacingDispatchErrorMessage(error), message);
      });
      yield* createParent(fixture.cwd, false);
      yield* refuseCreate({}, "Panel chats start after the first message.");
      yield* orchestrator.dispatch(sendParentMessage("command:parent-topic"));
      const first = createPanel.participants[0]!;
      const differentOption = { id: "fastMode", value: true };
      yield* refuseCreate({ participants: [first] }, "Add at least 2 models.");
      yield* refuseCreate(
        { participants: Array.from({ length: PANEL_MAX_PANELISTS + 1 }, () => first) },
        "A panel has up to 5 models.",
      );
      yield* refuseCreate(
        {
          participants: [
            ...createPanel.participants,
            codeAgent(selection(codex, "low")),
            codeAgent(selection(codex, "high")),
          ],
        },
        "A panel can have only one code agent.",
      );
      yield* refuseCreate({ rounds: 6 }, "Choose between 1 and 5 rounds.");
      yield* refuseCreate({ topic: " " }, "Enter a topic.");
      yield* refuseCreate(
        { topic: "x".repeat(PANEL_TEXT_MAX_CHARS + 1) },
        "Keep the topic under 8,000 characters.",
      );
      yield* refuseCreate(
        {
          participants: [
            panelist({
              ...first.modelSelection,
              options: [...first.modelSelection.options!, differentOption],
            }),
            panelist({
              ...first.modelSelection,
              options: [differentOption, ...first.modelSelection.options!],
            }),
          ],
        },
        "Already in this panel.",
      );
      yield* refuseCreate(
        {
          participants: [first, panelist({ ...selection(codex, "high"), model: "missing-model" })],
        },
        "This provider can't join a panel chat.",
      );
      yield* refuseCreate(
        {
          participants: [
            first,
            panelist(selection(ProviderInstanceId.make("missing-instance"), "low")),
          ],
        },
        "This provider can't join a panel chat.",
      );
      yield* refuseCreate(
        { participants: [...createPanel.participants, codeAgent(selection(claude, "low"))] },
        "This provider can't be limited to reading, so it can't be the code agent.",
      );
      yield* Ref.set(fixture.availability, "disabled");
      yield* refuseCreate({}, "This provider can't join a panel chat.");
      yield* Ref.set(fixture.availability, "ready");
      assert.isNull(yield* orchestrator.getThreadShell(panelThreadId));

      yield* dispatchClient(createPanel);
      const empty = yield* postPanel("message:empty-post", " ").pipe(Effect.flip);
      const long = yield* postPanel("message:long-post", "x".repeat(PANEL_TEXT_MAX_CHARS + 1)).pipe(
        Effect.flip,
      );
      assert.equal(userFacingDispatchErrorMessage(empty), "Enter a message.");
      assert.equal(
        userFacingDispatchErrorMessage(long),
        "Keep panel messages under 8,000 characters.",
      );
      yield* refuseCreate(
        {
          commandId: CommandId.make("command:nested-panel"),
          parentThreadId: panelThreadId,
          threadId: ThreadId.make("thread:nested-panel"),
        },
        "Panel chats start after the first message.",
      );
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect.each(["disabled", "removed"] as const)(
  "settles when the next provider is %s",
  (availability) =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createParent(fixture.cwd);
        const codexSelection = selection(codex, "low");
        yield* dispatchClient({
          ...createPanel,
          participants: [
            panelist(selection(claude, "low")),
            panelist({
              ...codexSelection,
              options: [...codexSelection.options, { id: "fastMode", value: true }],
            }),
          ],
        });
        const first = yield* orchestrator.getThreadProjection(panelThreadId);
        assert.deepEqual(
          first.thread.panel?.participants.map(({ name, toolsRemoved }) => [name, toolsRemoved]),
          [
            ["Panel Model · Claude", false],
            ["Panel Model · Codex", true],
          ],
        );
        yield* finishRun(panelThreadId, first.runs[0]!.id);
        yield* Ref.set(fixture.availability, availability);
        const settled = yield* settleCurrent(false);
        const next = yield* orchestrator.getThreadProjection(panelThreadId);
        assert.isTrue(
          settled.storedEvents.some(({ event }) => event.type === "provider-session.detached"),
        );
        assert.deepEqual(panelTurns(next), [
          ["p1", "reply", "replied"],
          availability === "disabled"
            ? ["p2", "reply", undefined]
            : ["p1", "conclusion", undefined],
        ]);
        assert.equal(next.runs[1]?.status, "starting");
        assert.equal(
          next.runs[1]?.providerInstanceId,
          availability === "disabled" ? codex : claude,
        );
        assert.equal(next.thread.panel?.turnCount, 2);
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect("schedules a code lookup and keeps its outcome through a stale lifecycle write", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* createParent(fixture.cwd);
      yield* dispatchClient({
        ...createPanel,
        participants: [
          codeAgent(selection(codex, "low")),
          panelist(selection(codex, "low")),
          panelist({ instanceId: codex, model: alternateModel }),
        ],
      });
      const first = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.equal(first.thread.panel?.participants[0]?.name, "Panel Model");
      assert.include(first.thread.panel?.participants[2], {
        id: "code",
        handle: "code",
        name: "Panel Model",
        toolsRemoved: true,
      });
      yield* Ref.set(fixture.reply, {
        text: "We should inspect that.\n@code Where does the queue live?",
      });
      const stale = yield* finishRun(panelThreadId, first.runs[0]!.id);
      yield* settleCurrent(false);
      const settled = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.include(settled.runs[1]?.panelTurn, {
        participantId: "code",
        kind: "lookup",
        askedBy: "p1",
      });
      const late = {
        id: EventId.make("event:late-panel-run"),
        type: "run.updated",
        threadId: panelThreadId,
        runId: stale.id,
        occurredAt: yield* DateTime.now,
        payload: stale,
      } as const;
      assert.include(ProjectionStore.applyToProjection(settled, late).runs[0]?.panelTurn, {
        outcome: "replied",
        lookup: "requested",
      });
      yield* sink.writeWithEffects({ events: [late], effects: [] });
      const projection = yield* orchestrator.getThreadProjection(panelThreadId);
      assert.include(projection.runs[0]?.panelTurn, { outcome: "replied", lookup: "requested" });
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect(
  "excludes panel usage-limit failures from recovery and preserves their outcome detail",
  () =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        yield* createParent(fixture.cwd);
        yield* dispatchClient(createPanel);
        const now = yield* DateTime.now;
        const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 5 }));
        yield* Ref.set(fixture.reply, {
          failure: {
            class: "usage_limit",
            message: "Quota reached.",
            code: null,
            retryable: false,
            resetAt,
          },
        });
        const parentDispatch = yield* orchestrator.dispatch(
          sendParentMessage("command:parent-limit"),
        );
        const parentRun = parentDispatch.storedEvents.find(
          ({ event }) => event.type === "run.created",
        )!.event.runId!;
        const { thread } = yield* orchestrator.getThreadRecords(panelThreadId, []);
        const limited = yield* finishRun(panelThreadId, thread.panel!.current!.runId);
        yield* finishRun(parentThreadId, parentRun);
        assert.equal(limited.status, "failed");
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: true,
        });
        assert.deepEqual(
          candidates.map(({ id }) => id),
          [parentThreadId],
        );

        yield* settleCurrent(false);
        const { panelTurn: _panelTurn, ...staleRun } = limited;
        yield* sink.writeWithEffects({
          events: [
            {
              id: EventId.make("event:late-limited-run"),
              type: "run.updated",
              threadId: panelThreadId,
              runId: limited.id,
              occurredAt: now,
              payload: staleRun,
            },
          ],
          effects: [],
        });
        assert.include(
          (yield* orchestrator.getThreadProjection(panelThreadId)).runs[0]?.panelTurn,
          {
            outcome: "limited",
            outcomeDetail: "Quota reached.",
          },
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect(
  "composes panelist and lookup prompts from the committed discussion without storing them",
  () =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const reactor = yield* PanelTurnReactor.PanelTurnReactor;
        const sink = yield* EventSink.EventSinkV2;
        const readPanel = engine.getThreadProjection(panelThreadId);
        yield* createParent(fixture.cwd);
        yield* dispatchClient({
          ...createPanel,
          participants: [...createPanel.participants, codeAgent(selection(codex, "low"))],
        });
        const first = (yield* readPanel).runs[0]!;
        yield* Ref.set(fixture.reply, { text: "Use one queue.\n@code Where is it defined?" });
        const afterOpen = yield* sink.latestSequence();
        yield* finishRun(panelThreadId, first.id);
        const ended = yield* awaitPanelEvent(
          afterOpen,
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.id &&
            event.payload.status === "completed",
        );
        yield* reactor.handle(ended);
        yield* reactor.handle(ended);
        const lookup = (yield* readPanel).runs[1]!;
        assert.lengthOf((yield* readPanel).runs, 2);
        yield* Ref.set(fixture.reply, { text: "One queue is defined in queue.ts:42." });
        yield* finishRun(panelThreadId, lookup.id);
        const lookupInput = (yield* Ref.get(fixture.seenTurns)).find(
          (turn) => turn.runId === lookup.id,
        );
        assert.include(lookupInput?.message.text, '<message from="@panel-model">Use one queue.');
        assert.include(
          lookupInput?.message.text,
          'Requests to answer:\n<message from="@panel-model">@code Where is it defined?</message>',
        );
        assert.deepEqual(lookupInput?.runtimePolicy?.panel, { role: "code_agent" });
        yield* settleCurrent(false);

        const second = (yield* readPanel).runs[2]!;
        yield* postPanel("message:z-first", "@code What about the tests?");
        yield* postPanel("message:a-last", "@code Find the queue tests.");
        yield* Ref.set(fixture.reply, { text: "Agreed." });
        yield* finishRun(panelThreadId, second.id);
        yield* settleCurrent(false);
        const userLookup = (yield* readPanel).runs[3]!;
        yield* postPanel("message:after-lookup", "@code Do not use this later post yet.");
        yield* finishRun(panelThreadId, userLookup.id);

        const seen = yield* Ref.get(fixture.seenTurns);
        const secondInput = seen.find((turn) => turn.runId === second.id);
        assert.include(
          secondInput?.message.text,
          '<message from="user">How should we simplify the queue?</message>',
        );
        assert.include(secondInput?.message.text, '<message from="@panel-model">Use one queue.');
        assert.include(
          secondInput?.message.text,
          '<message from="@code">One queue is defined in queue.ts:42.</message>',
        );
        assert.notInclude(secondInput?.message.text, "Find the queue tests.");
        assert.deepEqual(secondInput?.runtimePolicy?.panel, { role: "panelist" });
        assert.isUndefined(secondInput?.appContext);
        const userInput = seen.find((turn) => turn.runId === userLookup.id);
        assert.include(
          userInput?.message.text,
          'Requests to answer:\n<message from="user">@code Find the queue tests.</message>',
        );
        assert.notInclude(userInput?.message.text, "Do not use this later post yet.");
        const projection = yield* readPanel;
        assert.deepEqual(
          projection.messages
            .filter((message) => message.panelParticipantId !== undefined)
            .map((message) => message.text),
          ["", "", "", ""],
        );
        const persistedMessages = yield* sink
          .stream({ threadId: panelThreadId, eventType: "message.updated" })
          .pipe(
            Stream.takeUntil(
              ({ event }) =>
                event.type === "message.updated" &&
                event.payload.runId === userLookup.id &&
                event.payload.role === "assistant",
            ),
            Stream.runCollect,
          );
        assert.isFalse(
          persistedMessages.some(
            ({ event }) =>
              event.type === "message.updated" && event.payload.text.includes("Discussion so far:"),
          ),
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect.each(["disabled", "uninstalled", "signed-out", "model-removed"] as const)(
  "settles a %s participant as unavailable before starting it",
  (availability) =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        yield* createParent(fixture.cwd);
        yield* dispatchClient({
          ...createPanel,
          participants: [panelist(selection(codex, "low")), panelist(selection(claude, "low"))],
        });
        yield* Ref.set(fixture.availability, availability);
        const { thread } = yield* engine.getThreadRecords(panelThreadId, []);
        const runId = thread.panel!.current!.runId;
        const failed = yield* finishRun(panelThreadId, runId);
        assert.equal(failed.status, "failed");
        assert.isNull(failed.startedAt);
        const projection = yield* engine.getThreadProjection(panelThreadId);
        const item = projection.turnItems.find((candidate) => candidate.type === "error");
        assert.equal(item?.type === "error" && item.failure.code, "panel_participant_unavailable");
        assert.isFalse((yield* Ref.get(fixture.seenTurns)).some((turn) => turn.runId === runId));
        yield* settleCurrent(false);
        assert.deepEqual(panelTurns(yield* engine.getThreadProjection(panelThreadId)), [
          ["p1", "reply", "unavailable"],
          ["p2", "reply", undefined],
        ]);
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect.each([
  ["reply", PANEL_PANELIST_REPLY_LIMIT_MS],
  ["lookup", PANEL_CODE_AGENT_REPLY_LIMIT_MS],
] as const)("interrupts a live %s at its time limit and advances the panel", ([kind, limit]) =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* PanelTurnReactor.PanelTurnReactor;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* createParent(fixture.cwd);
      const afterParent = yield* sink.latestSequence();
      yield* dispatchClient({
        ...createPanel,
        participants: [...createPanel.participants, codeAgent(selection(codex, "low"))],
      });
      if (kind === "lookup") {
        yield* Ref.set(fixture.reply, { text: "Need evidence.\n@code Where does the queue live?" });
        yield* settleCurrent();
      }
      const runId = (yield* engine.getThreadRecords(panelThreadId, [])).thread.panel!.current!
        .runId;
      yield* Ref.set(fixture.reply, { wait: true });
      yield* worker.drain();
      const started = yield* awaitPanelEvent(
        afterParent,
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          event.payload.status === "running",
      );
      yield* awaitPanelEvent(
        afterParent,
        (event) =>
          event.type === "provider-turn.updated" &&
          event.runId === runId &&
          event.payload.status === "running",
      );
      yield* reactor.handle(started);
      yield* TestClock.adjust(limit - 1);
      yield* reactor.handle(started);
      assert.isFalse(
        (yield* engine.getThreadRecords(panelThreadId, [])).thread.panel?.current?.timedOut,
      );
      yield* TestClock.adjust(1);
      yield* awaitPanelEvent(
        afterParent,
        (event) =>
          event.type === "panel.updated" && event.payload.panel?.current?.timedOut === true,
      );
      yield* worker.drain();
      const ended = yield* awaitPanelEvent(
        afterParent,
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runId &&
          event.payload.status === "interrupted",
      );
      yield* reactor.handle(ended);
      const projection = yield* engine.getThreadProjection(panelThreadId);
      assert.equal(
        projection.runs.find((run) => run.id === runId)?.panelTurn?.outcome,
        "timed_out",
      );
      assert.equal(projection.thread.panel?.current?.participantId, "p2");
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect(
  "declines panel approvals, dismisses questions, and cancels the deadline on archive",
  () =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const engine = yield* Orchestrator.OrchestratorV2;
        const reactor = yield* PanelTurnReactor.PanelTurnReactor;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        yield* createParent(fixture.cwd);
        const sequence = yield* sink.latestSequence();
        yield* dispatchClient(createPanel);
        yield* Ref.set(fixture.reply, { wait: true });
        yield* worker.drain();
        const started = yield* awaitPanelEvent(
          sequence,
          (event) => event.type === "run.updated" && event.payload.status === "running",
        );
        yield* reactor.handle(started);
        const projection = yield* engine.getThreadProjection(panelThreadId);
        const run = projection.runs[0]!;
        const providerSessionId = projection.providerThreads.find(
          (thread) => thread.id === run.providerThreadId,
        )?.providerSessionId;
        assert.isDefined(providerSessionId);
        const now = yield* DateTime.now;
        const live = { type: "live", providerSessionId: providerSessionId! } as const;
        const requests = [
          ["command", live, "decline"],
          ["user_input", { type: "message" }, "cancel"],
          ["user_input", live, "cancel"],
        ] as const;
        for (const [index, [kind, responseCapability, decision]] of requests.entries()) {
          const requestId = RuntimeRequestId.make(`request:panel:${index}`);
          const event = {
            id: EventId.make(`event:panel:request:${index}`),
            type: "runtime-request.updated",
            threadId: panelThreadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId: run.rootNodeId!,
              providerTurnId: null,
              nativeRequestRef: null,
              status: "pending",
              kind,
              responseCapability,
              createdAt: now,
              resolvedAt: null,
            },
          } as const satisfies OrchestrationV2DomainEvent;
          yield* sink.write({ events: [event] });
          yield* reactor.handle(event);
          const after = yield* engine.getThreadProjection(panelThreadId);
          assert.include(
            after.runtimeRequests.find((request) => request.id === requestId),
            {
              status: "resolved",
              decision,
            },
          );
        }
        yield* worker.drain();
        const archived = yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("command:archive-live-panel"),
          threadId: panelThreadId,
        });
        const archiveEvent = archived.storedEvents.find(
          ({ event }) => event.type === "thread.archived",
        )!.event;
        yield* reactor.handle(archiveEvent);
        yield* TestClock.adjust(PANEL_PANELIST_REPLY_LIMIT_MS);
        assert.equal(
          (yield* receipts.getByCommandId(
            CommandId.make(`panel:${panelThreadId}:time-limit:${run.id}`),
          ))._tag,
          "None",
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect("sweeps an in-flight panel to interrupted without starting another turn", () =>
  Effect.gen(function* () {
    const fixture = yield* panelFixture;
    yield* Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const reactor = yield* PanelTurnReactor.PanelTurnReactor;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      yield* createParent(fixture.cwd);
      yield* dispatchClient(createPanel);
      yield* recovery.recover;
      yield* reactor.start();
      const projection = yield* engine.getThreadProjection(panelThreadId);
      assert.include(projection.thread.panel, {
        status: "idle",
        idleReason: "interrupted",
        cursor: "p1",
        current: null,
      });
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["cancelled"],
      );
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect(
  "blocks restart continuation and cancels an unstarted panel run without resending it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* panelFixture;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* createParent(fixture.cwd);
        yield* dispatchClient(createPanel);
        const projection = yield* orchestrator.getThreadProjection(panelThreadId);
        const { panel: _panel, ...ordinaryThread } = projection.thread;
        const now = yield* DateTime.now;
        assert.isFalse(
          restartContinuationBlocked(
            { ...projection, thread: ordinaryThread },
            projection.runs[0]!,
            now,
            false,
          ),
        );
        assert.isTrue(restartContinuationBlocked(projection, projection.runs[0]!, now, false));

        yield* recovery.recover;
        const { runs } = yield* orchestrator.getThreadRecords(panelThreadId, ["runs"]);
        assert.deepEqual(
          runs.map((run) => run.status),
          ["cancelled"],
        );
        const starts = (yield* outbox.listByCommandId(createPanel.commandId)).filter(
          ({ request }) => request.type === "provider-turn.start",
        );
        assert.deepEqual(
          starts.map(({ status }) => status),
          ["cancelled"],
        );
        assert.deepEqual(
          yield* outbox.listByCommandId(CommandId.make(`command:restart-resend:${runs[0]!.id}`)),
          [],
        );
        yield* orchestrator.dispatch({
          type: "panel.turn.settle",
          threadId: panelThreadId,
          commandId: CommandId.make("command:panel-recovery"),
          trigger: { type: "recovery" },
        });
        const recovered = yield* orchestrator.getThreadProjection(panelThreadId);
        assert.include(recovered.thread.panel, {
          status: "idle",
          idleReason: "interrupted",
          cursor: "p1",
          current: null,
        });
        assert.lengthOf(recovered.runs, 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
);
