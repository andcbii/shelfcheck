import { exchangeAuthorizationCode } from "@/lib/trakt-auth";
import { requestOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

function cookieValue(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = requestOrigin(request);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const expectedState = cookieValue(request, "shelfcheck-trakt-state");
  try {
    if (!code || !state || state !== expectedState) throw new Error("The Trakt login response could not be verified. Please try again.");
    const redirectUri = `${origin}/api/auth/trakt/callback`;
    await exchangeAuthorizationCode(code, redirectUri);
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL("/trakt?trakt=connected", origin).toString(),
        "Set-Cookie": "shelfcheck-trakt-state=; Path=/api/auth/trakt/callback; HttpOnly; SameSite=Lax; Max-Age=0",
      },
    });
  } catch (error) {
    return Response.redirect(new URL(`/trakt?auth_error=${encodeURIComponent(error instanceof Error ? error.message : "Trakt login failed.")}`, origin));
  }
}
