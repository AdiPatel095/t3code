import {
  CommandId,
  isDelegatedAppThread,
  NonNegativeInt,
  type OrchestrationV2Command,
  type OrchestrationV2PanelParticipant,
  OrchestrationV2PanelRole,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  modelSelectionsEqual,
} from "@t3tools/shared/model";
import {
  derivePanelHandle,
  lowestPanelModelOptions,
  PANEL_CODE_HANDLE,
  PANEL_MAX_PANELISTS,
  PANEL_MAX_ROUNDS,
  PANEL_MIN_PANELISTS,
  PANEL_MIN_ROUNDS,
  PANEL_TEXT_MAX_CHARS,
} from "@t3tools/shared/panelChat";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  providerConstraints,
  requireAdvertisedModel,
  withWorkspaceModels,
} from "../../mcp/OrchestratorMcpService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectStore from "../ProjectStore.ts";
import { ProjectionStoreThreadNotFoundError } from "../ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";

type CreateCommand = Extract<OrchestrationV2Command, { type: "panel.create" }>;
type PostCommand = Extract<OrchestrationV2Command, { type: "panel.post" }>;
type ContinueCommand = Extract<OrchestrationV2Command, { type: "panel.continue" }>;
type PanelDispatch = Effect.Effect<
  Orchestrator.OrchestratorV2DispatchResult,
  PanelChatError | Orchestrator.OrchestratorV2Error
>;

export class PanelChatError extends Schema.TaggedError<PanelChatError>()("PanelChatError", {
  commandId: CommandId,
  message: TrimmedNonEmptyString,
  participant: Schema.optional(
    Schema.Struct({ role: OrchestrationV2PanelRole, index: NonNegativeInt }),
  ),
}) {}

export class PanelChatService extends Context.Service<
  PanelChatService,
  {
    readonly create: (command: CreateCommand) => PanelDispatch;
    readonly post: (command: PostCommand) => PanelDispatch;
    readonly continue: (command: ContinueCommand) => PanelDispatch;
  }
>()("t3/orchestration-v2/panel/PanelChatService") {}

