import { Pressable } from "react-native";

import { cn } from "../../lib/cn";
import type { PaneListItemProps } from "./PaneListItem.types";
export type { PaneListItemProps } from "./PaneListItem.types";

export function PaneListItem(props: PaneListItemProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      className={cn(
        "mt-1 min-h-12 justify-center rounded-md border-l-2 border-transparent px-3 py-2 active:bg-subtle",
        props.selected && "border-primary bg-subtle-strong",
      )}
      onPress={props.onPress}
    >
      {props.children}
    </Pressable>
  );
}
