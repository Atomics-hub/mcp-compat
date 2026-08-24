# mcp-compat

[![npm version](https://img.shields.io/npm/v/mcp-compat)](https://www.npmjs.com/package/mcp-compat)
[![CI](https://github.com/Atomics-hub/mcp-compat/actions/workflows/ci.yml/badge.svg)](https://github.com/Atomics-hub/mcp-compat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/mcp-compat)](LICENSE)

Dual-era compatibility primitives and diagnostics for the Model Context Protocol.

`mcp-compat` helps libraries, gateways, clients, and servers handle the boundary between handshake-era MCP (`2025-11-25` and earlier) and stateless MCP (`2026-07-28`). The core has **zero runtime dependencies** and does not import either generation of the official SDK.

```bash
npm install mcp-compat
```

```ts
import {
  detectMcpEra,
  negotiateProtocolVersion,
  withModernMeta,
} from "mcp-compat";

const request = withModernMeta({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
});

detectMcpEra(request).era; // "modern"
negotiateProtocolVersion(["2026-07-28", "2025-11-25"]); // "2026-07-28"
```

It also ships a safe, CI-friendly CLI:

```bash
npx mcp-compat probe https://example.com/mcp
npx mcp-compat audit transcript.json --strict
```

## Why this exists

MCP now has two lifecycle eras with materially different wire behavior.

| Concern                   | Legacy through `2025-11-25` | Modern `2026-07-28`         |
| ------------------------- | --------------------------- | --------------------------- |
| Opening                   | `initialize` handshake      | No required handshake       |
| Version                   | Negotiated once             | Declared on every request   |
| Identity and capabilities | Connection-scoped           | Per-request `_meta`         |
| Discovery                 | Initialize result           | `server/discover`           |
| Sessions                  | `Mcp-Session-Id`            | Removed                     |
| HTTP routing              | Body inspection             | `Mcp-Method` and `Mcp-Name` |
| Change stream             | Session GET / subscriptions | `subscriptions/listen`      |

A dual-era implementation can serve both. A modern-only side and a legacy-only side cannot communicate directly. Some features cannot be translated without application knowledge, so this package reports those boundaries instead of silently changing semantics.

Protocol references:

- [MCP `2026-07-28` announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [Official TypeScript SDK migration documentation](https://ts.sdk.modelcontextprotocol.io/v2/)

## Core API

### Detect a protocol era

```ts
import { detectMcpEra } from "mcp-compat";

const detection = detectMcpEra(message, {
  "MCP-Protocol-Version": "2026-07-28",
  "MCP-Method": "tools/call",
  "MCP-Name": "search",
});

// {
//   era: "modern",
//   confidence: "high",
//   protocolVersion: "2026-07-28",
//   signals: [...],
//   issues: []
// }
```

Conflicting signals return `era: "unknown"` with explicit issues. Unknown future version strings are not guessed from date ordering: MCP protocol revisions are an enumerated set.

### Add modern per-request metadata

```ts
import { withModernMeta } from "mcp-compat";

const modern = withModernMeta(
  {
    jsonrpc: "2.0",
    id: "call-1",
    method: "tools/call",
    params: {
      name: "search",
      arguments: { query: "otters" },
      _meta: { "vendor.example/traceId": "trace-1" },
    },
  },
  {
    clientInfo: { name: "my-client", version: "2.0.0" },
    clientCapabilities: {},
  },
);
```

Existing vendor metadata is preserved. The input object is never mutated.

### Mirror modern HTTP routing headers

```ts
import { normalizeMcpHeaders } from "mcp-compat";

normalizeMcpHeaders(modern);
// {
//   "Content-Type": "application/json",
//   "Accept": "application/json, text/event-stream",
//   "MCP-Protocol-Version": "2026-07-28",
//   "MCP-Method": "tools/call",
//   "MCP-Name": "search"
// }
```

Principal-name routing is supported for tool calls, prompts, resource reads, and task operations.
Values that are not safe plain-ASCII header values are encoded using MCP's Base64 sentinel format and decoded before comparison.

### Negotiate supported revisions

```ts
import { negotiateProtocolVersion } from "mcp-compat";

negotiateProtocolVersion(["2025-11-25", "2026-07-28"]);
// "2026-07-28"

negotiateProtocolVersion(["2023-01-01"]);
// null
```

The local list determines preference order. No lexical date comparison is used.

### Build a conforming unsupported-version error

```ts
import { createUnsupportedProtocolError } from "mcp-compat";

createUnsupportedProtocolError(7, "2028-01-01");
// JSON-RPC error -32022 with requested and supported revisions
```

### Classify endpoint compatibility

```ts
import { classifyCompatibility } from "mcp-compat";

classifyCompatibility("legacy", "modern").status; // "incompatible"
classifyCompatibility("modern", "dual").status; // "compatible"
classifyCompatibility("legacy", "legacy").status; // "compatible"
```

## Audit messages and transcripts

```ts
import { auditMcpMessage, auditMcpTranscript } from "mcp-compat";

const report = auditMcpMessage(message, headers);
const transcript = auditMcpTranscript([
  { message: firstRequest, headers: firstHeaders },
  { message: firstResponse, headers: responseHeaders },
]);
```

Findings have stable codes, severities, messages, and JSON paths. Current checks include:

- JSON-RPC 2.0 structure;
- conflicting versions and protocol-era signals;
- body/header method, subject, and version mismatches;
- required modern protocol version and capabilities, plus recommended client identity;
- forbidden modern `Mcp-Session-Id` usage;
- removed lifecycle and session methods;
- missing modern `resultType`;
- malformed legacy initialization;
- missing routing headers for tools, prompts, resources, and tasks.

## Probe live endpoints

```ts
import { probeMcpEndpoint } from "mcp-compat";

const report = await probeMcpEndpoint("https://example.com/mcp", {
  timeoutMs: 5_000,
  maxResponseBytes: 1_048_576,
});

report.support; // "dual" | "modern" | "legacy" | "unknown"
```

The probe performs only two protocol lifecycle operations:

1. modern `server/discover`;
2. legacy `initialize`.

It never lists or invokes tools, reads resources, retrieves prompts, or supplies credentials. When initialize returns a session ID, cleanup sends a best-effort `DELETE`.

Redirects are rejected, response bodies are bounded, timeouts are enforced, embedded URL credentials are forbidden, and caller cancellation is supported.

> [!WARNING]
> A server-side product must not expose arbitrary probe URLs to untrusted users without outbound network policy. Any URL-fetching feature can otherwise become an SSRF primitive. Restrict schemes, hosts, ports, DNS resolution, and private network access at the deployment boundary.

## CLI

### Detect

```bash
mcp-compat detect request.json
mcp-compat detect request.json --headers headers.json --json
cat request.json | mcp-compat detect -
```

Exit code is `0` for a recognized era, `1` for unknown, and `2` for invalid input or usage.

### Audit

```bash
mcp-compat audit request.json --headers headers.json
mcp-compat audit transcript.json --strict --json
```

A transcript can be an array of raw messages or entries shaped as `{ "message": ..., "headers": ... }`.

Audit exits `1` when errors exist. `--strict` also makes warnings fail. This makes it suitable as a CI gate.

### Probe

```bash
mcp-compat probe https://example.com/mcp
mcp-compat probe https://example.com/mcp --timeout 10000 --json
```

Probe exits `0` for dual-era support, `1` for a known single era, and `2` when support cannot be established.

### Input guards

```bash
mcp-compat audit large.json --max-bytes 1048576
mcp-compat probe https://example.com/mcp --max-response-bytes 1048576
```

Files are size-checked before parsing. Standard input is counted incrementally.

## What this package does not do

`mcp-compat` does not claim that every feature can be translated between eras.

- It does not invent semantics for legacy sampling, roots, elicitation, or logging.
- It does not proxy arbitrary tool calls.
- It does not hide capability mismatches.
- It does not treat an unknown future revision as compatible.
- It does not replace the official SDK or conformance suite.

Use it as a small compatibility layer, router primitive, diagnostic engine, migration gate, or input to a purpose-built gateway.

## Runtime and package support

- Node.js 18 or newer
- ESM and CommonJS
- Built-in TypeScript declarations
- Zero runtime dependencies
- Fetch-compatible runtimes for live probing

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately rather than opening a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Protocol rules require an authoritative specification or official SDK reference plus positive and negative tests.

## License

MIT © Atomics Hub

`mcp-compat` is an independent project and is not affiliated with or endorsed by the Model Context Protocol maintainers.
