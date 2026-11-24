import type { SpeechCustomWords } from "@t3tools/contracts";

import { applySpeechAliases } from "./customWords.ts";

export interface LocalCleanupEndpointConfig {
  readonly url: string;
  readonly model: string;
}

/** Parses an optional local OpenAI-compatible /v1/chat/completions cleanup endpoint. */
export function parseLocalCleanupEndpoint(
  rawUrl: string | undefined,
  rawModel: string | undefined,
): LocalCleanupEndpointConfig | null {
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
    model: rawModel?.trim() || "default",
  };
}

const CONTRACTION_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bi'm\b/gi, "I'm"],
  [/\bi've\b/gi, "I've"],
  [/\bi'll\b/gi, "I'll"],
  [/\bi'd\b/gi, "I'd"],
  [/\bim\b/gi, "I'm"],
  [/\bive\b/gi, "I've"],
  [/\bdont\b/gi, "don't"],
  [/\bcant\b/gi, "can't"],
  [/\bwont\b/gi, "won't"],
  [/\bdoesnt\b/gi, "doesn't"],
  [/\bdidnt\b/gi, "didn't"],
  [/\bisnt\b/gi, "isn't"],
  [/\barent\b/gi, "aren't"],
  [/\bwasnt\b/gi, "wasn't"],
  [/\bwerent\b/gi, "weren't"],
  [/\bhavent\b/gi, "haven't"],
  [/\bhasnt\b/gi, "hasn't"],
  [/\bwouldnt\b/gi, "wouldn't"],
  [/\bcouldnt\b/gi, "couldn't"],
  [/\bshouldnt\b/gi, "shouldn't"],
  [/\bthats\b/gi, "that's"],
  [/\bwhats\b/gi, "what's"],
  [/\btheres\b/gi, "there's"],
  [/\bheres\b/gi, "here's"],
  [/\byoure\b/gi, "you're"],
  [/\btheyre\b/gi, "they're"],
  [/\bweve\b/gi, "we've"],
  [/\byouve\b/gi, "you've"],
  [/\btheyve\b/gi, "they've"],
];

const QUESTION_STARTER =
  /^(?:what|why|how|where|when|who|which|can|could|would|should|do|does|did|is|are|was|were|will|have|has)\b/i;

function preserveInitialCase(original: string, replacement: string): string {
  if (original.length > 0 && original[0] === original[0]!.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applySpokenCorrections(text: string, customCue?: string): string {
  const cues = ["scratch that", "never mind", "nevermind", "i mean"];
  const trimmedCue = customCue?.trim();
  if (trimmedCue) cues.unshift(trimmedCue);
  const cuePattern = cues.map(escapeRegExp).join("|");
  // "make it 42, scratch that, 24" -> "make it 24"
  const pattern = new RegExp(
    `(\\b\\S+)\\s*[,;:.\\s-]+(?:${cuePattern})\\s*[,;:.\\s-]+(\\S+)`,
    "gi",
  );
  return text.replace(pattern, "$2");
}

/**
 * Deterministic, zero-API-call Phase 2 transcript cleaner.
 * Fixes capitalization, punctuation spacing, common contractions, word stutters,
 * spoken self-corrections, and custom dictionary spellings locally.
 */
export function cleanTranscriptLocally(
  rawTranscript: string,
  options: {
    readonly customWords: SpeechCustomWords;
    readonly correctionWord?: string | undefined;
  },
): string {
  let text = rawTranscript.replace(/\s+/g, " ").trim();
  if (!text) return "";

  text = applySpokenCorrections(text, options.correctionWord);

  // Collapse accidental immediate word stutters ("the the" -> "the").
  text = text.replace(/\b([a-z]{1,12})\s+\1\b/gi, "$1");

  // Fix contractions and standalone "i" -> "I".
  for (const [pattern, replacement] of CONTRACTION_REPLACEMENTS) {
    text = text.replace(pattern, (match) => preserveInitialCase(match, replacement));
  }
  text = text.replace(/\bi\b/g, "I");

  // Normalize spacing around punctuation.
  text = text
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?=[A-Za-z0-9])/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

  // Capitalize start of transcript and after sentence-ending punctuation.
  text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix: string, letter: string) => {
    return `${prefix}${letter.toUpperCase()}`;
  });

  // Add terminal punctuation for multi-word utterances if none is present.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 3 && !/[.!?…:]$/.test(text)) {
    text += QUESTION_STARTER.test(text) ? "?" : ".";
  }

  return applySpeechAliases(text, options.customWords).trim();
}

/**
 * Calls a local OpenAI-compatible `/v1/chat/completions` endpoint for Phase 2 cleanup
 * (e.g. Ollama, llama.cpp, LM Studio, or Spark local model server).
 */
export async function cleanTranscriptWithLocalEndpoint(
  config: LocalCleanupEndpointConfig,
  transcript: string,
  instructions: string,
  customWords: SpeechCustomWords,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: transcript },
      ],
    }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Local cleanup endpoint returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Local cleanup endpoint returned empty content.");
  }
  return applySpeechAliases(content.trim(), customWords).trim();
}
