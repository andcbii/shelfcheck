export async function runWorkerPool<T>(items: T[], workers: number, process: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await process(items[index], index);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, workers), items.length || 1) }, worker));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

type Clock = { now: () => number; sleep: (milliseconds: number) => Promise<void> };

export class ProviderStartGate<TProvider> {
  private readonly gates = new Map<TProvider, Promise<void>>();
  /** When each provider's next spaced request may start: the last spaced start plus its spacing. */
  private readonly nextStarts = new Map<TProvider, number>();
  /** Deadlines no request to the provider starts before, spaced or not: cooldowns, Retry-After and retry back-off. */
  private readonly deadlines = new Map<TProvider, number>();

  constructor(private readonly clock: Clock = { now: Date.now, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }) {}

  private readonly sleepers = new Map<TProvider, Set<() => void>>();

  /**
   * Waits for this provider's turn. `spacingMs` may be a function: it is read
   * when the request starts, so it follows the latest pacing. `check` runs
   * before the wait and whenever a wait ends or is woken; a throw ends the wait
   * and releases the turn, so queued requests can stop as soon as the provider
   * becomes unavailable.
   */
  async wait(provider: TProvider, spacingMs: number | (() => number), check?: () => void) {
    let release!: () => void;
    const previous = this.gates.get(provider) || Promise.resolve();
    this.gates.set(provider, new Promise<void>((resolve) => { release = resolve; }));
    await previous;
    try {
      const { waitMs, startedAt } = await this.waitFor(provider, () => Math.max(this.nextStarts.get(provider) || 0, this.deadlines.get(provider) || 0), check);
      this.nextStarts.set(provider, startedAt + (typeof spacingMs === "function" ? spacingMs() : spacingMs));
      return { waitMs, startedAt };
    } finally {
      release();
    }
  }

  /**
   * Waits only for this provider's deadlines, not its turn: the request
   * neither queues behind spaced requests nor moves their next start.
   * `check` runs as for `wait`.
   */
  waitUnspaced(provider: TProvider, check?: () => void) {
    return this.waitFor(provider, () => this.deadlines.get(provider) || 0, check);
  }

  private async waitFor(provider: TProvider, target: () => number, check?: () => void) {
    check?.();
    let waitMs = 0;
    // A completed sleep counts as reaching its target even if the clock reads earlier (a frozen or
    // differently mocked clock); only a later deadline set meanwhile, such as a cooldown, waits again.
    let now = this.clock.now();
    for (let until = target(); until > now; until = target()) {
      waitMs += until - now;
      const completed = await this.sleep(provider, until - now);
      check?.();
      now = completed ? Math.max(this.clock.now(), until) : this.clock.now();
    }
    return { waitMs, startedAt: now };
  }

  /** Sleeps for this provider until the time passes (true) or `wake` ends it early (false). */
  sleep(provider: TProvider, milliseconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sleepers = this.sleepers.get(provider) || new Set<() => void>();
      this.sleepers.set(provider, sleepers);
      const finish = (completed: boolean) => { if (sleepers.delete(woken)) resolve(completed); };
      const woken = () => finish(false);
      sleepers.add(woken);
      this.clock.sleep(milliseconds).then(() => finish(true));
    });
  }

  /** Ends every current sleep for this provider early, so its waiters look again. */
  wake(provider: TProvider) {
    for (const woken of [...(this.sleepers.get(provider) || [])]) woken();
  }

  /** Forgets every provider's next start and deadlines, as a server restart does. */
  reset() { this.nextStarts.clear(); this.deadlines.clear(); }

  /** No request to this provider, spaced or unspaced, starts before `timestamp`. */
  delayUntil(provider: TProvider, timestamp: number) {
    this.deadlines.set(provider, Math.max(this.deadlines.get(provider) || 0, timestamp));
  }
}

export type ActiveScanWork = { key: string; show: string; phase: string };

export class ActiveScanTracker {
  private readonly active = new Map<string, ActiveScanWork>();

