"use client";

import { useEffect, useState } from "react";

type PendingAuth = { clientId: string; clientSecret: string; redirectUri: string };
type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; created_at?: number };

export default function TraktCallback() {
  const [message, setMessage] = useState("Completing Trakt sign-in…");

  useEffect(() => {
    const complete = async () => {
      const code = new URLSearchParams(window.location.search).get("code");
      const pending = JSON.parse(localStorage.getItem("shelfcheck-trakt-oauth-pending") || "null") as PendingAuth | null;
      if (!code || !pending) throw new Error("The Trakt callback is missing its authorization details. Return to Shelfcheck and try again.");
      const response = await fetch("/api/trakt-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "exchange", code, ...pending }),
      });
      const data = await response.json() as TokenResponse & { error?: string; error_description?: string };
      if (!response.ok) throw new Error(data.error_description || data.error || `Trakt token exchange failed (${response.status}).`);
      const expiresAt = data.created_at ? (data.created_at + data.expires_in) * 1000 : Date.now() + data.expires_in * 1000;
      localStorage.setItem("shelfcheck-trakt", JSON.stringify({ clientId: pending.clientId, clientSecret: pending.clientSecret, token: data.access_token, refreshToken: data.refresh_token, expiresAt, redirectUri: pending.redirectUri }));
      localStorage.removeItem("shelfcheck-trakt-oauth-pending");
      window.location.replace("/");
    };
    complete().catch((error) => setMessage(error instanceof Error ? error.message : "Trakt sign-in could not be completed."));
  }, []);

  return <main><section className="empty"><div>↻</div><h1>{message}</h1><p>If this message does not clear, return to Shelfcheck settings and try again.</p></section></main>;
}
