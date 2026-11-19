import { ProviderStartGate } from "@/lib/scan-concurrency";
import { PROVIDER_REQUEST_SPACING_MS, type ProviderName } from "@/lib/provider-policy";
import type { ScanLogger } from "@/lib/scan-log";
import { SHELFCHECK_USER_AGENT } from "@/lib/user-agent";

type ProviderMetric = { requests: number; failures: number; retries: number; networkMs: number; queueWaitMs: number; rateLimitWaitMs: number };

export const MAX_PROVIDER_COOLDOWN_MS = 15 * 60 * 1000;

export class ProviderHttpError extends Error {
  constructor(readonly provider: ProviderName, readonly status: number, readonly requested?: ProviderRequestIdentity) {
    super(`${provider} request failed (${status}).`);
  }
}

export type ProviderRequestIdentity = {provider:ProviderName;kind:string;id?:number};
export class ProviderResponseError extends Error {
  constructor(readonly provider:ProviderName, readonly requested?:ProviderRequestIdentity) { super(`${provider} returned an incomplete or unreadable response.`); }
}
export class ProviderNetworkError extends Error {
  constructor(readonly provider:ProviderName, readonly requested?:ProviderRequestIdentity) { super(`${provider} network request failed after retries.`); }
}
function requestIdentity(url:string, provider:ProviderName):ProviderRequestIdentity | undefined {
  const path = new URL(url).pathname;
  if (path === "/v4/login") return {provider,kind:"authentication"};
  if (path === "/library/sections") return {provider,kind:"library sections"};
  if (path.startsWith("/library/sections/")) return {provider,kind:"library inventory"};
  if (path.startsWith("/library/metadata/")) return {provider,kind:path.includes("allLeaves") ? "show episode inventory" : "show metadata"};
  if (path === "/3/tv/changes") return {provider,kind:"show change feed"};
  if (path === "/v4/updates") return {provider,kind:"series update feed"};
  const episode = path.match(/\/episodes\/(\d+)\/extended$/);
  if (episode) return {provider,kind:"episode",id:Number(episode[1])};
  const translation = path.match(/\/episodes\/(\d+)\/translations\/eng$/);
  if (translation) return {provider,kind:"episode English translation",id:Number(translation[1])};
  const search = path.match(/\/search\/tvdb\/(\d+)$/);
  if (search) return {provider,kind:"TVDB episode search",id:Number(search[1])};
  const coordinate = path.match(/\/tv\/(\d+)\/season\/(\d+)\/episode\/(\d+)$/);
  if (coordinate) return {provider,kind:`show ${coordinate[1]} season ${coordinate[2]} episode`,id:Number(coordinate[3])};
  const season = path.match(/\/tv\/(\d+)\/season\/(\d+)$/);
  if (season) return {provider,kind:`show ${season[1]} season`,id:Number(season[2])};
  const catalogue = path.match(/\/series\/(\d+)\/episodes\/default$/);
  if (catalogue) return {provider,kind:"series episode catalogue",id:Number(catalogue[1])};
  const record = path.match(/\/(tv|series|episodes|find)\/(\d+)$/);
  if (record) return {provider,kind:record[1] === "tv" ? "show" : record[1] === "episodes" ? "episode" : record[1] === "find" ? "external ID search" : "series",id:Number(record[2])};
  return undefined;
}

/** What a provider cooldown was asked for with: a 429's Retry-After, or a server error's Retry-After. */
export type ProviderCooldownReason = "rate-limit" | "server";

/** A provider cooldown: why it was asked for, when it ends, and the safe evidence of the response that asked. */
export type ProviderCooldown = { reason: ProviderCooldownReason; deadline: number; status?: number; requested?: ProviderRequestIdentity };

const COOLDOWN_WORDING: Record<ProviderCooldownReason, (provider: ProviderName, minutes: number) => string> = {
  "rate-limit": (provider, minutes) => `${provider} requested a ${minutes}-minute cooldown.`,
  server: (provider, minutes) => `${provider} is unavailable and asked Shelfcheck to wait ${minutes} minutes.`,
};

/**
 * A provider cooldown over the 15-minute limit: the provider is unavailable
 * for the Scan run. `retryAfterMs` is the time remaining when it was raised.
 */
