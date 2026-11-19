import "server-only";

import { readTraktApplication, readTraktCredentials, writeTraktCredentials, type TraktCredentials } from "@/lib/server-config";
import { ProviderHttpError, ProviderNetworkError, ProviderResponseError, type ProviderAuth } from "@/lib/provider-client";
import { SHELFCHECK_USER_AGENT } from "@/lib/user-agent";

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
  const requested = {provider:"Trakt" as const,kind:"authentication"};
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": SHELFCHECK_USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(()=>{throw new ProviderNetworkError("Trakt",requested);});
  if (!response.ok) {
    throw new ProviderHttpError("Trakt",response.status,requested);
  }
  const token = await response.json().catch(()=>{throw new ProviderResponseError("Trakt",requested);}) as TokenResponse;
  return saveToken(application, token, redirectUri);
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

/** How close to expiry a Trakt token is refreshed before use. */
const REFRESH_BEFORE_EXPIRY_MS = 60_000;

let refreshPromise: Promise<TraktCredentials | null> | null = null;

/**
 * Replaces a rejected or expiring Trakt token, the one refresh coordinator
 * for every caller. Callers share the refresh in flight, and each refresh
 * first rereads the saved login: when another caller already replaced
 * `staleToken`, its token is adopted instead of spending the rotated refresh
 * token again. A failed refresh leaves the saved credentials untouched.
 */
function refreshCredentials(staleToken: string): Promise<TraktCredentials | null> {
  refreshPromise ||= (async () => {
    const saved = await readTraktCredentials();
    if (!saved || saved.accessToken !== staleToken) return saved;
    return tokenRequest({
      refresh_token: saved.refreshToken,
      client_id: saved.clientId,
      client_secret: saved.clientSecret,
      redirect_uri: saved.redirectUri,
      grant_type: "refresh_token",
    }, saved, saved.redirectUri);
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function validTraktCredentials(forceRefresh = false): Promise<{ clientId: string; accessToken: string } | null> {
  const credentials = await readTraktCredentials();
  if (!credentials) return null;
  if (!forceRefresh && credentials.expiresAt > Date.now() + REFRESH_BEFORE_EXPIRY_MS) return credentials;
  return refreshCredentials(credentials.accessToken);
}

/**
 * The Trakt login one Scan run sends with its Trakt requests. It is read once
 * when the run opens it, refreshed within a minute of expiry or after Trakt
 * rejects its token, and never kept for a later run.
 */
export class TraktRunCredentials implements ProviderAuth {
  /** A refresh that failed in this run, and the token it tried to replace: it is not tried again for that token. */
  private failedRefresh?: { token: string; error: unknown };

  private constructor(private credentials: TraktCredentials) {}

  /** The saved Trakt login for a new Scan run, or null when Trakt is not logged in. */
  static async open(): Promise<TraktRunCredentials | null> {
    const credentials = await readTraktCredentials();
    return credentials ? new TraktRunCredentials(credentials) : null;
  }

  async current() {
    if (this.credentials.expiresAt <= Date.now() + REFRESH_BEFORE_EXPIRY_MS) await this.recover(this.credentials.accessToken);
    const { accessToken, clientId } = this.credentials;
    return { token: accessToken, headers: { Authorization: `Bearer ${accessToken}`, "trakt-api-key": clientId, "trakt-api-version": "2" } };
  }

  async recover(rejectedToken: string) {
    // Only the token still in use is refreshed; a newer one is already in place.
    if (rejectedToken !== this.credentials.accessToken) return;
    if (this.failedRefresh?.token === rejectedToken) throw this.failedRefresh.error;
    try {
      // Null only when the login was removed meanwhile: the rejected token stays, so the replay ends the request.
      this.credentials = await refreshCredentials(rejectedToken) || this.credentials;
    } catch (error) {
      this.failedRefresh = { token: rejectedToken, error };
      throw error;
    }
  }
}
