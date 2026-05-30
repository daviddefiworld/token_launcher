const SYNC_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

async function fetchTimeFromDateHeader(url: string): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    const dateHeader = response.headers.get('date');
    if (!dateHeader) throw new Error(`No Date header from ${url}`);
    const parsed = Date.parse(dateHeader);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid Date header from ${url}`);
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTimeFromWorldTimeApi(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', {
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`worldtimeapi responded with ${response.status}`);
    const body = (await response.json()) as { unixtime?: number };
    if (!Number.isFinite(body.unixtime)) throw new Error('worldtimeapi missing unixtime');
    return body.unixtime! * 1000;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNetworkTimeMs(): Promise<number> {
  const results = await Promise.allSettled([
    fetchTimeFromDateHeader('https://www.google.com'),
    fetchTimeFromDateHeader('https://cloudflare.com'),
    fetchTimeFromWorldTimeApi()
  ]);
  const times = results
    .filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled')
    .map((result) => result.value);
  if (times.length === 0) {
    const reason = results
      .map((result) => (result.status === 'rejected' ? result.reason : null))
      .filter(Boolean)
      .join('; ');
    throw new Error(`Could not fetch network time (${reason || 'unknown error'})`);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

export class NetworkTime {
  private offsetMs = 0;
  private syncedAt = 0;
  private syncPromise: Promise<void> | null = null;

  /** UTC-ish timestamp adjusted for local clock drift. */
  now(): number {
    return Date.now() + this.offsetMs;
  }

  async sync(force = false): Promise<void> {
    const stale = !this.syncedAt || Date.now() - this.syncedAt > SYNC_TTL_MS;
    if (!force && !stale) return;
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.doSync().finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  startBackgroundSync(): void {
    void this.sync(true);
    setInterval(() => void this.sync(true), SYNC_TTL_MS);
  }

  private async doSync(): Promise<void> {
    const localBefore = Date.now();
    try {
      const networkMs = await fetchNetworkTimeMs();
      const localAfter = Date.now();
      this.offsetMs = networkMs - (localBefore + localAfter) / 2;
      this.syncedAt = Date.now();
    } catch (error) {
      if (!this.syncedAt) throw error;
      console.warn('[networkTime] sync failed, using previous offset:', error);
    }
  }
}

export const networkTime = new NetworkTime();
