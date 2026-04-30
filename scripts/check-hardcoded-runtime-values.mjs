import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TARGET_DIR = join(ROOT, "app", "api");

const BLOCKED_PATTERNS = [
  {
    label: "hardcoded business UUID",
    regex: /b381c0cc-4786-4032-8b22-5143aeaf3e30/g,
  },
  {
    label: "hardcoded business slug",
    regex: /primetime-golf/g,
  },
  {
    label: "hardcoded website domain",
    regex: /primetimegolf\.org/g,
  },
  {
    label: "hardcoded test destination phone",
    regex: /\+15103756639/g,
  },
];

const IGNORE_FILES = new Set([
  join(TARGET_DIR, "config", "index.ts"),
]);

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      out.push(...listFiles(fullPath));
      continue;
    }

    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(fullPath)) continue;
    out.push(fullPath);
  }
  return out;
}

const offenders = [];
for (const filePath of listFiles(TARGET_DIR)) {
  if (IGNORE_FILES.has(filePath)) continue;
  const content = readFileSync(filePath, "utf8");

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.regex.test(content)) {
      offenders.push({ filePath, label: pattern.label });
    }
  }
}

if (offenders.length > 0) {
  console.error("Hardcoded runtime values detected:");
  for (const offender of offenders) {
    const rel = offender.filePath.replace(`${ROOT}\\`, "").replace(`${ROOT}/`, "");
    console.error(`- ${rel} (${offender.label})`);
  }
  process.exit(1);
}

console.log("No blocked hardcoded runtime values found.");
