import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "./AppText";
import type { FormFieldProps, FormSectionProps } from "./FormSection.types";
export type { FormFieldProps, FormSectionProps } from "./FormSection.types";

export function FormSection(props: FormSectionProps) {
  return (
    <View className="gap-3 rounded-xl border border-border-subtle bg-card p-4">
      <Text className="tm-eyebrow text-3xs text-foreground-muted">{props.title}</Text>
      {props.children}
    </View>
  );
}

export function FormField({ label, ...props }: FormFieldProps) {
  return (
    <>
      {label ? <Text className="tm-label text-3xs text-foreground-muted">{label}</Text> : null}
      <TextInput {...props} className="rounded-lg bg-card" />
    </>
  );
}
