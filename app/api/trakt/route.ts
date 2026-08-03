const TRAKT_API = "https://api.trakt.tv";
const ALLOWED_PATHS = [
  /^\/sync\/collection\/shows$/,
  /^\/sync\/last_activities$/,
  /^\/shows\/\d+$/,
  /^\/shows\/\d+\/progress\/collection$/,
];

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const path = requestUrl.searchParams.get("path");
  const clientId = request.headers.get("x-trakt-client-id");
  const authorization = request.headers.get("authorization");

  if (!path || !path.startsWith("/") || path.startsWith("//") || !clientId || !authorization) {
    return Response.json({ error: "Missing or invalid Trakt request details." }, { status: 400 });
  }

  const upstreamUrl = new URL(path, TRAKT_API);
  if (upstreamUrl.origin !== TRAKT_API || !ALLOWED_PATHS.some((pattern) => pattern.test(upstreamUrl.pathname))) {
    return Response.json({ error: "Unsupported Trakt endpoint." }, { status: 400 });
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": clientId,
        Authorization: authorization,
      },
    });

    const responseHeaders = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "Cache-Control": "private, no-store",
    });
    for (const name of ["Retry-After", "X-Pagination-Page-Count", "X-Pagination-Item-Count", "X-RateLimit", "X-RateLimit-Remaining"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: "The connection from Shelfcheck to Trakt failed." }, {
      status: 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
