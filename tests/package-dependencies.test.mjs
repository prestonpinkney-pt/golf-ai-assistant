import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("server-only is declared as a production dependency", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));

  assert.match(
    packageJson.dependencies?.["server-only"] ?? "",
    /^\^?0\.0\.1$/,
    "server-only must remain installable in production for server module imports"
  );

  assert.equal(
    packageLock.packages?.[""]?.dependencies?.["server-only"],
    packageJson.dependencies["server-only"],
    "package-lock root dependencies must include server-only"
  );
  assert.ok(
    packageLock.packages?.["node_modules/server-only"],
    "package-lock must include the server-only package entry"
  );
});
