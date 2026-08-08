import "server-only";

import { readTraktApplication, readTraktCredentials, writeTraktCredentials, type TraktCredentials } from "@/lib/server-config";

const TOKEN_URL = "https://auth.trakt.tv/oauth/token";

export async function traktApplication() {
  const application = await readTraktApplication();
  if (!application) throw new Error("Enter your Trakt Client ID and Client Secret before logging in.");
  return application;
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; created_at?: number };

async function saveToken(application: { clientId: string; clientSecret: string }, token: TokenResponse, redirectUri: string): Promise<TraktCredentials> {
  const createdAt = Number(token.created_at) || Math.floor(Date.now() / 1000);
  const credentials = {
    ...application,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: (createdAt + Number(token.expires_in)) * 1000,
    redirectUri,
  };
  await writeTraktCredentials(credentials);
  return credentials;
}

async function tokenRequest(body: Record<string, string>, application: { clientId: string; clientSecret: string }, redirectUri: string) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error_description?: string };
    throw new Error(detail.error_description || `Trakt authorization failed (${response.status}).`);
  }
  return saveToken(application, await response.json() as TokenResponse, redirectUri);
}

export async function exchangeAuthorizationCode(code: string, redirectUri: string) {
  const application = await traktApplication();
  return tokenRequest({
    code,
    client_id: application.clientId,
    client_secret: application.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }, application, redirectUri);
}

let refreshPromise: Promise<TraktCredentials> | null = null;

export async function validTraktCredentials(forceRefresh = false): Promise<{ clientId: string; accessToken: string } | null> {
  const credentials = await readTraktCredentials();
  if (!credentials) return null;
  if (!forceRefresh && credentials.expiresAt > Date.now() + 60_000) return credentials;
  if (!refreshPromise) {
    refreshPromise = tokenRequest({
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: credentials.redirectUri,
      grant_type: "refresh_token",
    }, credentials, credentials.redirectUri).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
