import assert from "node:assert/strict";
import test from "node:test";

import { requestOrigin } from "../lib/request-origin";

test("uses the request origin without proxy headers", () => {
  assert.equal(requestOrigin(new Request("http://localhost:3000/trakt")), "http://localhost:3000");
});

test("uses the configured public origin behind a reverse proxy", () => {
  process.env.SHELFCHECK_PUBLIC_URL = "https://shelfcheck.example.com/path";
  const request = new Request("http://shelfcheck:3000/api/auth/trakt/login", {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "shelfcheck.example.com",
    },
  });

  assert.equal(requestOrigin(request), "https://shelfcheck.example.com");
  delete process.env.SHELFCHECK_PUBLIC_URL;
});

test("does not trust forwarding headers without a configured public origin", () => {
  const request = new Request("http://shelfcheck:3000/api/auth/trakt/login", {
    headers: {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "shelfcheck.example.com, shelfcheck:3000",
    },
  });

  assert.equal(requestOrigin(request), "http://shelfcheck:3000");
});

test("falls back to the request origin for an invalid public URL", () => {
  process.env.SHELFCHECK_PUBLIC_URL = "javascript:alert(1)";
  assert.equal(requestOrigin(new Request("http://localhost:3000/trakt")), "http://localhost:3000");
  delete process.env.SHELFCHECK_PUBLIC_URL;
});
