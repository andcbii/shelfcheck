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
  private readonly nextStarts = new Map<TProvider, number>();

  constructor(private readonly clock: Clock = { now: Date.now, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }) {}

  /** Waits for this provider's turn. `spacingMs` may be a function: it is read when the request starts, so it follows the latest pacing. */
  async wait(provider: TProvider, spacingMs: number | (() => number)) {
    let release!: () => void;
    const previous = this.gates.get(provider) || Promise.resolve();
    this.gates.set(provider, new Promise<void>((resolve) => { release = resolve; }));
    await previous;
    let waitMs = 0;
    // A completed sleep counts as reaching its target even if the clock reads earlier (a frozen or
    // differently mocked clock); only a later deadline set meanwhile, such as a cooldown, waits again.
    let now = this.clock.now();
    for (let target = this.nextStarts.get(provider) || 0; target > now; target = this.nextStarts.get(provider) || 0) {
      waitMs += target - now;
      await this.clock.sleep(target - now);
      now = Math.max(this.clock.now(), target);
    }
    const startedAt = now;
    this.nextStarts.set(provider, startedAt + (typeof spacingMs === "function" ? spacingMs() : spacingMs));
    release();
    return { waitMs, startedAt };
  }

  /** Forgets every provider's next start, as a server restart does. */
  reset() { this.nextStarts.clear(); }

  delayUntil(provider: TProvider, timestamp: number) {
    this.nextStarts.set(provider, Math.max(this.nextStarts.get(provider) || 0, timestamp));
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
