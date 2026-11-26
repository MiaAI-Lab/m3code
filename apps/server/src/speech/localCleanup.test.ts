import { describe, expect, it, vi } from "vite-plus/test";

import {
  cleanTranscriptLocally,
  cleanTranscriptWithLocalEndpoint,
  parseLocalCleanupEndpoint,
} from "./localCleanup.ts";

describe("localCleanup", () => {
  it("cleans capitalization, contractions, stutters, punctuation, and spoken corrections locally", () => {
    expect(
      cleanTranscriptLocally("i dont think the the parser works right", { customWords: [] }),
    ).toBe("I don't think the parser works right.");

    expect(cleanTranscriptLocally("can you check why tests fail", { customWords: [] })).toBe(
      "Can you check why tests fail?",
    );

    expect(cleanTranscriptLocally("set timeout to 42, scratch that, 24", { customWords: [] })).toBe(
      "Set timeout to 24.",
    );

    expect(
      cleanTranscriptLocally("use m3 code for local voice", {
        customWords: [{ term: "M3 Code", aliases: ["m3 code"] }],
      }),
    ).toBe("Use M3 Code for local voice.");
  });

  it("parses valid local cleanup endpoints", () => {
    expect(
      parseLocalCleanupEndpoint("http://127.0.0.1:11434/v1/chat/completions", "qwen2.5:3b"),
    ).toEqual({
      url: "http://127.0.0.1:11434/v1/chat/completions",
      model: "qwen2.5:3b",
    });
    expect(parseLocalCleanupEndpoint("", "")).toBeNull();
    expect(parseLocalCleanupEndpoint("file:///tmp/x", "")).toBeNull();
  });

  it("calls a local OpenAI-compatible chat completions endpoint for Phase 2 cleanup", async () => {
    using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Fix the failing parser tests." } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const cleaned = await cleanTranscriptWithLocalEndpoint(
      { url: "http://127.0.0.1:11434/v1/chat/completions", model: "qwen2.5:3b" },
      "fix the failing parser tests",
      "Clean up punctuation and capitals.",
      [],
    );
    expect(cleaned).toBe("Fix the failing parser tests.");
  });
});
