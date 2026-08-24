#!/usr/bin/env node
import { stat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import {
  auditMcpMessage,
  auditMcpTranscript,
  detectMcpEra,
  probeMcpEndpoint,
} from "./index.js";
import type { HeaderInput, TranscriptEntry } from "./types.js";

const DEFAULT_MAX_BYTES = 67_108_864;
const require = createRequire(import.meta.url);
const packageVersion = (require("../package.json") as { version: string })
  .version;

const usage = `mcp-compat <detect|audit|probe> <input> [options]

Detects, audits, and safely probes legacy and modern MCP implementations.

Commands:
  detect <file|->   Detect the protocol era of one JSON-RPC message
  audit <file|->    Audit a message or transcript for compatibility defects
  probe <url>       Probe server/discover and initialize without calling tools

Options:
  -h, --help              Show this help
  -v, --version           Show the installed version
  --headers FILE          JSON object containing HTTP headers
  --json                  Emit machine-readable JSON
  --strict                Treat audit warnings as failures
  --timeout MS            Per-probe timeout (default: 5000)
  --max-bytes N           Maximum input size (default: 67108864)
  --max-response-bytes N  Maximum probe response size (default: 1048576)

Examples:
  mcp-compat detect request.json --headers headers.json
  mcp-compat audit transcript.json --strict
  mcp-compat probe https://example.com/mcp --json
`;

interface Arguments {
  command?: string;
  input?: string;
  headers?: string;
  json: boolean;
  strict: boolean;
  timeoutMs?: number;
  maxBytes: number;
  maxResponseBytes?: number;
  help: boolean;
  version: boolean;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function parseArguments(values: readonly string[]): Arguments {
  const positional: string[] = [];
  const parsed: Arguments = {
    json: false,
    strict: false,
    maxBytes: DEFAULT_MAX_BYTES,
    help: false,
    version: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") parsed.help = true;
    else if (value === "--version" || value === "-v") parsed.version = true;
    else if (value === "--json") parsed.json = true;
    else if (value === "--strict") parsed.strict = true;
    else if (
      value === "--headers" ||
      value === "--timeout" ||
      value === "--max-bytes" ||
      value === "--max-response-bytes"
    ) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      index += 1;
      if (value === "--headers") parsed.headers = next;
      else if (value === "--timeout") {
        parsed.timeoutMs = positiveInteger(next, value);
      } else if (value === "--max-bytes") {
        parsed.maxBytes = positiveInteger(next, value);
      } else {
        parsed.maxResponseBytes = positiveInteger(next, value);
      }
    } else if (value?.startsWith("--")) {
      throw new Error(`Unknown option: ${value}`);
    } else if (value !== undefined) {
      positional.push(value);
    }
  }
  if (positional[0]) parsed.command = positional[0];
  if (positional[1]) parsed.input = positional[1];
  if (positional.length > 2) throw new Error("Too many positional arguments.");
  return parsed;
}

async function readStandardInput(maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    const buffer =
      typeof value === "string"
        ? Buffer.from(value)
        : value instanceof Uint8Array
          ? value
          : Buffer.from(String(value));
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error(
        `Input exceeds --max-bytes limit of ${String(maxBytes)}.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readText(path: string, maxBytes: number): Promise<string> {
  if (path === "-") return readStandardInput(maxBytes);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
  if (info.size > maxBytes) {
    throw new Error(`Input exceeds --max-bytes limit of ${String(maxBytes)}.`);
  }
  return readFile(path, "utf8");
}

async function readJson(path: string, maxBytes: number): Promise<unknown> {
  const source = await readText(path, maxBytes);
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}`, { cause: error });
  }
}

async function readHeaders(
  path: string | undefined,
  maxBytes: number,
): Promise<HeaderInput | undefined> {
  if (!path) return undefined;
  const value = await readJson(path, maxBytes);
  return parseHeaderRecord(value, "--headers");
}

function parseHeaderRecord(value: unknown, label: string): HeaderInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item !== "string" &&
      !(Array.isArray(item) && item.every((entry) => typeof entry === "string"))
    ) {
      throw new Error(`Header ${key} must be a string or string array.`);
    }
  }
  return value as HeaderInput;
}

function transcriptEntries(
  input: unknown,
  headers: HeaderInput | undefined,
): TranscriptEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const values: readonly unknown[] = input;
  return values.map((entry) => {
    if (typeof entry === "object" && entry !== null && "message" in entry) {
      const candidate: Record<string, unknown> = entry;
      const embeddedHeaders = candidate.headers;
      const parsedHeaders =
        embeddedHeaders === undefined
          ? undefined
          : parseHeaderRecord(embeddedHeaders, "Transcript entry headers");
      return {
        message: candidate.message,
        ...(parsedHeaders
          ? { headers: parsedHeaders }
          : headers
            ? { headers }
            : {}),
      };
    }
    return { message: entry, ...(headers ? { headers } : {}) };
  });
}

function printHumanAudit(report: ReturnType<typeof auditMcpMessage>): void {
  process.stdout.write(
    `${report.valid ? "compatible" : "incompatible"} (${report.detection.era}, ${report.detection.confidence} confidence)\n`,
  );
  for (const item of report.findings) {
    process.stdout.write(
      `${item.severity.toUpperCase()} ${item.code}: ${item.message}${item.path ? ` [${item.path}]` : ""}\n`,
    );
  }
}

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${packageVersion}\n`);
    return 0;
  }
  if (!args.command || !args.input || args.command === "help") {
    process.stdout.write(usage);
    return args.command === "help" ? 0 : 2;
  }
  if (args.command === "probe") {
    if (args.headers) throw new Error("--headers is not used with probe.");
    const report = await probeMcpEndpoint(args.input, {
      ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
      ...(args.maxResponseBytes
        ? { maxResponseBytes: args.maxResponseBytes }
        : {}),
    });
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(`support: ${report.support}\n`);
      for (const diagnostic of report.diagnostics) {
        process.stdout.write(`${diagnostic}\n`);
      }
    }
    return report.support === "dual" ? 0 : report.support === "unknown" ? 2 : 1;
  }
  if (args.command !== "detect" && args.command !== "audit") {
    throw new Error(`Unknown command: ${args.command}`);
  }
  const [input, headers] = await Promise.all([
    readJson(args.input, args.maxBytes),
    readHeaders(args.headers, args.maxBytes),
  ]);
  if (args.command === "detect") {
    const detection = detectMcpEra(input, headers);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(detection, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${detection.era} (${detection.confidence} confidence)${detection.protocolVersion ? ` ${detection.protocolVersion}` : ""}\n`,
      );
      for (const issue of detection.issues) process.stdout.write(`${issue}\n`);
    }
    return detection.era === "unknown" ? 1 : 0;
  }
  const entries = transcriptEntries(input, headers);
  if (entries) {
    const report = auditMcpTranscript(entries);
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      process.stdout.write(
        `${report.valid ? "compatible" : "incompatible"}: ${String(entries.length)} messages, ${String(report.counts.error)} errors, ${String(report.counts.warning)} warnings\n`,
      );
      for (const [index, entry] of report.entries.entries()) {
        for (const item of entry.findings) {
          process.stdout.write(
            `#${String(index + 1)} ${item.severity.toUpperCase()} ${item.code}: ${item.message}\n`,
          );
        }
      }
    }
    return report.valid && (!args.strict || report.counts.warning === 0)
      ? 0
      : 1;
  }
  const report = auditMcpMessage(input, headers);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHumanAudit(report);
  return report.valid && (!args.strict || report.counts.warning === 0) ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mcp-compat: ${message}\n`);
    process.exitCode = 2;
  });
