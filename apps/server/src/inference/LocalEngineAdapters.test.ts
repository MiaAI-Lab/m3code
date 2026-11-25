import { describe, expect, it } from "@effect/vitest";

import {
  engineBaseUrl,
  engineServerId,
  getLocalEngineAdapter,
  LOCAL_ENGINE_ADAPTERS,
  parseExtraArgs,
  parseHumanSizeToBytes,
  parseOllamaList,
  parseOllamaPs,
  parseVersionOutput,
} from "./LocalEngineAdapters.ts";

describe("LocalEngineAdapters", () => {
  it("registers all expected pluggable engine kinds", () => {
    const kinds = LOCAL_ENGINE_ADAPTERS.map((a) => a.kind);
    expect(kinds).toEqual(["ollama", "llama-cpp", "mlx", "lm-studio", "vllm", "sglang", "omega"]);
  });

  it("parses extraArgs safely without a shell", () => {
    expect(parseExtraArgs(undefined)).toEqual([]);
    expect(parseExtraArgs("   ")).toEqual([]);
    expect(parseExtraArgs("--cache-reuse 256 --chat-template \"chatml v2\" -k 'a b'")).toEqual([
      "--cache-reuse",
      "256",
      "--chat-template",
      "chatml v2",
      "-k",
      "a b",
    ]);
  });

  it("extracts version tags from CLI output", () => {
    expect(parseVersionOutput("ollama version is 0.6.2\n")).toBe("0.6.2");
    expect(parseVersionOutput("version: 5123 (abc1234)\nbuilt with clang")).toBe("5123");
    expect(parseVersionOutput("vllm 0.8.3-rc1")).toBe("0.8.3-rc1");
    expect(parseVersionOutput("   \n")).toBeUndefined();
  });

  it("parses ollama list and ps tables", () => {
    const listOut = [
      "NAME                      ID              SIZE      MODIFIED",
      "qwen3:32b                 a1b2c3d4e5f6    19.8 GB   2 days ago",
      "nomic-embed-text:latest   9876543210ab    274 MB    3 weeks ago",
    ].join("\n");
    expect(parseOllamaList(listOut)).toEqual([
      { id: "qwen3:32b", sizeBytes: Math.round(19.8 * 1024 ** 3) },
      { id: "nomic-embed-text:latest", sizeBytes: 274 * 1024 ** 2 },
    ]);

    const psOut = [
      "NAME         ID              SIZE     PROCESSOR   UNTIL",
      "qwen3:32b    a1b2c3d4e5f6    22 GB    100% GPU    4 minutes from now",
    ].join("\n");
    expect(parseOllamaPs(psOut)).toEqual(["qwen3:32b"]);
    expect(parseHumanSizeToBytes("1.5 GB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseHumanSizeToBytes("invalid")).toBeUndefined();
  });

  it("builds llama-cpp launch args for both local GGUF and HuggingFace repos", () => {
    const adapter = getLocalEngineAdapter("llama-cpp");
    const hfSpec = adapter.buildStart("/opt/homebrew/bin/llama-server", {
      host: "127.0.0.1",
      port: 8088,
      model: "bartowski/Qwen3-32B-GGUF",
      contextLength: 65536,
      gpuLayers: 999,
      kvCacheQuant: "q8_0",
      parallelSlots: 4,
      flashAttention: true,
      extraArgs: "--jinja",
    });
    expect(hfSpec).toEqual({
      command: "/opt/homebrew/bin/llama-server",
      args: [
        "--host",
        "127.0.0.1",
        "--port",
        "8088",
        "-hf",
        "bartowski/Qwen3-32B-GGUF",
        "-c",
        "65536",
        "-ngl",
        "999",
        "--parallel",
        "4",
        "-fa",
        "on",
        "-ctk",
        "q8_0",
        "-ctv",
        "q8_0",
        "--jinja",
      ],
    });

    const fileSpec = adapter.buildStart("/opt/homebrew/bin/llama-server", {
      model: "/models/qwen3.gguf",
    });
    expect(fileSpec.args).toContain("-m");
    expect(fileSpec.args).toContain("/models/qwen3.gguf");
  });

  it("builds Ollama env vars and MLX CLI flags", () => {
    const ollama = getLocalEngineAdapter("ollama");
    const ollamaSpec = ollama.buildStart("/opt/homebrew/bin/ollama", {
      host: "0.0.0.0",
      port: 11435,
      contextLength: 32768,
      parallelSlots: 2,
      flashAttention: true,
      kvCacheQuant: "q8_0",
    });
    expect(ollamaSpec.args).toEqual(["serve"]);
    expect(ollamaSpec.env).toEqual({
      OLLAMA_HOST: "0.0.0.0:11435",
      OLLAMA_CONTEXT_LENGTH: "32768",
      OLLAMA_NUM_PARALLEL: "2",
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
    });
    // Wildcard bind address normalizes to 127.0.0.1 for gateway client URL.
    expect(engineBaseUrl(ollama, { host: "0.0.0.0", port: 11435 })).toBe(
      "http://127.0.0.1:11435/v1",
    );
    expect(engineServerId("ollama")).toBe("local-ollama");

    const mlx = getLocalEngineAdapter("mlx");
    const mlxSpec = mlx.buildStart("/usr/local/bin/mlx_lm.server", {
      model: "mlx-community/Qwen3-32B-4bit",
      port: 8081,
      contextLength: 16384,
      kvCacheQuant: "q4_0",
    });
    expect(mlxSpec.args).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "8081",
      "--model",
      "mlx-community/Qwen3-32B-4bit",
      "--max-tokens",
      "16384",
      "--kv-bits",
      "4",
    ]);
  });
});
