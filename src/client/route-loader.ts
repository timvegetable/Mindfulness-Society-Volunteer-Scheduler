/** The authenticated scope a route snapshot is valid for. */
export interface RouteIdentity {
  email: string;
  role: string;
}

export interface RouteReadRequest {
  route: string;
  identity: RouteIdentity;
  generation: number;
}

export type RouteLoadResult<Data> =
  | { route: string; status: 'fresh'; generation: number; data: Data }
  | { route: string; status: 'discarded'; generation: number }
  | { route: string; status: 'failed'; generation: number; error: unknown };

export interface RouteLoaderOptions<Data> {
  /** Fresh read for one route; invoked at most once per identity, route, and generation. */
  read: (request: RouteReadRequest) => Promise<Data>;
}

/**
 * Coordinates route loads in memory only. Snapshots are keyed by authenticated
 * email, role, and route, so a revisit paints the last valid response
 * synchronously while a fresh read runs behind it. Nothing is persisted and
 * nothing here authorizes an action: every mutation still presents the
 * authenticated credential and is decided by the server.
 */
export class RouteLoader<Data> {
  private readonly read: (request: RouteReadRequest) => Promise<Data>;
  private identity: RouteIdentity | undefined;
  private generation = 0;
  /** Key -> the only generation still allowed to write that key. */
  private readonly writable = new Map<string, number>();
  private readonly snapshots = new Map<string, Data>();
  private readonly inFlight = new Map<string, Promise<RouteLoadResult<Data>>>();

  constructor(options: RouteLoaderOptions<Data>) {
    this.read = options.read;
  }

  /**
   * Re-scopes the loader. A change of email, role, or sign-in state discards
   * every snapshot and in-flight read and advances the generation, so no
   * previous identity's response can render. Re-setting the same identity is
   * deliberately a no-op: a credential refresh must not throw away the cache.
   */
  setIdentity(identity: RouteIdentity | undefined): void {
    if (this.identity?.email === identity?.email && this.identity?.role === identity?.role) return;
    this.identity = identity;
    this.generation += 1;
    this.writable.clear();
    this.snapshots.clear();
    this.inFlight.clear();
  }

  /** Cached data for the current identity's route, for an immediate paint. */
  cached(route: string): Data | undefined {
    if (!this.identity) return undefined;
    return this.snapshots.get(this.keyFor(route, this.identity));
  }

  /** True while a fresh read for the route is neither settled nor superseded. */
  isLoading(route: string): boolean {
    if (!this.identity) return false;
    return this.inFlight.has(this.keyFor(route, this.identity));
  }

  /**
   * Reads the route once per identity and generation. Concurrent callers for the
   * same key observe one read, and a response whose generation was superseded is
   * reported as discarded instead of replacing newer state.
   */
  load(route: string): Promise<RouteLoadResult<Data>> {
    const identity = this.identity;
    if (!identity) return Promise.resolve({ route, status: 'discarded', generation: this.generation });
    const key = this.keyFor(route, identity);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const generation = ++this.generation;
    this.writable.set(key, generation);
    const started = this.start(route, key, identity, generation);
    this.inFlight.set(key, started);
    return started;
  }

  /**
   * Discards a route's snapshot and any in-flight read, so the next load is a
   * genuinely fresh read. A successful mutation calls this before reloading the
   * active route.
   */
  invalidate(route: string): void {
    if (!this.identity) return;
    const key = this.keyFor(route, this.identity);
    this.writable.delete(key);
    this.snapshots.delete(key);
    this.inFlight.delete(key);
  }

  private async start(route: string, key: string, identity: RouteIdentity, generation: number): Promise<RouteLoadResult<Data>> {
    try {
      const data = await this.read({ route, identity, generation });
      if (this.writable.get(key) !== generation) return { route, status: 'discarded', generation };
      this.snapshots.set(key, data);
      return { route, status: 'fresh', generation, data };
    } catch (error) {
      if (this.writable.get(key) !== generation) return { route, status: 'discarded', generation };
      return { route, status: 'failed', generation, error };
    } finally {
      // Only the newest read for the key stays registered as in flight.
      if (this.writable.get(key) === generation) this.inFlight.delete(key);
    }
  }

  private keyFor(route: string, identity: RouteIdentity): string {
    return JSON.stringify([identity.email, identity.role, route]);
  }
}
