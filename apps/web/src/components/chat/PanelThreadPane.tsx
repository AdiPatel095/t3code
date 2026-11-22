import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2PanelState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { T, useGT } from "gt-react";
import { FileSearchIcon, Trash2Icon, UsersRoundIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { readLocalApi } from "../../localApi";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function PanelRoster({ panel }: { panel: OrchestrationV2PanelState }) {
  const gt = useGT();
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="xs" aria-label={gt("Participants")} />}>
        <UsersRoundIcon />
        {panel.participants.length}
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-72 max-w-[calc(100vw-1rem)]"
        aria-label={gt("Participants")}
      >
        <h3 className="text-xs font-medium">{gt("Participants")}</h3>
        <ol>
          {panel.participants.map((participant, index) => (
            <li key={participant.id} className="flex h-8 min-w-0 items-center gap-2">
              {participant.role === "code_agent" ? (
                <FileSearchIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <>
                  <span className="text-2xs text-muted-foreground tabular-nums">{index + 1}</span>
                  <ProviderInstanceIcon
                    driverKind={participant.driver}
                    displayName={participant.name}
                    className="size-4 shrink-0"
                    iconClassName="size-4"
                  />
                </>
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{participant.name}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">@{participant.handle}</span>
              {participant.role === "code_agent" ? (
                <Badge variant="outline" size="sm">
                  {gt("Code", { $context: "badge, role of the code agent" })}
                </Badge>
              ) : null}
            </li>
          ))}
        </ol>
        <div className="text-2xs text-muted-foreground">
          {gt("Rounds: {rounds}", { rounds: panel.rounds })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function PanelAddToChat({
  parentRef,
  panelRef,
  title,
}: {
  parentRef: ScopedThreadRef;
  panelRef: ScopedThreadRef;
  title: string;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              useComposerDraftStore
                .getState()
                .addThreadContexts(parentRef, [threadContextRecord(panelRef, title)], {
                  insertAtCaret: false,
                });
            }}
          >
            <T>Add to chat</T>
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {gt("Adds this panel chat to the main thread's next message.")}
      </TooltipPopup>
    </Tooltip>
  );
}

export function PanelDeleteButton({
  panelRef,
  title,
  canOperate,
  onDeleted,
}: {
  panelRef: ScopedThreadRef;
  title: string;
  canOperate: boolean;
  onDeleted: () => void;
}) {
  const gt = useGT();
  const { environmentId, threadId } = panelRef;
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [deleting, setDeleting] = useState(false);
  async function removePanel() {
    if (deleting || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setDeleting(true);
    if (confirmThreadDelete) {
      const api = readLocalApi();
      const confirmation =
        api === undefined
          ? null
          : await settlePromise(() =>
              api.dialogs.confirm(
                [
                  gt('Delete panel chat "{title}"?', { title }),
                  gt("This permanently clears its conversation history."),
                ].join("\n"),
                { variant: "destructive" },
              ),
            );
      if (confirmation?._tag !== "Success" || !confirmation.value) {
        setDeleting(false);
        return;
      }
    }
    const result = await deleteThread({ environmentId, input: { threadId } });
    setDeleting(false);
    if (result._tag === "Success") {
      releaseComposerDraftUploads(panelRef);
      useComposerDraftStore.getState().clearDraftThread(panelRef);
      onDeleted();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not delete the panel chat"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={!canOperate || deleting}
      aria-label={gt("Delete panel chat")}
      onClick={() => void removePanel()}
    >
      <Trash2Icon />
    </Button>
  );
}