export class ProviderCooldownTooLongError extends Error {
  constructor(readonly provider: ProviderName, readonly retryAfterMs: number, readonly cooldown: ProviderCooldown) {
    super(`${COOLDOWN_WORDING[cooldown.reason](provider, Math.ceil(retryAfterMs / 60_000))} Affected shows will be checked again next scan.`);
  }
  get reason() { return this.cooldown.reason; }
  get deadline() { return this.cooldown.deadline; }
  get status() { return this.cooldown.status; }
  get requested() { return this.cooldown.requested; }
}

/** Time, sleeping and per-attempt deadlines, injectable so pacing and timeouts can be tested in exact virtual milliseconds. */
export type ProviderClock = {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  /** An abort signal that fires after `milliseconds`, and a way to cancel it once the attempt ends. */
  deadline(milliseconds: number): { signal: AbortSignal; clear(): void };
};

// Captured at load, as the request gate always did: pacing follows real time even where a caller fakes Date.
const realNow = Date.now;

export const systemClock: ProviderClock = {
  now: () => realNow(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  deadline: (milliseconds) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("The provider request timed out.", "TimeoutError")), milliseconds);
    timer.unref?.();
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  },
};

/** The Scan run that dispatched a request: where its log lines and rate-limit pauses go. */
export type ProviderRun = {
  logger: ScanLogger;
  /** The run's log event prefix; empty keeps unprefixed names such as the Trakt scan's `request.response`. */
  eventPrefix: string;
  reportRateLimit(provider: ProviderName, paused: boolean, resumeAt?: string): void;
};

export type ProviderClientOptions = {
  clock?: ProviderClock;
  fetch?: typeof fetch;
  /** The live Scan run that dispatched the current request; undefined outside one or once it settled. */
  run?: () => ProviderRun | undefined;
};

/** Each attempt's deadline, covering the response headers and its body. */
export const PROVIDER_ATTEMPT_TIMEOUT_MS = 30_000;
const PROVIDER_ATTEMPTS = 5;

/** The bounded exponential backoff between attempts: 1, 2, 4, 8 seconds, never over 30. */
function backoffDelay(attempt: number) { return Math.min(30_000, 1000 * 2 ** attempt); }

export function retryDelay(response: Response, attempt: number, now = Date.now()) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1_000, date - now);
  }
  return backoffDelay(attempt);
}

/** The wait a retryable 429 or 5xx response asks for; over the 15-minute limit it is a provider cooldown instead. */
export function acceptedRetryDelay(provider: ProviderName, response: Response, attempt: number, now = Date.now(), requested?: ProviderRequestIdentity) {
  const delay = retryDelay(response, attempt, now);
  if ((response.status === 429 || response.status >= 500) && delay > MAX_PROVIDER_COOLDOWN_MS) {
    throw new ProviderCooldownTooLongError(provider, delay, { reason: response.status === 429 ? "rate-limit" : "server", deadline: now + delay, status: response.status, requested });
  }
  return delay;
}

function emptyMetrics(): Record<ProviderName, ProviderMetric> {
  return Object.fromEntries((["Plex", "TMDB", "TVDB", "Trakt"] as ProviderName[]).map((provider) => [provider, { requests: 0, failures: 0, retries: 0, networkMs: 0, queueWaitMs: 0, rateLimitWaitMs: 0 }])) as Record<ProviderName, ProviderMetric>;
}

/** An attempt that ran past its deadline, while waiting for headers or reading the body. */
class AttemptTimedOut extends Error {}

