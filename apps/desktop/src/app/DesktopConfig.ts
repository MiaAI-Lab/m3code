import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

export const trimmedString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

export const trimmedStringWithLegacy = (primary: string, legacy: string) =>
  Config.all([trimmedString(primary), trimmedString(legacy)]).pipe(
    Config.map(([next, prev]) => Option.orElse(next, () => prev)),
  );

const optionalBooleanWithLegacy = (primary: string, legacy: string) =>
  Config.all([
    Config.Boolean(primary).pipe(Config.option),
    Config.Boolean(legacy).pipe(Config.option),
  ]).pipe(
    Config.map(([next, prev]) =>
      Option.getOrElse(
        Option.orElse(next, () => prev),
        () => false,
      ),
    ),
  );

const optionalPortWithLegacy = (primary: string, legacy: string) =>
  Config.all([
    Config.Port(primary).pipe(Config.option),
    Config.Port(legacy).pipe(Config.option),
  ]).pipe(Config.map(([next, prev]) => Option.orElse(next, () => prev)));

const commaSeparatedStringsWithLegacy = (primary: string, legacy: string) =>
  trimmedStringWithLegacy(primary, legacy).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  t3Home: trimmedStringWithLegacy("M3CODE_HOME", "T3CODE_HOME"),
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedStringWithLegacy(
    "M3CODE_DESKTOP_APP_USER_MODEL_ID",
    "T3CODE_DESKTOP_APP_USER_MODEL_ID",
  ),
  devRemoteT3ServerEntryPath: trimmedStringWithLegacy(
    "M3CODE_DEV_REMOTE_M3_SERVER_ENTRY_PATH",
    "T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH",
  ),
  configuredBackendPort: optionalPortWithLegacy("M3CODE_PORT", "T3CODE_PORT"),
  commitHashOverride: trimmedStringWithLegacy("M3CODE_COMMIT_HASH", "T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedStringWithLegacy(
    "M3CODE_DESKTOP_LAN_HOST",
    "T3CODE_DESKTOP_LAN_HOST",
  ),
  desktopHttpsEndpointUrls: commaSeparatedStringsWithLegacy(
    "M3CODE_DESKTOP_HTTPS_ENDPOINTS",
    "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  ),
  desktopLauncherPath: trimmedStringWithLegacy(
    "M3CODE_DESKTOP_LAUNCHER_PATH",
    "T3CODE_DESKTOP_LAUNCHER_PATH",
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBooleanWithLegacy(
    "M3CODE_DISABLE_AUTO_UPDATE",
    "T3CODE_DISABLE_AUTO_UPDATE",
  ),
  mockUpdates: optionalBooleanWithLegacy(
    "M3CODE_DESKTOP_MOCK_UPDATES",
    "T3CODE_DESKTOP_MOCK_UPDATES",
  ),
  mockUpdateServerPort: optionalPortWithLegacy(
    "M3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT",
    "T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT",
  ).pipe(Config.map(Option.getOrElse(() => 3000))),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
