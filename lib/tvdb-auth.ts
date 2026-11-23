import "server-only";
import type { ProviderClient } from "@/lib/provider-client";

export async function authenticateTvdb(client: ProviderClient, apiKey: string, pin?: string): Promise<string> {
  const response = await client.json<{ data?: { token?: string } | string }>("https://api4.thetvdb.com/v4/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, ...(pin ? { pin } : {}) }),
  }, "TVDB");
  const token = typeof response.data === "string" ? response.data : response.data?.token;
  if (!token) throw new Error("TVDB login did not return a token.");
  return token;
}

/** A Plex scan's one TVDB sign-in: the token it returned, or the error it failed with, whatever its kind. */
export type TvdbSignIn = { outcome: "authenticated"; token: string } | { outcome: "failed"; error: unknown };

export async function signInToTvdb(client: ProviderClient, apiKey: string, pin?: string): Promise<TvdbSignIn> {
  try {
    return { outcome: "authenticated", token: await authenticateTvdb(client, apiKey, pin) };
  } catch (error) {
    return { outcome: "failed", error };
  }
}
