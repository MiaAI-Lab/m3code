// @effect-diagnostics nodeBuiltinImport:off -- manages long-lived local inference engine child processes with PID tracking and stdout/stderr ring buffers.
// @effect-diagnostics globalTimers:off -- bounded process-exit kill timers inside Promise wrappers for Node ChildProcess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  InferenceServerId,
  LocalEngineError,
  type LocalEngineControlInput,
  type LocalEngineControlResult,
  type LocalEngineGetLogsInput,
  type LocalEngineGetLogsResult,
  type LocalEngineKind,
  type LocalEngineLaunchConfig,
  type LocalEngineManageModelInput,
  type LocalEngineManageModelResult,
  type LocalEngineModel,
  type LocalEngineSaveConfigInput,
  type LocalEngineSaveConfigResult,
  type LocalEnginesListInput,
  type LocalEnginesListResult,
  type LocalEngineStatus,
  type LocalEngineUpdateInput,
  type LocalEngineUpdateResult,
  type LocalHostHardware,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ServerConfig } from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as InferenceServerRegistry from "./InferenceServerRegistry.ts";
import {
  LOCAL_ENGINE_ADAPTERS,
  engineBaseUrl,
  enginePort,
  engineServerId,
  getLocalEngineAdapter,
  parseOllamaList,
  parseOllamaPs,
  parseVersionOutput,
  type LocalEngineAdapter,
} from "./LocalEngineAdapters.ts";

const MAX_LOG_LINES = 200;
const PROBE_TIMEOUT = Duration.millis(1200);
const CMD_TIMEOUT_MS = 8_000;
const UPDATE_TIMEOUT_MS = 180_000;
const MODEL_OP_TIMEOUT_MS = 300_000;

const LmStudioListItem = Schema.Struct({
  modelKey: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  sizeBytes: Schema.optional(Schema.Number),
  quantization: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
});
const decodeLmStudioList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(LmStudioListItem)),
);
const OllamaLoadBody = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    prompt: Schema.String,
    keep_alive: Schema.String,
  }),
);
const encodeOllamaLoadBody = Schema.encodeSync(OllamaLoadBody);
const decodeSavedConfigs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJsonUnknown = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

interface ManagedProcess {
  readonly child: NodeChildProcess.ChildProcess;
  readonly pid: number;
  readonly logs: string[];
  lastError?: string;
}

type SavedConfigs = Partial<Record<LocalEngineKind, LocalEngineLaunchConfig>>;

export class LocalEngineManager extends Context.Service<
  LocalEngineManager,
  {
    readonly list: (
      input: LocalEnginesListInput,
    ) => Effect.Effect<LocalEnginesListResult, LocalEngineError>;
    readonly control: (
      input: LocalEngineControlInput,
    ) => Effect.Effect<LocalEngineControlResult, LocalEngineError>;
    readonly update: (
      input: LocalEngineUpdateInput,
    ) => Effect.Effect<LocalEngineUpdateResult, LocalEngineError>;
    readonly manageModel: (
      input: LocalEngineManageModelInput,
    ) => Effect.Effect<LocalEngineManageModelResult, LocalEngineError>;
    readonly saveConfig: (
      input: LocalEngineSaveConfigInput,
    ) => Effect.Effect<LocalEngineSaveConfigResult, LocalEngineError>;
    readonly getLogs: (
      input: LocalEngineGetLogsInput,
    ) => Effect.Effect<LocalEngineGetLogsResult, LocalEngineError>;
  }
>()("t3/inference/LocalEngineManager") {}

