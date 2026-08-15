import assert from "node:assert/strict";
import test from "node:test";
import { acceptedRetryDelay, ProviderCooldownTooLongError, retryDelay } from "../lib/plex-provider-client";

test("provider retries honor the complete Retry-After duration", () => {
  const response = new Response(null, { status: 429, headers: { "Retry-After": "127" } });
  assert.equal(retryDelay(response, 3), 127_000);
  assert.equal(acceptedRetryDelay("Trakt", response, 3), 127_000);
});

test("provider retries reject excessive cooldowns instead of retrying early", () => {
  const response = new Response(null, { status: 429, headers: { "Retry-After": "86400" } });
  assert.throws(() => acceptedRetryDelay("Trakt", response, 0), (error) => error instanceof ProviderCooldownTooLongError && error.retryAfterMs === 86_400_000);
});
