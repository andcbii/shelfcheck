import { ProviderStartGate } from "@/lib/scan-concurrency";
import { PROVIDER_REQUEST_SPACING_MS, type PlexProviderName } from "@/lib/plex-provider-policy";
import type { ScanLogger } from "@/lib/scan-log";

type ProviderMetric = { requests: number; failures: number; retries: number; networkMs: number; queueWaitMs: number; rateLimitWaitMs: number };

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const MAX_PROVIDER_COOLDOWN_MS = 15 * 60 * 1000;

export class ProviderCooldownTooLongError extends Error {
  constructor(readonly provider: PlexProviderName, readonly retryAfterMs: number) {
    super(`${provider} requested a ${Math.ceil(retryAfterMs / 60_000)}-minute cooldown. Affected shows will be checked again next scan.`);
  }
}

export function retryDelay(response: Response, attempt: number) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1_000, date - Date.now());
  }
  return Math.min(30_000, 1000 * 2 ** attempt);
}

export function acceptedRetryDelay(provider: PlexProviderName, response: Response, attempt: number) {
  const delay = retryDelay(response, attempt);
  if (response.status === 429 && delay > MAX_PROVIDER_COOLDOWN_MS) throw new ProviderCooldownTooLongError(provider, delay);
  return delay;
}

function emptyMetrics(): Record<PlexProviderName, ProviderMetric> {
  return Object.fromEntries((["Plex", "TMDB", "TVDB", "Trakt"] as PlexProviderName[]).map((provider) => [provider, { requests: 0, failures: 0, retries: 0, networkMs: 0, queueWaitMs: 0, rateLimitWaitMs: 0 }])) as Record<PlexProviderName, ProviderMetric>;
}

export class PlexProviderClient {
  private readonly gate = new ProviderStartGate<PlexProviderName>();
  private currentMetrics = emptyMetrics();
  private readonly rateLimitedUntil = new Map<PlexProviderName, number>();
  private readonly unavailable = new Map<PlexProviderName, ProviderCooldownTooLongError>();

  constructor(private readonly logger: () => ScanLogger | undefined, private readonly onRateLimit: (provider: PlexProviderName, paused: boolean) => void) {}

  resetMetrics() { this.currentMetrics = emptyMetrics(); this.rateLimitedUntil.clear(); this.unavailable.clear(); }
  metrics() { return this.currentMetrics; }

  async json<T>(url: string, init: RequestInit, provider: PlexProviderName): Promise<T> {
    const unavailable = this.unavailable.get(provider);
    if (unavailable) throw unavailable;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { waitMs: queueWaitMs } = await this.gate.wait(provider, PROVIDER_REQUEST_SPACING_MS[provider]);
      const queuedUnavailable = this.unavailable.get(provider);
      if (queuedUnavailable) throw queuedUnavailable;
      const requestStarted = Date.now();
      const metric = this.currentMetrics[provider];
      metric.requests += 1;
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
        const networkMs = Date.now() - requestStarted;
        metric.networkMs += networkMs;
        metric.queueWaitMs += queueWaitMs;
        const parsed = new URL(url);
        const details = { provider, path: `${parsed.pathname}${parsed.search}`, status: response.status, attempt: attempt + 1, networkMs, queueWaitMs, retryAfter: response.headers.get("Retry-After") || undefined, rateLimitRemaining: response.headers.get("X-Ratelimit-Remaining") || response.headers.get("X-RateLimit-Remaining") || undefined };
        if (response.ok) {
          this.logger()?.info("plex.request.response", details);
          if ((this.rateLimitedUntil.get(provider) || 0) <= Date.now()) {
            this.rateLimitedUntil.delete(provider);
            this.onRateLimit(provider, false);
          }
          return response.json() as Promise<T>;
        }
        this.logger()?.warn("plex.request.response", details);
        if (response.status !== 429 && response.status < 500) throw new Error(`${provider} request failed (${response.status}).`);
        if (attempt === 4) throw new Error(`${provider} request failed (${response.status}) after retries.`);
        let delay: number;
        try {
          delay = acceptedRetryDelay(provider, response, attempt);
        } catch (error) {
          if (error instanceof ProviderCooldownTooLongError) {
            this.unavailable.set(provider, error);
            this.rateLimitedUntil.delete(provider);
            this.onRateLimit(provider, false);
          }
          throw error;
        }
        metric.retries += 1;
        metric.rateLimitWaitMs += response.status === 429 ? delay : 0;
        this.logger()?.warn("plex.request.retry", { ...details, delayMs: delay });
        const retryAt = Date.now() + delay;
        if (response.status === 429) {
          this.rateLimitedUntil.set(provider, Math.max(this.rateLimitedUntil.get(provider) || 0, retryAt));
          this.onRateLimit(provider, true);
        }
        this.gate.delayUntil(provider, retryAt);
        await wait(delay);
      } catch (error) {
        if (error instanceof ProviderCooldownTooLongError) { metric.failures += 1; throw error; }
        if (error instanceof Error && /request failed \(4\d\d\)/.test(error.message)) { metric.failures += 1; throw error; }
        if (attempt === 4) { metric.failures += 1; throw new Error(`${provider} request failed after retries: ${error instanceof Error ? error.message : String(error)}`); }
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        metric.retries += 1;
        this.logger()?.warn("plex.request.network-retry", { provider, attempt: attempt + 1, delayMs: delay, error: error instanceof Error ? error.message : String(error) });
        this.gate.delayUntil(provider, Date.now() + delay);
        await wait(delay);
      }
    }
    throw new Error(`${provider} request failed.`);
  }
}
