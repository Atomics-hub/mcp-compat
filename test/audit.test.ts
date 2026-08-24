import { describe, expect, it } from "vitest";
import {
  MCP_META_KEYS,
  MODERN_PROTOCOL_VERSION,
  auditMcpMessage,
  auditMcpTranscript,
  withModernMeta,
} from "../src/index.js";

describe("message audit", () => {
  it("accepts a complete modern request", () => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });
    const report = auditMcpMessage(request, {
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      "MCP-Method": "tools/call",
      "MCP-Name": "search",
      Accept: "application/json, text/event-stream",
    });
    expect(report.valid).toBe(true);
    expect(report.counts.error).toBe(0);
  });

  it("finds modern metadata, routing, session, and removed-method defects", () => {
    const report = auditMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "logging/setLevel",
        params: {
          _meta: {
            [MCP_META_KEYS.protocolVersion]: MODERN_PROTOCOL_VERSION,
          },
        },
      },
      {
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "MCP-Method": "tools/list",
        "Mcp-Session-Id": "forbidden",
      },
    );
    expect(report.valid).toBe(false);
    expect(report.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MCP011", "MCP020", "MCP022", "MCP023"]),
    );
  });

  it("requires JSON-RPC structure", () => {
    expect(auditMcpMessage(null).findings[0]?.code).toBe("MCP001");
    const report = auditMcpMessage({ hello: "world" });
    expect(report.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MCP002", "MCP003"]),
    );
    expect(
      auditMcpMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: -1, message: "both" },
      }).findings.map((item) => item.code),
    ).toContain("MCP008");
    expect(
      auditMcpMessage({
        jsonrpc: "2.0",
        id: null,
        method: "tools/list",
        params: [],
        result: {},
      }).findings.map((item) => item.code),
    ).toEqual(expect.arrayContaining(["MCP004", "MCP005", "MCP006"]));
    expect(
      auditMcpMessage({
        jsonrpc: "2.0",
        error: { code: 1.5, message: 7 },
      }).findings.map((item) => item.code),
    ).toEqual(expect.arrayContaining(["MCP007", "MCP009"]));
  });

  it("checks legacy initialize fields", () => {
    const report = auditMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(report.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MCP031", "MCP036"]),
    );
  });

  it("warns on signal-free messages and rejects missing modern routing headers", () => {
    expect(
      auditMcpMessage({ jsonrpc: "2.0", id: 1, result: {} }).findings.map(
        (item) => item.code,
      ),
    ).toContain("MCP040");
    const modern = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(
      auditMcpMessage(modern, {
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      }).findings.map((item) => item.code),
    ).toContain("MCP025");
  });

  it("rejects non-object modern results", () => {
    expect(
      auditMcpMessage(
        { jsonrpc: "2.0", id: 1, result: null },
        { "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION },
      ).findings.map((item) => item.code),
    ).toContain("MCP029");
  });

  it("requires complete modern metadata, subject routing, and result types", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: {
        name: "launch",
        _meta: {
          [MCP_META_KEYS.protocolVersion]: MODERN_PROTOCOL_VERSION,
          [MCP_META_KEYS.clientInfo]: { name: "test", version: "1" },
        },
      },
    };
    expect(
      auditMcpMessage(request, {
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "MCP-Method": "prompts/get",
      }).findings.map((item) => item.code),
    ).toEqual(expect.arrayContaining(["MCP027", "MCP028"]));

    expect(
      auditMcpMessage(
        { jsonrpc: "2.0", id: 1, result: {} },
        { "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION },
      ).findings.map((item) => item.code),
    ).toContain("MCP029");
  });

  it("enforces modern HTTP version, accept, and principal headers", () => {
    const list = withModernMeta({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(
      auditMcpMessage(list, { "Mcp-Method": "tools/list" }).findings.map(
        (item) => item.code,
      ),
    ).toEqual(expect.arrayContaining(["MCP033", "MCP034"]));

    const prompt = withModernMeta({
      jsonrpc: "2.0",
      id: 2,
      method: "prompts/get",
      params: {},
    });
    expect(
      auditMcpMessage(prompt, {
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "prompts/get",
        Accept: "application/json, text/event-stream",
      }).findings.map((item) => item.code),
    ).toContain("MCP035");
  });

  it("treats client identity as recommended rather than required", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          [MCP_META_KEYS.protocolVersion]: MODERN_PROTOCOL_VERSION,
          [MCP_META_KEYS.clientCapabilities]: {},
        },
      },
    };
    const report = auditMcpMessage(request, {
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
      "Mcp-Method": "tools/list",
      Accept: "application/json, text/event-stream",
    });
    expect(report.valid).toBe(true);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "MCP022", severity: "warning" }),
    );
  });

  it("checks legacy version fields and HTTP accept semantics", () => {
    const report = auditMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { capabilities: {}, clientInfo: {} },
      },
      {
        Accept: "application/json;q=0, text/event-stream",
      },
    );
    expect(report.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MCP030", "MCP034"]),
    );
  });
});

describe("transcript audit", () => {
  it("aggregates findings without losing entry detail", () => {
    const report = auditMcpTranscript([
      {
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        },
      },
      { message: null },
    ]);
    expect(report.valid).toBe(false);
    expect(report.entries).toHaveLength(2);
    expect(report.counts.error).toBeGreaterThan(0);
  });

  it("uses request context to audit modern responses", () => {
    const request = withModernMeta({
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
    });
    const report = auditMcpTranscript([
      { message: request },
      { message: { jsonrpc: "2.0", id: "list-1", result: { tools: [] } } },
    ]);
    expect(report.valid).toBe(false);
    expect(report.entries[1]?.findings.map((item) => item.code)).toContain(
      "MCP029",
    );
  });
});
