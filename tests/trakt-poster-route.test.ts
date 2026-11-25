import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/poster/route";
import { SHELFCHECK_USER_AGENT } from "../lib/user-agent";

const POSTER = "media.trakt.tv/shows/1865/medium/poster.webp";
const IMAGE_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

function posterRequest(src: string) {
  return new Request(`http://localhost/api/poster?src=${encodeURIComponent(src)}`);
}

/** Fakes Trakt's image host, which answers 403 unless the request identifies itself as Shelfcheck. */
function fakeTraktImageHost(t: test.TestContext, reply?: () => Response) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), headers });
    if (reply) return reply();
    if (headers.get("User-Agent") !== SHELFCHECK_USER_AGENT) return new Response("<html>Forbidden</html>", { status: 403, headers: { "Content-Type": "text/html; charset=UTF-8" } });
    return new Response(IMAGE_BYTES, { status: 200, headers: { "Content-Type": "image/webp" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return requests;
}

test("the Trakt poster proxy identifies itself as Shelfcheck, so the image host serves the poster", async (t) => {
  const requests = fakeTraktImageHost(t);
  const response = await GET(posterRequest(POSTER));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/webp");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), IMAGE_BYTES);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://${POSTER}`);
  assert.equal(requests[0].headers.get("Accept"), "image/avif,image/webp,image/*");
  assert.match(response.headers.get("Cache-Control") || "", /max-age=86400/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("the Trakt poster proxy refuses hosts other than Trakt and plain HTTP without fetching", async (t) => {
  const requests = fakeTraktImageHost(t);
  for (const src of ["https://attacker.invalid/poster.webp", "http://media.trakt.tv/poster.webp", "https://trakt.tv.attacker.invalid/x.webp"]) {
    const response = await GET(posterRequest(src));
    assert.equal(response.status, 400, src);
  }
  assert.equal((await GET(new Request("http://localhost/api/poster"))).status, 400);
  assert.equal(requests.length, 0);
});

test("the Trakt poster proxy reports an upstream failure as unavailable", async (t) => {
  fakeTraktImageHost(t, () => new Response("gone", { status: 404, headers: { "Content-Type": "text/plain" } }));
  const response = await GET(posterRequest(POSTER));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Poster unavailable");
});

test("the Trakt poster proxy refuses an upstream answer that is not an image", async (t) => {
  fakeTraktImageHost(t, () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
  const response = await GET(posterRequest(POSTER));
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Poster unavailable");
});
