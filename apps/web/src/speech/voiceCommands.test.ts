import { describe, expect, it } from "vite-plus/test";

import { parseVoiceCommand, type VoiceModelCandidate } from "./voiceCommands";

const MODELS: readonly VoiceModelCandidate[] = [
  {
    instanceId: "claude-1",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    providerLabel: "Claude",
  },
  {
    instanceId: "claude-1",
    model: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    providerLabel: "Claude",
  },
  {
    instanceId: "codex-1",
    model: "gpt-5.4",
    label: "GPT-5.4",
    providerLabel: "Codex",
  },
  {
    instanceId: "ag-1",
    model: "gemini-3-pro",
    label: "Gemini 3 Pro",
    providerLabel: "Antigravity",
  },
];

describe("parseVoiceCommand", () => {
  it("recognizes stop and clear commands", () => {
    expect(parseVoiceCommand("Stop generating.", MODELS)).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("cancel turn", MODELS)).toEqual({ kind: "stop" });
    expect(parseVoiceCommand("Clear draft!", MODELS)).toEqual({ kind: "clear" });
  });

  it("recognizes standalone and trailing send commands", () => {
    expect(parseVoiceCommand("send it.", MODELS)).toEqual({ kind: "send", text: "" });
    expect(parseVoiceCommand("Fix the failing unit test, send it.", MODELS)).toEqual({
      kind: "send",
      text: "Fix the failing unit test",
    });
    expect(parseVoiceCommand("Explain this diff, over", MODELS)).toEqual({
      kind: "send",
      text: "Explain this diff",
    });
  });

  it("switches AI models by voice, with or without chained prompt", () => {
    expect(parseVoiceCommand("Switch to Opus.", MODELS)).toEqual({
      kind: "switch-model",
      candidate: MODELS[1],
      remainingText: "",
      autoSend: false,
    });
    expect(parseVoiceCommand("Use model Gemini 3 Pro", MODELS)).toEqual({
      kind: "switch-model",
      candidate: MODELS[3],
      remainingText: "",
      autoSend: false,
    });
    expect(parseVoiceCommand("Switch to Sonnet and refactor the parser, send it.", MODELS)).toEqual(
      {
        kind: "switch-model",
        candidate: MODELS[0],
        remainingText: "refactor the parser",
        autoSend: true,
      },
    );
  });

  it("leaves normal dictation untouched", () => {
    expect(parseVoiceCommand("Refactor the sidebar to use flexbox", MODELS)).toEqual({
      kind: "none",
    });
    expect(parseVoiceCommand("Switch to the settings tab when ready", MODELS)).toEqual({
      kind: "none",
    });
  });
});
