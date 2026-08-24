import { describe, expect, it } from "vitest";
import {
  LEGACY_PROTOCOL_VERSIONS,
  MCP_META_KEYS,
  MODERN_PROTOCOL_VERSION,
  classifyCompatibility,
  createModernMeta,
  createUnsupportedProtocolError,
  detectMcpEra,
  extractMcpProtocolVersion,
  getMcpRouting,
  isLegacyProtocolVersion,
  isModernProtocolVersion,
  negotiateProtocolVersion,
  normalizeMcpHeaders,
  withModernMeta,
} from "../src/index.js";

describe("protocol versions and detection", () => {
  it("classifies the protocol date boundary", () => {
    expect(isLegacyProtocolVersion("2025-11-25")).toBe(true);
    expect(isModernProtocolVersion(MODERN_PROTOCOL_VERSION)).toBe(true);
    expect(isModernProtocolVersion("2027-01-01")).toBe(false);
    expect(isModernProtocolVersion("v2")).toBe(false);
  });

  it("detects a modern per-request message", () => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(detectMcpEra(request)).toMatchObject({
      era: "modern",
      confidence: "high",
      protocolVersion: MODERN_PROTOCOL_VERSION,
    });
    expect(extractMcpProtocolVersion(request)).toBe(MODERN_PROTOCOL_VERSION);
  });

  it("detects modern discovery without headers", () => {
    expect(
      detectMcpEra({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
    ).toMatchObject({ era: "modern", confidence: "high" });
  });

  it("detects legacy initialize and session traffic", () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    };
    expect(detectMcpEra(initialize)).toMatchObject({
      era: "legacy",
      confidence: "high",
      protocolVersion: "2025-11-25",
    });
    expect(
      detectMcpEra(
        { jsonrpc: "2.0", method: "tools/list" },
        { "Mcp-Session-Id": "abc" },
      ),
    ).toMatchObject({ era: "legacy", confidence: "medium" });
  });

  it("refuses conflicting era and version signals", () => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    const result = detectMcpEra(request, {
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
    });
    expect(result.era).toBe("unknown");
    expect(result.issues.join(" ")).toMatch(
      /Conflicting|both modern and legacy/u,
    );
  });

  it("returns unknown for non-objects and signal-free responses", () => {
    expect(detectMcpEra(null)).toMatchObject({ era: "unknown" });
    expect(detectMcpEra({ jsonrpc: "2.0", id: 1, result: {} })).toMatchObject({
      era: "unknown",
    });
  });
});

