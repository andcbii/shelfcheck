import assert from "node:assert/strict";
import test from "node:test";

import { requestOrigin } from "../lib/request-origin";

test("uses the request origin without proxy headers", () => {
  assert.equal(requestOrigin(new Request("http://localhost:3000/trakt")), "http://localhost:3000");
});

test("uses the public protocol and host forwarded by a reverse proxy", () => {
  const request = new Request("http://shelfcheck:3000/api/auth/trakt/login", {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "shelfcheck.alderaan.co",
    },
  });

  assert.equal(requestOrigin(request), "https://shelfcheck.alderaan.co");
});

test("uses the first value from a chain of forwarding proxies", () => {
  const request = new Request("http://shelfcheck:3000/api/auth/trakt/login", {
    headers: {
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "shelfcheck.alderaan.co, shelfcheck:3000",
    },
  });

  assert.equal(requestOrigin(request), "https://shelfcheck.alderaan.co");
});
