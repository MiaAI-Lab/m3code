import { describe, expect, it, vi } from "vite-plus/test";

import { parseLocalSpeechEndpoint, transcribeWithLocalEndpoint } from "./localEndpoint.ts";
import { encodePcm16Wav } from "./wav.ts";

describe("localEndpoint", () => {
  it("parses valid http and https endpoints and defaults model to whisper-1", () => {
    expect(parseLocalSpeechEndpoint("http://127.0.0.1:8178/inference", "")).toEqual({
      url: "http://127.0.0.1:8178/inference",
      model: "whisper-1",
    });
    expect(
      parseLocalSpeechEndpoint(" https://spark.local/v1/audio/transcriptions ", "whisper-large-v3"),
    ).toEqual({
      url: "https://spark.local/v1/audio/transcriptions",
      model: "whisper-large-v3",
    });
    expect(parseLocalSpeechEndpoint("", "")).toBeNull();
    expect(parseLocalSpeechEndpoint("file:///etc/passwd", "")).toBeNull();
    expect(parseLocalSpeechEndpoint("not-a-url", "")).toBeNull();
  });

  it("encodes 16 kHz mono WAV header and samples", () => {
    const wav = encodePcm16Wav(new Float32Array([0, 0.5, -1]));
    expect(wav.byteLength).toBe(44 + 6);
    const header = new TextDecoder().decode(new Uint8Array(wav, 0, 4));
    expect(header).toBe("RIFF");
    const view = new DataView(wav);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(-32768);
  });

  it("posts WAV multipart form data and reads JSON text", async () => {
    let capturedForm: FormData | null = null;
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedForm = init?.body as FormData;
      return new Response(JSON.stringify({ text: "hello from local whisper" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const text = await transcribeWithLocalEndpoint(
      { url: "http://127.0.0.1:8178/inference", model: "large-v3-turbo" },
      new Float32Array([0.1, -0.1]),
      {
        speechLanguage: "en",
        speechTranslateToEnglish: false,
        speechCustomWords: [{ term: "M3 Code", aliases: [] }],
        speechRemoveFillerWords: true,
        speechSilenceFiltering: true,
      },
    );

    expect(text).toBe("hello from local whisper");
    expect(capturedForm?.get("model")).toBe("large-v3-turbo");
    expect(capturedForm?.get("language")).toBe("en");
    expect(capturedForm?.get("prompt")).toBe("M3 Code");
    expect(capturedForm?.get("file")).toBeInstanceOf(Blob);
  });
});
