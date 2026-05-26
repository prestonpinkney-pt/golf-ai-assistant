import assert from "node:assert/strict";
import test from "node:test";
import { listCampaignsForBusiness } from "./list-campaigns";

test("listCampaignsForBusiness returns setupRequired when campaigns table missing", async () => {
  const supabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                order: async () => ({
                  data: null,
                  error: {
                    message:
                      'Could not find the table "public.campaigns" in the schema cache',
                  },
                }),
              };
            },
          };
        },
      };
    },
  };

  const result = await listCampaignsForBusiness(supabase as never, "biz-1");
  assert.equal(result.ok, true);
  if (!result.ok || !result.setupRequired) {
    assert.fail("expected setupRequired result");
  }
  assert.equal(result.missing.includes("campaigns"), true);
  assert.match(result.setupMessage, /campaigns_ledger\.sql/);
});
