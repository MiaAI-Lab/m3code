import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { InferenceServerId } from "./inference.ts";

/** Built-in local inference engines managed by M3 Code's pluggable engine registry. */
export const LocalEngineKind = Schema.Literals([
  "ollama",
  "llama-cpp",
  "mlx",
  "lm-studio",
  "vllm",
  "sglang",
  "omega",
]);
export type LocalEngineKind = typeof LocalEngineKind.Type;

export const LocalEngineKvCacheQuant = Schema.Literals(["f16", "q8_0", "q4_0", "fp8", "auto"]);
export type LocalEngineKvCacheQuant = typeof LocalEngineKvCacheQuant.Type;

/** Per-engine launch options and presets persisted per environment. */
export const LocalEngineLaunchConfig = Schema.Struct({
  /** Port to bind the OpenAI-compatible HTTP server on. */
  port: Schema.optional(NonNegativeInt),
  /** Bind address (defaults to 127.0.0.1). */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Default model path, tag, or Hugging Face repo id to load on start. */
  model: Schema.optional(Schema.String),
  /** Context window length in tokens (e.g. 8192, 32768, 131072). */
  contextLength: Schema.optional(NonNegativeInt),
  /** Number of GPU layers to offload (llama.cpp -ngl; 999 = all). */
  gpuLayers: Schema.optional(NonNegativeInt),
  /** KV cache quantization mode. */
  kvCacheQuant: Schema.optional(LocalEngineKvCacheQuant),
  /** Memory cap / utilization in GB (or converted to utilization ratio for vLLM/SGLang). */
  memoryLimitGb: Schema.optional(Schema.Number),
  /** Parallel request slots (llama.cpp --parallel / Ollama OLLAMA_NUM_PARALLEL). */
  parallelSlots: Schema.optional(NonNegativeInt),
  /** Flash attention toggle where supported. */
  flashAttention: Schema.optional(Schema.Boolean),
  /** Additional raw CLI arguments appended when launching the engine. */
  extraArgs: Schema.optional(Schema.String),
  /** Automatically register/enable this engine in Inference Servers when started. */
  autoRegister: Schema.optional(Schema.Boolean),
});
export type LocalEngineLaunchConfig = typeof LocalEngineLaunchConfig.Type;

export const LocalEngineModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  sizeBytes: Schema.optional(NonNegativeInt),
  quantization: Schema.optional(TrimmedNonEmptyString),
  modifiedAt: Schema.optional(IsoDateTime),
  loaded: Schema.optional(Schema.Boolean),
  contextLength: Schema.optional(NonNegativeInt),
});
export type LocalEngineModel = typeof LocalEngineModel.Type;

export const LocalEngineCapabilities = Schema.Struct({
  canStartStop: Schema.Boolean,
  canUpdate: Schema.Boolean,
  canPullModels: Schema.Boolean,
  canLoadUnload: Schema.Boolean,
  canDeleteModels: Schema.Boolean,
});
export type LocalEngineCapabilities = typeof LocalEngineCapabilities.Type;

export const LocalEngineStatus = Schema.Struct({
  kind: LocalEngineKind,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  defaultPort: NonNegativeInt,
  baseUrl: TrimmedNonEmptyString,
  installed: Schema.Boolean,
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  installHint: Schema.optional(TrimmedNonEmptyString),
  running: Schema.Boolean,
  managedByServer: Schema.Boolean,
  pid: Schema.optional(NonNegativeInt),
  activeModels: Schema.Array(TrimmedNonEmptyString),
  localModels: Schema.Array(LocalEngineModel),
  launchConfig: LocalEngineLaunchConfig,
  capabilities: LocalEngineCapabilities,
  registeredServerId: Schema.optional(InferenceServerId),
  recentLogs: Schema.Array(Schema.String),
  lastError: Schema.optional(Schema.String),
});
export type LocalEngineStatus = typeof LocalEngineStatus.Type;

