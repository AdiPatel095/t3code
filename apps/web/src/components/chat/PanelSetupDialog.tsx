import {
  AuthOrchestrationOperateScope,
  ModelSelection,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import {
  PANEL_DEFAULT_ROUNDS,
  PANEL_MAX_PANELISTS,
  PANEL_MAX_ROUNDS,
  PANEL_MIN_PANELISTS,
  PANEL_MIN_ROUNDS,
  PANEL_TEXT_MAX_CHARS,
  panelReplyBudget,
} from "@t3tools/shared/panelChat";
import * as Schema from "effect/Schema";
import { useGT, useMessages } from "gt-react";
import { FileSearchIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { NO_PROVIDER_MODEL_SELECTION, type ProviderInstanceEntry } from "../../providerInstances";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerEffortColumn, describeComposerEffort } from "./ComposerModelEffort";
import {
  countEligiblePanelModels,
  filterRememberedPanelRoster,
  findPanelModel,
  newPanelModelSelection,
  PANEL_SETUP_REASONS,
  panelModelDisabledReason,
  panelSetupDisabledReason,
  providerOffersPanelRole,
  type PanelRosterPreference,
} from "./PanelSetupDialog.logic";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { TraitsSelectionInput } from "./TraitsPicker";

const ROUNDS = Array.from(
  { length: PANEL_MAX_ROUNDS - PANEL_MIN_ROUNDS + 1 },
  (_, index) => PANEL_MIN_ROUNDS + index,
);
const panelRostersSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    panelists: Schema.Array(ModelSelection),
    codeAgent: Schema.NullOr(ModelSelection),
    rounds: Schema.Literals(ROUNDS),
  }),
);
const EMPTY_ROSTERS: Readonly<Record<string, PanelRosterPreference>> = {};
const ROW_CLASS = "flex h-9 items-center gap-2 rounded-lg px-2 pointer-coarse:h-11";
const LABEL_CLASS = "text-xs font-medium text-muted-foreground";
const NOTE_CLASS = "text-2xs text-muted-foreground";

interface PanelSlot {
  readonly id: string;
  readonly selection: ModelSelection | null;
}

interface PanelSetupDraft {
  readonly panelists: ReadonlyArray<PanelSlot>;
  readonly codeAgent: PanelSlot | null;
  readonly rounds: number;
  readonly topic: string;
}

const draftsByThread = new Map<string, PanelSetupDraft>();

