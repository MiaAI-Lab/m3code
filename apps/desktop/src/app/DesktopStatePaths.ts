import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

/**
 * Resolves the desktop base dir: explicit `M3CODE_HOME`/`T3CODE_HOME`, else `~/.m3`,
 * falling back to legacy `~/.t3` when `~/.m3` does not exist yet and `~/.t3` exists.
 */
export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly pathExists?: (path: string) => boolean;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () => {
    const m3Dir = input.joinPath(input.homeDirectory, ".m3");
    const legacyT3Dir = input.joinPath(input.homeDirectory, ".t3");
    if (input.pathExists && !input.pathExists(m3Dir) && input.pathExists(legacyT3Dir)) {
      return legacyT3Dir;
    }
    return m3Dir;
  });
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
