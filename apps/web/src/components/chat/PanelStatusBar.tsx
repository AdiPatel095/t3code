import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2PanelState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { panelContinueTooltip, panelStatus } from "@t3tools/client-runtime/panel-chat";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useGT, useMessages } from "gt-react";
import { SquareIcon } from "lucide-react";
import { useRef, useState } from "react";

import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

export function usePanelControl() {
  const gt = useGT();
  const stopPanel = useAtomCommand(threadEnvironment.stopPanel, { reportFailure: false });
  const continuePanel = useAtomCommand(threadEnvironment.continuePanel, { reportFailure: false });
  const inFlight = useRef(false);
  const [pending, setPending] = useState<{
    threadRef: ScopedThreadRef;
    action: "stop" | "continue";
  } | null>(null);

  async function onAction(threadRef: ScopedThreadRef, action: "stop" | "continue") {
    const { environmentId, threadId } = threadRef;
    if (inFlight.current || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    inFlight.current = true;
    setPending({ threadRef, action });
    const run = action === "stop" ? stopPanel : continuePanel;
    const result = await run({ environmentId, input: { threadId } });
    inFlight.current = false;
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title:
          action === "stop"
            ? gt("Could not stop the panel chat")
            : gt("Could not continue the panel chat"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  }

  return { pending, onAction };
}

export function PanelStatusBar({
  panel,
  canOperate,
  archived,
  pending,
  onAction,
}: {
  panel: OrchestrationV2PanelState;
  canOperate: boolean;
  archived: boolean;
  pending: "stop" | "continue" | null;
  onAction: (action: "stop" | "continue") => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const status = panelStatus(panel, panel.participants, pending === "stop", messages);
  const continuing = status.action === "continue";
  const stopping = status.action === "none";
  const tooltip = !canOperate
    ? gt("You don't have permission to run agents in this environment.")
    : continuing && !archived
      ? panelContinueTooltip(panel, messages)
      : null;
  const action = continuing ? "continue" : "stop";
  const button = (
    <Button
      variant={continuing ? "ghost" : "ghost-destructive"}
      size="xs"
      disabled={tooltip === null && (archived || stopping || pending !== null)}
      aria-disabled={!canOperate || archived || stopping || pending !== null || undefined}
      onClick={() => {
        if (canOperate && !archived && !stopping && pending === null) onAction(action);
      }}
    >
      {stopping ? (
        <Spinner aria-hidden="true" />
      ) : continuing ? null : (
        <SquareIcon className="size-3 fill-current" />
      )}
      {continuing
        ? gt("Continue", { $context: "button, continues the panel discussion" })
        : gt("Stop", { $context: "button, stops the panel discussion" })}
    </Button>
  );
  return (
    <ComposerBanner.Root variant={status.tone} density="default" detached>
      <ComposerBanner.Row
        layout="wrap-actions"
        className="px-2 @max-[360px]:flex-col @max-[360px]:items-stretch"
      >
        <ComposerBanner.Content role="status" aria-live="polite" className="whitespace-normal">
          {status.text}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {tooltip ? (
            <Tooltip>
              <TooltipTrigger render={button} />
              <TooltipPopup>{tooltip}</TooltipPopup>
            </Tooltip>
          ) : (
            button
          )}
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}