function extraSearchDirs(): ReadonlyArray<string> {
  const home = NodeOS.homedir();
  return [
    NodePath.join(home, ".local", "bin"),
    NodePath.join(home, ".local", "opt", "q36"),
    NodePath.join(home, ".lmstudio", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = NodeFS.statSync(filePath);
    if (!stat.isFile()) return false;
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(candidates: ReadonlyArray<string>): string | undefined {
  const pathDirs = (process.env.PATH ?? "").split(NodePath.delimiter).filter(Boolean);
  const dirs = [...new Set([...pathDirs, ...extraSearchDirs()])];
  for (const name of candidates) {
    if (NodePath.isAbsolute(name) && isExecutableFile(name)) return name;
    for (const dir of dirs) {
      const full = NodePath.join(dir, name);
      if (isExecutableFile(full)) return full;
    }
  }
  return undefined;
}

function runCommandAsync(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  env?: Readonly<Record<string, string>>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(command, [...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      finish(1);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `\nTimed out after ${Math.round(timeoutMs / 1000)}s.`;
      finish(124);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length < 256_000) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 256_000) stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += err.message;
      finish(1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

async function detectHardware(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): Promise<LocalHostHardware> {
  const cpus = NodeOS.cpus();
  const cpuModel = cpus[0]?.model?.trim() || undefined;
  const totalMemoryBytes = NodeOS.totalmem();
  const freeMemoryBytes = NodeOS.freemem();
  const unifiedMemory = platform === "darwin" && arch === "arm64";

  let gpuName: string | undefined;
  let vramTotalBytes: number | undefined;
  let vramUsedBytes: number | undefined;

  if (unifiedMemory) {
    gpuName = cpuModel ? `${cpuModel} (Unified Memory)` : "Apple Silicon (Unified Memory)";
    vramTotalBytes = totalMemoryBytes;
    vramUsedBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);
  } else {
    const nvidia = await runCommandAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
      2500,
    );
    if (nvidia.exitCode === 0 && nvidia.stdout.trim().length > 0) {
      const firstLine = nvidia.stdout.trim().split(/\r?\n/)[0] ?? "";
      const parts = firstLine.split(",").map((p) => p.trim());
      if (parts[0]) gpuName = parts[0];
      const totalMiB = Number(parts[1]);
      const usedMiB = Number(parts[2]);
      if (Number.isFinite(totalMiB) && totalMiB > 0) {
        vramTotalBytes = Math.round(totalMiB * 1024 * 1024);
      }
      if (Number.isFinite(usedMiB) && usedMiB >= 0) {
        vramUsedBytes = Math.round(usedMiB * 1024 * 1024);
      }
    }
  }

  return {
    platform,
    arch,
    ...(cpuModel ? { cpuModel } : {}),
    cpuCores: cpus.length,
    totalMemoryBytes,
    freeMemoryBytes,
    ...(gpuName ? { gpuName } : {}),
    ...(vramTotalBytes !== undefined ? { vramTotalBytes } : {}),
    ...(vramUsedBytes !== undefined ? { vramUsedBytes } : {}),
    unifiedMemory,
  };
}

/** Scan Hugging Face cache for local MLX / GGUF repos (best-effort, fast). */
function scanHuggingFaceCacheModels(filterMlx: boolean): ReadonlyArray<LocalEngineModel> {
  const hubDir = NodePath.join(NodeOS.homedir(), ".cache", "huggingface", "hub");
  try {
    const entries = NodeFS.readdirSync(hubDir, { withFileTypes: true });
    const models: LocalEngineModel[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("models--")) continue;
      const repoId = entry.name.slice("models--".length).replace(/--/g, "/");
      if (filterMlx && !repoId.toLowerCase().includes("mlx")) continue;
      models.push({ id: repoId });
    }
    return models.slice(0, 64);
  } catch {
    return [];
  }
}

function appendLogLines(buffer: string[], chunk: string) {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    buffer.push(line);
    if (buffer.length > MAX_LOG_LINES) {
      buffer.splice(0, buffer.length - MAX_LOG_LINES);
    }
  }
}

function loadSavedConfigsFromDisk(configPath: string): SavedConfigs {
  try {
    const raw = NodeFS.readFileSync(configPath, "utf8");
    const decoded = decodeSavedConfigs(raw);
    if (Option.isSome(decoded) && typeof decoded.value === "object" && decoded.value !== null) {
      return decoded.value as SavedConfigs;
    }
    return {};
  } catch {
    return {};
  }
}

function writeSavedConfigsToDisk(configPath: string, configs: SavedConfigs): void {
  const encoded = encodeJsonUnknown(configs);
  if (Option.isNone(encoded)) return;
  try {
    NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
    NodeFS.writeFileSync(configPath, encoded.value, "utf8");
  } catch {
    // Non-fatal: keep in-memory config if disk write fails.
  }
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;
  const inferenceServers = yield* InferenceServerRegistry.InferenceServerRegistry;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArch = yield* HostProcess.Architecture;

  const configPath = NodePath.join(config.stateDir, "local-engines.json");
  const managed = new Map<LocalEngineKind, ManagedProcess>();
  const versionCache = new Map<string, string | undefined>();
  const savedConfigs: SavedConfigs = loadSavedConfigsFromDisk(configPath);

  const persistConfigs = () => writeSavedConfigsToDisk(configPath, savedConfigs);

  // Clean up any child processes we spawned when the server shuts down.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const proc of managed.values()) {
        try {
          proc.child.kill("SIGTERM");
        } catch {
          // Process already exited.
        }
      }
      managed.clear();
    }),
  );

  const probeModelsEndpoint = Effect.fnUntraced(function* (baseUrl: string) {
    return yield* httpClient.execute(HttpClientRequest.get(`${baseUrl}/models`)).pipe(
      Effect.flatMap((response) => {
        if (response.status < 200 || response.status >= 300) {
          return Effect.succeed({
            ok: response.status === 401 || response.status === 403,
            models: [] as string[],
          });
        }
        return response.stream.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.map((body) => {
            const parsed = InferenceServerRegistry.readModelList(body);
            return {
              ok: true,
              models: parsed ? parsed.models.map((m) => m.id) : [],
            };
          }),
        );
      }),
      Effect.timeoutOption(PROBE_TIMEOUT),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
  });

  const getVersion = (binaryPath: string, versionArgs: ReadonlyArray<string>, fresh: boolean) =>
    Effect.promise(async () => {
      if (!fresh && versionCache.has(binaryPath)) {
        return versionCache.get(binaryPath);
      }
      const res = await runCommandAsync(binaryPath, versionArgs, 3500);
      const parsed = parseVersionOutput(res.stdout || res.stderr);
      versionCache.set(binaryPath, parsed);
      return parsed;
    });

  const inspectEngine = Effect.fnUntraced(function* (
    adapter: LocalEngineAdapter,
    fresh: boolean,
    registeredServers: Readonly<
      Record<string, { readonly baseUrl: string; readonly enabled: boolean }>
    >,
  ) {
    const launchConfig: LocalEngineLaunchConfig = savedConfigs[adapter.kind] ?? {
      port: adapter.defaultPort,
      host: "127.0.0.1",
      autoRegister: true,
    };
    const baseUrl = engineBaseUrl(adapter, launchConfig);
    const binaryPath = findBinary(adapter.binaries);
    const installed = binaryPath !== undefined;
    const version = installed
      ? yield* getVersion(binaryPath, adapter.versionArgs, fresh)
      : undefined;

    const proc = managed.get(adapter.kind);
    const managedAlive = proc !== undefined && proc.child.exitCode === null && !proc.child.killed;
    const httpProbe = yield* probeModelsEndpoint(baseUrl);
    const running = managedAlive || (httpProbe?.ok ?? false);

    let localModels: LocalEngineModel[] = [];
    let activeModels: string[] = [...(httpProbe?.models ?? [])];

    if (installed && binaryPath) {
      if (adapter.kind === "ollama") {
        const [listRes, psRes] = yield* Effect.promise(() =>
          Promise.all([
            runCommandAsync(binaryPath, ["list"], CMD_TIMEOUT_MS),
            running
              ? runCommandAsync(binaryPath, ["ps"], CMD_TIMEOUT_MS)
              : Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }),
          ]),
        );
        if (listRes.exitCode === 0) {
          const parsedActive = psRes.exitCode === 0 ? parseOllamaPs(psRes.stdout) : [];
          if (parsedActive.length > 0) {
            activeModels = [...new Set([...parsedActive, ...activeModels])];
          }
          const activeSet = new Set(activeModels);
          localModels = parseOllamaList(listRes.stdout).map((m) => ({
            ...m,
            loaded: activeSet.has(m.id),
          }));
        }
      } else if (adapter.kind === "lm-studio") {
        const lsRes = yield* Effect.promise(() =>
          runCommandAsync(binaryPath, ["ls", "--json"], CMD_TIMEOUT_MS),
        );
        if (lsRes.exitCode === 0) {
          const decoded = decodeLmStudioList(lsRes.stdout);
          if (Option.isSome(decoded)) {
            const activeSet = new Set(activeModels);
            localModels = decoded.value
              .filter((item) => Boolean(item.modelKey || item.path))
              .map((item) => {
                const id = (item.modelKey ?? item.path)!;
                return {
                  id,
                  ...(typeof item.sizeBytes === "number" ? { sizeBytes: item.sizeBytes } : {}),
                  ...(item.quantization?.name ? { quantization: item.quantization.name } : {}),
                  loaded: activeSet.has(id),
                };
              });
          }
        }
      } else if (adapter.kind === "mlx") {
        const activeSet = new Set(activeModels);
        localModels = scanHuggingFaceCacheModels(true).map((m) => ({
          ...m,
          loaded: activeSet.has(m.id),
        }));
      }
    }

    // Include any actively served models from /v1/models that weren't in localModels.
    const seen = new Set(localModels.map((m) => m.id));
    for (const id of activeModels) {
      if (!seen.has(id)) {
        localModels.push({ id, loaded: true });
        seen.add(id);
      }
    }

    const normalizedBase = baseUrl.replace(/\/+$/, "");
    const registeredMatch = Object.entries(registeredServers).find(
      ([, cfg]) => cfg.baseUrl.replace(/\/+$/, "") === normalizedBase,
    );
    const registeredServerId = registeredMatch
      ? (registeredMatch[0] as LocalEngineStatus["registeredServerId"])
      : undefined;

    return {
      kind: adapter.kind,
      displayName: adapter.displayName,
      description: adapter.description,
      defaultPort: adapter.defaultPort,
      baseUrl,
      installed,
      ...(binaryPath ? { binaryPath } : {}),
      ...(version ? { version } : {}),
      installHint: adapter.installHint(hostPlatform),
      running,
      managedByServer: managedAlive,
      ...(managedAlive && proc ? { pid: proc.pid } : {}),
      activeModels,
      localModels,
      launchConfig,
      capabilities: adapter.capabilities,
      ...(registeredServerId ? { registeredServerId } : {}),
      recentLogs: proc ? [...proc.logs] : [],
      ...(proc?.lastError ? { lastError: proc.lastError } : {}),
    } satisfies LocalEngineStatus;
  });

  const getRegisteredServers = Effect.fnUntraced(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    return Option.isSome(settings) ? settings.value.inferenceServers : {};
  });

  const autoRegisterInGateway = Effect.fnUntraced(function* (
    adapter: LocalEngineAdapter,
    launchConfig: LocalEngineLaunchConfig,
  ) {
    if (launchConfig.autoRegister === false) return;
    const baseUrl = engineBaseUrl(adapter, launchConfig);
    const existing = yield* getRegisteredServers();
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    const already = Object.entries(existing).find(
      ([, cfg]) => cfg.baseUrl.replace(/\/+$/, "") === normalizedBase,
    );
    if (already) {
      const [id, cfg] = already;
      if (!cfg.enabled) {
        yield* settingsService
          .updateSettings({ inferenceServers: { [id]: { ...cfg, enabled: true } } })
          .pipe(Effect.ignore);
      }
      yield* inferenceServers.refresh(InferenceServerId.make(id)).pipe(Effect.ignore);
      return;
    }
    const id = engineServerId(adapter.kind);
    yield* settingsService
      .updateSettings({
        inferenceServers: {
          [id]: {
            displayName: `${adapter.displayName} (Local)`,
            baseUrl,
            apiKey: "",
            enabled: true,
          },
        },
      })
      .pipe(Effect.ignore);
    yield* inferenceServers.refresh(id).pipe(Effect.ignore);
  });

  const stopManagedProcess = (kind: LocalEngineKind, binaryPath?: string) =>
    Effect.promise(async () => {
      const proc = managed.get(kind);
      if (proc) {
        try {
          proc.child.kill("SIGTERM");
        } catch {
          // Ignore already exited.
        }
        await new Promise<void>((resolve) => {
          if (proc.child.exitCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            try {
              proc.child.kill("SIGKILL");
            } catch {
              // Ignore.
            }
            resolve();
          }, 3000);
          proc.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        managed.delete(kind);
        return true;
      }
      if (kind === "lm-studio" && binaryPath) {
        const res = await runCommandAsync(binaryPath, ["server", "stop"], CMD_TIMEOUT_MS);
        return res.exitCode === 0;
      }
      return false;
    });

  const startManagedProcess = (
    adapter: LocalEngineAdapter,
    binaryPath: string,
    launchConfig: LocalEngineLaunchConfig,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const spec = adapter.buildStart(binaryPath, launchConfig);
        if (adapter.kind === "lm-studio") {
          const res = await runCommandAsync(spec.command, spec.args, CMD_TIMEOUT_MS, spec.env);
          if (res.exitCode !== 0) {
            throw new Error(
              res.stderr.trim() || res.stdout.trim() || "Failed to start LM Studio server.",
            );
          }
          return;
        }

        const child = NodeChildProcess.spawn(spec.command, [...spec.args], {
          env: { ...process.env, ...spec.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (!child.pid) {
          throw new Error(`Failed to spawn ${spec.command}`);
        }
        const entry: ManagedProcess = {
          child,
          pid: child.pid,
          logs: [`[m3] started ${spec.command} ${spec.args.join(" ")} (pid ${child.pid})`],
        };
        managed.set(adapter.kind, entry);
        child.stdout?.on("data", (chunk: Buffer | string) => {
          appendLogLines(entry.logs, chunk.toString());
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          appendLogLines(entry.logs, chunk.toString());
        });
        child.on("error", (err) => {
          entry.lastError = err.message;
          appendLogLines(entry.logs, `[m3] process error: ${err.message}`);
        });
        child.on("exit", (code, signal) => {
          appendLogLines(
            entry.logs,
            `[m3] exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          );
          if (code && code !== 0) {
            entry.lastError = `Exited with code ${code}`;
          }
        });
        // Give the server a brief moment to bind or fail immediately on bad flags.
        await new Promise((r) => setTimeout(r, 600));
        if (child.exitCode !== null && child.exitCode !== 0) {
          const tail = entry.logs.slice(-4).join("\n");
          throw new Error(tail || `${adapter.displayName} exited with code ${child.exitCode}.`);
        }
      },
      catch: (error) =>
        new LocalEngineError({
          kind: adapter.kind,
          message: error instanceof Error ? error.message : String(error),
        }),
    });

  const list = Effect.fn("LocalEngineManager.list")(function* (input: LocalEnginesListInput) {
    const fresh = input.fresh ?? false;
    const [hardware, registered, now] = yield* Effect.all([
      Effect.promise(() => detectHardware(hostPlatform, hostArch)),
      getRegisteredServers(),
      DateTime.now,
    ]);
    const engines = yield* Effect.forEach(
      LOCAL_ENGINE_ADAPTERS,
      (adapter) => inspectEngine(adapter, fresh, registered),
      { concurrency: "unbounded" },
    );
    return {
      hardware,
      engines,
      checkedAt: DateTime.formatIso(now),
    } satisfies LocalEnginesListResult;
  });

  const saveConfig = Effect.fn("LocalEngineManager.saveConfig")(function* (
    input: LocalEngineSaveConfigInput,
  ) {
    const adapter = getLocalEngineAdapter(input.kind);
    savedConfigs[input.kind] = {
      ...savedConfigs[input.kind],
      ...input.launchConfig,
    };
    persistConfigs();
    const registered = yield* getRegisteredServers();
    const engine = yield* inspectEngine(adapter, false, registered);
    return { engine } satisfies LocalEngineSaveConfigResult;
  });

  const control = Effect.fn("LocalEngineManager.control")(function* (
    input: LocalEngineControlInput,
  ) {
    const adapter = getLocalEngineAdapter(input.kind);
    if (input.launchConfig) {
      savedConfigs[input.kind] = {
        ...savedConfigs[input.kind],
        ...input.launchConfig,
      };
      persistConfigs();
    }
    const launchConfig: LocalEngineLaunchConfig = savedConfigs[input.kind] ?? {
      port: adapter.defaultPort,
      host: "127.0.0.1",
      autoRegister: true,
    };
    const binaryPath = findBinary(adapter.binaries);
    if (!binaryPath) {
      return yield* new LocalEngineError({
        kind: input.kind,
        message: `${adapter.displayName} is not installed. Install it with: ${adapter.installHint(hostPlatform)}`,
      });
    }

    let message = "";
    if (input.action === "stop") {
      const stopped = yield* stopManagedProcess(input.kind, binaryPath);
      message = stopped
        ? `Stopped ${adapter.displayName}.`
        : `${adapter.displayName} is running externally (not started by M3 Code): stop it from its own service manager.`;
    } else if (input.action === "restart") {
      yield* stopManagedProcess(input.kind, binaryPath);
      yield* startManagedProcess(adapter, binaryPath, launchConfig);
      yield* autoRegisterInGateway(adapter, launchConfig);
      message = `Restarted ${adapter.displayName} on port ${enginePort(adapter, launchConfig)}.`;
    } else {
      if (managed.has(input.kind)) {
        yield* stopManagedProcess(input.kind, binaryPath);
      }
      yield* startManagedProcess(adapter, binaryPath, launchConfig);
      yield* autoRegisterInGateway(adapter, launchConfig);
      message = `Started ${adapter.displayName} on port ${enginePort(adapter, launchConfig)}.`;
    }

    const registered = yield* getRegisteredServers();
    const engine = yield* inspectEngine(adapter, false, registered);
    return { engine, message } satisfies LocalEngineControlResult;
  });

  const update = Effect.fn("LocalEngineManager.update")(function* (input: LocalEngineUpdateInput) {
    const adapter = getLocalEngineAdapter(input.kind);
    const binaryPath = findBinary(adapter.binaries);
    if (!binaryPath) {
      return yield* new LocalEngineError({
        kind: input.kind,
        message: `${adapter.displayName} is not installed. Install with: ${adapter.installHint(hostPlatform)}`,
      });
    }
    const updateSpec = adapter.buildUpdate?.(binaryPath, hostPlatform);
    if (!updateSpec) {
      return yield* new LocalEngineError({
        kind: input.kind,
        message: `Automatic updates for ${adapter.displayName} are not configured on ${hostPlatform}. Update it using: ${adapter.installHint(hostPlatform)}`,
      });
    }
    const previousVersion = yield* getVersion(binaryPath, adapter.versionArgs, true);
    const res = yield* Effect.promise(() =>
      runCommandAsync(updateSpec.command, updateSpec.args, UPDATE_TIMEOUT_MS, updateSpec.env),
    );
    const combinedOutput = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n");
    if (res.exitCode !== 0) {
      return yield* new LocalEngineError({
        kind: input.kind,
        message: combinedOutput || `Update command failed with exit code ${res.exitCode}.`,
      });
    }
    const refreshedBinary = findBinary(adapter.binaries) ?? binaryPath;
    const newVersion = yield* getVersion(refreshedBinary, adapter.versionArgs, true);
    const changed = previousVersion !== newVersion;
    return {
      kind: input.kind,
      updated: changed || res.exitCode === 0,
      ...(previousVersion ? { previousVersion } : {}),
      ...(newVersion ? { newVersion } : {}),
      message: changed
        ? `Updated ${adapter.displayName} from ${previousVersion ?? "unknown"} to ${newVersion ?? "latest"}.`
        : `${adapter.displayName} is up to date (${newVersion ?? previousVersion ?? "installed"}).`,
      ...(combinedOutput ? { output: combinedOutput.slice(0, 8000) } : {}),
    } satisfies LocalEngineUpdateResult;
  });

  const manageModel = Effect.fn("LocalEngineManager.manageModel")(function* (
    input: LocalEngineManageModelInput,
  ) {
    const adapter = getLocalEngineAdapter(input.kind);
    const binaryPath = findBinary(adapter.binaries);
    if (!binaryPath) {
      return yield* new LocalEngineError({
        kind: input.kind,
        message: `${adapter.displayName} is not installed.`,
      });
    }

    let args: string[] | undefined;
    if (adapter.kind === "ollama") {
      switch (input.action) {
        case "pull":
          args = ["pull", input.model];
          break;
        case "delete":
          args = ["rm", input.model];
          break;
        case "unload":
          args = ["stop", input.model];
          break;
        case "load": {
          // Warm the model via Ollama's /api/generate with empty prompt so it stays loaded in memory.
          const launchConfig = savedConfigs.ollama ?? {
            port: adapter.defaultPort,
            host: "127.0.0.1",
          };
          const rootUrl = engineBaseUrl(adapter, launchConfig).replace(/\/v1$/, "");
          const payload = encodeOllamaLoadBody({
            model: input.model,
            prompt: "",
            keep_alive: "10m",
          });
          yield* httpClient
            .execute(
              HttpClientRequest.post(`${rootUrl}/api/generate`).pipe(
                HttpClientRequest.bodyText(payload, "application/json"),
              ),
            )
            .pipe(
              Effect.timeout(Duration.seconds(60)),
              Effect.mapError(
                (err) =>
                  new LocalEngineError({
                    kind: input.kind,
                    message: `Failed to load ${input.model} in Ollama: ${String(err)}`,
                  }),
              ),
            );
          const registered = yield* getRegisteredServers();
          const engine = yield* inspectEngine(adapter, false, registered);
          return {
            ok: true,
            message: `Loaded ${input.model} in Ollama.`,
            engine,
          } satisfies LocalEngineManageModelResult;
        }
      }
    } else if (adapter.kind === "lm-studio") {
      switch (input.action) {
        case "pull":
          args = ["get", input.model, "--yes"];
          break;
        case "load":
          args = ["load", input.model];
          break;
        case "unload":
          args = ["unload", input.model];
          break;
        case "delete":
          return yield* new LocalEngineError({
            kind: input.kind,
            message:
              "LM Studio CLI does not support deleting models via CLI; remove it in LM Studio.",
          });
      }
    }

    if (!args) {
      return yield* new LocalEngineError({
        kind: input.kind,
        message: `${adapter.displayName} does not support '${input.action}' directly. Set the model in Launch Options and restart the engine.`,
      });
    }

    const res = yield* Effect.promise(() => runCommandAsync(binaryPath, args, MODEL_OP_TIMEOUT_MS));
    const output = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n");
    if (res.exitCode !== 0) {
      return yield* new LocalEngineError({
        kind: input.kind,
        message: output || `${adapter.displayName} ${input.action} failed (exit ${res.exitCode}).`,
      });
    }

    const registered = yield* getRegisteredServers();
    const engine = yield* inspectEngine(adapter, false, registered);
    return {
      ok: true,
      message: `${input.action} succeeded for ${input.model}.`,
      ...(output ? { output: output.slice(0, 8000) } : {}),
      engine,
    } satisfies LocalEngineManageModelResult;
  });

  const getLogs = (
    input: LocalEngineGetLogsInput,
  ): Effect.Effect<LocalEngineGetLogsResult, LocalEngineError> =>
    Effect.sync(() => {
      const proc = managed.get(input.kind);
      const limit = input.limit ?? MAX_LOG_LINES;
      const lines = proc ? proc.logs.slice(-limit) : [];
      return {
        kind: input.kind,
        lines,
      } satisfies LocalEngineGetLogsResult;
    });

  return LocalEngineManager.of({
    list,
    control,
    update,
    manageModel,
    saveConfig,
    getLogs,
  });
});

export const layer = Layer.effect(LocalEngineManager, make);