describe("metadata and routing", () => {
  it("merges modern metadata without mutating the request", () => {
    const original = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "mcp" },
        _meta: { vendor: true },
      },
    } as const;
    const modern = withModernMeta(original, {
      clientInfo: { name: "suite", version: "2" },
      clientCapabilities: { tasks: true },
    });
    expect(modern).not.toBe(original);
    expect(modern.params._meta).toMatchObject({
      vendor: true,
      [MCP_META_KEYS.protocolVersion]: MODERN_PROTOCOL_VERSION,
      [MCP_META_KEYS.clientInfo]: { name: "suite", version: "2" },
      [MCP_META_KEYS.clientCapabilities]: { tasks: true },
    });
    expect(original.params._meta).toEqual({ vendor: true });
  });

  it("rejects invalid modern versions and missing methods", () => {
    expect(() => createModernMeta({ protocolVersion: "2025-11-25" })).toThrow(
      RangeError,
    );
    expect(() => withModernMeta({ jsonrpc: "2.0" })).toThrow(TypeError);
  });

  it("normalizes routing headers and preserves selected transport headers", () => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "weather" },
    });
    expect(
      normalizeMcpHeaders(request, {
        authorization: "Bearer token",
        accept: "application/json, text/event-stream",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "MCP-Method": "tools/call",
      "MCP-Name": "weather",
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      Authorization: "Bearer token",
      Accept: "application/json, text/event-stream",
    });
  });

  it("adds conforming transport defaults and safely encodes principals", () => {
    const unicode = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "Hello, 世界" },
    });
    const headers = normalizeMcpHeaders(unicode);
    expect(headers.Accept).toBe("application/json, text/event-stream");
    expect(headers["MCP-Name"]).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(
      getMcpRouting(unicode, { "Mcp-Name": headers["MCP-Name"] }).issues,
    ).toEqual([]);

    for (const name of [" padded ", "line1\nline2", "=?base64?literal?="]) {
      const request = withModernMeta({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name },
      });
      expect(normalizeMcpHeaders(request)["MCP-Name"]).toMatch(
        /^=\?base64\?.+\?=$/u,
      );
    }
  });

  it("uses body values as the authoritative header source", () => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "body-name" },
    });
    expect(
      normalizeMcpHeaders(request, {
        "MCP-Protocol-Version": "2025-11-25",
        "Mcp-Name": "header-name",
      }),
    ).toMatchObject({
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      "MCP-Name": "body-name",
    });
  });

  it.each([
    ["prompts/get", { name: "release-notes" }, "release-notes"],
    ["resources/read", { uri: "file:///guide.md" }, "file:///guide.md"],
    ["tasks/get", { taskId: "task-42" }, "task-42"],
    ["tasks/update", { taskId: "task-42" }, "task-42"],
    ["tasks/cancel", { taskId: "task-42" }, "task-42"],
  ])("maps %s principal routing", (method, params, expected) => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    expect(normalizeMcpHeaders(request)["MCP-Name"]).toBe(expected);
  });

  it("reports routing mismatches", () => {
    const routing = getMcpRouting(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "one" },
      },
      { "Mcp-Method": "tools/list", "Mcp-Name": "two" },
    );
    expect(routing.issues).toHaveLength(2);
  });

  it("supports Fetch Headers and iterable headers and rejects bad sentinels", () => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "snowman ☃" },
    });
    const encoded = normalizeMcpHeaders(request)["MCP-Name"] ?? "";
    expect(
      getMcpRouting(request, new Headers({ "Mcp-Name": encoded })).issues,
    ).toEqual([]);
    expect(getMcpRouting(request, [["Mcp-Name", encoded]]).issues).toEqual([]);
    expect(
      getMcpRouting(request, { "Mcp-Name": "=?base64?not-valid!?=" }).issues,
    ).toContain("Mcp-Name header contains invalid Base64 sentinel encoding.");
    expect(
      getMcpRouting(request, { "Mcp-Name": "=?base64?/w==?=" }).issues,
    ).toContain("Mcp-Name header contains invalid Base64 sentinel encoding.");
  });
});

describe("negotiation and compatibility", () => {
  it("selects local preference order and returns null without overlap", () => {
    expect(
      negotiateProtocolVersion(["2025-11-25", MODERN_PROTOCOL_VERSION]),
    ).toBe(MODERN_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(["2023-01-01"])).toBeNull();
    expect(
      negotiateProtocolVersion(
        [MODERN_PROTOCOL_VERSION, "2025-11-25"],
        ["2025-11-25", MODERN_PROTOCOL_VERSION],
      ),
    ).toBe("2025-11-25");
  });

  it("constructs the standard unsupported-version error", () => {
    expect(
      createUnsupportedProtocolError(7, "2028-01-01", [
        MODERN_PROTOCOL_VERSION,
      ]),
    ).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32022,
        message: "Unsupported protocol version: 2028-01-01",
        data: {
          requested: "2028-01-01",
          supported: [MODERN_PROTOCOL_VERSION],
        },
      },
    });
  });

  it("classifies the dual-era matrix honestly", () => {
    expect(classifyCompatibility("legacy", "modern").status).toBe(
      "incompatible",
    );
    expect(classifyCompatibility("modern", "dual").status).toBe("compatible");
    expect(classifyCompatibility("dual", "legacy").status).toBe("downgrade");
    expect(classifyCompatibility("legacy", "legacy").status).toBe("compatible");
    expect(classifyCompatibility("unknown", "dual").status).toBe("unknown");
    expect(LEGACY_PROTOCOL_VERSIONS).toContain("2025-11-25");
  });
});
