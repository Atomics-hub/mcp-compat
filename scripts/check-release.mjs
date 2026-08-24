import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = `v${packageJson.version}`;
const actual = process.env.RELEASE_TAG;

assert.ok(actual, "RELEASE_TAG is required");
assert.equal(
  actual,
  expected,
  `release tag must exactly match package version ${expected}`,
);
process.stdout.write(`Release tag ${actual} matches package version.\n`);
