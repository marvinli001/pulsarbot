import { describe, expect, it } from "vitest";
import {
  createProviderMediaRequestPreview,
  createProviderRequestPreview,
  supportsProviderCapability,
} from "../packages/providers/src/index.js";
import type { ProviderProfile } from "../packages/shared/src/index.js";

function profile(
  kind: ProviderProfile["kind"],
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id: "provider_1",
    kind,
    label: kind,
    apiBaseUrl: "",
    apiKeyRef: "provider:test",
    defaultModel: "test-model",
    visionModel: null,
    audioModel: null,
    documentModel: null,
    stream: false,
    reasoningEnabled: true,
    reasoningLevel: "medium",
    thinkingBudget: null,
    temperature: 0.2,
    topP: null,
    maxOutputTokens: 1024,
    toolCallingEnabled: true,
    jsonModeEnabled: true,
    visionEnabled: false,
    audioInputEnabled: false,
    documentInputEnabled: false,
    headers: {},
    extraBody: {},
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("provider request preview", () => {
  it("builds an OpenAI responses payload", () => {
    const preview = createProviderRequestPreview({
      profile: profile("openai"),
      apiKey: "sk-test",
      input: {
        jsonMode: true,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(preview.url).toContain("/responses");
    expect(preview.headers.Authorization).toBe("Bearer sk-test");
    expect(preview.body.model).toBe("test-model");
  });

  it("builds an Anthropic payload with thinking enabled", () => {
    const preview = createProviderRequestPreview({
      profile: profile("anthropic"),
      apiKey: "anthropic-key",
      input: {
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(preview.url).toContain("/messages");
    expect(preview.headers["x-api-key"]).toBe("anthropic-key");
    expect(preview.body.thinking).toBeTruthy();
  });

  it("covers the configured provider kinds", () => {
    const cases = [
      {
        kind: "gemini" as const,
        apiKey: "gemini-key",
        urlPart: ":generateContent",
        header: "x-goog-api-key",
        assert(preview: ReturnType<typeof createProviderRequestPreview>) {
          expect(preview.body.contents).toBeTruthy();
          expect(preview.body.generationConfig).toMatchObject({
            maxOutputTokens: 1024,
            responseMimeType: "application/json",
          });
        },
      },
      {
        kind: "openrouter" as const,
        apiKey: "openrouter-key",
        urlPart: "/chat/completions",
        header: "Authorization",
        assert(preview: ReturnType<typeof createProviderRequestPreview>) {
          expect(preview.body.model).toBe("test-model");
          expect(preview.body.response_format).toEqual({ type: "json_object" });
        },
      },
      {
        kind: "bailian" as const,
        apiKey: "bailian-key",
        urlPart: "/generation",
        header: "Authorization",
        assert(preview: ReturnType<typeof createProviderRequestPreview>) {
          expect(preview.body.model).toBe("test-model");
          expect(preview.body.input).toBeTruthy();
          expect(preview.body.parameters).toBeTruthy();
        },
      },
      {
        kind: "openai_compatible_chat" as const,
        apiKey: "compatible-chat-key",
        urlPart: "/chat/completions",
        header: "Authorization",
        assert(preview: ReturnType<typeof createProviderRequestPreview>) {
          expect(preview.body.model).toBe("test-model");
          expect(preview.body.messages).toBeTruthy();
        },
      },
      {
        kind: "openai_compatible_responses" as const,
        apiKey: "compatible-responses-key",
        urlPart: "/responses",
        header: "Authorization",
        assert(preview: ReturnType<typeof createProviderRequestPreview>) {
          expect(preview.body.model).toBe("test-model");
          expect(preview.body.input).toBeTruthy();
        },
      },
    ];

    for (const testCase of cases) {
      const preview = createProviderRequestPreview({
        profile: profile(testCase.kind),
        apiKey: testCase.apiKey,
        input: {
          jsonMode: true,
          messages: [{ role: "user", content: "Ping" }],
        },
      });

      expect(preview.url).toContain(testCase.urlPart);
      if (testCase.header === "Authorization") {
        expect(preview.headers.Authorization).toContain(testCase.apiKey);
      } else {
        expect(preview.headers[testCase.header]).toBe(testCase.apiKey);
      }
      testCase.assert(preview);
    }
  });
});

describe("provider media request preview", () => {
  it("builds an OpenRouter audio payload", () => {
    const preview = createProviderMediaRequestPreview({
      profile: profile("openrouter", {
        audioModel: "google/gemini-2.5-flash",
      }),
      apiKey: "openrouter-key",
      input: {
        kind: "audio",
        prompt: "Please transcribe this audio file.",
        rawBody: new Uint8Array([1, 2, 3]),
        mimeType: "audio/ogg",
        fileName: "voice.ogg",
      },
    });

    const body = preview?.body as Record<string, any>;
    expect(preview?.url).toContain("/chat/completions");
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.messages[0].content[1]).toMatchObject({
      type: "input_audio",
      input_audio: {
        format: "ogg",
      },
    });
    expect(body.messages[0].content[1].input_audio.data).toBeTruthy();
  });

  it("builds an Anthropic PDF payload with the beta header", () => {
    const preview = createProviderMediaRequestPreview({
      profile: profile("anthropic", {
        documentModel: "claude-sonnet-4-5",
      }),
      apiKey: "anthropic-key",
      input: {
        kind: "document",
        prompt: "Extract the document text.",
        rawBody: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
        fileName: "memo.pdf",
      },
    });

    const body = preview?.body as Record<string, any>;
    expect(preview?.url).toContain("/messages");
    expect(preview?.headers["anthropic-beta"]).toBe("pdfs-2024-09-25");
    expect(body.messages[0].content[0]).toMatchObject({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
      },
    });
  });

  it("builds a Gemini inline document payload", () => {
    const preview = createProviderMediaRequestPreview({
      profile: profile("gemini", {
        documentModel: "gemini-2.5-flash",
      }),
      apiKey: "gemini-key",
      input: {
        kind: "document",
        prompt: "Summarize this PDF.",
        rawBody: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
        fileName: "paper.pdf",
      },
    });

    const body = preview?.body as Record<string, any>;
    expect(preview?.url).toContain(":generateContent");
    expect(body.contents[0].parts[1]).toMatchObject({
      inlineData: {
        mimeType: "application/pdf",
      },
    });
  });

  it("builds Bailian audio, vision, and document payloads", () => {
    const audioPreview = createProviderMediaRequestPreview({
      profile: profile("bailian", {
        audioModel: "qwen3-asr-flash",
      }),
      apiKey: "bailian-key",
      input: {
        kind: "audio",
        prompt: "Transcribe this.",
        rawBody: new Uint8Array([1, 2, 3]),
        mimeType: "audio/mpeg",
        fileName: "clip.mp3",
      },
    });
    const imagePreview = createProviderMediaRequestPreview({
      profile: profile("bailian", {
        visionModel: "qwen-vl-max-latest",
      }),
      apiKey: "bailian-key",
      input: {
        kind: "image",
        prompt: "Describe this image.",
        rawBody: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        fileName: "image.png",
      },
    });
    const documentPreview = createProviderMediaRequestPreview({
      profile: profile("bailian", {
        documentModel: "qwen-doc-turbo",
      }),
      apiKey: "bailian-key",
      input: {
        kind: "document",
        prompt: "Extract this document.",
        rawBody: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
        fileName: "manual.pdf",
      },
    });

    const audioBody = audioPreview?.body as Record<string, any>;
    const imageBody = imagePreview?.body as Record<string, any>;
    const documentBody = documentPreview?.body as Record<string, any>;

    expect(audioPreview?.url).toContain("/compatible-mode/v1/chat/completions");
    expect(audioBody.messages[0].content[1]).toMatchObject({
      type: "audio_url",
    });

    expect(imagePreview?.url).toContain("/multimodal-generation/generation");
    expect(imageBody.input.messages[0].content[0].image).toContain("data:image/png;base64,");

    expect(documentPreview?.url).toContain("/compatible-mode/v1/responses");
    expect(documentBody.input[0].content[1]).toMatchObject({
      type: "input_file",
      filename: "manual.pdf",
    });
  });

  it("captures provider media support rules", () => {
    expect(supportsProviderCapability(profile("anthropic"), "audio")).toBe(false);
    expect(
      supportsProviderCapability(profile("anthropic"), "document", {
        mimeType: "application/pdf",
        fileName: "notes.pdf",
      }),
    ).toBe(true);
    expect(
      supportsProviderCapability(profile("anthropic"), "document", {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "notes.docx",
      }),
    ).toBe(false);
    expect(
      supportsProviderCapability(profile("bailian"), "document", {
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "notes.docx",
      }),
    ).toBe(true);
  });
});
