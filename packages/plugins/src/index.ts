import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { load } from "cheerio";
import { nowIso } from "@pulsarbot/core";
import type { SearchSettings, ToolDescriptor } from "@pulsarbot/shared";

export interface ToolExecutionContext {
  workspaceId: string;
  timezone: string;
  searchSettings?: SearchSettings | null;
}

export interface BuiltinToolDefinition {
  pluginId: string;
  descriptor: ToolDescriptor;
  execute: (
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
}

function compactWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function preferredResultCount(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
  fallback = 5,
): number {
  const requested = Number(input.maxResults ?? input.limit ?? context.searchSettings?.maxResults ?? fallback);
  if (!Number.isFinite(requested) || requested <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(requested), 1), 10);
}

const builtInTools: BuiltinToolDefinition[] = [
  {
    pluginId: "time-context",
    descriptor: {
      id: "get_current_time",
      title: "Get Current Time",
      description: "Return the current ISO timestamp and UTC offset context.",
      inputSchema: {},
      permissionScopes: [],
      source: "builtin",
    },
    async execute(_input, context) {
      return {
        nowIso: nowIso(),
        timezone: context.timezone,
      };
    },
  },
  {
    pluginId: "native-google-search",
    descriptor: {
      id: "google_search",
      title: "Google Search",
      description: "Search Google results pages without an API key.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      permissionScopes: ["network:search"],
      source: "plugin",
    },
    async execute(input, context) {
      const query = String(input.query ?? "");
      const maxResults = preferredResultCount(input, context);
      const response = await fetch(
        `https://www.google.com/search?hl=en&q=${encodeURIComponent(query)}`,
        {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
        },
      );
      const html = await response.text();
      const $ = load(html);
      const results = $("a[href^='/url?q=']")
        .slice(0, maxResults)
        .toArray()
        .map((element) => {
          const href = $(element).attr("href") ?? "";
          const title = compactWhitespace($(element).text());
          const url = href.replace("/url?q=", "").split("&sa=")[0];
          return {
            title,
            url,
          };
        })
        .filter((result) => result.title && result.url);
      return { query, provider: "google_native", results };
    },
  },
  {
    pluginId: "native-bing-search",
    descriptor: {
      id: "bing_search",
      title: "Bing Search",
      description: "Search Bing results pages without an API key.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      permissionScopes: ["network:search"],
      source: "plugin",
    },
    async execute(input, context) {
      const query = String(input.query ?? "");
      const maxResults = preferredResultCount(input, context);
      const response = await fetch(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
        {
          headers: {
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
        },
      );
      const html = await response.text();
      const $ = load(html);
      const results = $("li.b_algo")
        .slice(0, maxResults)
        .toArray()
        .map((element) => ({
          title: compactWhitespace($(element).find("h2").text()),
          url: $(element).find("h2 a").attr("href") ?? "",
          snippet: compactWhitespace($(element).find("p").text()),
        }))
        .filter((result) => result.title && result.url);
      return { query, provider: "bing_native", results };
    },
  },
  {
    pluginId: "web-browse-fetcher",
    descriptor: {
      id: "web_browse",
      title: "Web Browse",
      description: "Fetch a web page and return readable content.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
      permissionScopes: ["network:browse"],
      source: "plugin",
    },
    async execute(input) {
      const url = String(input.url ?? "");
      const response = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      });
      const html = await response.text();
      const dom = new JSDOM(html, { url });
      const readable = new Readability(dom.window.document).parse();
      const text =
        readable?.textContent ??
        compactWhitespace(load(html).text()).slice(0, 10_000);
      return {
        url,
        title: readable?.title ?? dom.window.document.title,
        content: compactWhitespace(text).slice(0, 10_000),
      };
    },
  },
  {
    pluginId: "document-processor",
    descriptor: {
      id: "document_extract_text",
      title: "Document Extract Text",
      description: "Normalize pasted document text into compact chunks.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      permissionScopes: ["document:read"],
      source: "plugin",
    },
    async execute(input) {
      const text = compactWhitespace(String(input.text ?? ""));
      return {
        text,
        paragraphs: text.split(/(?<=[.!?])\s+/).slice(0, 20),
      };
    },
  },
];

export class BuiltinPluginRegistry {
  private readonly tools = new Map<string, BuiltinToolDefinition>(
    builtInTools.map((tool) => [tool.descriptor.id, tool]),
  );

  public listTools(enabledPluginIds: string[]): ToolDescriptor[] {
    const enabled = new Set(enabledPluginIds);
    return [...this.tools.values()]
      .filter(
        (tool) =>
          tool.descriptor.source === "builtin" || enabled.has(tool.pluginId),
      )
      .map((tool) => tool.descriptor);
  }

  public async executeTool(
    toolId: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolId}`);
    }
    return tool.execute(input, context);
  }
}

export function createBuiltinPluginRegistry(): BuiltinPluginRegistry {
  return new BuiltinPluginRegistry();
}
