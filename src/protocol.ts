import {
  asMessage,
  asString,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  getHeader,
  getMeta,
  getNamespacedMeta,
  getParams,
  isObject,
} from "./internal.js";
import type {
  CompatibilityResult,
  EraDetection,
  HeaderInput,
  ImplementationInfo,
  JsonObject,
  McpMessage,
  McpRouting,
  McpSupport,
  ModernMetaOptions,
} from "./types.js";

export const MODERN_PROTOCOL_VERSION = "2026-07-28" as const;
export const LEGACY_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [
  MODERN_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
] as const;

export const MCP_META_KEYS = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
} as const;

const MODERN_ONLY_METHODS = new Set([
  "server/discover",
  "subscriptions/listen",
]);
const LEGACY_LIFECYCLE_METHODS = new Set([
  "initialize",
  "notifications/initialized",
]);

export function isModernProtocolVersion(version: string): boolean {
  return version === MODERN_PROTOCOL_VERSION;
}

export function isLegacyProtocolVersion(version: string): boolean {
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

export function extractMcpProtocolVersion(
  input: unknown,
  headers?: HeaderInput,
): string | undefined {
  const headerVersion = getHeader(headers, "mcp-protocol-version");
  if (headerVersion) return headerVersion.trim();
  const message = asMessage(input);
  if (!message) return undefined;
  const metaVersion = asString(
    getNamespacedMeta(getMeta(message), "protocolVersion"),
  );
  if (metaVersion) return metaVersion;
  const params = getParams(message);
  return params ? asString(params.protocolVersion) : undefined;
}

export function detectMcpEra(
  input: unknown,
  headers?: HeaderInput,
): EraDetection {
  const signals: string[] = [];
  const issues: string[] = [];
  const message = asMessage(input);
  if (!message) {
    return {
      era: "unknown",
      confidence: "low",
      signals,
      issues: ["Input is not a JSON object."],
    };
  }

  const versions = new Set<string>();
  const headerVersion = getHeader(headers, "mcp-protocol-version")?.trim();
  const metaVersion = asString(
    getNamespacedMeta(getMeta(message), "protocolVersion"),
  );
  const paramsVersion = asString(getParams(message)?.protocolVersion);
  for (const value of [headerVersion, metaVersion, paramsVersion]) {
    if (value) versions.add(value);
  }
  if (versions.size > 1) {
    issues.push(`Conflicting protocol versions: ${[...versions].join(", ")}.`);
  }

  const protocolVersion = headerVersion ?? metaVersion ?? paramsVersion;
  let modern = 0;
  let legacy = 0;
  if (protocolVersion) {
    if (isModernProtocolVersion(protocolVersion)) {
      modern += 3;
      signals.push(`modern protocol version ${protocolVersion}`);
    } else if (isLegacyProtocolVersion(protocolVersion)) {
      legacy += 3;
      signals.push(`legacy protocol version ${protocolVersion}`);
    } else {
      issues.push(`Protocol version ${protocolVersion} is not recognized.`);
    }
  }

  const method = asString(message.method);
  if (method && MODERN_ONLY_METHODS.has(method)) {
    modern += 3;
    signals.push(`modern method ${method}`);
  }
  if (method && LEGACY_LIFECYCLE_METHODS.has(method)) {
    legacy += 3;
    signals.push(`legacy lifecycle method ${method}`);
  }
  if (getMeta(message)) {
    const modernMeta = getNamespacedMeta(getMeta(message), "protocolVersion");
    if (modernMeta !== undefined) {
      modern += 2;
      signals.push("per-request MCP metadata");
    }
  }
  if (getHeader(headers, "mcp-session-id")) {
    legacy += 2;
    signals.push("Mcp-Session-Id header");
  }
  if (getHeader(headers, "mcp-method")) {
    modern += 1;
    signals.push("Mcp-Method routing header");
  }

  if (modern > 0 && legacy > 0) {
    issues.push("Message contains both modern and legacy protocol signals.");
    return {
      era: "unknown",
      confidence: "low",
      ...(protocolVersion ? { protocolVersion } : {}),
      signals,
      issues,
    };
  }
  const score = Math.max(modern, legacy);
  const confidence = score >= 3 ? "high" : score >= 2 ? "medium" : "low";
  return {
    era: modern > 0 ? "modern" : legacy > 0 ? "legacy" : "unknown",
    confidence,
    ...(protocolVersion ? { protocolVersion } : {}),
    signals,
    issues,
  };
}

export function getMcpRouting(
  input: unknown,
  headers?: HeaderInput,
): McpRouting {
  const issues: string[] = [];
  const message = asMessage(input);
  const bodyMethod = message ? asString(message.method) : undefined;
  const headerMethod = getHeader(headers, "mcp-method")?.trim();
  if (bodyMethod && headerMethod && bodyMethod !== headerMethod) {
    issues.push(
      `Mcp-Method header ${headerMethod} does not match body method ${bodyMethod}.`,
    );
  }
  const params = message ? getParams(message) : undefined;
  const bodyName = getPrincipalName(bodyMethod, params);
  const rawHeaderName = getHeader(headers, "mcp-name")?.trim();
  const headerName = rawHeaderName
    ? decodeMcpHeaderValue(rawHeaderName)
    : undefined;
  if (rawHeaderName && headerName === undefined) {
    issues.push("Mcp-Name header contains invalid Base64 sentinel encoding.");
  } else if (
    bodyName !== undefined &&
    headerName !== undefined &&
    bodyName !== headerName
  ) {
    issues.push(
      `Mcp-Name header ${headerName} does not match body principal ${bodyName}.`,
    );
  }
  const method = headerMethod ?? bodyMethod;
  const name = headerName ?? bodyName;
  return {
    ...(method ? { method } : {}),
    ...(name ? { name } : {}),
    issues,
  };
}

function getPrincipalName(
  method: string | undefined,
  params: JsonObject | undefined,
): string | undefined {
  if (!method || !params) return undefined;
  if (method === "tools/call" || method === "prompts/get") {
    return asString(params.name);
  }
  if (method === "resources/read") return asString(params.uri);
  if (
    method === "tasks/get" ||
    method === "tasks/update" ||
    method === "tasks/cancel"
  ) {
    return asString(params.taskId);
  }
  return undefined;
}

export function createModernMeta(options: ModernMetaOptions = {}): JsonObject {
  const protocolVersion = options.protocolVersion ?? MODERN_PROTOCOL_VERSION;
  if (!isModernProtocolVersion(protocolVersion)) {
    throw new RangeError(
      `Modern metadata requires the recognized revision ${MODERN_PROTOCOL_VERSION}.`,
    );
  }
  const clientInfo: ImplementationInfo = options.clientInfo ?? {
    name: "mcp-compat",
    version: "0.1.0",
  };
  return {
    ...(options.existing ?? {}),
    [MCP_META_KEYS.protocolVersion]: protocolVersion,
    [MCP_META_KEYS.clientInfo]: { ...clientInfo },
    [MCP_META_KEYS.clientCapabilities]: {
      ...(options.clientCapabilities ?? {}),
    },
  };
}

export function withModernMeta<T extends McpMessage>(
  request: T,
  options: ModernMetaOptions = {},
): T {
  if (!asString(request.method)) {
    throw new TypeError("MCP request method must be a non-empty string.");
  }
  const params = getParams(request) ?? {};
  const meta = createModernMeta({
    ...options,
    existing: {
      ...(isObject(params._meta) ? params._meta : {}),
      ...(options.existing ?? {}),
    },
  });
  const result: T = {
    ...request,
    params: { ...params, _meta: meta },
  };
  return result;
}

export function normalizeMcpHeaders(
  input: unknown,
  headers?: HeaderInput,
): Record<string, string> {
  const message = asMessage(input);
  if (!message) throw new TypeError("MCP request must be a JSON object.");
  const method = asString(message.method);
  if (!method)
    throw new TypeError("MCP request method must be a non-empty string.");
  const version =
    extractMcpProtocolVersion(message) ??
    getHeader(headers, "mcp-protocol-version")?.trim();
  const bodyName = getPrincipalName(method, getParams(message));
  const existingAccept = getHeader(headers, "accept");
  const requiredAccept = "application/json, text/event-stream";
  const normalized: Record<string, string> = {
    "Content-Type": "application/json",
    "MCP-Method": method,
    Accept:
      existingAccept && existingAccept !== requiredAccept
        ? `${requiredAccept}, ${existingAccept}`
        : requiredAccept,
  };
  if (version) normalized["MCP-Protocol-Version"] = version;
  if (bodyName) normalized["MCP-Name"] = encodeMcpHeaderValue(bodyName);
  const authorization = getHeader(headers, "authorization");
  if (authorization) normalized.Authorization = authorization;
  return normalized;
}

export function negotiateProtocolVersion(
  peerVersions: readonly string[],
  supportedVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): string | null {
  const peer = new Set(peerVersions);
  for (const version of supportedVersions) {
    if (peer.has(version)) return version;
  }
  return null;
}

export function createUnsupportedProtocolError(
  id: unknown,
  requested: string | undefined,
  supported: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): JsonObject {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32022,
      message: requested
        ? `Unsupported protocol version: ${requested}`
        : "Unsupported protocol version",
      data: { supported: [...supported], ...(requested ? { requested } : {}) },
    },
  };
}

export function classifyCompatibility(
  client: McpSupport,
  server: McpSupport,
): CompatibilityResult {
  if (client === "unknown" || server === "unknown") {
    return {
      status: "unknown",
      client,
      server,
      reason: "At least one endpoint has unknown protocol support.",
    };
  }
  if (client === "dual" || server === "dual" || client === server) {
    const downgrade = client === "dual" && server === "legacy";
    return {
      status: downgrade ? "downgrade" : "compatible",
      client,
      server,
      reason: downgrade
        ? "The connection can negotiate down to the legacy protocol."
        : "Client and server share a compatible protocol era.",
    };
  }
  return {
    status: "incompatible",
    client,
    server,
    reason:
      "A modern-only endpoint and a legacy-only endpoint cannot communicate directly.",
  };
}
