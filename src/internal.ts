import { Buffer } from "node:buffer";
import type {
  HeaderInput,
  HeaderRecord,
  JsonObject,
  McpMessage,
} from "./types.js";

const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/u;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asMessage(value: unknown): McpMessage | undefined {
  return isObject(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getHeader(
  headers: HeaderInput | undefined,
  requestedName: string,
): string | undefined {
  if (!headers) return undefined;
  const name = requestedName.toLowerCase();
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(requestedName);
    return value === null || value.length === 0 ? undefined : value;
  }
  if (Symbol.iterator in Object(headers)) {
    for (const pair of headers as Iterable<readonly [string, string]>) {
      if (pair[0].toLowerCase() === name) return pair[1];
    }
    return undefined;
  }
  for (const [key, raw] of Object.entries(headers as HeaderRecord)) {
    if (key.toLowerCase() !== name || raw === undefined) continue;
    return typeof raw === "string" ? raw : raw.join(", ");
  }
  return undefined;
}

export function getParams(message: McpMessage): JsonObject | undefined {
  return isObject(message.params) ? message.params : undefined;
}

export function getMeta(message: McpMessage): JsonObject | undefined {
  const params = getParams(message);
  return params && isObject(params._meta) ? params._meta : undefined;
}

export function getNamespacedMeta(
  meta: JsonObject | undefined,
  field: string,
): unknown {
  if (!meta) return undefined;
  const flat = meta[`io.modelcontextprotocol/${field}`];
  if (flat !== undefined) return flat;
  const namespace = meta["io.modelcontextprotocol"];
  return isObject(namespace) ? namespace[field] : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function encodeMcpHeaderValue(value: string): string {
  const headerSafe = /^[\t\x20-\x7e]+$/u.test(value);
  const hasOuterWhitespace = value.trim() !== value;
  const looksEncoded = value.startsWith("=?base64?") && value.endsWith("?=");
  if (headerSafe && !hasOuterWhitespace && !looksEncoded) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function decodeMcpHeaderValue(value: string): string | undefined {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const match = BASE64_SENTINEL.exec(value);
  if (!match) return undefined;
  const payload = match[1] ?? "";
  try {
    const buffer = Buffer.from(payload, "base64");
    if (buffer.toString("base64") !== payload) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}
