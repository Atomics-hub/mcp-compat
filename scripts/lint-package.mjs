import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = process.platform === "win32" ? ".cmd" : "";
const environment = {
  ...process.env,
  npm_config_cache: join(root, ".npm-cache"),
};

for (const [command, arguments_] of [
  ["publint", []],
  ["attw", ["--pack", "."]],
]) {
  execFileSync(
    join(root, "node_modules", ".bin", `${command}${extension}`),
    arguments_,
    { cwd: root, env: environment, stdio: "inherit" },
  );
}
