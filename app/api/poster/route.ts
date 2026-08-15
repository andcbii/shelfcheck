const ALLOWED_HOST = /(^|\.)trakt\.tv$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams.get("src");
  if (!source) return new Response("Missing image source", { status: 400 });

  try {
    const imageUrl = new URL(source.startsWith("https://") ? source : `https://${source}`);
    if (imageUrl.protocol !== "https:" || !ALLOWED_HOST.test(imageUrl.hostname)) {
      return new Response("Unsupported image host", { status: 400 });
    }

    const upstream = await fetch(imageUrl, {
      headers: { Accept: "image/avif,image/webp,image/*" },
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = upstream.headers.get("Content-Type") || "";
    if (!upstream.ok || !upstream.body || !contentType.toLowerCase().startsWith("image/")) {
      return new Response("Poster unavailable", { status: upstream.status || 502 });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Invalid image source", { status: 400 });
  }
}
