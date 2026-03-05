import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareApiClient } from "../packages/cloudflare/src/index.js";

function createClient() {
  return new CloudflareApiClient({
    accountId: "account-test",
    apiToken: "token-test",
    vectorizeDimensions: 256,
  });
}

function okResponse(result: unknown) {
  return new Response(JSON.stringify({
    success: true,
    result,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cloudflare Vectorize request shaping", () => {
  it("normalizes query payload fields before sending", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ matches: [] }) as unknown as Response,
    );

    const client = createClient();
    await client.queryVectors({
      indexName: "memory-main",
      vector: [1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      topK: 0,
    });

    const call = fetchSpy.mock.calls[0];
    expect(call).toBeTruthy();
    const init = call?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));

    expect(body.vector).toEqual([1, 0, 0, 0]);
    expect(body.topK).toBe(1);
    expect(body.returnMetadata).toBe("all");
    expect(body.filter).toBeUndefined();
  });

  it("maps boolean returnMetadata to vectorize enum", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ matches: [] }) as unknown as Response,
    );

    const client = createClient();
    await client.queryVectors({
      indexName: "memory-main",
      vector: [0.1, 0.2],
      topK: 2,
      returnMetadata: false,
    });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.returnMetadata).toBe("none");
  });
});
