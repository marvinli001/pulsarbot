import { describe, expect, it } from "vitest";
import {
  bailianServerCodeFromUrl,
  resolveBailianMcpEndpointUrl,
  resolveSecretTemplateString,
} from "../apps/server/src/app.js";

describe("Bailian MCP sync helpers", () => {
  it("resolves exact and templated secret references", async () => {
    const resolveSecret = async (scope: string) =>
      scope === "provider:bailian:apiKey" ? "sk-bailian" : null;

    await expect(
      resolveSecretTemplateString("provider:bailian:apiKey", resolveSecret),
    ).resolves.toBe("sk-bailian");

    await expect(
      resolveSecretTemplateString(
        "Bearer {{secret:provider:bailian:apiKey}}",
        resolveSecret,
      ),
    ).resolves.toBe("Bearer sk-bailian");
  });

  it("extracts Bailian server codes from both /mcp and /sse endpoints", () => {
    expect(
      bailianServerCodeFromUrl(
        "https://dashscope.aliyuncs.com/api/v1/mcps/weather/mcp",
      ),
    ).toBe("weather");
    expect(
      bailianServerCodeFromUrl(
        "https://dashscope.aliyuncs.com/api/v1/mcps/travel-assistant/sse",
      ),
    ).toBe("travel-assistant");
  });

  it("prefers nested mcp endpoints and falls back to /mcp", () => {
    expect(
      resolveBailianMcpEndpointUrl(
        {
          urls: {
            mcp: "/api/v1/mcps/weather/mcp",
          },
        },
        "https://dashscope.aliyuncs.com",
        "weather",
      ),
    ).toBe("https://dashscope.aliyuncs.com/api/v1/mcps/weather/mcp");

    expect(
      resolveBailianMcpEndpointUrl(
        {},
        "https://dashscope.aliyuncs.com",
        "travel-assistant",
      ),
    ).toBe("https://dashscope.aliyuncs.com/api/v1/mcps/travel-assistant/mcp");
  });
});
