import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MCP_META_KEYS,
  MODERN_PROTOCOL_VERSION,
  auditMcpMessage,
  createUnsupportedProtocolError,
  detectMcpEra,
  negotiateProtocolVersion,
  normalizeMcpHeaders,
} from "../src/index.js";

describe("property and hostile-input checks", () => {
  it("never throws while auditing arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => auditMcpMessage(value)).not.toThrow();
      }),
      { numRuns: 2_000 },
    );
  });

  it("never throws with arbitrary string header records", () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.dictionary(
          fc.string(),
          fc.oneof(fc.string(), fc.array(fc.string())),
        ),
        (value, headers) => {
          expect(() => auditMcpMessage(value, headers)).not.toThrow();
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("always detects complete modern requests", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter(
            (method) =>
              method !== "initialize" && method !== "notifications/initialized",
          ),
        fc.string(),
        (method, vendorValue) => {
          const request = {
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              _meta: {
                vendor: vendorValue,
                [MCP_META_KEYS.protocolVersion]: MODERN_PROTOCOL_VERSION,
                [MCP_META_KEYS.clientInfo]: { name: "property", version: "1" },
                [MCP_META_KEYS.clientCapabilities]: {},
              },
            },
          };
          expect(detectMcpEra(request).era).toBe("modern");
          expect(normalizeMcpHeaders(request)["MCP-Method"]).toBe(method);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("negotiation always follows local preference", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc
            .integer({ min: 2020, max: 2035 })
            .map((year) => `${String(year)}-01-01`),
        ),
        fc.uniqueArray(
          fc
            .integer({ min: 2020, max: 2035 })
            .map((year) => `${String(year)}-01-01`),
        ),
        (peer, local) => {
          const expected =
            local.find((version) => peer.includes(version)) ?? null;
          expect(negotiateProtocolVersion(peer, local)).toBe(expected);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("unsupported-version responses preserve arbitrary safe IDs", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        (id, requested) => {
          const response = createUnsupportedProtocolError(id, requested);
          expect(response.jsonrpc).toBe("2.0");
          expect(response.id).toBe(id);
          expect(response.error).toBeTypeOf("object");
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
