import { readPlexProviders } from "@/lib/server-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const thumb = new URL(request.url).searchParams.get("thumb") || "";
  if (!thumb.startsWith("/") || thumb.startsWith("//")) return new Response("Invalid poster path", { status: 400 });
  const config = await readPlexProviders();
  if (!config) return new Response("Plex is not configured", { status: 409 });
  const upstream = await fetch(`${config.plexUrl}${thumb}`, { headers: { "X-Plex-Token": config.plexToken, Accept: "image/avif,image/webp,image/*" }, signal: AbortSignal.timeout(15_000) });
  if (!upstream.ok || !upstream.body) return new Response("Poster unavailable", { status: upstream.status || 502 });
  return new Response(upstream.body, { headers: { "Content-Type": upstream.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}