/** Reads the body within the attempt's deadline: a body that stops arriving is a timed-out attempt, not an unreadable response. */
async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new AttemptTimedOut();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new AttemptTimedOut()); signal.addEventListener("abort", onAbort, { once: true }); });
  try {
    return await Promise.race([response.text(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) response.body?.cancel().catch(() => {});
  }
}

/**
 * The one HTTP client for scan requests to Plex, TMDB, TVDB and Trakt.
 *
 * Transport state lasts as long as the client: each provider's request gate
 * and rate-limit deadline, so a new Scan run still honours a Retry-After an
 * earlier run received. Run state (metrics, the pauses this run has been
 * shown, providers unavailable for this run) is reset by `startRun`. Log lines
 * and pause reports go only to the run that dispatched the request.
 */
export class ProviderClient {
  private readonly clock: ProviderClock;
  private readonly fetch: typeof fetch;
  private readonly run: () => ProviderRun | undefined;
  private readonly gate: ProviderStartGate<ProviderName>;
  /** Process-wide: when each provider's latest rate-limit wait ends. */
  private readonly rateLimitDeadline = new Map<ProviderName, number>();
  private currentMetrics = emptyMetrics();
  /** Run state: the end of the pause this run has been shown, per provider. */
  private readonly shownPauseUntil = new Map<ProviderName, number>();
  private readonly unavailable = new Map<ProviderName, ProviderCooldownTooLongError>();
  /** Process-wide: each provider's longest provider cooldown, kept until it ends (for this server process only). */
  private readonly cooldowns = new Map<ProviderName, ProviderCooldown>();

  constructor(options: ProviderClientOptions = {}) {
    this.clock = options.clock || systemClock;
    this.fetch = options.fetch || ((input, init) => globalThis.fetch(input, init));
    this.run = options.run || (() => undefined);
    this.gate = new ProviderStartGate<ProviderName>(this.clock);
  }

  /** Starts a Scan run's state: metrics, shown pauses and run-only unavailability. Provider deadlines are kept. */
  startRun() { this.currentMetrics = emptyMetrics(); this.shownPauseUntil.clear(); this.unavailable.clear(); }
  /**
   * Forgets provider cooldowns and rate-limit deadlines, as a server restart
   * does. For requests outside Scan runs that a user retries on demand, such as
   * resolving a Manual Match, and for tests that simulate a restart.
   */
  forgetProviderDeadlines() { this.cooldowns.clear(); this.rateLimitDeadline.clear(); }
  metrics() { return this.currentMetrics; }

  private event(run: ProviderRun | undefined, name: string) {
    return run?.eventPrefix ? `${run.eventPrefix}.${name}` : name;
  }

  /** Shows the dispatching run a rate-limit pause still in force, such as one an earlier run received. */
  private showPendingPause(provider: ProviderName) {
    const until = this.rateLimitDeadline.get(provider) || 0;
    if (until <= this.clock.now() || (this.shownPauseUntil.get(provider) || 0) >= until) return;
    this.shownPauseUntil.set(provider, until);
    this.run()?.reportRateLimit(provider, true, new Date(until).toISOString());
  }

  /**
   * Records a provider cooldown: the longest deadline and its reason win, and
   * the provider is unavailable for the rest of this run. The gate is not held
   * for it, so requests already queued reach their availability check at once
   * instead of sleeping. Returns the error to throw.
   */
  private recordCooldown(provider: ProviderName, cooldown: ProviderCooldown) {
    const kept = this.cooldowns.get(provider);
    const longest = kept && kept.deadline >= cooldown.deadline ? kept : cooldown;
    this.cooldowns.set(provider, longest);
    const error = new ProviderCooldownTooLongError(provider, longest.deadline - this.clock.now(), longest);
    this.unavailable.set(provider, error);
    if (this.shownPauseUntil.delete(provider)) this.run()?.reportRateLimit(provider, false);
    return error;
  }

  /**
   * Throws when the provider is unavailable for this run, or when a recorded
   * provider cooldown still has more than 15 minutes to run, such as one an
   * earlier run received. Within 15 minutes the gate waits out the remainder.
   */
  private assertAvailable(provider: ProviderName) {
    const unavailable = this.unavailable.get(provider);
    if (unavailable) throw unavailable;
    const cooldown = this.cooldowns.get(provider);
    if (!cooldown) return;
    const remaining = cooldown.deadline - this.clock.now();
    if (remaining <= 0) this.cooldowns.delete(provider);
    else if (remaining > MAX_PROVIDER_COOLDOWN_MS) throw this.recordCooldown(provider, cooldown);
    else {
      this.gate.delayUntil(provider, cooldown.deadline);
      if (cooldown.reason === "rate-limit") this.rateLimitDeadline.set(provider, Math.max(this.rateLimitDeadline.get(provider) || 0, cooldown.deadline));
    }
  }

  async json<T>(url: string, init: RequestInit, provider: ProviderName): Promise<T> {
    const requested = requestIdentity(url,provider);
    this.assertAvailable(provider);
    for (let attempt = 0; attempt < PROVIDER_ATTEMPTS; attempt += 1) {
      this.showPendingPause(provider);
      const { waitMs: queueWaitMs } = await this.gate.wait(provider, PROVIDER_REQUEST_SPACING_MS[provider]);
      this.assertAvailable(provider);
      const requestStarted = this.clock.now();
      const metric = this.currentMetrics[provider];
      metric.requests += 1;
      const deadline = this.clock.deadline(PROVIDER_ATTEMPT_TIMEOUT_MS);
      try {
        let response: Response;
        let body: string | undefined;
        try {
          const headers = new Headers(init.headers);
          if (!headers.has("User-Agent")) headers.set("User-Agent", SHELFCHECK_USER_AGENT);
          response = await this.fetch(url, { ...init, headers, signal: deadline.signal });
          if (response.ok) body = await readBody(response, deadline.signal);
        } catch (error) {
          throw deadline.signal.aborted ? new AttemptTimedOut() : error;
        }
        const run = this.run();
        const networkMs = this.clock.now() - requestStarted;
        metric.networkMs += networkMs;
        metric.queueWaitMs += queueWaitMs;
        const parsed = new URL(url);
        const details = { provider, path: `${parsed.pathname}${parsed.search}`, status: response.status, attempt: attempt + 1, networkMs, queueWaitMs, elapsedMs: networkMs, retryAfter: response.headers.get("Retry-After") || undefined, rateLimitRemaining: response.headers.get("X-Ratelimit-Remaining") || response.headers.get("X-RateLimit-Remaining") || undefined };
        if (response.ok) {
          run?.logger.info(this.event(run, "request.response"), details);
          const shownUntil = this.shownPauseUntil.get(provider);
          if (shownUntil !== undefined && shownUntil <= this.clock.now()) {
            this.shownPauseUntil.delete(provider);
            run?.reportRateLimit(provider, false);
          }
          try { return JSON.parse(body!) as T; } catch { throw new ProviderResponseError(provider, requested); }
        }
        run?.logger.warn(this.event(run, "request.response"), details);
        if (response.status !== 429 && response.status < 500) throw new ProviderHttpError(provider, response.status, requested);
        let delay: number;
        try {
          // Decided before the final attempt gives up, so a long wait is never lost as a plain HTTP failure.
          delay = acceptedRetryDelay(provider, response, attempt, this.clock.now(), requested);
        } catch (error) {
          throw error instanceof ProviderCooldownTooLongError ? this.recordCooldown(provider, error.cooldown) : error;
        }
        if (attempt === PROVIDER_ATTEMPTS - 1) throw new ProviderHttpError(provider, response.status, requested);
        metric.retries += 1;
        metric.rateLimitWaitMs += response.status === 429 ? delay : 0;
        run?.logger.warn(this.event(run, "request.retry"), { ...details, delayMs: delay });
        const retryAt = this.clock.now() + delay;
        if (response.status === 429) {
          this.rateLimitDeadline.set(provider, Math.max(this.rateLimitDeadline.get(provider) || 0, retryAt));
          const until = Math.max(this.shownPauseUntil.get(provider) || 0, retryAt);
          this.shownPauseUntil.set(provider, until);
          run?.reportRateLimit(provider, true, new Date(until).toISOString());
        }
        this.gate.delayUntil(provider, retryAt);
        await this.clock.sleep(delay);
      } catch (error) {
        if (error instanceof ProviderCooldownTooLongError) { metric.failures += 1; throw error; }
        if (error instanceof ProviderHttpError || error instanceof ProviderResponseError) { metric.failures += 1; throw error; }
        if (attempt === PROVIDER_ATTEMPTS - 1) { metric.failures += 1; throw new ProviderNetworkError(provider,requested); }
        const delay = backoffDelay(attempt);
        metric.retries += 1;
        const run = this.run();
        run?.logger.warn(this.event(run, "request.network-retry"), { provider, attempt: attempt + 1, delayMs: delay, error: error instanceof AttemptTimedOut ? `${provider} request timed out` : `${provider} network request failed` });
        this.gate.delayUntil(provider, this.clock.now() + delay);
        await this.clock.sleep(delay);
      } finally {
        deadline.clear();
      }
    }
    throw new Error(`${provider} request failed.`);
  }
}
