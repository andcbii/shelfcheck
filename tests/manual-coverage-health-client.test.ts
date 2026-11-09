import assert from "node:assert/strict";
import test from "node:test";
import { PlexProviderClient, ProviderHttpError } from "../lib/plex-provider-client";
test("provider failures retain typed HTTP status for health decisions", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 404 }));
  const client = new PlexProviderClient(() => undefined, () => {});
  await assert.rejects(client.json("https://api4.thetvdb.com/v4/episodes/200/extended", {}, "TVDB"), error => error instanceof ProviderHttpError && error.status === 404 && error.provider === "TVDB");
});
