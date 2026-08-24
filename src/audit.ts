import {
  asMessage,
  asString,
  getHeader,
  getMeta,
  getNamespacedMeta,
  getParams,
  isObject,
} from "./internal.js";
import {
  MODERN_PROTOCOL_VERSION,
  detectMcpEra,
  getMcpRouting,
  isModernProtocolVersion,
} from "./protocol.js";
import type {
  AuditFinding,
  AuditReport,
  FindingSeverity,
  HeaderInput,
  TranscriptEntry,
  TranscriptReport,
} from "./types.js";

const REMOVED_MODERN_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "logging/setLevel",
  "resources/subscribe",
  "resources/unsubscribe",
]);

const PRINCIPAL_FIELDS = new Map<string, "name" | "uri" | "taskId">([
  ["tools/call", "name"],
  ["prompts/get", "name"],
  ["resources/read", "uri"],
  ["tasks/get", "taskId"],
  ["tasks/update", "taskId"],
  ["tasks/cancel", "taskId"],
]);

function finding(
  code: string,
  severity: FindingSeverity,
  message: string,
  path?: string,
): AuditFinding {
  return { code, severity, message, ...(path ? { path } : {}) };
}

function countFindings(findings: readonly AuditFinding[]) {
  return {
    error: findings.filter((item) => item.severity === "error").length,
    warning: findings.filter((item) => item.severity === "warning").length,
    info: findings.filter((item) => item.severity === "info").length,
  };
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validRequestId(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function accepts(headers: HeaderInput, mediaType: string): boolean {
  const value = getHeader(headers, "accept");
  if (!value) return false;
  return value.split(",").some((part) => {
    const [type, ...parameters] = part.trim().toLowerCase().split(";");
    const disabled = parameters.some((parameter) =>
      /^q=0(?:\.0*)?$/u.test(parameter.trim()),
    );
    return type === mediaType && !disabled;
  });
}

export function auditMcpMessage(
  input: unknown,
  headers?: HeaderInput,
): AuditReport {
  const detection = detectMcpEra(input, headers);
  const routing = getMcpRouting(input, headers);
  const findings: AuditFinding[] = [];
  const message = asMessage(input);
  if (!message) {
    findings.push(
      finding("MCP001", "error", "Message must be a JSON object.", "$"),
    );
    return {
      valid: false,
      detection,
      routing,
      findings,
      counts: countFindings(findings),
    };
  }
  if (message.jsonrpc !== "2.0") {
    findings.push(
      finding(
        "MCP002",
        "error",
        'MCP messages must declare jsonrpc: "2.0".',
        "$.jsonrpc",
      ),
    );
  }
  const method = asString(message.method);
  const hasResult = hasOwn(message, "result");
  const hasError = hasOwn(message, "error");
  const hasResponse = hasResult || hasError;
  if (!method && !hasResponse) {
    findings.push(
      finding(
        "MCP003",
        "error",
        "Message must contain a method or a response result/error.",
        "$",
      ),
    );
  }
  if (method) {
    if (hasResponse) {
      findings.push(
        finding(
          "MCP004",
          "error",
          "JSON-RPC requests and notifications cannot contain result or error.",
          "$",
        ),
      );
    }
    if (hasOwn(message, "id") && !validRequestId(message.id)) {
      findings.push(
        finding(
          "MCP005",
          "error",
          "MCP request IDs must be finite numbers or strings.",
          "$.id",
        ),
      );
    }
    if (hasOwn(message, "params") && !isObject(message.params)) {
      findings.push(
        finding(
          "MCP006",
          "error",
          "MCP params must be a JSON object when present.",
          "$.params",
        ),
      );
    }
  } else if (hasResponse) {
    if (!validRequestId(message.id)) {
      findings.push(
        finding(
          "MCP007",
          "error",
          "MCP responses require a finite numeric or string ID.",
          "$.id",
        ),
      );
    }
    if (hasResult === hasError) {
      findings.push(
        finding(
          "MCP008",
          "error",
          "JSON-RPC responses must contain exactly one of result or error.",
          "$",
        ),
      );
    }
    if (hasError) {
      const error = message.error;
      if (
        !isObject(error) ||
        !Number.isInteger(error.code) ||
        typeof error.message !== "string"
      ) {
        findings.push(
          finding(
            "MCP009",
            "error",
            "JSON-RPC errors require an integer code and string message.",
            "$.error",
          ),
        );
      }
    }
  }
  for (const issue of detection.issues) {
    findings.push(finding("MCP010", "error", issue));
  }
  for (const issue of routing.issues) {
    findings.push(finding("MCP011", "error", issue));
  }

  if (
    method &&
    headers &&
    (!accepts(headers, "application/json") ||
      !accepts(headers, "text/event-stream"))
  ) {
    findings.push(
      finding(
        "MCP034",
        "error",
        "HTTP requests must accept application/json and text/event-stream.",
      ),
    );
  }

  const hasModernSignal =
    detection.era === "modern" ||
    detection.signals.some((signal) =>
      /^(modern protocol|modern method|per-request|Mcp-Method)/u.test(signal),
    );
  if (hasModernSignal && method) {
    if (REMOVED_MODERN_METHODS.has(method)) {
      findings.push(
        finding(
          "MCP020",
          "error",
          `${method} is not part of the ${MODERN_PROTOCOL_VERSION} protocol.`,
          "$.method",
        ),
      );
    }
    const meta = getMeta(message);
    if (!asString(getNamespacedMeta(meta, "protocolVersion"))) {
      findings.push(
        finding(
          "MCP021",
          "error",
          "Modern requests must carry protocolVersion in per-request _meta.",
          "$.params._meta",
        ),
      );
    }
    if (!isObject(getNamespacedMeta(meta, "clientInfo"))) {
      findings.push(
        finding(
          "MCP022",
          "warning",
          "Modern clients should carry clientInfo in per-request _meta.",
          "$.params._meta",
        ),
      );
    }
    if (!isObject(getNamespacedMeta(meta, "clientCapabilities"))) {
      findings.push(
        finding(
          "MCP027",
          "error",
          "Modern requests must carry clientCapabilities in per-request _meta.",
          "$.params._meta",
        ),
      );
    }
    if (getHeader(headers, "mcp-session-id")) {
      findings.push(
        finding(
          "MCP023",
          "error",
          "Mcp-Session-Id was removed in the modern stateless protocol.",
        ),
      );
    }
    const headerVersion = getHeader(headers, "mcp-protocol-version");
    if (headers && !headerVersion) {
      findings.push(
        finding(
          "MCP033",
          "error",
          "Modern HTTP requests must include MCP-Protocol-Version.",
        ),
      );
    } else if (headerVersion && !isModernProtocolVersion(headerVersion)) {
      findings.push(
        finding(
          "MCP024",
          "error",
          "Modern traffic cannot declare a legacy MCP-Protocol-Version header.",
        ),
      );
    }
    if (headers && !getHeader(headers, "mcp-method")) {
      findings.push(
        finding(
          "MCP025",
          "error",
          "Modern HTTP requests must mirror the method in MCP-Method.",
        ),
      );
    }
    const principalField = PRINCIPAL_FIELDS.get(method);
    if (principalField && !asString(getParams(message)?.[principalField])) {
      findings.push(
        finding(
          "MCP035",
          "error",
          `${method} requires a non-empty params.${principalField} principal.`,
          `$.params.${principalField}`,
        ),
      );
    }
    if (headers && routing.name && !getHeader(headers, "mcp-name")) {
      findings.push(
        finding(
          "MCP028",
          "error",
          "Modern HTTP requests addressing a subject must mirror it in MCP-Name.",
        ),
      );
    }
  }

  if (
    hasModernSignal &&
    hasResult &&
    (!isObject(message.result) || !asString(message.result.resultType))
  ) {
    findings.push(
      finding(
        "MCP029",
        "error",
        "Modern result objects must declare resultType.",
        "$.result.resultType",
      ),
    );
  }

  if (detection.era === "legacy") {
    if (method === "initialize") {
      const version = asString(getParams(message)?.protocolVersion);
      if (!version) {
        findings.push(
          finding(
            "MCP030",
            "error",
            "Legacy initialize requires params.protocolVersion.",
            "$.params.protocolVersion",
          ),
        );
      }
      if (!isObject(getParams(message)?.clientInfo)) {
        findings.push(
          finding(
            "MCP031",
            "error",
            "Legacy initialize requires params.clientInfo.",
            "$.params.clientInfo",
          ),
        );
      }
      if (!isObject(getParams(message)?.capabilities)) {
        findings.push(
          finding(
            "MCP036",
            "error",
            "Legacy initialize requires params.capabilities.",
            "$.params.capabilities",
          ),
        );
      }
    }
  }

  if (detection.era === "unknown" && findings.length === 0) {
    findings.push(
      finding(
        "MCP040",
        "warning",
        "Protocol era could not be determined from this message.",
      ),
    );
  }
  const counts = countFindings(findings);
  return {
    valid: counts.error === 0,
    detection,
    routing,
    findings,
    counts,
  };
}

export function auditMcpTranscript(
  entries: readonly TranscriptEntry[],
): TranscriptReport {
  const requests = new Map<
    string,
    { era: "legacy" | "modern"; protocolVersion?: string }
  >();
  const reports = entries.map((entry) => {
    const message = asMessage(entry.message);
    const method = message ? asString(message.method) : undefined;
    const id = message?.id;
    const key = validRequestId(id) ? `${typeof id}:${String(id)}` : undefined;
    let report = auditMcpMessage(entry.message, entry.headers);
    if (!method && key && report.detection.era === "unknown") {
      const request = requests.get(key);
      if (request?.era === "modern") {
        report = auditMcpMessage(entry.message, {
          "MCP-Protocol-Version":
            request.protocolVersion ?? MODERN_PROTOCOL_VERSION,
        });
      }
    }
    if (method && key && report.detection.era !== "unknown") {
      requests.set(key, {
        era: report.detection.era,
        ...(report.detection.protocolVersion
          ? { protocolVersion: report.detection.protocolVersion }
          : {}),
      });
    } else if (!method && key) {
      requests.delete(key);
    }
    return report;
  });
  const counts = reports.reduce(
    (total, report) => ({
      error: total.error + report.counts.error,
      warning: total.warning + report.counts.warning,
      info: total.info + report.counts.info,
    }),
    { error: 0, warning: 0, info: 0 },
  );
  return { valid: counts.error === 0, entries: reports, counts };
}
