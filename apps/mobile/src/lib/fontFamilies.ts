export const FONT_FAMILIES = {
  regular: "Inter-Regular",
  medium: "Inter-Medium",
  bold: "Inter-Bold",
  display: "SairaCondensed-Light",
  displayMedium: "SairaCondensed-Medium",
  mono: "JetBrainsMono-Regular",
  monoBold: "JetBrainsMono-Bold",
} as const;

export interface ResolvedFontFamilies {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
  readonly display: string;
  readonly displayMedium: string;
  readonly mono: string;
  readonly monoBold: string;
}

export function resolveFontFamilies(
  useMonospaceFont: boolean,
  platformOS?: string,
): ResolvedFontFamilies {
  if (!useMonospaceFont) return FONT_FAMILIES;
  if (platformOS === "ios") {
    return {
      ...FONT_FAMILIES,
      regular: "Menlo",
      medium: "Menlo",
      bold: "Menlo-Bold",
    };
  }
  return {
    ...FONT_FAMILIES,
    regular: "monospace",
    medium: "monospace",
    bold: "monospace",
  };
}

export function resolveUniwindFontFamilyVariables(
  useMonospaceFont: boolean,
  platformOS?: string,
): Readonly<Record<string, string>> {
  const families = resolveFontFamilies(useMonospaceFont, platformOS);
  const mono = platformOS === "ios" ? "ui-monospace" : "monospace";
  return {
    "--font-sans": useMonospaceFont ? mono : families.regular,
    "--font-medium": useMonospaceFont ? mono : families.medium,
    "--font-bold": useMonospaceFont ? mono : families.bold,
    "--font-display": families.display,
    "--font-display-medium": families.displayMedium,
    "--font-mono": families.mono,
    "--font-mono-bold": families.monoBold,
  };
}
