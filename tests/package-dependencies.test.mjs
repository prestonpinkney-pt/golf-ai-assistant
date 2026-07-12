import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));

test("runtime modules imported by production code are direct dependencies", () => {
  assert.equal(
    packageJson.dependencies?.["server-only"],
    "^0.0.1",
    "server-only must remain a direct dependency because production modules import it"
  );

  assert.ok(
    packageLock.packages?.["node_modules/server-only"],
    "package-lock.json must include server-only for clean installs"
  );
});