const PARENT_UNAVAILABLE = "Panel chats start after the first message.";
const PROVIDER_UNAVAILABLE = "This provider can't join a panel chat.";
const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);
const REASONING_OPTION_IDS = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "variant",
  "reasoning_effort",
  "thinking_level",
  "thought_level",
  "thinking",
]);

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

  const create = Effect.fn("PanelChatService.create")(function* (command: CreateCommand) {
    const reject = (message: string, participant?: PanelChatError["participant"]) =>
      new PanelChatError({
        commandId: command.commandId,
        message,
        ...(participant === undefined ? {} : { participant }),
      });
    // The command receipt owns replay even after the roster's providers or parent change.
    if (yield* threads.hasReceipt(command.commandId)) {
      return yield* orchestrator.dispatch({ ...command, type: "panel.open", participants: [] });
    }

    const panelists = command.participants.filter(({ role }) => role === "panelist");
    const codeAgents = command.participants.filter(({ role }) => role === "code_agent");
    if (panelists.length < PANEL_MIN_PANELISTS) return yield* reject("Add at least 2 models.");
    if (panelists.length > PANEL_MAX_PANELISTS) return yield* reject("A panel has up to 5 models.");
    if (codeAgents.length > 1) return yield* reject("A panel can have only one code agent.");
    if (
      !Number.isInteger(command.rounds) ||
      command.rounds < PANEL_MIN_ROUNDS ||
      command.rounds > PANEL_MAX_ROUNDS
    ) {
      return yield* reject("Choose between 1 and 5 rounds.");
    }
    const topic = command.topic.trim();
    if (topic.length === 0) return yield* reject("Enter a topic.");
    if (topic.length > PANEL_TEXT_MAX_CHARS)
      return yield* reject("Keep the topic under 8,000 characters.");
    const duplicate = panelists.findIndex((panelist, index) =>
      panelists
        .slice(0, index)
        .some((other) => modelSelectionsEqual(panelist.modelSelection, other.modelSelection)),
    );
    if (duplicate !== -1) {
      return yield* reject("Already in this panel.", { role: "panelist", index: duplicate });
    }

    const { thread: parent } = yield* threads.getThreadRecords(command.parentThreadId, []).pipe(
      Effect.catchTags({
        OrchestratorProjectionError: (error) =>
          isProjectionStoreThreadNotFoundError(error.cause)
            ? Effect.fail(reject(PARENT_UNAVAILABLE))
            : Effect.fail(error),
      }),
    );
    if (
      parent.deletedAt !== null ||
      parent.archivedAt !== null ||
      parent.panel !== undefined ||
      parent.lineage.sideChat ||
      isDelegatedAppThread(parent) ||
      (yield* threads.getMessageCount(parent.id)) === 0
    ) {
      return yield* reject(PARENT_UNAVAILABLE);
    }

    const project = yield* projects
      .get(parent.projectId)
      .pipe(
        Effect.mapError(
          (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: parent.id, cause }),
        ),
      );
    const available = withWorkspaceModels(
      yield* providers.getProviders,
      parent.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot,
    );
    const handles = new Set<string>();
    const resolved: Array<{
      readonly participant: OrchestrationV2PanelParticipant;
      readonly instanceName: string;
      readonly effortLabel: string | undefined;
    }> = [];
    for (const [index, { role, modelSelection }] of [
      ...panelists.entries(),
      ...codeAgents.entries(),
    ]) {
      const participantRef = { role, index };
      const rejectProvider = () => reject(PROVIDER_UNAVAILABLE, participantRef);
      const provider = available.find(
        (candidate) => candidate.instanceId === modelSelection.instanceId,
      );
      if (
        provider === undefined ||
        providerConstraints(provider, true).length > 0 ||
        !(yield* threads.isProviderInstanceEnabledForProject({
          projectId: parent.projectId,
          instanceId: provider.instanceId,
        }))
      ) {
        return yield* rejectProvider();
      }
      const adapter = yield* adapters
        .get(provider.instanceId)
        .pipe(Effect.mapError(rejectProvider));
      yield* requireAdvertisedModel(provider, modelSelection.model).pipe(
        Effect.mapError(rejectProvider),
      );
      const model =
        provider.models.find((candidate) => candidate.slug === modelSelection.model) ??
        provider.models.find((candidate) =>
          candidate.aliases?.some(
            (alias) => alias.toLowerCase() === modelSelection.model.toLowerCase(),
          ),
        );
      if (model === undefined) return yield* rejectProvider();

      const capabilities = yield* adapter.getCapabilities().pipe(Effect.mapError(rejectProvider));
      const capability = capabilities.runtimePolicy.panelChat;
      if (role === "code_agent" && capability?.readOnly !== "enforced") {
        return yield* reject(
          "This provider can't be limited to reading, so it can't be the code agent.",
          participantRef,
        );
      }
      if (capability === undefined) return yield* rejectProvider();

      const caps = model.capabilities ?? {};
      const descriptors = getProviderOptionDescriptors({
        caps,
        selections: modelSelection.options,
      });
      const options =
        command.createdBy === "agent" && modelSelection.options === undefined
          ? lowestPanelModelOptions(descriptors)
          : undefined;
      const selection = {
        ...modelSelection,
        model: model.slug,
        ...(options === undefined ? {} : { options }),
      };
      if (
        role === "panelist" &&
        resolved.some(({ participant }) =>
          modelSelectionsEqual(participant.modelSelection, selection),
        )
      ) {
        return yield* reject("Already in this panel.", participantRef);
      }
      const selectedDescriptors =
        options === undefined
          ? descriptors
          : getProviderOptionDescriptors({ caps, selections: options });
      const reasoning = selectedDescriptors.find(
        (descriptor) =>
          descriptor.type === "select" &&
          (descriptor.role === "reasoning" || REASONING_OPTION_IDS.has(descriptor.id)),
      );
      const handle =
        role === "code_agent"
          ? PANEL_CODE_HANDLE
          : derivePanelHandle(model.shortName ?? model.name ?? model.slug, handles);
      handles.add(handle);
      resolved.push({
        participant: {
          id: role === "code_agent" ? PANEL_CODE_HANDLE : `p${resolved.length + 1}`,
          role,
          name: model.name,
          handle,
          driver: adapter.driver,
          modelSelection: selection,
          toolsRemoved: role === "code_agent" || capability.panelistToolsRemoved,
        },
        instanceName: provider.displayName ?? provider.instanceId,
        effortLabel: getProviderOptionCurrentLabel(reasoning),
      });
    }
    const participants = resolved.map(({ participant, instanceName, effortLabel }) => {
      if (participant.role !== "panelist") return participant;
      const peers = resolved.filter(
        (other) =>
          other.participant.role === "panelist" &&
          other.participant !== participant &&
          other.participant.name === participant.name,
      );
      if (peers.length === 0) return participant;
      const suffix =
        effortLabel !== undefined && peers.every((peer) => peer.effortLabel !== effortLabel)
          ? effortLabel
          : instanceName;
      return { ...participant, name: `${participant.name} · ${suffix}` };
    });

    return yield* orchestrator.dispatch({ ...command, type: "panel.open", participants, topic });
  });

  const post = Effect.fn("PanelChatService.post")((command: PostCommand) =>
    orchestrator.dispatch(command),
  );
  const continuePanel = Effect.fn("PanelChatService.continue")((command: ContinueCommand) =>
    orchestrator.dispatch(command),
  );

  return PanelChatService.of({ create, post, continue: continuePanel });
});

export const layer = Layer.effect(PanelChatService, make);
