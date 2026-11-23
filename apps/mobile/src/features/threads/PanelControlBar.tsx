import { panelContinueTooltip, panelStatus } from "@t3tools/client-runtime/panel-chat";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type OrchestrationV2PanelState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Toast } from "../../components/ui/Toast";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ReadOnlyComposerBar } from "./ReadOnlyComposerBar";

export function PanelControlBar(props: {
  readonly threadRef: ScopedThreadRef;
  readonly panel: OrchestrationV2PanelState | undefined;
  readonly archived: boolean;
  readonly canOperate: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const stopPanel = useAtomCommand(threadEnvironment.stopPanel, { reportFailure: false });
  const continuePanel = useAtomCommand(threadEnvironment.continuePanel, { reportFailure: false });
  const [pending, setPending] = useState<"stop" | "continue" | null>(null);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<"stop" | "continue" | null>(null);
  const { panel, threadRef, archived, canOperate } = props;
  const status = panel && panelStatus(panel, panel.participants, pending === "stop", resolve);
  const continuing = status?.action === "continue";
  const stopping = status?.action === "none";

  async function runAction() {
    if (
      !status ||
      status.action === "none" ||
      archived ||
      inFlight.current ||
      !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    const action = status.action;
    const run = action === "stop" ? stopPanel : continuePanel;
    inFlight.current = true;
    setPending(action);
    setFailure(null);
    const result = await run({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).finally(() => {
      inFlight.current = false;
      setPending(null);
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) setFailure(action);
  }

  return (
    <View className="gap-2">
      {failure === null ? null : (
        <Toast
          message={
            failure === "stop"
              ? gt("Could not stop the panel chat")
              : gt("Could not continue the panel chat")
          }
          tone="danger"
          onDismiss={() => setFailure(null)}
        />
      )}
      <ReadOnlyComposerBar>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-t3-bold text-sm text-foreground">
            <T>Panel chat</T>
          </Text>
          {status ? (
            <Text
              accessibilityLiveRegion="polite"
              className={
                status.tone === "error"
                  ? "text-xs text-danger-foreground"
                  : "text-xs text-foreground-secondary"
              }
            >
              {status.text}
            </Text>
          ) : null}
        </View>
        {status ? (
          <Button
            label={
              continuing
                ? gt("Continue", { $context: "button, continues the panel discussion" })
                : gt("Stop", { $context: "button, stops the panel discussion" })
            }
            accessibilityHint={
              !canOperate
                ? gt("You don't have permission to run agents in this environment.")
                : continuing && !archived && panel
                  ? panelContinueTooltip(panel, resolve)
                  : undefined
            }
            tone={continuing ? "secondary" : "danger"}
            icon={continuing ? undefined : "stop.fill"}
            size="compact"
            disabled={!canOperate || archived || stopping || pending !== null}
            loading={stopping || pending === "continue"}
            onPress={() => void runAction()}
          />
        ) : null}
      </ReadOnlyComposerBar>
    </View>
  );
}
