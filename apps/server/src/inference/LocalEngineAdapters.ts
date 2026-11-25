import {
  InferenceServerId,
  type LocalEngineCapabilities,
  type LocalEngineKind,
  type LocalEngineLaunchConfig,
  type LocalEngineModel,
} from "@t3tools/contracts";

export interface LocalEngineLaunchSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface LocalEngineAdapter {
  readonly kind: LocalEngineKind;
  readonly displayName: string;
  readonly description: string;
  readonly defaultPort: number;
  /** Candidate executable names/paths searched in order. */
  readonly binaries: ReadonlyArray<string>;
  readonly versionArgs: ReadonlyArray<string>;
  readonly capabilities: LocalEngineCapabilities;
  readonly installHint: (platform: NodeJS.Platform) => string;
  readonly buildStart: (
    binaryPath: string,
    config: LocalEngineLaunchConfig,
  ) => LocalEngineLaunchSpec;
  readonly buildUpdate?: (
    binaryPath: string,
    platform: NodeJS.Platform,
  ) => LocalEngineLaunchSpec | undefined;
}

/**
 * Quote-aware CLI argument splitter so user `extraArgs` never pass through a shell.
 * Supports single quotes, double quotes, and backslash escapes.
 */
export function parseExtraArgs(raw: string | undefined): ReadonlyArray<string> {
  if (!raw || raw.trim().length === 0) return [];
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) args.push(current);
  return args;
}

function engineHost(config: LocalEngineLaunchConfig): string {
  const host = config.host?.trim();
  return host && host.length > 0 ? host : "127.0.0.1";
}

export function enginePort(
  adapter: Pick<LocalEngineAdapter, "defaultPort">,
  config: LocalEngineLaunchConfig,
): number {
  return config.port && config.port > 0 ? config.port : adapter.defaultPort;
}

export function engineBaseUrl(
  adapter: Pick<LocalEngineAdapter, "defaultPort">,
  config: LocalEngineLaunchConfig,
): string {
  const rawHost = engineHost(config);
  const clientHost = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  return `http://${clientHost}:${enginePort(adapter, config)}/v1`;
}

export function engineServerId(kind: LocalEngineKind): InferenceServerId {
  return InferenceServerId.make(`local-${kind}`);
}

export function parseVersionOutput(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine.length === 0) return undefined;
  // Extract semver or build tag if embedded in a banner (e.g. "ollama version is 0.6.2" or "version: 5123 (abc123)").
  const semver = firstLine.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9._-]+)?)\b/);
  if (semver?.[1]) return semver[1];
  const build = firstLine.match(/version:\s*([^\s(]+)/i);
  if (build?.[1]) return build[1];
  return firstLine.slice(0, 64);
}

/** Parse `ollama list` tabular output into structured LocalEngineModel entries. */
export function parseOllamaList(stdout: string): ReadonlyArray<LocalEngineModel> {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const models: LocalEngineModel[] = [];
  for (const line of lines) {
    if (!line || line.startsWith("NAME")) continue;
    // Columns are separated by 2+ spaces: NAME   ID   SIZE   MODIFIED
    const cols = line.split(/\s{2,}/);
    const id = cols[0]?.trim();
    if (!id) continue;
    const sizeStr = cols[2]?.trim();
    const sizeBytes = parseHumanSizeToBytes(sizeStr);
    models.push({
      id,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  }
  return models;
}

/** Parse `ollama ps` tabular output into active model IDs. */
export function parseOllamaPs(stdout: string): ReadonlyArray<string> {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const active: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith("NAME")) continue;
    const cols = line.split(/\s{2,}/);
    const id = cols[0]?.trim();
    if (id) active.push(id);
  }
  return active;
}

export function parseHumanSizeToBytes(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const unit = match[2]!.toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(value * (multipliers[unit] ?? 1));
}

