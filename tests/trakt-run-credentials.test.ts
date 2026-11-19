import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { isTraktAuthenticationFailure, ProviderClient, ProviderHttpError, ProviderNetworkError } from "../lib/provider-client";
import { fakeClock, fakeFetch, json, runHarness } from "./provider-test-support";

const serverOnlyHook = registerHooks({ resolve(specifier, context, next) { return specifier === "server-only" ? { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true } : next(specifier, context); } });
const config = await import("../lib/server-config");
const { TraktRunCredentials } = await import("../lib/trakt-auth");
serverOnlyHook.deregister();

const SEARCH = "https://api.trakt.tv/search/tvdb/301?type=episode";
const OLD = "secret-access-old";
const NEW = "secret-access-new";
const renewed = () => Response.json({ access_token: NEW, refresh_token: "secret-refresh-new", expires_in: 86400, created_at: Math.floor(Date.now() / 1000) });

/** A saved Trakt login in a temporary config directory, an OAuth endpoint fake, and a client with a fake clock. */
async function setup(t: TestContext, api: Parameters<typeof fakeFetch>[0], oauth: (body: Record<string, string>) => Response | Promise<Response> = renewed) {
  const dir = mkdtempSync(path.join(tmpdir(), "trakt-run-credentials-"));
  const previous = process.env.SHELFCHECK_CONFIG_DIR;
  process.env.SHELFCHECK_CONFIG_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.SHELFCHECK_CONFIG_DIR; else process.env.SHELFCHECK_CONFIG_DIR = previous; rmSync(dir, { recursive: true, force: true }); });
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret-client-secret", accessToken: OLD, refreshToken: "secret-refresh-old", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  const oauthRequests: Record<string, string>[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://auth.trakt.tv/oauth/token", "only OAuth goes through global fetch");
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    oauthRequests.push(body);
    return oauth(body);
  });
  const time = fakeClock();
  const runs = runHarness(time.now);
  const http = fakeFetch(api);
  const client = new ProviderClient({ clock: time.clock, fetch: http.fetch, run: () => runs.runs.bound() });
  client.startRun();
  const credentials = (await TraktRunCredentials.open())!;
  const configFile = () => readFileSync(path.join(dir, "config.yml"), "utf8");
  return { time, runs, http, client, credentials, oauthRequests, configFile };
}

const bearer = (init: RequestInit) => new Headers(init.headers).get("Authorization");
const outcome = (promise: Promise<unknown>) => promise.then((value) => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined, error }));

test("concurrent requests rejected with the same token share one refresh, and each replays with the new token", async (t) => {
  const { time, http, client, credentials, oauthRequests } = await setup(t, ({ init }) => bearer(init) === `Bearer ${OLD}` ? json({}, { status: 401 }) : json({ ok: true }));
  const results = await time.runUntil(Promise.all([1, 2, 3].map(() => client.json(SEARCH, {}, "Trakt", credentials))));
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(oauthRequests.length, 1);
  assert.equal(oauthRequests[0].grant_type, "refresh_token");
  // A request still queued when the refresh lands goes out with the new token straight away.
  const tokens = http.requests.map(({ init }) => bearer(init));
  assert.equal(tokens.filter((token) => token === `Bearer ${NEW}`).length, 3, "each request is answered with the new token");
  assert.ok(tokens.indexOf(`Bearer ${NEW}`) > tokens.lastIndexOf(`Bearer ${OLD}`), `no old token after the refresh: ${tokens}`);
});

test("a late 401 for the old token reuses the newer token instead of refreshing again", async (t) => {
  const { time, http, client, credentials, oauthRequests } = await setup(t, async ({ init, index }) => {
    if (index === 1) { await time.clock.sleep(5_000); return json({}, { status: 401 }); }
    return bearer(init) === `Bearer ${OLD}` ? json({}, { status: 401 }) : json({ ok: true });
  });
  const results = await time.runUntil(Promise.all([client.json(SEARCH, {}, "Trakt", credentials), client.json(SEARCH, {}, "Trakt", credentials)]));
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(oauthRequests.length, 1, "the late rejection of the old token does not spend the new refresh token");
  assert.equal(bearer(http.requests.at(-1)!.init), `Bearer ${NEW}`);
});

test("a 401 after a transient retry still gets its one authentication recovery", async (t) => {
  const { time, http, client, credentials, oauthRequests } = await setup(t, ({ index }) => [json({}, { status: 503 }), json({}, { status: 401 }), json({ ok: true })][index]);
  assert.deepEqual(await time.runUntil(client.json(SEARCH, {}, "Trakt", credentials)), { ok: true });
  assert.equal(oauthRequests.length, 1);
  assert.equal(http.requests.length, 3);
});

test("transient retries after an authentication recovery keep their full budget", async (t) => {
  const { time, http, client, credentials } = await setup(t, ({ index }) => index === 0 ? json({}, { status: 401 }) : index < 5 ? json({}, { status: 503 }) : json({ ok: true }));
  assert.deepEqual(await time.runUntil(client.json(SEARCH, {}, "Trakt", credentials)), { ok: true });
  assert.equal(http.requests.length, 6, "one replay plus five transient attempts");
});

