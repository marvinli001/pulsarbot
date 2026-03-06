import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderMediaRequestPreview,
  createProviderRequestPreview,
  getProviderAdapter,
  invokeProvider,
  supportsProviderCapability,
} from "../packages/providers/src/index.js";
import type { ProviderProfile } from "../packages/shared/src/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    expect(preview.body.temperature).toBe(0.2);
    expect("top_p" in preview.body).toBe(false);
  });

  it("normalizes OpenAI GPT-5 model aliases", () => {
    const preview = createProviderRequestPreview({
      profile: profile("openai", {
        defaultModel: "gpt5.2",
      }),
      apiKey: "sk-test",
      input: {
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(preview.body.model).toBe("gpt-5.2");
  });

  it("omits temperature and top_p for OpenAI GPT-5.x models", () => {
    const preview = createProviderRequestPreview({
      profile: profile("openai", {
        defaultModel: "gpt5",
        topP: 0.8,
      }),
      apiKey: "sk-test",
      input: {
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(preview.body.model).toBe("gpt-5");
    expect("temperature" in preview.body).toBe(false);
    expect("top_p" in preview.body).toBe(false);
  });

  it("omits temperature and top_p for OpenAI reasoning models", () => {
    const preview = createProviderRequestPreview({
      profile: profile("openai", {
        defaultModel: "o3-mini",
        topP: 0.8,
      }),
      apiKey: "sk-test",
      input: {
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(preview.body.model).toBe("o3-mini");
    expect("temperature" in preview.body).toBe(false);
    expect("top_p" in preview.body).toBe(false);
  });

  it("retries transient provider network failures", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output_text: "OK",
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeProvider({
      profile: profile("openai"),
      apiKey: "sk-test",
      input: {
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(result.text).toBe("OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the caller-provided timeout for provider requests", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          }, { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = invokeProvider({
      profile: profile("openai"),
      apiKey: "sk-test",
      input: {
        messages: [{ role: "user", content: "Hello" }],
      },
      timeoutMs: 40_000,
    });
    const expectation = expect(resultPromise).rejects.toThrow(
      "Provider request timed out after 40000ms",
    );

    await vi.advanceTimersByTimeAsync(40_000);

    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("builds an Anthropic payload with thinking enabled", () => {
    const preview = createProviderRequestPreview({
      profile: profile("anthropic", {
        defaultModel: "claude-sonnet-4-6",
      }),
      apiKey: "anthropic-key",
      input: {
        jsonMode: true,
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(preview.url).toContain("/messages");
    expect(preview.headers["x-api-key"]).toBe("anthropic-key");
    expect(preview.body.thinking).toEqual({ type: "adaptive" });
    expect(preview.body.output_config).toEqual({
      effort: "medium",
      format: {
        type: "json_schema",
        name: "json_output",
        schema: {
          type: "object",
          additionalProperties: true,
        },
      },
    });
  });

  it("builds an OpenAI responses payload for native tool calling", () => {
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

    expect(preview.url).toContain("/responses");
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

  it("builds an OpenAI-compatible responses payload for native tool calling", () => {
    const preview = createProviderRequestPreview({
      profile: profile("openai_compatible_responses"),
      apiKey: "compatible-responses-key",
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

  it("builds an Anthropic payload for native tool calling", () => {
    const preview = createProviderRequestPreview({
      profile: profile("anthropic", {
        defaultModel: "claude-sonnet-4-6",
        thinkingBudget: 2048,
      }),
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
    expect(preview.body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
    expect(preview.headers["anthropic-beta"]).toContain(
      "interleaved-thinking-2025-05-14",
    );
  });

  it("builds an Anthropic payload with tool_choice none, native tools, and mcp options", () => {
    const preview = createProviderRequestPreview({
      profile: profile("anthropic", {
        defaultModel: "claude-sonnet-4-6",
      }),
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
        toolChoice: "none",
        providerOptions: {
          anthropic: {
            betas: ["fine-grained-tool-streaming-2025-05-14"],
            tools: [
              {
                type: "web_search_20250305",
                name: "web_search",
                max_uses: 2,
              },
            ],
            mcpServers: [
              {
                type: "url",
                url: "https://mcp.example.com",
                name: "remote-search",
              },
            ],
            contextManagement: {
              clear_tool_uses_20250919: {
                trigger: "auto",
              },
            },
            serviceTier: "auto",
          },
        },
      },
    });

    expect(preview.headers["anthropic-beta"]).toContain(
      "fine-grained-tool-streaming-2025-05-14",
    );
    expect(preview.headers["anthropic-beta"]).toContain(
      "context-management-2025-06-27",
    );
    expect(preview.headers["anthropic-beta"]).toContain("mcp-client-2025-11-20");
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
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
      },
    ]);
    expect(preview.body.tool_choice).toEqual({ type: "none" });
    expect(preview.body.mcp_servers).toEqual([
      {
        type: "url",
        url: "https://mcp.example.com",
        name: "remote-search",
      },
    ]);
    expect(preview.body.context_management).toEqual({
      clear_tool_uses_20250919: {
        trigger: "auto",
      },
    });
    expect(preview.body.service_tier).toBe("auto");
  });

  it("maps Anthropic tool results into search_result blocks for citations", () => {
    const preview = createProviderRequestPreview({
      profile: profile("anthropic"),
      apiKey: "anthropic-key",
      input: {
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "toolu_1",
                toolId: "search_web",
                input: { query: "CoserLab" },
              },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_1",
            content: JSON.stringify({
              query: "CoserLab",
              results: [
                {
                  title: "CoserLab",
                  url: "https://coserlab.io/",
                  snippet: "CoserLab official site.",
                },
              ],
            }),
          },
        ],
      },
    });

    expect(preview.body.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            {
              type: "search_result",
              title: "CoserLab",
              source: "https://coserlab.io/",
              citations: {
                enabled: true,
              },
              content: [
                {
                  type: "text",
                  text: "CoserLab official site.",
                },
              ],
            },
          ],
        },
      ],
    });
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

  it("parses OpenAI-compatible chat tool calls", () => {
    const adapter = getProviderAdapter("openai_compatible_chat");
    const result = adapter.parseResponse({
      id: "chatcmpl-1",
      choices: [
        {
          message: {
            role: "assistant",
            content: "Using compatible chat tool calling.",
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

    expect(result.text).toContain("Using compatible chat tool calling.");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        toolId: "search_web",
        input: { query: "tokyo weather" },
      },
    ]);
  });

  it("parses OpenAI-compatible responses tool calls", () => {
    const adapter = getProviderAdapter("openai_compatible_responses");
    const result = adapter.parseResponse({
      id: "resp_1",
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
        documentModel: "claude-sonnet-4-6",
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
      title: "memo.pdf",
      source: {
        type: "base64",
        media_type: "application/pdf",
      },
    });
  });

  it("builds an Anthropic plain-text document payload", () => {
    const preview = createProviderMediaRequestPreview({
      profile: profile("anthropic", {
        documentModel: "claude-sonnet-4-6",
      }),
      apiKey: "anthropic-key",
      input: {
        kind: "document",
        prompt: "Summarize this note.",
        rawBody: new TextEncoder().encode("Alpha project notes"),
        mimeType: "text/plain; charset=utf-8",
        fileName: "notes.txt",
      },
    });

    const body = preview?.body as Record<string, any>;
    expect(preview?.url).toContain("/messages");
    expect(preview?.headers["anthropic-beta"]).toBeUndefined();
    expect(body.messages[0].content[0]).toEqual({
      type: "document",
      title: "notes.txt",
      source: {
        type: "text",
        media_type: "text/plain",
        data: "Alpha project notes",
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
    expect(audioBody.model).toBe("qwen3-asr-flash");
    expect(audioBody.messages[0].content[0]).toMatchObject({
      type: "input_audio",
      input_audio: {},
    });
    expect(audioBody.messages[0].content).toHaveLength(1);
    expect(audioBody.messages[0].content[0].input_audio.data).toContain(
      "data:audio/mpeg;base64,",
    );

    expect(imagePreview?.url).toContain("/multimodal-generation/generation");
    expect(imageBody.input.messages[0].content[0].image).toContain("data:image/png;base64,");
    expect(imageBody.parameters.incremental_output).toBe(true);

    expect(documentPreview?.url).toContain("/compatible-mode/v1/chat/completions");
    expect(documentBody.messages[0]).toMatchObject({
      role: "system",
      content: "fileid://<uploaded-file-id>",
    });
  });

  it("builds a Bailian qwen-audio-asr payload on DashScope multimodal endpoint", () => {
    const preview = createProviderMediaRequestPreview({
      profile: profile("bailian", {
        audioModel: "qwen-audio-asr",
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

    const body = preview?.body as Record<string, any>;
    expect(preview?.url).toContain("/api/v1/services/aigc/multimodal-generation/generation");
    expect(body.model).toBe("qwen-audio-asr");
    expect(body.input.messages[0].content[0].audio).toContain("data:audio/mpeg;base64,");
    expect(body.parameters.result_format).toBe("message");
  });

  it("returns null for Bailian qwen3-asr-flash-filetrans with inline audio bytes", () => {
    const preview = createProviderMediaRequestPreview({
      profile: profile("bailian", {
        audioModel: "qwen3-asr-flash-filetrans",
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
    expect(preview).toBeNull();
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
        mimeType: "text/plain",
        fileName: "notes.txt",
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
    expect(
      supportsProviderCapability(
        profile("bailian", {
          audioModel: "qwen3-asr-flash-filetrans",
        }),
        "audio",
      ),
    ).toBe(false);
    expect(
      supportsProviderCapability(
        profile("bailian", {
          audioModel: "qwen-audio-asr",
        }),
        "audio",
      ),
    ).toBe(true);
  });
});
