import { readPlexProviders } from "@/lib/server-config";
import { isAllowedPlexThumbPath, MAX_PLEX_POSTER_BYTES } from "@/lib/plex-poster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" };
  try {
    const thumb = new URL(request.url).searchParams.get("thumb") || "";
    if (!isAllowedPlexThumbPath(thumb)) return new Response("Invalid poster path", { status: 400, headers });
    const config = await readPlexProviders();
    if (!config) return new Response("Plex is not configured", { status: 409, headers });
    const upstream = await fetch(`${config.plexUrl}${thumb}`, { headers: { "X-Plex-Token": config.plexToken, Accept: "image/avif,image/webp,image/*" }, signal: AbortSignal.timeout(15_000) });
    const contentType = upstream.headers.get("Content-Type") || "";
    if (!upstream.ok || !upstream.body || !contentType.toLowerCase().startsWith("image/")) return new Response("Poster unavailable", { status: upstream.ok ? 502 : upstream.status, headers });
    const contentLength = Number(upstream.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PLEX_POSTER_BYTES) return new Response("Poster is too large", { status: 413, headers });
    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_PLEX_POSTER_BYTES) return new Response("Poster is too large", { status: 413, headers });
    return new Response(body, { headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response("Poster unavailable", { status: 502, headers });
  }
}
