import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { Pressable } from "react-native";
import { AppActivityIndicator } from "./AppActivityIndicator";
import { AppText } from "./AppText";
import { cn } from "../../lib/cn";

export interface ButtonProps {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon?: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly accessibilityHint?: string;
  readonly loading?: boolean;
  readonly tone?: "primary" | "secondary" | "danger" | "text" | "contrast";
  readonly fullWidth?: boolean;
  readonly size?: "default" | "compact";
}

const TONES = {
  contrast: {
    container: "bg-foreground",
    label: "text-screen",
    icon: "accent-screen",
    weight: "font-t3-bold",
  },
  primary: {
    container: "bg-primary",
    label: "text-primary-foreground",
    icon: "accent-primary-foreground",
    weight: "font-t3-bold",
  },
  secondary: {
    container: "border border-border bg-transparent",
    label: "text-foreground",
    icon: "accent-icon",
    weight: "font-t3-medium",
  },
  danger: {
    container: "bg-danger",
    label: "text-danger-foreground",
    icon: "accent-danger-foreground",
    weight: "font-t3-bold",
  },
  text: {
    container: "bg-transparent",
    label: "text-primary-text",
    icon: "accent-primary-text",
    weight: "font-t3-medium",
  },
} as const;

export function Button(props: ButtonProps) {
  const tone = TONES[props.tone ?? "secondary"];
  const disabled = Boolean(props.disabled || props.loading);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled, busy: Boolean(props.loading) }}
      disabled={disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center justify-center gap-2 rounded-full active:opacity-70",
        props.size === "compact" ? "min-h-10 px-5" : "min-h-[44px] px-6 android:min-h-[48px]",
        props.fullWidth ? "w-full" : "self-start",
        disabled ? "bg-subtle-strong" : tone.container,
      )}
    >
      {props.loading ? (
        <AppActivityIndicator colorClassName="accent-foreground-muted" />
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={18}
          tintColorClassName={disabled ? "accent-foreground-muted" : tone.icon}
        />
      ) : null}
      <AppText
        className={cn(
          "min-w-0 shrink text-center",
          tone.weight,
          disabled ? "text-foreground-muted" : tone.label,
        )}
      >
        {props.label}
      </AppText>
    </Pressable>
  );
}
