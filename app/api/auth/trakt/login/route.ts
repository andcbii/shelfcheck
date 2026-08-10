import { randomBytes } from "node:crypto";
import { requestOrigin } from "@/lib/request-origin";
import { traktApplication } from "@/lib/trakt-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { clientId } = await traktApplication();
    const state = randomBytes(24).toString("base64url");
    const origin = requestOrigin(request);
    const redirectUri = `${origin}/api/auth/trakt/callback`;
    const target = new URL("https://auth.trakt.tv/oauth/authorize");
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        "Set-Cookie": `shelfcheck-trakt-state=${state}; Path=/api/auth/trakt/callback; HttpOnly; SameSite=Lax; Max-Age=600${origin.startsWith("https:") ? "; Secure" : ""}`,
      },
    });
  } catch (error) {
    return Response.redirect(new URL(`/trakt?auth_error=${encodeURIComponent(error instanceof Error ? error.message : "Trakt login is unavailable.")}`, request.url));
  }
}
