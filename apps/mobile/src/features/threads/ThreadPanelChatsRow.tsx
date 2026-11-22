import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { Platform, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { usePanelChats } from "../../state/entities";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function ThreadPanelChatsRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const panels = usePanelChats(props);
  const openLinkedThread = useOpenLinkedThread();
  const gt = useGT();
  if (panels.length === 0) return null;
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-2 pl-4",
        Platform.OS === "android" ? "bg-thread-canvas" : "bg-screen",
      )}
    >
      <SymbolView name="person.3" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="text-xs text-foreground-muted">
        <T>Panel chats</T>
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <View className="flex-row gap-1 pr-4">
          {panels.map((panel) => {
            const title = panel.title;
            const running = panel.source.panel?.status === "running";
            return (
              <Pressable
                key={panel.id}
                accessibilityRole="button"
                accessibilityLabel={
                  running
                    ? gt("Open panel chat {title}, running", { title })
                    : gt("Open panel chat {title}", { title })
                }
                className="max-w-48 flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1"
                onPress={() =>
                  openLinkedThread({ environmentId: props.environmentId, threadId: panel.id })
                }
              >
                {running ? (
                  <View className="h-1.5 w-1.5 shrink-0 rounded-full bg-adaptive-indigo-600-300" />
                ) : null}
                <Text className="shrink text-xs text-foreground" numberOfLines={1}>
                  {title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}
