export type JsonObject = Record<string, unknown>;

export type McpEra = "legacy" | "modern" | "unknown";
export type McpSupport = McpEra | "dual";
export type Confidence = "high" | "medium" | "low";

export interface McpMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export type HeaderValue = string | readonly string[] | undefined;
export type HeaderRecord = Record<string, HeaderValue>;
export type HeaderInput =
  Headers | HeaderRecord | Iterable<readonly [string, string]>;

export interface EraDetection {
  era: McpEra;
  confidence: Confidence;
  protocolVersion?: string;
  signals: string[];
  issues: string[];
}

export interface McpRouting {
  method?: string;
  name?: string;
  issues: string[];
}

export interface ImplementationInfo {
  name: string;
  version: string;
  title?: string;
}

export interface ModernMetaOptions {
  protocolVersion?: string;
  clientInfo?: ImplementationInfo;
  clientCapabilities?: JsonObject;
  existing?: JsonObject;
}

export interface CompatibilityResult {
  status: "compatible" | "downgrade" | "incompatible" | "unknown";
  client: McpSupport;
  server: McpSupport;
  reason: string;
}

export type FindingSeverity = "error" | "warning" | "info";

export interface AuditFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  path?: string;
}

export interface AuditReport {
  valid: boolean;
  detection: EraDetection;
  routing: McpRouting;
  findings: AuditFinding[];
  counts: Record<FindingSeverity, number>;
}

export interface TranscriptEntry {
  message: unknown;
  headers?: HeaderInput;
}

export interface TranscriptReport {
  valid: boolean;
  entries: AuditReport[];
  counts: Record<FindingSeverity, number>;
}

export interface ProbeAttempt {
  supported: boolean | null;
  status?: number;
  protocolVersion?: string;
  durationMs: number;
  error?: string;
  response?: unknown;
}

export interface ProbeReport {
  url: string;
  support: McpSupport;
  compatible: boolean;
  modern: ProbeAttempt;
  legacy: ProbeAttempt;
  diagnostics: string[];
}

export interface ProbeOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  clientInfo?: ImplementationInfo;
}
