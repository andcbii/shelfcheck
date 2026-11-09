import "server-only";
import type { PlexProviderClient } from "@/lib/plex-provider-client";

export async function authenticateTvdb(client: PlexProviderClient, apiKey: string, pin?: string): Promise<string> {
  const response = await client.json<{ data?: { token?: string } | string }>("https://api4.thetvdb.com/v4/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey: apiKey, ...(pin ? { pin } : {}) }),
  }, "TVDB");
  const token = typeof response.data === "string" ? response.data : response.data?.token;
  if (!token) throw new Error("TVDB login did not return a token.");
  return token;
}
