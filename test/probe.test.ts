import { describe, expect, it, vi } from "vitest";
import { MODERN_PROTOCOL_VERSION, probeMcpEndpoint } from "../src/index.js";

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function asFetch(
  implementation: (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return implementation;
}

function parseRequestBody(init: RequestInit | undefined): {
  id: string;
  method: string;
} {
  if (typeof init?.body !== "string")
    throw new TypeError("Expected JSON body.");
  return JSON.parse(init.body) as { id: string; method: string };
}

describe("endpoint probe", () => {
  it("classifies and cleans up a dual-era endpoint", async () => {
    const fetcher = vi.fn(
      asFetch((_input, init) => {
        if (init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const body = parseRequestBody(init);
        if (body.method === "server/discover") {
          expect(new Headers(init?.headers).get("accept")).toContain(
            "text/event-stream",
          );
          return Promise.resolve(
            json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                resultType: "complete",
                supportedVersions: [MODERN_PROTOCOL_VERSION],
                capabilities: {},
              },
            }),
          );
        }
        return Promise.resolve(
          json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "test", version: "1" },
              },
            },
            200,
            { "mcp-session-id": "session" },
          ),
        );
      }),
    );
    const report = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: fetcher,
    });
    expect(report.support).toBe("dual");
    expect(report.compatible).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("classifies modern-only and legacy-only endpoints", async () => {
    const modernOnly = asFetch((_input, init) => {
      const body = parseRequestBody(init);
      return Promise.resolve(
        body.method === "server/discover"
          ? json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                resultType: "complete",
                supportedVersions: [MODERN_PROTOCOL_VERSION],
                capabilities: {},
              },
            })
          : json(
              {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32022, message: "unsupported" },
              },
              400,
            ),
      );
    });
    expect(
      (await probeMcpEndpoint("https://example.com/mcp", { fetch: modernOnly }))
        .support,
    ).toBe("modern");

    const legacyOnly = asFetch((_input, init) => {
      const body = parseRequestBody(init);
      return Promise.resolve(
        body.method === "server/discover"
          ? json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: "method not found" },
            })
          : json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "test", version: "1" },
              },
            }),
      );
    });
    expect(
      (await probeMcpEndpoint("https://example.com/mcp", { fetch: legacyOnly }))
        .support,
    ).toBe("legacy");
  });

  it("handles invalid JSON, oversized bodies, timeouts, and external aborts", async () => {
    const invalid = asFetch(() =>
      Promise.resolve(
        new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const invalidReport = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: invalid,
    });
    expect(invalidReport.support).toBe("unknown");
    expect(invalidReport.modern.error).toMatch(/JSON|Unexpected/u);

    const oversized = asFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ x: "xx" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const oversizedReport = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: oversized,
      maxResponseBytes: 1,
    });
    expect(oversizedReport.modern.error).toMatch(/exceeded/u);

    const hanging = asFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const timedOut = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: hanging,
      timeoutMs: 1,
    });
    expect(timedOut.modern.error).toMatch(/timed out/u);

    const controller = new AbortController();
    controller.abort("caller");
    const aborted = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: hanging,
      signal: controller.signal,
    });
    expect(aborted.modern.error).toMatch(/aborted/u);
  });

  it("rejects unsafe URLs and invalid limits", async () => {
    await expect(probeMcpEndpoint("file:///tmp/socket")).rejects.toThrow(
      /http/u,
    );
    await expect(
      probeMcpEndpoint("https://user:secret@example.com/mcp"),
    ).rejects.toThrow(/credentials/u);
    await expect(
      probeMcpEndpoint("https://example.com/mcp", { timeoutMs: 0 }),
    ).rejects.toThrow(/timeoutMs/u);
  });

  it("stays isolated across concurrent probes", async () => {
    const fetcher = asFetch((_input, init) => {
      const body = parseRequestBody(init);
      return Promise.resolve(
        body.method === "server/discover"
          ? json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                resultType: "complete",
                supportedVersions: [MODERN_PROTOCOL_VERSION],
                capabilities: {},
              },
            })
          : json(
              {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32601, message: "method not found" },
              },
              400,
            ),
      );
    });
    const reports = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        probeMcpEndpoint(`https://example.com/mcp/${String(index)}`, {
          fetch: fetcher,
        }),
      ),
    );
    expect(reports.every((report) => report.support === "modern")).toBe(true);
  });

  it("rejects generic JSON and recognizes modern protocol errors", async () => {
    const generic = asFetch(() => Promise.resolve(json({ hello: "world" })));
    expect(
      (await probeMcpEndpoint("https://example.com/mcp", { fetch: generic }))
        .support,
    ).toBe("unknown");

    const modernError = asFetch((_input, init) => {
      const body = parseRequestBody(init);
      return Promise.resolve(
        json(
          {
            jsonrpc: "2.0",
            id: body.id,
            error:
              body.method === "server/discover"
                ? {
                    code: -32022,
                    message: "unsupported",
                    data: { supported: ["2027-01-01"] },
                  }
                : { code: -32601, message: "method not found" },
          },
          400,
        ),
      );
    });
    expect(
      (
        await probeMcpEndpoint("https://example.com/mcp", {
          fetch: modernError,
        })
      ).support,
    ).toBe("modern");
  });

  it("rejects wrong content types, empty bodies, and unmatched SSE", async () => {
    const wrongType = asFetch(() =>
      Promise.resolve(
        new Response("{}", { headers: { "content-type": "text/plain" } }),
      ),
    );
    const wrong = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: wrongType,
    });
    expect(wrong.modern.error).toMatch(/Content-Type/u);

    const empty = asFetch(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    expect(
      (await probeMcpEndpoint("https://example.com/mcp", { fetch: empty }))
        .support,
    ).toBe("unknown");

    const unmatchedSse = asFetch(() =>
      Promise.resolve(
        new Response(
          'data: not-json\n\ndata: {"jsonrpc":"2.0","id":"wrong","result":{}}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    );
    const unmatched = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: unmatchedSse,
    });
    expect(unmatched.modern.error).toMatch(/matching response/u);
  });

  it("reports ordinary fetch failures and validates upper bounds", async () => {
    const failing = asFetch(() => Promise.reject(new Error("network down")));
    const report = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: failing,
    });
    expect(report.modern.error).toBe("network down");
    await expect(
      probeMcpEndpoint("https://example.com/mcp", {
        maxResponseBytes: 67_108_865,
      }),
    ).rejects.toThrow(/maxResponseBytes/u);
  });

  it("accepts a matching JSON-RPC response delivered over SSE", async () => {
    const fetcher = asFetch((_input, init) => {
      const body = parseRequestBody(init);
      if (body.method !== "server/discover") {
        return Promise.resolve(
          json(
            {
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: "method not found" },
            },
            400,
          ),
        );
      }
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: {},
        },
      });
      return Promise.resolve(
        new Response(`event: message\ndata: ${payload}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
      );
    });
    expect(
      (await probeMcpEndpoint("https://example.com/mcp", { fetch: fetcher }))
        .support,
    ).toBe("modern");
  });

  it("stops oversized streams early and bounds ignored cleanup", async () => {
    let bytesPulled = 0;
    const oversized = asFetch(() => {
      let chunks = 0;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (chunks >= 100) {
                controller.close();
                return;
              }
              chunks += 1;
              const value = new Uint8Array(1_024);
              bytesPulled += value.byteLength;
              controller.enqueue(value);
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    });
    await probeMcpEndpoint("https://example.com/mcp", {
      fetch: oversized,
      maxResponseBytes: 1,
    });
    expect(bytesPulled).toBeLessThan(10_000);

    const hangingCleanup = asFetch((_input, init) => {
      if (init?.method === "DELETE") return new Promise<Response>(() => {});
      const body = parseRequestBody(init);
      return Promise.resolve(
        body.method === "server/discover"
          ? json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                resultType: "complete",
                supportedVersions: [MODERN_PROTOCOL_VERSION],
                capabilities: {},
              },
            })
          : json(
              {
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  serverInfo: { name: "test", version: "1" },
                },
              },
              200,
              { "mcp-session-id": "session" },
            ),
      );
    });
    const started = performance.now();
    const report = await probeMcpEndpoint("https://example.com/mcp", {
      fetch: hangingCleanup,
      timeoutMs: 5,
    });
    expect(report.support).toBe("dual");
    expect(performance.now() - started).toBeLessThan(250);
  });
});