export const LocalHostHardware = Schema.Struct({
  platform: TrimmedNonEmptyString,
  arch: TrimmedNonEmptyString,
  cpuModel: Schema.optional(TrimmedNonEmptyString),
  cpuCores: NonNegativeInt,
  totalMemoryBytes: NonNegativeInt,
  freeMemoryBytes: NonNegativeInt,
  gpuName: Schema.optional(TrimmedNonEmptyString),
  vramTotalBytes: Schema.optional(NonNegativeInt),
  vramUsedBytes: Schema.optional(NonNegativeInt),
  unifiedMemory: Schema.Boolean,
});
export type LocalHostHardware = typeof LocalHostHardware.Type;

export const LocalEnginesListInput = Schema.Struct({
  /** When true, also probe model lists and refresh engine status even if cached. */
  fresh: Schema.optional(Schema.Boolean),
});
export type LocalEnginesListInput = typeof LocalEnginesListInput.Type;

export const LocalEnginesListResult = Schema.Struct({
  hardware: LocalHostHardware,
  engines: Schema.Array(LocalEngineStatus),
  checkedAt: IsoDateTime,
});
export type LocalEnginesListResult = typeof LocalEnginesListResult.Type;

export const LocalEngineControlAction = Schema.Literals(["start", "stop", "restart"]);
export type LocalEngineControlAction = typeof LocalEngineControlAction.Type;

export const LocalEngineControlInput = Schema.Struct({
  kind: LocalEngineKind,
  action: LocalEngineControlAction,
  launchConfig: Schema.optional(LocalEngineLaunchConfig),
});
export type LocalEngineControlInput = typeof LocalEngineControlInput.Type;

export const LocalEngineControlResult = Schema.Struct({
  engine: LocalEngineStatus,
  message: Schema.String,
});
export type LocalEngineControlResult = typeof LocalEngineControlResult.Type;

export const LocalEngineUpdateInput = Schema.Struct({
  kind: LocalEngineKind,
});
export type LocalEngineUpdateInput = typeof LocalEngineUpdateInput.Type;

export const LocalEngineUpdateResult = Schema.Struct({
  kind: LocalEngineKind,
  updated: Schema.Boolean,
  previousVersion: Schema.optional(TrimmedNonEmptyString),
  newVersion: Schema.optional(TrimmedNonEmptyString),
  message: Schema.String,
  output: Schema.optional(Schema.String),
});
export type LocalEngineUpdateResult = typeof LocalEngineUpdateResult.Type;

export const LocalEngineModelAction = Schema.Literals(["pull", "load", "unload", "delete"]);
export type LocalEngineModelAction = typeof LocalEngineModelAction.Type;

export const LocalEngineManageModelInput = Schema.Struct({
  kind: LocalEngineKind,
  action: LocalEngineModelAction,
  model: TrimmedNonEmptyString,
});
export type LocalEngineManageModelInput = typeof LocalEngineManageModelInput.Type;

export const LocalEngineManageModelResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  output: Schema.optional(Schema.String),
  engine: LocalEngineStatus,
});
export type LocalEngineManageModelResult = typeof LocalEngineManageModelResult.Type;

export const LocalEngineSaveConfigInput = Schema.Struct({
  kind: LocalEngineKind,
  launchConfig: LocalEngineLaunchConfig,
});
export type LocalEngineSaveConfigInput = typeof LocalEngineSaveConfigInput.Type;

export const LocalEngineSaveConfigResult = Schema.Struct({
  engine: LocalEngineStatus,
});
export type LocalEngineSaveConfigResult = typeof LocalEngineSaveConfigResult.Type;

export const LocalEngineGetLogsInput = Schema.Struct({
  kind: LocalEngineKind,
  limit: Schema.optional(NonNegativeInt),
});
export type LocalEngineGetLogsInput = typeof LocalEngineGetLogsInput.Type;

export const LocalEngineGetLogsResult = Schema.Struct({
  kind: LocalEngineKind,
  lines: Schema.Array(Schema.String),
});
export type LocalEngineGetLogsResult = typeof LocalEngineGetLogsResult.Type;

export class LocalEngineError extends Schema.TaggedError<LocalEngineError>()("LocalEngineError", {
  message: Schema.String,
  kind: Schema.optional(LocalEngineKind),
}) {}
