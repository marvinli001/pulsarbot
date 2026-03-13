import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinPluginRegistry } from "../packages/plugins/src/index.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("builtin search plugins", () => {
  it("falls back to DuckDuckGo HTML when Google returns a JS interstitial", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://www.google.com/search?")) {
        return new Response(
          `
            <html>
              <head><title>Google Search</title></head>
              <body>
                Please click <a href="/httpservice/retry/enablejs">here</a>.
              </body>
            </html>
          `,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=UTF-8" },
          },
        );
      }

      if (url.startsWith("https://html.duckduckgo.com/html/?q=")) {
        return new Response(
          `
            <html>
              <body>
                <div class="result">
                  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcoserlab.io%2F">
                    CoserLab
                  </a>
                  <a class="result__snippet">CoserLab official site.</a>
                </div>
              </body>
            </html>
          `,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=UTF-8" },
          },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const registry = createBuiltinPluginRegistry();
    const result = await registry.executeTool(
      "google_search",
      { query: "coserlab.io" },
      {
        workspaceId: "main",
        timezone: "UTC",
        searchSettings: null,
      },
    ) as {
      provider: string;
      upstream?: string;
      results: Array<{ title: string; url: string; snippet?: string }>;
    };

    expect(result.provider).toBe("google_native");
    expect(result.upstream).toBe("duckduckgo_html");
    expect(result.results).toEqual([
      expect.objectContaining({
        title: "CoserLab",
        url: "https://coserlab.io/",
        snippet: "CoserLab official site.",
      }),
    ]);
  });

  it("rejects non-2xx browse responses instead of treating them as readable content", async () => {
    global.fetch = vi.fn(async () =>
      new Response("<html><title>404</title><body>missing</body></html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=UTF-8" },
      })
    ) as typeof fetch;

    const registry = createBuiltinPluginRegistry();

    await expect(
      registry.executeTool(
        "web_browse",
        { url: "https://example.com/missing" },
        {
          workspaceId: "main",
          timezone: "UTC",
          searchSettings: null,
        },
      ),
    ).rejects.toThrow("Browse request failed: HTTP 404");
  });

  it("rejects localhost browse targets before making a request", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("fetch should not be called");
    }) as typeof fetch;

    const registry = createBuiltinPluginRegistry();

    await expect(
      registry.executeTool(
        "web_browse",
        { url: "http://localhost:3000/internal" },
        {
          workspaceId: "main",
          timezone: "UTC",
          searchSettings: null,
        },
      ),
    ).rejects.toThrow("Localhost and local network hostnames are not allowed");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects redirect hops to private browse targets before following them", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://example.com/redirect") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "http://127.0.0.1/internal",
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const registry = createBuiltinPluginRegistry();

    await expect(
      registry.executeTool(
        "web_browse",
        { url: "https://example.com/redirect" },
        {
          workspaceId: "main",
          timezone: "UTC",
          searchSettings: null,
        },
      ),
    ).rejects.toThrow("IP literal URLs are not allowed");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
