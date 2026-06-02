import assert from "node:assert/strict";
import test from "node:test";

test("gateAiRespondInternalRequest rejects dashboard-style requests without internal bearer secret", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.INTERNAL_API_SECRET = "internal-secret";

  const { gateAiRespondInternalRequest } = await import("./route");

  const denied = gateAiRespondInternalRequest(
    new Request("https://example.test/api/ai/respond")
  );
  assert.equal(denied?.status, 401);

  const allowed = gateAiRespondInternalRequest(
    new Request("https://example.test/api/ai/respond", {
      headers: { authorization: "Bearer internal-secret" },
    })
  );
  assert.equal(allowed, null);
});
