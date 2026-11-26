export interface VoiceModelCandidate {
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  readonly providerLabel: string;
}

export type ParsedVoiceCommand =
  | { readonly kind: "none" }
  | { readonly kind: "stop" }
  | { readonly kind: "clear" }
  | { readonly kind: "send"; readonly text: string }
  | {
      readonly kind: "switch-model";
      readonly candidate: VoiceModelCandidate;
      readonly remainingText: string;
      readonly autoSend: boolean;
    };

function normalizePhrase(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9.\s-]+/g, " ")
    .replace(/\.+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingSendPhrase(text: string): { readonly text: string; readonly send: boolean } {
  const match = text.match(
    /^(.*?)(?:[,.;:!?—–-\s]+)(send it|send message|send prompt|submit message|submit prompt|over)[.!?]*$/i,
  );
  if (match) {
    return { text: match[1]!.trim(), send: true };
  }
  const standalone = normalizePhrase(text);
  if (
    standalone === "send" ||
    standalone === "send it" ||
    standalone === "send message" ||
    standalone === "submit" ||
    standalone === "submit message"
  ) {
    return { text: "", send: true };
  }
  return { text, send: false };
}

function scoreModelCandidate(query: string, candidate: VoiceModelCandidate): number {
  const normalizedQuery = normalizePhrase(query);
  if (!normalizedQuery) return 0;
  const fields = [
    normalizePhrase(candidate.label),
    normalizePhrase(candidate.model),
    normalizePhrase(`${candidate.providerLabel} ${candidate.label}`),
    normalizePhrase(candidate.providerLabel),
  ];

  for (const field of fields) {
    if (field === normalizedQuery) return 100;
  }

  const queryTokens = normalizedQuery.split(" ").filter((token) => token.length > 0);
  if (queryTokens.length === 0) return 0;

  let best = 0;
  for (const field of fields) {
    if (field.includes(normalizedQuery)) {
      best = Math.max(best, 80 + normalizedQuery.length);
      continue;
    }
    const fieldTokens = field.split(/[\s.-]+/).filter(Boolean);
    const matched = queryTokens.filter((token) =>
      fieldTokens.some(
        (candidateToken) => candidateToken === token || candidateToken.startsWith(token),
      ),
    );
    if (matched.length === queryTokens.length) {
      best = Math.max(best, 60 + matched.length * 5);
    }
  }
  return best;
}

export function matchVoiceModelCandidate(
  query: string,
  candidates: readonly VoiceModelCandidate[],
): VoiceModelCandidate | null {
  let bestCandidate: VoiceModelCandidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreModelCandidate(query, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }
  return bestScore >= 60 ? bestCandidate : null;
}

/** Parses a newly transcribed utterance for hands-free model-switching and turn-control commands. */
export function parseVoiceCommand(
  rawTranscript: string,
  candidates: readonly VoiceModelCandidate[],
): ParsedVoiceCommand {
  const trimmed = rawTranscript.trim();
  if (!trimmed) return { kind: "none" };
  const normalized = normalizePhrase(trimmed);

  if (
    normalized === "stop" ||
    normalized === "stop generating" ||
    normalized === "stop generation" ||
    normalized === "cancel turn" ||
    normalized === "interrupt"
  ) {
    return { kind: "stop" };
  }

  if (normalized === "clear" || normalized === "clear draft" || normalized === "clear prompt") {
    return { kind: "clear" };
  }

  // Match "switch [model] to <model>[ and <prompt>]" or "use model <model>[ and <prompt>]"
  const switchMatch = trimmed.match(
    /^(?:switch(?:\s+the)?\s+model\s+to|switch\s+to|use\s+model|change\s+model\s+to)\s+(.+)$/i,
  );
  if (switchMatch && candidates.length > 0) {
    const rest = switchMatch[1]!.replace(/[.!?]+$/, "").trim();
    const chained = rest.match(/^(.+?)\s+(?:and|then)\s+(.+)$/i);
    if (chained) {
      const candidate = matchVoiceModelCandidate(chained[1]!, candidates);
      if (candidate) {
        const trailing = stripTrailingSendPhrase(chained[2]!.trim());
        return {
          kind: "switch-model",
          candidate,
          remainingText: trailing.text,
          autoSend: trailing.send,
        };
      }
    }
    const candidate = matchVoiceModelCandidate(rest, candidates);
    if (candidate) {
      return {
        kind: "switch-model",
        candidate,
        remainingText: "",
        autoSend: false,
      };
    }
  }

  const trailingSend = stripTrailingSendPhrase(trimmed);
  if (trailingSend.send) {
    return { kind: "send", text: trailingSend.text };
  }

  return { kind: "none" };
}
