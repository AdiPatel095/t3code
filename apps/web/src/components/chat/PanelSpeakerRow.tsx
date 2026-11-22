import type { OrchestrationV2PanelParticipant } from "@t3tools/contracts";
import { T } from "gt-react";
import { FileSearchIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";

export function PanelSpeakerRow({
  row,
}: {
  row: { speaker: OrchestrationV2PanelParticipant; askedBy?: string };
}) {
  const { speaker, askedBy } = row;
  const color = providerTextColor(speaker.driver);
  const codeAgent = speaker.role === "code_agent";
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1 pt-3 pb-1">
      {codeAgent ? (
        <FileSearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ProviderInstanceIcon
          driverKind={speaker.driver}
          displayName={speaker.name}
          size="compact"
          className="size-3.5 shrink-0"
        />
      )}
      <span
        className={cn("truncate text-xs font-medium", color.className ?? "text-foreground")}
        style={color.style}
      >
        {codeAgent ? <T>Code agent</T> : speaker.name}
      </span>
      {codeAgent ? (
        <span className="truncate text-2xs text-muted-foreground">{speaker.name}</span>
      ) : null}
      {askedBy === undefined ? null : (
        <span className="min-w-0 text-2xs break-words text-muted-foreground">· {askedBy}</span>
      )}
    </div>
  );
}
