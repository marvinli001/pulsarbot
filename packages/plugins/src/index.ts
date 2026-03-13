import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

const WEB_BROWSE_TIMEOUT_MS = 10_000;
const WEB_BROWSE_MAX_BYTES = 2 * 1024 * 1024;
const WEB_BROWSE_MAX_REDIRECTS = 5;

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] ?? 0) << 24 >>> 0) +
    ((parts[1] ?? 0) << 16) +
    ((parts[2] ?? 0) << 8) +
    (parts[3] ?? 0);
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  if (value === null) {
    return false;
  }

  const inRange = (start: string, end: string) => {
    const startValue = ipv4ToNumber(start);
    const endValue = ipv4ToNumber(end);
    return startValue !== null &&
      endValue !== null &&
      value >= startValue &&
      value <= endValue;
  };

  return inRange("0.0.0.0", "0.255.255.255") ||
    inRange("10.0.0.0", "10.255.255.255") ||
    inRange("100.64.0.0", "100.127.255.255") ||
    inRange("127.0.0.0", "127.255.255.255") ||
    inRange("169.254.0.0", "169.254.255.255") ||
    inRange("172.16.0.0", "172.31.255.255") ||
    inRange("192.0.0.0", "192.0.0.255") ||
    inRange("192.0.2.0", "192.0.2.255") ||
    inRange("192.168.0.0", "192.168.255.255") ||
    inRange("198.18.0.0", "198.19.255.255") ||
    inRange("198.51.100.0", "198.51.100.255") ||
    inRange("203.0.113.0", "203.0.113.255") ||
    inRange("224.0.0.0", "255.255.255.255");
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().split("%")[0] ?? ip.toLowerCase();
  return normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb");
}

function isBlockedResolvedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isBlockedIpv4(address);
  }
  if (family === 6) {
    return isBlockedIpv6(address);
  }
  return false;
}

async function ensureSafeBrowseUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Browse URL is invalid");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new Error("Browse URL hostname is missing");
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Localhost and local network hostnames are not allowed");
  }
  if (isIP(hostname)) {
    throw new Error("IP literal URLs are not allowed");
  }

  try {
    const records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("DNS lookup timed out")), 2_000);
      }),
    ]);
    if (records.some((record) => isBlockedResolvedAddress(record.address))) {
      throw new Error("Resolved address points to a private or reserved network");
    }
  } catch (error) {
    if (error instanceof Error && (
      error.message === "DNS lookup timed out" ||
      error.message.includes("private or reserved network")
    )) {
      throw error;
    }
  }

  return parsed;
}

async function fetchSearchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Search request failed: HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchBrowseResponse(initialUrl: URL): Promise<{
  response: Response;
  finalUrl: URL;
}> {
  const signal = AbortSignal.timeout(WEB_BROWSE_TIMEOUT_MS);
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= WEB_BROWSE_MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      redirect: "manual",
      signal,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === WEB_BROWSE_MAX_REDIRECTS) {
        throw new Error("Browse request exceeded redirect limit");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Browse redirect location is missing");
      }
      currentUrl = await ensureSafeBrowseUrl(new URL(location, currentUrl).toString());
      continue;
    }

    return {
      response,
      finalUrl: await ensureSafeBrowseUrl(response.url || currentUrl.toString()),
    };
  }

  throw new Error("Browse request exceeded redirect limit");
}

function parseGoogleResults(html: string, maxResults: number): SearchResult[] {
  const $ = load(html);
  return $("a[href^='/url?q=']")
    .slice(0, maxResults)
    .toArray()
    .map((element) => {
      const href = $(element).attr("href") ?? "";
      const title = compactWhitespace($(element).text());
      const url = href.replace("/url?q=", "").split("&sa=")[0] ?? "";
      return {
        title,
        url,
      };
    })
    .filter((result) => result.title && result.url);
}

function parseBingResults(html: string, maxResults: number): SearchResult[] {
  const $ = load(html);
  return $("li.b_algo")
    .slice(0, maxResults)
    .toArray()
    .map((element) => ({
      title: compactWhitespace($(element).find("h2").text()),
      url: $(element).find("h2 a").attr("href") ?? "",
      snippet: compactWhitespace($(element).find("p").text()),
    }))
    .filter((result) => result.title && result.url);
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const absolute = new URL(rawUrl, "https://html.duckduckgo.com");
    const redirected = absolute.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : absolute.toString();
  } catch {
    return rawUrl;
  }
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const $ = load(html);
  return $("a.result__a")
    .slice(0, maxResults)
    .toArray()
    .map((element) => {
      const title = compactWhitespace($(element).text());
      const url = decodeDuckDuckGoUrl($(element).attr("href") ?? "");
      const snippet = compactWhitespace(
        $(element).closest(".result").find(".result__snippet").text(),
      );
      return {
        title,
        url,
        snippet,
      };
    })
    .filter((result) => result.title && result.url);
}

async function fallbackDuckDuckGoSearch(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const html = await fetchSearchHtml(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  );
  return parseDuckDuckGoResults(html, maxResults);
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
      const html = await fetchSearchHtml(
        `https://www.google.com/search?hl=en&q=${encodeURIComponent(query)}`,
      );
      const results = parseGoogleResults(html, maxResults);
      if (results.length > 0) {
        return { query, provider: "google_native", results };
      }

      const fallbackResults = await fallbackDuckDuckGoSearch(query, maxResults);
      return {
        query,
        provider: "google_native",
        upstream: "duckduckgo_html",
        results: fallbackResults,
      };
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
      const html = await fetchSearchHtml(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
      );
      const results = parseBingResults(html, maxResults);
      if (results.length > 0) {
        return { query, provider: "bing_native", results };
      }

      const fallbackResults = await fallbackDuckDuckGoSearch(query, maxResults);
      return {
        query,
        provider: "bing_native",
        upstream: "duckduckgo_html",
        results: fallbackResults,
      };
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
      const safeUrl = await ensureSafeBrowseUrl(String(input.url ?? ""));
      const { response, finalUrl } = await fetchBrowseResponse(safeUrl);
      if (!response.ok) {
        throw new Error(`Browse request failed: HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > WEB_BROWSE_MAX_BYTES) {
        throw new Error("Browse response is too large");
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > WEB_BROWSE_MAX_BYTES) {
        throw new Error("Browse response is too large");
      }
      const html = Buffer.from(buffer).toString("utf8");
      const dom = new JSDOM(html, { url: finalUrl.toString() });
      const readable = new Readability(dom.window.document).parse();
      const text =
        readable?.textContent ??
        compactWhitespace(load(html).text()).slice(0, 10_000);
      return {
        url: finalUrl.toString(),
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
