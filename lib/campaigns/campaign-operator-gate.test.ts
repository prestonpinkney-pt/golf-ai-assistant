import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

describe("CloseOS campaign operator gates (static QA)", () => {
  test("approve route requires authenticated business user", () => {
    const src = read("app/api/campaigns/[campaignId]/approve/route.ts");
    assert.match(src, /requireBusinessUser/);
    assert.match(src, /approved_at/);
  });

  test("send route requires auth and only sends approved messages", () => {
    const src = read("app/api/campaigns/[campaignId]/send/route.ts");
    assert.match(src, /requireBusinessUser/);
    assert.match(src, /\.eq\("status", "approved"\)/);
    assert.match(src, /evaluateCampaignRecipientPolicy/);
    assert.match(src, /evaluateCampaignSendWindow/);
  });

  test("campaign list/create routes require business user", () => {
    const list = read("app/api/campaigns/route.ts");
    assert.match(list, /requireBusinessUser/);
  });
});

describe("CloseOS MVP route files exist", () => {
  const mvpPages = [
    "app/(dashboard)/dashboard/page.tsx",
    "app/(dashboard)/dashboard/dashboard-client.tsx",
    "app/(dashboard)/messages/page.tsx",
    "app/(dashboard)/opportunities/page.tsx",
    "app/(dashboard)/outbound/page.tsx",
    "app/(dashboard)/outbound/[campaignId]/page.tsx",
    "app/(dashboard)/campaigns/page.tsx",
    "app/(dashboard)/revenue-recovery/page.tsx",
    "app/(dashboard)/settings/page.tsx",
  ];

  for (const rel of mvpPages) {
    test(rel, () => {
      read(rel);
    });
  }
});