export const LOCAL_ENGINE_ADAPTERS: ReadonlyArray<LocalEngineAdapter> = [
  {
    kind: "ollama",
    displayName: "Ollama",
    description: "One-command local model runner with built-in model registry and OpenAI API.",
    defaultPort: 11434,
    binaries: ["ollama"],
    versionArgs: ["--version"],
    capabilities: {
      canStartStop: true,
      canUpdate: true,
      canPullModels: true,
      canLoadUnload: true,
      canDeleteModels: true,
    },
    installHint: (platform) =>
      platform === "darwin"
        ? "brew install ollama"
        : "curl -fsSL https://ollama.com/install.sh | sh",
    buildStart: (binaryPath, config) => {
      const host = engineHost(config);
      const port = enginePort({ defaultPort: 11434 }, config);
      const env: Record<string, string> = {
        OLLAMA_HOST: `${host}:${port}`,
      };
      if (config.contextLength) env.OLLAMA_CONTEXT_LENGTH = String(config.contextLength);
      if (config.parallelSlots) env.OLLAMA_NUM_PARALLEL = String(config.parallelSlots);
      if (config.flashAttention !== undefined) {
        env.OLLAMA_FLASH_ATTENTION = config.flashAttention ? "1" : "0";
      }
      if (config.kvCacheQuant && config.kvCacheQuant !== "auto") {
        env.OLLAMA_KV_CACHE_TYPE = config.kvCacheQuant;
      }
      return {
        command: binaryPath,
        args: ["serve", ...parseExtraArgs(config.extraArgs)],
        env,
      };
    },
    buildUpdate: (_binaryPath, platform) =>
      platform === "darwin" ? { command: "brew", args: ["upgrade", "ollama"] } : undefined,
  },
  {
    kind: "llama-cpp",
    displayName: "llama.cpp",
    description:
      "High-performance GGUF server (llama-server) with fine-grained KV cache, GPU offload, and context control.",
    defaultPort: 8080,
    binaries: ["llama-server"],
    versionArgs: ["--version"],
    capabilities: {
      canStartStop: true,
      canUpdate: true,
      canPullModels: false,
      canLoadUnload: false,
      canDeleteModels: false,
    },
    installHint: (platform) =>
      platform === "darwin"
        ? "brew install llama.cpp"
        : "Build from https://github.com/ggml-org/llama.cpp or install via your package manager",
    buildStart: (binaryPath, config) => {
      const args: string[] = [
        "--host",
        engineHost(config),
        "--port",
        String(enginePort({ defaultPort: 8080 }, config)),
      ];
      if (config.model?.trim()) {
        // Support either local GGUF path (-m) or HuggingFace repo (-hf).
        const m = config.model.trim();
        if (m.includes("/") && !m.startsWith("/") && !m.startsWith(".") && !m.endsWith(".gguf")) {
          args.push("-hf", m);
        } else {
          args.push("-m", m);
        }
      }
      if (config.contextLength) args.push("-c", String(config.contextLength));
      if (config.gpuLayers !== undefined) args.push("-ngl", String(config.gpuLayers));
      if (config.parallelSlots) args.push("--parallel", String(config.parallelSlots));
      if (config.flashAttention) args.push("-fa", "on");
      if (config.kvCacheQuant && config.kvCacheQuant !== "auto" && config.kvCacheQuant !== "fp8") {
        args.push("-ctk", config.kvCacheQuant, "-ctv", config.kvCacheQuant);
      }
      args.push(...parseExtraArgs(config.extraArgs));
      return { command: binaryPath, args };
    },
    buildUpdate: (_binaryPath, platform) =>
      platform === "darwin" ? { command: "brew", args: ["upgrade", "llama.cpp"] } : undefined,
  },
  {
    kind: "mlx",
    displayName: "MLX (Apple Silicon)",
    description:
      "Native Apple Silicon MLX inference server (mlx_lm.server) with unified-memory efficiency.",
    defaultPort: 8081,
    binaries: ["mlx_lm.server", "mlx-lm"],
    versionArgs: ["--help"],
    capabilities: {
      canStartStop: true,
      canUpdate: true,
      canPullModels: false,
      canLoadUnload: false,
      canDeleteModels: false,
    },
    installHint: () => "pip3 install -U mlx-lm  (or uv tool install mlx-lm)",
    buildStart: (binaryPath, config) => {
      const args: string[] = [
        "--host",
        engineHost(config),
        "--port",
        String(enginePort({ defaultPort: 8081 }, config)),
      ];
      if (config.model?.trim()) {
        args.push("--model", config.model.trim());
      }
      if (config.contextLength) {
        args.push("--max-tokens", String(config.contextLength));
      }
      if (config.kvCacheQuant === "q8_0") args.push("--kv-bits", "8");
      if (config.kvCacheQuant === "q4_0") args.push("--kv-bits", "4");
      args.push(...parseExtraArgs(config.extraArgs));
      return { command: binaryPath, args };
    },
    buildUpdate: () => ({ command: "pip3", args: ["install", "-U", "mlx-lm"] }),
  },
  {
    kind: "lm-studio",
    displayName: "LM Studio",
    description: "Desktop & headless local model manager (lms CLI) with GGUF and MLX runtimes.",
    defaultPort: 1234,
    binaries: ["lms"],
    versionArgs: ["version"],
    capabilities: {
      canStartStop: true,
      canUpdate: false,
      canPullModels: true,
      canLoadUnload: true,
      canDeleteModels: false,
    },
    installHint: () => "Install LM Studio from https://lmstudio.ai and enable the `lms` CLI",
    buildStart: (binaryPath, config) => {
      const args: string[] = [
        "server",
        "start",
        "--port",
        String(enginePort({ defaultPort: 1234 }, config)),
        ...parseExtraArgs(config.extraArgs),
      ];
      return { command: binaryPath, args };
    },
  },
  {
    kind: "vllm",
    displayName: "vLLM",
    description: "High-throughput PagedAttention inference server for NVIDIA / Linux GPU hosts.",
    defaultPort: 8000,
    binaries: ["vllm"],
    versionArgs: ["--version"],
    capabilities: {
      canStartStop: true,
      canUpdate: true,
      canPullModels: false,
      canLoadUnload: false,
      canDeleteModels: false,
    },
    installHint: () => "pip3 install -U vllm",
    buildStart: (binaryPath, config) => {
      const args: string[] = ["serve"];
      if (config.model?.trim()) args.push(config.model.trim());
      args.push(
        "--host",
        engineHost(config),
        "--port",
        String(enginePort({ defaultPort: 8000 }, config)),
      );
      if (config.contextLength) args.push("--max-model-len", String(config.contextLength));
      if (config.kvCacheQuant === "fp8") args.push("--kv-cache-dtype", "fp8");
      if (
        config.memoryLimitGb !== undefined &&
        config.memoryLimitGb > 0 &&
        config.memoryLimitGb <= 1
      ) {
        args.push("--gpu-memory-utilization", String(config.memoryLimitGb));
      }
      args.push(...parseExtraArgs(config.extraArgs));
      return { command: binaryPath, args };
    },
    buildUpdate: () => ({ command: "pip3", args: ["install", "-U", "vllm"] }),
  },
  {
    kind: "sglang",
    displayName: "SGLang",
    description:
      "RadixAttention serving engine for fast prefix-cached multi-turn coding workloads.",
    defaultPort: 30000,
    binaries: ["sglang"],
    versionArgs: ["--version"],
    capabilities: {
      canStartStop: true,
      canUpdate: true,
      canPullModels: false,
      canLoadUnload: false,
      canDeleteModels: false,
    },
    installHint: () => "pip3 install -U 'sglang[all]'",
    buildStart: (binaryPath, config) => {
      const args: string[] = [
        "launch_server",
        "--host",
        engineHost(config),
        "--port",
        String(enginePort({ defaultPort: 30000 }, config)),
      ];
      if (config.model?.trim()) args.push("--model-path", config.model.trim());
      if (config.contextLength) args.push("--context-length", String(config.contextLength));
      args.push(...parseExtraArgs(config.extraArgs));
      return { command: binaryPath, args };
    },
    buildUpdate: () => ({ command: "pip3", args: ["install", "-U", "sglang"] }),
  },
  {
    kind: "omega",
    displayName: "Omega Stack",
    description: "Pure seeded-Omega native serving stack (omega-router / q36-serve / ollm).",
    defaultPort: 18090,
    binaries: ["omega-router", "q36-35b", "q36-serve", "ollm"],
    versionArgs: ["--version"],
    capabilities: {
      canStartStop: true,
      canUpdate: false,
      canPullModels: false,
      canLoadUnload: false,
      canDeleteModels: false,
    },
    installHint: () => "Install omega-router or ollm into ~/.local/bin",
    buildStart: (binaryPath, config) => {
      const args: string[] = [];
      if (binaryPath.endsWith("ollm")) {
        args.push("serve", "--port", String(enginePort({ defaultPort: 18090 }, config)));
      }
      args.push(...parseExtraArgs(config.extraArgs));
      return { command: binaryPath, args };
    },
  },
];

export function getLocalEngineAdapter(kind: LocalEngineKind): LocalEngineAdapter {
  const found = LOCAL_ENGINE_ADAPTERS.find((adapter) => adapter.kind === kind);
  if (!found) {
    throw new Error(`Unknown local engine kind: ${String(kind)}`);
  }
  return found;
}
