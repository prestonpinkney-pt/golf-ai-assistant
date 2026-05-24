/**
 * Loads `server-only` as empty for unit tests executed under plain Node/tsx (no Next resolver).
 * Provides a deterministic OpenAI key so modules that eagerly construct the client load under Node.
 * Resolves `@/*` path aliases from tsconfig (required when `--experimental-test-module-mocks` bypasses tsx paths).
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");

const origLoad = Module._load.bind(Module);
const origResolveFilename = Module._resolveFilename.bind(Module);
const projectRoot = path.resolve(__dirname, "..");

if (!process.env.OPENAI_API_KEY?.trim()) {
  process.env.OPENAI_API_KEY = "test_openai_key_stub_unit";
}

function resolveAliasPath(request) {
  if (!request.startsWith("@/")) {
    return null;
  }
  const base = path.join(projectRoot, request.slice(2));
  for (const ext of [".ts", ".tsx", ".js", ".mjs", ".cjs", ""]) {
    const candidate = ext ? `${base}${ext}` : base;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return base;
}

Module._resolveFilename = function patchedResolveFilename(
  request,
  parent,
  isMain,
  options
) {
  const aliased = resolveAliasPath(request);
  if (aliased) {
    return origResolveFilename.call(this, aliased, parent, isMain, options);
  }
  return origResolveFilename.call(this, request, parent, isMain, options);
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "server-only") {
    return {};
  }
  const aliased = resolveAliasPath(request);
  if (aliased) {
    return origLoad(aliased, parent, isMain);
  }
  return origLoad(request, parent, isMain);
};
