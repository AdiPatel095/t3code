import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  PANEL_CODE_AGENT_REPLY_LIMIT_MS,
  PANEL_PANELIST_REPLY_LIMIT_MS,
} from "@t3tools/shared/panelChat";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { isTerminalRunStatus } from "../ThreadManagementService.ts";

export class PanelTurnReactor extends Context.Service<
  PanelTurnReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/panel/PanelTurnReactor") {}

function panelEventThread(event: OrchestrationV2DomainEvent): ThreadId | null {
  switch (event.type) {
    case "run.updated":
      return event.payload.panelTurn === undefined ? null : event.threadId;
    case "thread.archived":
    case "thread.deleted":
      return event.payload.panel === undefined ? null : event.threadId;
    case "runtime-request.updated":
      return event.payload.status === "pending" ? event.threadId : null;
    default:
      return null;
  }
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scope = yield* Effect.scope;
  const limits = new Map<ThreadId, { readonly runId: RunId; readonly fiber: Fiber.Fiber<void> }>();

  const cancelLimit = Effect.fn("PanelTurnReactor.cancelLimit")(function* (
    threadId: ThreadId,
    runId?: RunId,
  ) {
    const limit = limits.get(threadId);
    if (limit === undefined || (runId !== undefined && limit.runId !== runId)) return;
    limits.delete(threadId);
    yield* Fiber.interrupt(limit.fiber);
  });

  const handle = Effect.fn("PanelTurnReactor.handle")(
    function* (event: OrchestrationV2DomainEvent) {
      const { threadId } = event;
      if (panelEventThread(event) === null) return;
      switch (event.type) {
        case "run.updated": {
          const run = event.payload;
          if (run.panelTurn === undefined) return;
          if (isTerminalRunStatus(run.status)) {
            yield* cancelLimit(threadId, run.id);
            yield* engine.dispatch({
              type: "panel.turn.settle",
              commandId: CommandId.make(`panel:${threadId}:settle:${run.id}`),
              threadId,
              trigger: { type: "run_ended", runId: run.id },
            });
            return;
          }
          if (run.startedAt === null || limits.get(threadId)?.runId === run.id) return;
          const thread = yield* projections.findThread(threadId);
          if (
            thread?.panel?.status !== "running" ||
            thread.panel.current?.runId !== run.id ||
            thread.archivedAt !== null ||
            thread.deletedAt !== null
          ) {
            return;
          }
          yield* cancelLimit(threadId);
          const duration =
            run.panelTurn.kind === "lookup"
              ? PANEL_CODE_AGENT_REPLY_LIMIT_MS
              : PANEL_PANELIST_REPLY_LIMIT_MS;
          const fiber = yield* Effect.sleep(duration).pipe(
            Effect.andThen(
              engine.dispatch({
                type: "panel.turn.settle",
                commandId: CommandId.make(`panel:${threadId}:time-limit:${run.id}`),
                threadId,
                trigger: { type: "time_limit", runId: run.id },
              }),
            ),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Applying the panel turn time limit failed", {
                    runId: run.id,
                    cause,
                  }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          );
          limits.set(threadId, { runId: run.id, fiber });
          return;
        }
        case "thread.archived":
        case "thread.deleted":
          yield* cancelLimit(threadId);
          return;
        case "runtime-request.updated": {
          const request = event.payload;
          const thread = yield* projections.findThread(threadId);
          if (thread?.panel === undefined) return;
          const current = yield* projections.getRuntimeRequest(threadId, request.id);
          if (current?.status !== "pending") return;
          const commandId = CommandId.make(`panel:${threadId}:dismiss:${request.id}`);
          // The dismiss command accepts message-backed questions. Live questions need a provider cancellation.
          if (current.kind === "user_input" && current.responseCapability.type === "message") {
            yield* engine.dispatch({
              type: "thread.user-input.dismiss",
              commandId,
              threadId,
              requestId: request.id,
            });
          } else {
            yield* engine.dispatch({
              type: "runtime-request.respond",
              commandId,
              threadId,
              requestId: request.id,
              decision: current.kind === "user_input" ? "cancel" : "decline",
            });
          }
        }
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Processing a panel turn event failed", {
                threadId: event.threadId,
                cause,
              }),
        ),
      ),
  );

  const recover = Effect.fn("PanelTurnReactor.recover")(
    function* (threadId: ThreadId) {
      const thread = yield* projections.findThread(threadId);
      if (thread?.panel?.status !== "running") return;
      yield* engine.dispatch({
        type: "panel.turn.settle",
        commandId: CommandId.make(`panel:${threadId}:recovery:${thread.panel.turnCount}`),
        threadId,
        trigger: { type: "recovery" },
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Recovering a panel failed", { threadId, cause }),
        ),
      ),
  );

  const sweep = Effect.gen(function* () {
    const threadIds = yield* projections.listRunningPanelThreadIds();
    yield* Effect.forEach(threadIds, recover, { discard: true });
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Finding panels to recover failed", { cause })),
    Effect.withSpan("PanelTurnReactor.sweep"),
  );

  const start = Effect.fn("PanelTurnReactor.start")(function* () {
    yield* sweep;
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...limits.keys()], (threadId) => cancelLimit(threadId), { discard: true }),
    );
    const reactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) => {
        const threadId = panelEventThread(event);
        return threadId === null ? Effect.void : reactions.run(threadId, handle(event));
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("The panel turn event stream failed", { cause })),
      ),
    );
  });

  return PanelTurnReactor.of({ start, handle, sweep });
});

export const layer = Layer.effect(PanelTurnReactor, make);