  update(key: string, show: string, phase: string) { this.active.set(key, { key, show, phase }); }
  remove(key: string) { this.active.delete(key); }
  snapshot() { return [...this.active.values()]; }
}

export async function runTrackedWorkerPool<T>(
  items: T[],
  workers: number,
  tracker: ActiveScanTracker,
  identify: (item: T) => { key: string; show: string },
  process: (item: T) => Promise<void>,
) {
  await runWorkerPool(items, workers, async (item) => {
    const identity = identify(item);
    tracker.update(identity.key, identity.show, "starting");
    try {
      await process(item);
    } finally {
      tracker.remove(identity.key);
    }
  });
}

/**
 * Prepares items ahead of their consumer. Offered items are prepared in offer order by at most
 * `concurrency` early preparations at a time, and offering stops starting them while `ahead` early
 * preparations are prepared or running but not yet taken. `take` consumes an item's preparation once:
 * the one already started, or one started at once for an item not offered or still waiting.
 * `settled` is called once per launched preparation, fulfilled or rejected.
 */
export class PreparationQueue<T, R> {
  private readonly waiting: T[] = [];
  private readonly launched = new Map<T, { promise: Promise<R>; early: boolean }>();
  private readonly taken = new Set<T>();
  private readonly running = new Set<Promise<unknown>>();
  private earlyRunning = 0;
  private earlyUntaken = 0;
  private closed = false;

  constructor(private readonly options: {
    concurrency: number;
    ahead: number;
    prepare: (item: T) => Promise<R>;
    settled?: (item: T, result: PromiseSettledResult<R>) => void;
  }) {}

  /** Queues an item for early preparation; an item already offered, launched or taken is ignored. */
  offer(item: T) {
    if (this.closed || this.taken.has(item) || this.launched.has(item) || this.waiting.includes(item)) return;
    this.waiting.push(item);
    this.pump();
  }

  /** Whether the queue is draining: launched preparations should stop at their next checkpoint. */
  get draining() { return this.closed; }

  /** Whether the item's preparation has been taken. */
  isTaken(item: T) { return this.taken.has(item); }

  /** The item's preparation, consumed once. */
  take(item: T): Promise<R> {
    if (this.taken.has(item)) throw new Error("A prepared result is consumed only once.");
    this.taken.add(item);
    const index = this.waiting.indexOf(item);
    if (index >= 0) this.waiting.splice(index, 1);
    const launched = this.launched.get(item);
    if (launched) {
      this.launched.delete(item);
      if (launched.early) { this.earlyUntaken -= 1; this.pump(); }
      return launched.promise;
    }
    return this.launch(item, false);
  }

  /** Starts no further early preparation and settles once every launched preparation has. */
  async drain() {
    this.closed = true;
    this.waiting.length = 0;
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  private pump() {
    while (!this.closed && this.waiting.length && this.earlyRunning < this.options.concurrency && this.earlyUntaken < this.options.ahead) {
      const item = this.waiting.shift()!;
      this.earlyRunning += 1;
      this.earlyUntaken += 1;
      const promise = this.launch(item, true);
      this.launched.set(item, { promise, early: true });
      const finished = () => { this.earlyRunning -= 1; this.pump(); };
      promise.then(finished, finished);
    }
  }

  private launch(item: T, early: boolean) {
    const promise = (async () => this.options.prepare(item))();
    const tracked = promise.then(
      (value) => this.options.settled?.(item, { status: "fulfilled", value }),
      (reason: unknown) => this.options.settled?.(item, { status: "rejected", reason }),
    ).catch(() => {}).finally(() => this.running.delete(tracked));
    this.running.add(tracked);
    // A rejection is observed by whoever takes it; until then it must not surface as unhandled.
    if (early) promise.catch(() => {});
    return promise;
  }
}

/** Runs `body`; when it fails, every registered drain settles before the failure is passed on. */
export async function settleBeforeFailing<T>(drains: (() => Promise<unknown>)[], body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    await Promise.allSettled(drains.map((drain) => drain()));
    throw error;
  }
}
