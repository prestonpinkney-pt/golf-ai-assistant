import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { escapeHtml, GET } from "./route";

test("escapeHtml encodes HTML-sensitive characters", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('xss')">`),
    "&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;"
  );
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("OAuth error query is reflected escaped (no XSS)", async () => {
  const payload = `<img src=x onerror=alert(1)><script>alert(1)</script>`;
  const url =
    "http://localhost/api/integrations/google-calendar/oauth/callback?error=" +
    encodeURIComponent(payload);
  const response = await GET(new NextRequest(url));
  assert.equal(response.status, 400);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/html/i
  );
  const html = await response.text();
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("onerror="), false);
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("Google OAuth returned:"));
});
