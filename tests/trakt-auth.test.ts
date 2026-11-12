import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SHELFCHECK_VERSION } from "../lib/version";
import { ProviderHttpError } from "../lib/plex-provider-client";

const serverOnlyHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const config = await import("../lib/server-config");
const auth = await import("../lib/trakt-auth");
serverOnlyHook.deregister();

const application = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const redirectUri = "https://shelfcheck.example/api/auth/trakt/callback";
const tokenResponse = { access_token: "new-access-token", refresh_token: "new-refresh-token", created_at: 1_800_000_000, expires_in: 3600 };
const renewedCredentials = {
  ...application,
  accessToken: tokenResponse.access_token,
  refreshToken: tokenResponse.refresh_token,
  expiresAt: (tokenResponse.created_at + tokenResponse.expires_in) * 1000,
  redirectUri,
};
const credentials = (expiresAt: number) => ({
  ...application,
  accessToken: "old-access-token",
  refreshToken: "old-refresh-token",
  expiresAt,
  redirectUri,
});

function assertTokenRequest(input: string | URL | Request, init: RequestInit | undefined, grant: Record<string, string>) {
  assert.equal(String(input), "https://auth.trakt.tv/oauth/token");
  assert.equal(init?.method, "POST");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("User-Agent"), `Shelfcheck/${SHELFCHECK_VERSION} (+https://github.com/andcbii/shelfcheck)`);
  assert.deepEqual(JSON.parse(String(init?.body)), {
    client_id: application.clientId,
    client_secret: application.clientSecret,
    redirect_uri: redirectUri,
    ...grant,
  });
}

test("Trakt OAuth token exchanges identify Shelfcheck and preserve managed credentials", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "shelfcheck-trakt-auth-test-"));
  const previousDirectory = process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_CONFIG_DIR = directory;
  t.after(() => {
    if (previousDirectory === undefined) delete process.env.SHELFCHECK_CONFIG_DIR;
    else process.env.SHELFCHECK_CONFIG_DIR = previousDirectory;
    rmSync(directory, { recursive: true, force: true });
  });
  const configContents = () => readFileSync(path.join(directory, "config.yml"), "utf8");

  await t.test("authorization-code exchange sends an app User-Agent and persists returned tokens", async (t) => {
    await config.writeTraktApplication(application);
    const request = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assertTokenRequest(input, init, { grant_type: "authorization_code", code: "test-authorization-code" });
      return Response.json(tokenResponse);
    });

    assert.deepEqual(await auth.exchangeAuthorizationCode("test-authorization-code", redirectUri), renewedCredentials);
    assert.equal(request.mock.callCount(), 1);
    assert.deepEqual(await config.readTraktCredentials(), renewedCredentials);
  });

  await t.test("expired credentials refresh with an app User-Agent and persist rotating tokens", async (t) => {
    await config.writeTraktCredentials(credentials(Date.now() - 60_000));
    const request = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assertTokenRequest(input, init, { grant_type: "refresh_token", refresh_token: "old-refresh-token" });
      return Response.json(tokenResponse);
    });

    assert.deepEqual(await auth.validTraktCredentials(), renewedCredentials);
    assert.equal(request.mock.callCount(), 1);
    assert.deepEqual(await config.readTraktCredentials(), renewedCredentials);
  });

  await t.test("forced refresh sends an app User-Agent even before token expiry", async (t) => {
    await config.writeTraktCredentials(credentials(Date.now() + 3_600_000));
    const request = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assertTokenRequest(input, init, { grant_type: "refresh_token", refresh_token: "old-refresh-token" });
      return Response.json(tokenResponse);
    });

    assert.deepEqual(await auth.validTraktCredentials(true), renewedCredentials);
    assert.equal(request.mock.callCount(), 1);
    assert.deepEqual(await config.readTraktCredentials(), renewedCredentials);
  });

  await t.test("unexpired credentials are reused without a token request or configuration write", async (t) => {
    const existing = credentials(Date.now() + 3_600_000);
    await config.writeTraktCredentials(existing);
    const before = configContents();
    const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected token request"); });

    assert.deepEqual(await auth.validTraktCredentials(), existing);
    assert.equal(request.mock.callCount(), 0);
    assert.equal(configContents(), before);
  });

  await t.test("JSON OAuth rejection retains safe HTTP evidence and does not overwrite saved credentials", async (t) => {
    await config.writeTraktCredentials(credentials(Date.now() + 3_600_000));
    const before = configContents();
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_grant", error_description: "The authorization code is invalid." }, { status: 400 }));

    await assert.rejects(auth.exchangeAuthorizationCode("invalid-code", redirectUri), (error:unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status,400);
      assert.deepEqual(error.requested,{provider:"Trakt",kind:"authentication"});
      assert.doesNotMatch(error.message,/authorization code is invalid/);
      return true;
    });
    assert.equal(configContents(), before);
  });

  await t.test("HTML 403 during refresh uses the status fallback and preserves saved credentials", async (t) => {
    await config.writeTraktCredentials(credentials(Date.now() - 60_000));
    const before = configContents();
    t.mock.method(globalThis, "fetch", async () => new Response("<html><title>Attention Required! | Cloudflare</title></html>", { status: 403, headers: { "Content-Type": "text/html" } }));

    await assert.rejects(auth.validTraktCredentials(), (error:unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status,403);
      assert.doesNotMatch(error.message,/Cloudflare|<html>/);
      return true;
    });
    assert.equal(configContents(), before);
  });

  await t.test("a failed refresh releases the in-flight request so a later refresh can succeed", async (t) => {
    await config.writeTraktCredentials(credentials(Date.now() - 60_000));
    const before = configContents();
    let attempts = 0;
    const request = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assertTokenRequest(input, init, { grant_type: "refresh_token", refresh_token: "old-refresh-token" });
      if (++attempts === 1) return Response.json({ error_description: "Please retry the token refresh." }, { status: 503 });
      return Response.json(tokenResponse);
    });

    await assert.rejects(auth.validTraktCredentials(), (error:unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.status,503);
      assert.doesNotMatch(error.message,/Please retry the token refresh/);
      return true;
    });
    assert.equal(configContents(), before);
    assert.deepEqual(await auth.validTraktCredentials(), renewedCredentials);
    assert.equal(request.mock.callCount(), 2);
    assert.deepEqual(await config.readTraktCredentials(), renewedCredentials);
  });
});
