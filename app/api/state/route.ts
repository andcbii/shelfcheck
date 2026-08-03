import { env } from "cloudflare:workers";

const CHUNK_SIZE = 400_000;

async function ensureStateTable() {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shelfcheck_states (
    user_id TEXT PRIMARY KEY NOT NULL,
    payload TEXT DEFAULT '{}' NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS shelfcheck_state_chunks (
    user_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, chunk_index)
  )`).run();
}

async function readState(userId: string) {
  const chunks = await env.DB.prepare(
    "SELECT payload, updated_at FROM shelfcheck_state_chunks WHERE user_id = ? ORDER BY chunk_index"
  ).bind(userId).all<{ payload: string; updated_at: string }>();
  if (chunks.results.length) {
    return {
      state: JSON.parse(chunks.results.map((chunk) => chunk.payload).join("")) as Record<string, unknown>,
      updatedAt: chunks.results[0].updated_at,
    };
  }
  const legacy = await env.DB.prepare(
    "SELECT payload, updated_at FROM shelfcheck_states WHERE user_id = ?"
  ).bind(userId).first<{ payload: string; updated_at: string }>();
  return legacy ? { state: JSON.parse(legacy.payload) as Record<string, unknown>, updatedAt: legacy.updated_at } : { state: null, updatedAt: null };
}

async function writeState(userId: string, state: Record<string, unknown>) {
  const payload = JSON.stringify(state);
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) chunks.push(payload.slice(offset, offset + CHUNK_SIZE));
  await env.DB.prepare("DELETE FROM shelfcheck_state_chunks WHERE user_id = ?").bind(userId).run();
  for (const [index, chunk] of chunks.entries()) {
    await env.DB.prepare(
      "INSERT INTO shelfcheck_state_chunks (user_id, chunk_index, payload) VALUES (?, ?, ?)"
    ).bind(userId, index, chunk).run();
  }
  await env.DB.prepare("DELETE FROM shelfcheck_states WHERE user_id = ?").bind(userId).run();
}

function userIdFor(request: Request) {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) return userId;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-development" : null;
}

export async function GET(request: Request) {
  const userId = userIdFor(request);
  if (!userId) return Response.json({ error: "Sign in is required." }, { status: 401 });
  await ensureStateTable();
  const saved = await readState(userId);
  return Response.json(saved);
}

export async function PATCH(request: Request) {
  const userId = userIdFor(request);
  if (!userId) return Response.json({ error: "Sign in is required." }, { status: 401 });
  await ensureStateTable();
  const patch = await request.json() as Record<string, unknown>;
  const current = await readState(userId);
  await writeState(userId, { ...(current.state || {}), ...patch });
  return Response.json({ saved: true });
}
