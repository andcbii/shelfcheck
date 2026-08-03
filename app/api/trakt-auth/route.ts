import { NextRequest, NextResponse } from "next/server";

const TRAKT = "https://api.trakt.tv";

export async function POST(request: NextRequest) {
  const body = await request.json() as Record<string, string>;
  let endpoint = "";
  let payload: Record<string, string> = {};
  if (body.action === "exchange") {
    endpoint = "/oauth/token";
    payload = { code: body.code, client_id: body.clientId, client_secret: body.clientSecret, redirect_uri: body.redirectUri, grant_type: "authorization_code" };
  } else if (body.action === "device") {
    endpoint = "/oauth/device/code";
    payload = { client_id: body.clientId };
  } else if (body.action === "poll") {
    endpoint = "/oauth/device/token";
    payload = { code: body.deviceCode, client_id: body.clientId, client_secret: body.clientSecret };
  } else if (body.action === "refresh") {
    endpoint = "/oauth/token";
    payload = { refresh_token: body.refreshToken, client_id: body.clientId, client_secret: body.clientSecret, redirect_uri: body.redirectUri || "urn:ietf:wg:oauth:2.0:oob", grant_type: "refresh_token" };
  } else return NextResponse.json({ error: "Unsupported authentication action." }, { status: 400 });

  const response = await fetch(`${TRAKT}${endpoint}`, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Shelfcheck/1.0 (Trakt collection audit)",
      "trakt-api-version": "2",
      "trakt-api-key": body.clientId,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  return NextResponse.json(await response.json().catch(() => ({})), { status: response.status });
}
