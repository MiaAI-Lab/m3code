import type { SpeechTranscriptionOptions } from "@t3tools/contracts";

import { encodePcm16Wav } from "./wav.ts";

export interface LocalSpeechEndpointConfig {
  readonly url: string;
  readonly model: string;
}

/** Parses and validates a local/LAN OpenAI-compatible or whisper.cpp STT endpoint URL. */
export function parseLocalSpeechEndpoint(
  rawUrl: string | undefined,
  rawModel: string | undefined,
): LocalSpeechEndpointConfig | null {
  const trimmed = rawUrl?.trim() ?? "";
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return {
    url: parsed.toString(),
    model: rawModel?.trim() || "whisper-1",
  };
}

/**
 * Sends 16 kHz mono Float32 PCM as a WAV upload to a local OpenAI-compatible
 * (`/v1/audio/transcriptions`) or `whisper.cpp` (`/inference`) STT server.
 */
export async function transcribeWithLocalEndpoint(
  config: LocalSpeechEndpointConfig,
  pcm: Float32Array,
  options: SpeechTranscriptionOptions,
  signal?: AbortSignal,
): Promise<string> {
  const wav = encodePcm16Wav(pcm);
  const form = new FormData();
  form.set("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
  form.set("model", config.model);
  form.set("response_format", "json");
  if (options.speechLanguage && options.speechLanguage !== "auto") {
    form.set("language", options.speechLanguage);
  }
  if (options.speechCustomWords.length > 0) {
    form.set("prompt", options.speechCustomWords.map(({ term }) => term).join(", "));
  }
  const response = await fetch(config.url, {
    method: "POST",
    body: form,
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Local speech endpoint returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json()) as { text?: unknown };
    if (typeof body.text === "string") return body.text;
    throw new Error("Local speech endpoint JSON response did not include a text string.");
  }
  const raw = (await response.text()).trim();
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    // Plain-text response (e.g. whisper.cpp text mode)
  }
  return raw;
}
