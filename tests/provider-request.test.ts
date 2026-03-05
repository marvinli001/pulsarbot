import { describe, expect, it } from "vitest";
import {
  createProviderMediaRequestPreview,
  createProviderRequestPreview,
  getProviderAdapter,
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

  it("builds an OpenAI chat-completions payload for native tool calling", () => {
    const preview = createProviderRequestPreview({
      profile: profile("openai"),
      apiKey: "sk-test",
      input: {
        messages: [{ role: "user", content: "Find docs" }],
        tools: [
          {
            id: "search_web",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        toolChoice: { type: "tool", toolId: "search_web" },
      },
    });

    expect(preview.url).toContain("/chat/completions");
    expect(preview.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ]);
    expect(preview.body.tool_choice).toEqual({
      type: "function",
      function: { name: "search_web" },
    });
  });

  it("builds an Anthropic payload for native tool calling", () => {
    const preview = createProviderRequestPreview({
      profile: profile("anthropic"),
      apiKey: "anthropic-key",
      input: {
        messages: [{ role: "user", content: "Find docs" }],
        tools: [
          {
            id: "search_web",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        toolChoice: "auto",
      },
    });

    expect(preview.url).toContain("/messages");
    expect(preview.body.tools).toEqual([
      {
        name: "search_web",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    expect(preview.body.tool_choice).toEqual({ type: "auto" });
  });

  it("builds an OpenRouter responses payload for native tool calling and reasoning", () => {
    const preview = createProviderRequestPreview({
      profile: profile("openrouter", {
        reasoningEnabled: true,
        reasoningLevel: "high",
      }),
      apiKey: "openrouter-key",
      input: {
        messages: [{ role: "user", content: "Find docs" }],
        tools: [
          {
            id: "search_web",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        toolChoice: { type: "tool", toolId: "search_web" },
      },
    });

    expect(preview.url).toContain("/responses");
    expect(preview.body.reasoning).toEqual({ effort: "high" });
    expect(preview.body.tools).toEqual([
      {
        type: "function",
        name: "search_web",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    expect(preview.body.tool_choice).toEqual({
      type: "function",
      name: "search_web",
    });
  });

  it("builds a Gemini payload for native tool calling", () => {
    const preview = createProviderRequestPreview({
      profile: profile("gemini"),
      apiKey: "gemini-key",
      input: {
        messages: [{ role: "user", content: "Find docs" }],
        tools: [
          {
            id: "search_web",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        toolChoice: { type: "tool", toolId: "search_web" },
      },
    });

    expect(preview.url).toContain(":generateContent");
    expect(preview.body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "search_web",
            description: "Search the web",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
    ]);
    expect(preview.body.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["search_web"],
      },
    });
  });

  it("builds a Bailian chat-completions payload for native tool calling and thinking", () => {
    const preview = createProviderRequestPreview({
      profile: profile("bailian", {
        reasoningEnabled: true,
        reasoningLevel: "medium",
      }),
      apiKey: "bailian-key",
      input: {
        messages: [{ role: "user", content: "Find docs" }],
        tools: [
          {
            id: "search_web",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        toolChoice: { type: "tool", toolId: "search_web" },
      },
    });

    expect(preview.url).toContain("/compatible-mode/v1/chat/completions");
    expect(preview.body.enable_thinking).toBe(true);
    expect(preview.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ]);
    expect(preview.body.tool_choice).toEqual({
      type: "function",
      function: { name: "search_web" },
    });
  });

  it("disables Bailian thinking when JSON mode is requested and forwards thinking budget otherwise", () => {
    const withJsonMode = createProviderRequestPreview({
      profile: profile("bailian", {
        reasoningEnabled: true,
        reasoningLevel: "high",
        thinkingBudget: 2048,
      }),
      apiKey: "bailian-key",
      input: {
        messages: [{ role: "user", content: "Return strict JSON" }],
        jsonMode: true,
      },
    });

    expect(withJsonMode.body.response_format).toEqual({ type: "json_object" });
    expect(withJsonMode.body.enable_thinking).toBe(false);
    expect(withJsonMode.body.thinking_budget).toBeUndefined();

    const withoutJsonMode = createProviderRequestPreview({
      profile: profile("bailian", {
        reasoningEnabled: true,
        reasoningLevel: "high",
        thinkingBudget: 2048,
      }),
      apiKey: "bailian-key",
      input: {
        messages: [{ role: "user", content: "Think deeply before answering." }],
      },
    });

    expect(withoutJsonMode.body.enable_thinking).toBe(true);
    expect(withoutJsonMode.body.thinking_budget).toBe(2048);
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
        urlPart: "/compatible-mode/v1/chat/completions",
        header: "Authorization",
        assert(preview: ReturnType<typeof createProviderRequestPreview>) {
          expect(preview.body.model).toBe("test-model");
          expect(preview.body.messages).toBeTruthy();
          expect(preview.body.enable_thinking).toBe(false);
          expect(preview.body.response_format).toEqual({ type: "json_object" });
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

describe("provider response parsing", () => {
  it("parses OpenAI chat-completions tool calls", () => {
    const adapter = getProviderAdapter("openai");
    const result = adapter.parseResponse({
      id: "chatcmpl-1",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Let me call a tool.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "search_web",
                  arguments: "{\"query\":\"tokyo weather\"}",
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.text).toContain("Let me call a tool.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        toolId: "search_web",
        input: { query: "tokyo weather" },
      },
    ]);
  });

  it("parses Anthropic tool_use blocks", () => {
    const adapter = getProviderAdapter("anthropic");
    const result = adapter.parseResponse({
      id: "msg_1",
      type: "message",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "search_web",
          input: { query: "tokyo weather" },
        },
        {
          type: "text",
          text: "I'll use the search result next.",
        },
      ],
    });

    expect(result.text).toContain("I'll use the search result next.");
    expect(result.toolCalls).toEqual([
      {
        id: "toolu_1",
        toolId: "search_web",
        input: { query: "tokyo weather" },
      },
    ]);
  });

  it("parses OpenRouter responses function_call blocks", () => {
    const adapter = getProviderAdapter("openrouter");
    const result = adapter.parseResponse({
      id: "resp_or_1",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "search_web",
          arguments: "{\"query\":\"tokyo weather\"}",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Using tool now." }],
        },
      ],
    });

    expect(result.text).toContain("Using tool now.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        toolId: "search_web",
        input: { query: "tokyo weather" },
      },
    ]);
  });

  it("parses Bailian chat-completions tool_calls", () => {
    const adapter = getProviderAdapter("bailian");
    const result = adapter.parseResponse({
      id: "chatcmpl_bl_1",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Using tool now.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "search_web",
                  arguments: "{\"query\":\"tokyo weather\"}",
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.text).toContain("Using tool now.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        toolId: "search_web",
        input: { query: "tokyo weather" },
      },
    ]);
  });

  it("parses Gemini functionCall blocks", () => {
    const adapter = getProviderAdapter("gemini");
    const result = adapter.parseResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: "call_1",
                  name: "search_web",
                  args: { query: "tokyo weather" },
                },
              },
              {
                text: "Using tool now.",
              },
            ],
          },
        },
      ],
    });

    expect(result.text).toContain("Using tool now.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        toolId: "search_web",
        input: { query: "tokyo weather" },
      },
    ]);
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
      type: "input_audio",
    });
    expect(audioBody.messages[0].content[1].input_audio).toMatchObject({
      format: "mp3",
    });

    expect(imagePreview?.url).toContain("/multimodal-generation/generation");
    expect(imageBody.input.messages[0].content[0].image).toContain("data:image/png;base64,");
    expect(imageBody.parameters.incremental_output).toBe(true);

    expect(documentPreview?.url).toContain("/compatible-mode/v1/chat/completions");
    expect(documentBody.messages[0]).toMatchObject({
      role: "system",
      content: "fileid://<uploaded-file-id>",
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