test("a second 401 is terminal, and a 403 is terminal without a refresh", async (t) => {
  const rejected = await setup(t, () => json({}, { status: 401 }));
  const second = await rejected.time.runUntil(outcome(rejected.client.json(SEARCH, {}, "Trakt", rejected.credentials)));
  assert.ok(second.error instanceof ProviderHttpError && second.error.status === 401);
  assert.ok(isTraktAuthenticationFailure(second.error));
  assert.equal(rejected.oauthRequests.length, 1);
  assert.equal(rejected.http.requests.length, 2);

  const forbidden = await setup(t, () => json({}, { status: 403 }));
  const refused = await forbidden.time.runUntil(outcome(forbidden.client.json(SEARCH, {}, "Trakt", forbidden.credentials)));
  assert.ok(refused.error instanceof ProviderHttpError && refused.error.status === 403);
  assert.ok(isTraktAuthenticationFailure(refused.error));
  assert.equal(forbidden.oauthRequests.length, 0);
  assert.equal(isTraktAuthenticationFailure(new ProviderHttpError("TMDB", 401)), false, "another provider's 401 is not a Trakt login failure");
});

const refreshFailures: [string, () => Response, (error: unknown) => boolean][] = [
  ["Trakt's OAuth server error", () => Response.json({}, { status: 503 }), (error) => error instanceof ProviderHttpError && error.status === 503],
  ["an OAuth rejection", () => Response.json({ error: "invalid_grant" }, { status: 400 }), (error) => error instanceof ProviderHttpError && error.status === 400],
  ["an unreachable OAuth server", () => { throw new TypeError("fetch failed"); }, (error) => error instanceof ProviderNetworkError],
];
for (const [name, oauth, check] of refreshFailures) {
  test(`a refresh that fails with ${name} keeps its cause, preserves the saved login and is not repeated for the same token`, async (t) => {
    const { time, http, client, credentials, oauthRequests, configFile } = await setup(t, () => json({}, { status: 401 }), oauth);
    const before = configFile();
    const first = await time.runUntil(outcome(client.json(SEARCH, {}, "Trakt", credentials)));
    assert.ok(check(first.error), `typed cause: ${String(first.error)}`);
    assert.deepEqual((first.error as { requested?: unknown }).requested, { provider: "Trakt", kind: "authentication" });
    assert.equal(isTraktAuthenticationFailure(first.error), false, "a failed refresh is not proof the login expired");
    assert.equal(configFile(), before, "the saved login is untouched");
    const second = await time.runUntil(outcome(client.json(SEARCH, {}, "Trakt", credentials)));
    assert.equal(second.error, first.error, "the same failure: Trakt is unavailable for the rest of the run");
    assert.equal(oauthRequests.length, 1, "no second refresh");
    assert.equal(http.requests.length, 1, "no further Trakt request in the run");
  });
}

test("tokens, secrets and Authorization headers never reach logs or errors", async (t) => {
  const { time, runs, client, credentials } = await setup(t, () => json({}, { status: 401 }));
  let error: unknown;
  const run = runs.start("plex", async () => { client.startRun(); error = (await outcome(client.json(SEARCH, {}, "Trakt", credentials))).error; });
  await time.runUntil(run.settled);
  const text = JSON.stringify(runs.lines) + String(error) + JSON.stringify(error);
  assert.doesNotMatch(text, /secret-|Bearer/);
  assert.ok(runs.lines.length > 0);
});

test("a token about to expire is refreshed before the first request, outside the attempt's deadline", async (t) => {
  const { time, http, client, oauthRequests } = await setup(t, ({ init }) => bearer(init) === `Bearer ${NEW}` ? json({ ok: true }) : json({}, { status: 401 }));
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret-client-secret", accessToken: OLD, refreshToken: "secret-refresh-old", expiresAt: Date.now() + 30_000, redirectUri: "http://localhost/callback" });
  const expiring = (await TraktRunCredentials.open())!;
  assert.deepEqual(await time.runUntil(client.json(SEARCH, {}, "Trakt", expiring)), { ok: true });
  assert.equal(oauthRequests.length, 1);
  assert.deepEqual(http.requests.map(({ init }) => bearer(init)), [`Bearer ${NEW}`], "the expiring token is never sent");
});

test("each scan run reads the saved login afresh", async (t) => {
  const { credentials } = await setup(t, () => json({ ok: true }));
  assert.equal((await credentials.current()).token, OLD);
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret-client-secret", accessToken: "secret-access-relogin", refreshToken: "secret-refresh-relogin", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  assert.equal((await (await TraktRunCredentials.open())!.current()).token, "secret-access-relogin", "a new run sees a new login");
});

test("a token another caller already refreshed is adopted instead of spending its rotated refresh token", async (t) => {
  const { time, http, client, credentials, oauthRequests } = await setup(t, ({ init }) => bearer(init) === "Bearer secret-access-elsewhere" ? json({ ok: true }) : json({}, { status: 401 }));
  // Another caller (such as the Trakt scan) refreshed the login after this run read it.
  await config.writeTraktCredentials({ clientId: "client", clientSecret: "secret-client-secret", accessToken: "secret-access-elsewhere", refreshToken: "secret-refresh-elsewhere", expiresAt: Date.now() + 86400_000, redirectUri: "http://localhost/callback" });
  assert.deepEqual(await time.runUntil(client.json(SEARCH, {}, "Trakt", credentials)), { ok: true });
  assert.equal(oauthRequests.length, 0, "no refresh with the spent refresh token");
  assert.deepEqual(http.requests.map(({ init }) => bearer(init)), [`Bearer ${OLD}`, "Bearer secret-access-elsewhere"]);
});
