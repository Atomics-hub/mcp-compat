import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
assert.deepEqual(
  packageJson.dependencies,
  undefined,
  "the published package must keep zero runtime dependencies",
);
const esm = await import(new URL("dist/index.js", root));
const require = createRequire(import.meta.url);
const cjs = require(fileURLToPath(new URL("dist/index.cjs", root)));

for (const api of [esm, cjs]) {
  const request = api.withModernMeta({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search" },
  });
  assert.equal(api.detectMcpEra(request).era, "modern");
  assert.equal(api.auditMcpMessage(request).valid, true);
  assert.equal(
    api.classifyCompatibility("legacy", "modern").status,
    "incompatible",
  );
  assert.equal(api.negotiateProtocolVersion(["2025-11-25"]), "2025-11-25");
}

const directory = mkdtempSync(join(tmpdir(), "mcp-compat-"));
const requestFixture = join(directory, "request.json");
const headersFixture = join(directory, "headers.json");
writeFileSync(
  requestFixture,
  JSON.stringify(
    esm.withModernMeta({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  ),
);
writeFileSync(
  headersFixture,
  JSON.stringify({
    "MCP-Protocol-Version": esm.MODERN_PROTOCOL_VERSION,
    "MCP-Method": "tools/list",
    Accept: "application/json, text/event-stream",
  }),
);
const cli = fileURLToPath(new URL("dist/cli.js", root));
const help = execFileSync(process.execPath, [cli, "--help"], {
  encoding: "utf8",
});
assert.match(help, /^mcp-compat <detect\|audit\|probe>/u);
const version = execFileSync(process.execPath, [cli, "--version"], {
  encoding: "utf8",
});
assert.equal(version.trim(), packageJson.version);
const detected = execFileSync(
  process.execPath,
  [cli, "detect", requestFixture, "--headers", headersFixture],
  { encoding: "utf8" },
);
assert.match(detected, /^modern/u);
const audited = execFileSync(
  process.execPath,
  [cli, "audit", requestFixture, "--headers", headersFixture],
  { encoding: "utf8" },
);
assert.match(audited, /^compatible/u);

let invalidFailed = false;
try {
  execFileSync(process.execPath, [cli, "audit", "-"], {
    input: JSON.stringify({ jsonrpc: "1.0" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (error) {
  invalidFailed = error.status === 1;
}
assert.equal(invalidFailed, true, "invalid audit must return exit code 1");

let sizeGuard = false;
try {
  execFileSync(
    process.execPath,
    [cli, "detect", requestFixture, "--max-bytes", "1"],
    { stdio: "pipe" },
  );
} catch (error) {
  sizeGuard = error.status === 2 && error.stderr.toString().includes("exceeds");
}
assert.equal(
  sizeGuard,
  true,
  "oversized input must be rejected before parsing",
);

const server = createServer((request, response) => {
  if (request.method === "DELETE") {
    response.writeHead(204).end();
    return;
  }
  assert.match(request.headers.accept ?? "", /application\/json/u);
  assert.match(request.headers.accept ?? "", /text\/event-stream/u);
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (body.method === "server/discover") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            resultType: "complete",
            supportedVersions: [esm.MODERN_PROTOCOL_VERSION],
            capabilities: {},
          },
        }),
      );
      return;
    }
    response.setHeader("mcp-session-id", "package-test");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "package-test", version: "1" },
        },
      }),
    );
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const output = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, "probe", `http://127.0.0.1:${address.port}/mcp`, "--json"],
      { encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
  assert.equal(JSON.parse(output).support, "dual");
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

process.stdout.write(
  "ESM, CommonJS, CLI help/version/detect/audit/probe, stdin, size guard, and live dual-era HTTP verification passed.\n",
);
