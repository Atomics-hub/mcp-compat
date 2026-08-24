import { errorMessage, isObject } from "./internal.js";
import {
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  MCP_META_KEYS,
  normalizeMcpHeaders,
} from "./protocol.js";
import type {
  JsonObject,
  ProbeAttempt,
  ProbeOptions,
  ProbeReport,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

function validateInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${String(maximum)}.`,
    );
  }
}

function validateUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("MCP probe URL must use http: or https:.");
  }
  if (url.username || url.password) {
    throw new TypeError("MCP probe URL must not embed credentials.");
  }
  return url;
}

function modernRequest(clientInfo: JsonObject): JsonObject {
  return {
    jsonrpc: "2.0",
    id: "mcp-compat-modern",
    method: "server/discover",
    params: {
      _meta: {
        [MCP_META_KEYS.protocolVersion]: MODERN_PROTOCOL_VERSION,
        [MCP_META_KEYS.clientInfo]: clientInfo,
        [MCP_META_KEYS.clientCapabilities]: {},
      },
    },
  };
}

function legacyRequest(clientInfo: JsonObject): JsonObject {
  return {
    jsonrpc: "2.0",
    id: "mcp-compat-legacy",
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo,
    },
  };
}

function errorCode(value: unknown): number | undefined {
  if (!isObject(value) || !isObject(value.error)) return undefined;
  return typeof value.error.code === "number" ? value.error.code : undefined;
}

function resultVersion(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  if (isObject(value.result)) {
    if (typeof value.result.protocolVersion === "string") {
      return value.result.protocolVersion;
    }
    if (Array.isArray(value.result.supportedVersions)) {
      return value.result.supportedVersions.find(
        (item): item is string => typeof item === "string",
      );
    }
  }
  if (isObject(value.error) && isObject(value.error.data)) {
    const supported = value.error.data.supported;
    if (Array.isArray(supported)) {
      return supported.find((item): item is string => typeof item === "string");
    }
  }
  return undefined;
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  cancelled: Promise<never>,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), cancelled]);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("response too large").catch(() => undefined);
        throw new RangeError(
          `Response exceeded ${String(maximumBytes)} bytes and was rejected.`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseSseResponse(text: string, requestId: unknown): unknown {
  let matching: unknown;
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(data);
    } catch {
      continue;
    }
    if (
      isObject(candidate) &&
      candidate.jsonrpc === "2.0" &&
      candidate.id === requestId &&
      (candidate.result !== undefined || candidate.error !== undefined)
    ) {
      matching = candidate;
    }
  }
  if (matching === undefined) {
    throw new SyntaxError("SSE stream did not contain the matching response.");
  }
  return matching;
}

function parseResponse(
  text: string,
  contentType: string | null,
  requestId: unknown,
): unknown {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/json") return JSON.parse(text);
  if (mediaType === "text/event-stream")
    return parseSseResponse(text, requestId);
  throw new TypeError(
    `Response Content-Type must be application/json or text/event-stream, received ${contentType ?? "none"}.`,
  );
}

function isJsonRpcResponse(value: unknown, requestId: unknown): boolean {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    value.id === requestId &&
    ((value.result !== undefined && value.error === undefined) ||
      (value.error !== undefined && value.result === undefined))
  );
}

function classifyResponse(
  era: "modern" | "legacy",
  request: JsonObject,
  body: unknown,
  responseOk: boolean,
): boolean | null {
  if (!isJsonRpcResponse(body, request.id)) return null;
  const code = errorCode(body);
  if (era === "modern") {
    if (code === -32020 || code === -32021 || code === -32022) return true;
    if (code !== undefined) return false;
    if (!responseOk || !isObject(body) || !isObject(body.result)) return null;
    return (
      body.result.resultType === "complete" &&
      Array.isArray(body.result.supportedVersions) &&
      body.result.supportedVersions.length > 0 &&
      body.result.supportedVersions.every((item) => typeof item === "string") &&
      isObject(body.result.capabilities)
    );
  }
  if (code !== undefined) return false;
  if (!responseOk || !isObject(body) || !isObject(body.result)) return null;
  return (
    typeof body.result.protocolVersion === "string" &&
    (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(
      body.result.protocolVersion,
    ) &&
    isObject(body.result.capabilities) &&
    isObject(body.result.serverInfo)
  );
}

async function attempt(
  fetcher: typeof globalThis.fetch,
  url: URL,
  request: JsonObject,
  era: "modern" | "legacy",
  timeoutMs: number,
  maxResponseBytes: number,
  outerSignal?: AbortSignal,
): Promise<ProbeAttempt & { sessionId?: string }> {
  const started = performance.now();
  const controller = new AbortController();
  let rejectCancellation: ((reason: Error) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort("timeout");
    rejectCancellation?.(new Error("timeout"));
  }, timeoutMs);
  const abort = () => {
    controller.abort(outerSignal?.reason);
    rejectCancellation?.(new Error("aborted"));
  };
  outerSignal?.addEventListener("abort", abort, { once: true });
  try {
    if (outerSignal?.aborted) {
      abort();
    }
    const headers = normalizeMcpHeaders(request);
    if (era === "legacy") {
      delete headers["MCP-Method"];
      delete headers["MCP-Protocol-Version"];
    }
    const response = await Promise.race([
      fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
        redirect: "error",
      }),
      cancelled,
    ]);
    const text = await readBoundedText(response, maxResponseBytes, cancelled);
    let body: unknown;
    try {
      body =
        text.length === 0
          ? undefined
          : parseResponse(
              text,
              response.headers.get("content-type"),
              request.id,
            );
    } catch (error) {
      return {
        supported: null,
        status: response.status,
        durationMs: performance.now() - started,
        error: errorMessage(error),
      };
    }
    const protocolVersion = resultVersion(body);
    const supported = classifyResponse(era, request, body, response.ok);
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    return {
      supported,
      status: response.status,
      durationMs: performance.now() - started,
      ...(protocolVersion ? { protocolVersion } : {}),
      ...(body !== undefined ? { response: body } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  } catch (error) {
    return {
      supported: null,
      durationMs: performance.now() - started,
      error: outerSignal?.aborted
        ? "Probe aborted by caller."
        : controller.signal.aborted
          ? `Probe timed out after ${String(timeoutMs)}ms.`
          : errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", abort);
  }
}

async function cleanupSession(
  fetcher: typeof globalThis.fetch,
  url: URL,
  sessionId: string | undefined,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<void> {
  if (!sessionId) return;
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => {
    controller.abort(outerSignal?.reason ?? "cleanup timeout");
    finish?.();
  };
  const timeout = setTimeout(stop, timeoutMs);
  outerSignal?.addEventListener("abort", stop, { once: true });
  try {
    await Promise.race([
      fetcher(url, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId },
        signal: controller.signal,
        redirect: "error",
      }).then(
        () => undefined,
        () => undefined,
      ),
      stopped,
    ]);
  } catch {
    // Cleanup is best-effort and does not change compatibility classification.
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", stop);
  }
}

export async function probeMcpEndpoint(
  inputUrl: string,
  options: ProbeOptions = {},
): Promise<ProbeReport> {
  const url = validateUrl(inputUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  validateInteger(timeoutMs, "timeoutMs", 300_000);
  validateInteger(maxResponseBytes, "maxResponseBytes", 67_108_864);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new TypeError("A Fetch API implementation is required.");
  }
  const clientInfo: JsonObject = options.clientInfo
    ? { ...options.clientInfo }
    : { name: "mcp-compat", version: "0.1.0" };
  const modern = await attempt(
    fetcher,
    url,
    modernRequest(clientInfo),
    "modern",
    timeoutMs,
    maxResponseBytes,
    options.signal,
  );
  const legacyWithSession = await attempt(
    fetcher,
    url,
    legacyRequest(clientInfo),
    "legacy",
    timeoutMs,
    maxResponseBytes,
    options.signal,
  );
  const { sessionId, ...legacy } = legacyWithSession;
  await cleanupSession(fetcher, url, sessionId, timeoutMs, options.signal);
  const support =
    modern.supported === true && legacy.supported === true
      ? "dual"
      : modern.supported === true
        ? "modern"
        : legacy.supported === true
          ? "legacy"
          : "unknown";
  const diagnostics: string[] = [];
  if (modern.error) diagnostics.push(`Modern probe: ${modern.error}`);
  if (legacy.error) diagnostics.push(`Legacy probe: ${legacy.error}`);
  if (support === "legacy") {
    diagnostics.push(
      "Endpoint supports legacy MCP but not the stateless 2026-07-28 protocol.",
    );
  } else if (support === "modern") {
    diagnostics.push(
      "Endpoint is modern-only; legacy clients require a dual-era gateway or upgrade.",
    );
  } else if (support === "unknown") {
    diagnostics.push("Endpoint support could not be established safely.");
  }
  return {
    url: url.href,
    support,
    compatible: support === "dual",
    modern,
    legacy,
    diagnostics,
  };
}