function PanelSlotRow(props: {
  environmentId: EnvironmentId;
  workspaceCwd: string | null;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  models: ReadonlyMap<ProviderInstanceEntry["instanceId"], ProviderInstanceEntry["models"]>;
  slot: PanelSlot;
  otherPanelists: ReadonlyArray<ModelSelection>;
  order?: number;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (selection: ModelSelection) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { selection } = props.slot;
  const provider = props.providers.find((entry) => entry.instanceId === selection?.instanceId);
  const model = selection ? findPanelModel(provider, selection.model) : undefined;
  const role = props.order === undefined ? "code_agent" : "panelist";
  const pickerInstanceId =
    selection?.instanceId ??
    props.providers.find((entry) => entry.models.length > 0 && providerOffersPanelRole(entry, role))
      ?.instanceId ??
    props.providers.find((entry) => entry.enabled && entry.models.length > 0)?.instanceId ??
    NO_PROVIDER_MODEL_SELECTION.instanceId;
  const traits: TraitsSelectionInput | null =
    selection && provider
      ? {
          provider: provider.driverKind,
          instanceId: selection.instanceId,
          models: provider.models,
          model: selection.model,
          modelOptions: selection.options,
          allowPromptInjectedEffort: false,
          onModelOptionsChange: (options) =>
            props.onChange(createModelSelection(selection.instanceId, selection.model, options)),
        }
      : null;
  const effort = describeComposerEffort(traits, "label", "sm", resolve);
  const mayReadFiles =
    role === "panelist" && provider?.snapshot.panelChat?.panelistToolsRemoved === false;
  function selectionFor(instanceId: ProviderInstanceEntry["instanceId"], slug: string) {
    const entry = props.providers.find((candidate) => candidate.instanceId === instanceId);
    const advertised = findPanelModel(entry, slug);
    return selection?.instanceId === instanceId && selection.model === advertised?.slug
      ? selection
      : newPanelModelSelection(instanceId, slug, advertised);
  }
  return (
    <div className={ROW_CLASS}>
      {props.order === undefined ? (
        <FileSearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="w-4 shrink-0 text-2xs tabular-nums text-muted-foreground">
          {props.order}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <ProviderModelPicker
          environmentId={props.environmentId}
          workspaceCwd={props.workspaceCwd}
          activeInstanceId={pickerInstanceId}
          model={selection?.model ?? ""}
          lockedProvider={null}
          instanceEntries={props.providers}
          modelOptionsByInstance={props.models}
          triggerClassName="w-full max-w-none justify-start text-left sm:max-w-none"
          {...(!model ? { triggerLabel: selection?.model ?? gt("Choose model") } : {})}
          triggerDetail={effort.detail}
          triggerSuffix={
            <>
              {mayReadFiles ? <span className={NOTE_CLASS}>{gt("May read files")}</span> : null}
              {effort.suffix}
            </>
          }
          effortColumn={<ComposerEffortColumn traits={traits} />}
          open={props.open && !props.disabled}
          disabled={props.disabled}
          onOpenChange={props.onOpenChange}
          getModelDisabledReason={(instanceId, slug) => {
            const reason = panelModelDisabledReason(
              props.providers,
              selectionFor(instanceId, slug),
              role,
              props.otherPanelists,
            );
            return reason ? resolve(reason) : null;
          }}
          onInstanceModelChange={(instanceId, slug) =>
            props.onChange(selectionFor(instanceId, slug))
          }
        />
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={props.disabled}
        aria-label={
          role === "code_agent"
            ? gt("Remove code agent")
            : gt("Remove {name}", { name: model?.name ?? selection?.model ?? gt("Model") })
        }
        onClick={props.onRemove}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function DisabledButtonHint(props: { reason: string | null; children: ReactNode }) {
  if (props.reason === null) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />}>{props.children}</TooltipTrigger>
      <TooltipPopup>{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

export function PanelSetupDialog(props: {
  parentRef: ScopedThreadRef;
  threadModel: ModelSelection;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  workspaceCwd: string | null;
  topic?: string;
  onClose: (startedThreadId: ThreadId | null) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const topicErrorId = useId();
  const { environmentId, threadId } = props.parentRef;
  const threadKey = scopedThreadKey(props.parentRef);
  const createPanel = useAtomCommand(threadEnvironment.createPanelChat, { reportFailure: false });
  const [rememberedRosters, setRememberedRosters] = useLocalStorage(
    "t3code:panel-roster:v1",
    EMPTY_ROSTERS,
    panelRostersSchema,
  );
  const [draft, setDraft] = useState<PanelSetupDraft>(() => {
    const previous = draftsByThread.get(threadKey);
    if (previous) return { ...previous, topic: props.topic ?? previous.topic };
    const remembered = rememberedRosters[environmentId];
    const roster = remembered ? filterRememberedPanelRoster(remembered, props.providers) : null;
    const { instanceId, model } = props.threadModel;
    const advertised = findPanelModel(
      props.providers.find((entry) => entry.instanceId === instanceId),
      model,
    );
    const firstModel = newPanelModelSelection(instanceId, model, advertised);
    const panelists = roster?.panelists ?? (model ? [firstModel] : []);
    return {
      panelists: panelists.map((selection, index) => ({ id: String(index), selection })),
      codeAgent: roster?.codeAgent ? { id: "code", selection: roster.codeAgent } : null,
      rounds: roster?.rounds ?? PANEL_DEFAULT_ROUNDS,
      topic: props.topic ?? "",
    };
  });
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [close, setClose] = useState<{ startedThreadId: ThreadId | null } | null>(null);
  const topicRef = useRef<HTMLTextAreaElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const models = new Map(props.providers.map((entry) => [entry.instanceId, entry.models]));
  const roster = {
    panelists: draft.panelists.flatMap(({ selection }) => (selection ? [selection] : [])),
    codeAgent: draft.codeAgent?.selection ?? null,
    rounds: draft.rounds,
  };
  const eligibleModelCount = countEligiblePanelModels(props.providers);
  const reason = panelSetupDisabledReason(roster, draft.topic, props.providers, eligibleModelCount);
  const full = draft.panelists.length >= PANEL_MAX_PANELISTS;
  const tooLong = draft.topic.trim().length > PANEL_TEXT_MAX_CHARS;
  const roundsLabel = gt("Rounds", { $context: "noun, discussion rounds" });

  function updateDraft(next: PanelSetupDraft) {
    draftsByThread.set(threadKey, next);
    setDraft(next);
  }

  function dismiss() {
    if (pending || close !== null) return;
    draftsByThread.set(threadKey, draft);
    setClose({ startedThreadId: null });
  }

  async function start() {
    if (
      pending ||
      close !== null ||
      reason !== null ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setPending(true);
    setOpenPicker(null);
    const targetThreadId = newThreadId();
    const result = await createPanel({
      environmentId,
      input: {
        parentThreadId: threadId,
        threadId: targetThreadId,
        topicMessageId: newMessageId(),
        topic: draft.topic.trim(),
        rounds: roster.rounds,
        participants: [
          ...roster.panelists.map((modelSelection) => ({
            role: "panelist" as const,
            modelSelection,
          })),
          ...(roster.codeAgent
            ? [{ role: "code_agent" as const, modelSelection: roster.codeAgent }]
            : []),
        ],
      },
    });
    if (result._tag === "Success") {
      setRememberedRosters((current) => ({ ...current, [environmentId]: roster }));
      draftsByThread.delete(threadKey);
      setClose({ startedThreadId: targetThreadId });
      return;
    }
    setPending(false);
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: gt("Could not start the panel chat"),
      ...(error instanceof Error ? { description: error.message } : {}),
    });
  }

  function addPanelist() {
    if (full) return;
    const slot = { id: randomUUID(), selection: null };
    updateDraft({ ...draft, panelists: [...draft.panelists, slot] });
    setOpenPicker(slot.id);
  }

  function renderSlot(slot: PanelSlot, index?: number) {
    return (
      <PanelSlotRow
        key={slot.id}
        environmentId={environmentId}
        workspaceCwd={props.workspaceCwd}
        providers={props.providers}
        models={models}
        slot={slot}
        {...(index === undefined ? {} : { order: index + 1 })}
        otherPanelists={draft.panelists.flatMap((other) =>
          other.id !== slot.id && other.selection ? [other.selection] : [],
        )}
        open={openPicker === slot.id}
        disabled={pending}
        onOpenChange={(open) =>
          setOpenPicker((current) => (open ? slot.id : current === slot.id ? null : current))
        }
        onChange={(selection) =>
          updateDraft(
            index === undefined
              ? { ...draft, codeAgent: { ...slot, selection } }
              : {
                  ...draft,
                  panelists: draft.panelists.map((row) =>
                    row.id === slot.id ? { ...row, selection } : row,
                  ),
                },
          )
        }
        onRemove={() => {
          if (openPicker === slot.id) setOpenPicker(null);
          updateDraft(
            index === undefined
              ? { ...draft, codeAgent: null }
              : { ...draft, panelists: draft.panelists.filter((row) => row.id !== slot.id) },
          );
        }}
      />
    );
  }

  return (
    <Dialog
      open={close === null}
      onOpenChange={(open, details) => {
        if (open) return;
        if (pending) details.cancel();
        else dismiss();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && close !== null) props.onClose(close.startedThreadId);
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() =>
          (roster.panelists.length >= PANEL_MIN_PANELISTS ? topicRef.current : addRef.current) ??
          true
        }
        finalFocus={() => !close?.startedThreadId}
        className="max-sm:[&>[data-slot=dialog-footer]]:flex-row max-sm:[&>[data-slot=dialog-footer]]:justify-end"
      >
        <DialogHeader>
          <DialogTitle>{gt("New panel chat")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div>
            <div className="flex items-center justify-between">
              <span className={LABEL_CLASS}>
                {gt("Models", { $context: "noun, AI models in the panel" })}
              </span>
              <span className="text-2xs tabular-nums text-muted-foreground">
                {gt("{count} of 5", { count: draft.panelists.length })}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {draft.panelists.map((slot, index) => renderSlot(slot, index))}
            </div>
            <DisabledButtonHint
              reason={full && !pending ? resolve(PANEL_SETUP_REASONS.maximum) : null}
            >
              <Button
                ref={addRef}
                variant="ghost"
                size="sm"
                disabled={full || pending}
                onClick={addPanelist}
              >
                <PlusIcon />
                {gt("Add model")}
              </Button>
            </DisabledButtonHint>
            <p className={NOTE_CLASS}>{gt("The first model also writes the conclusion.")}</p>
            {eligibleModelCount < PANEL_MIN_PANELISTS ? (
              <p className="text-xs text-muted-foreground">
                {resolve(PANEL_SETUP_REASONS.unavailable)}
              </p>
            ) : null}
          </div>
          <div>
            <div className={LABEL_CLASS}>{gt("Code agent")}</div>
            {draft.codeAgent ? (
              renderSlot(draft.codeAgent)
            ) : (
              <div className="flex h-9 items-center gap-2 px-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    updateDraft({ ...draft, codeAgent: { id: "code", selection: null } });
                    setOpenPicker("code");
                  }}
                >
                  <FileSearchIcon />
                  {gt("Add code agent")}
                </Button>
                <span className="ms-auto text-end text-2xs text-muted-foreground">
                  {gt("Reads this project's code when asked")}
                </span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className={LABEL_CLASS}>{roundsLabel}</span>
            <ToggleGroup
              aria-label={roundsLabel}
              value={[String(draft.rounds)]}
              disabled={pending}
              onValueChange={([value]) => {
                if (value !== undefined) updateDraft({ ...draft, rounds: Number(value) });
              }}
            >
              {ROUNDS.map((round) => (
                <ToggleGroupItem key={round} value={String(round)}>
                  {round}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="ms-auto text-end text-2xs tabular-nums text-muted-foreground max-sm:basis-full">
              {gt("Up to {count, plural, one {{count} reply} other {{count} replies}}", {
                count: panelReplyBudget(roster.panelists.length, draft.rounds),
              })}
            </span>
          </div>
          <div className="[&_[data-slot=textarea]]:max-h-[calc(8lh+var(--spacing)*3-2px)]">
            <Textarea
              ref={topicRef}
              rows={3}
              disabled={pending}
              value={draft.topic}
              aria-label={gt("Topic")}
              aria-invalid={tooLong || undefined}
              aria-describedby={tooLong ? topicErrorId : undefined}
              placeholder={gt("What should they discuss?")}
              onChange={(event) => updateDraft({ ...draft, topic: event.target.value })}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                event.preventDefault();
                void start();
              }}
            />
            {tooLong ? (
              <p id={topicErrorId} className="text-xs text-destructive">
                {resolve(PANEL_SETUP_REASONS.longTopic)}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={dismiss}>
            {gt("Cancel")}
          </Button>
          <DisabledButtonHint reason={reason && !pending ? resolve(reason) : null}>
            <Button disabled={pending || reason !== null} onClick={() => void start()}>
              {pending ? (
                <>
                  <Spinner aria-hidden size="xs" />
                  {gt("Starting…")}
                </>
              ) : (
                gt("Start panel")
              )}
            </Button>
          </DisabledButtonHint>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
