import { z } from 'zod';
import { TimeSchema, TimeZoneSchema, VolunteerSchema, WeekdaySchema } from '../../shared/domain.js';
import { DEFAULT_INSIGHT_CONFIG } from './overlap.js';
import type { InsightClock, InsightConfig, InsightDataset, InsightRepository } from './types.js';

/** The slice of the Apps Script script cache this adapter depends on. */
export type ScriptCache = {
  get(key: string): string | null;
  put(key: string, value: string, seconds: number): void;
};

export type CacheInsightRepositoryOptions = {
  cache: ScriptCache;
  config: InsightConfig;
  clock?: InsightClock;
};

const CACHE_KEY_PREFIX = 'insight-dataset';
const CACHE_TTL_SECONDS = 300;
const CACHE_MAX_BYTES = 90 * 1024;

const DEFAULT_CLOCK: InsightClock = {
  now(): string {
    return new Date().toISOString();
  },
};

const OverlapCellSchema = z.object({
  weekday: WeekdaySchema,
  start: TimeSchema,
  end: TimeSchema,
  timeZone: TimeZoneSchema,
  count: z.number().int().nonnegative(),
  volunteerIds: z.array(z.string().min(1)),
});

const InsightDatasetSchema = z.object({
  sourceRevision: z.record(z.string(), z.number()),
  generatedAt: z.string().min(1),
  stale: z.boolean(),
  staleReasons: z.array(z.string()),
  leftoverVolunteers: z.array(VolunteerSchema),
  cells: z.array(OverlapCellSchema),
});

const CachedInsightSchema = z.object({
  fingerprint: z.string().min(1),
  expiresAt: z.number(),
  sourceRevision: z.record(z.string(), z.number()),
  dataset: InsightDatasetSchema,
});

/**
 * The calculation-relevant configuration, resolved exactly like `calculateOverlapCells`
 * so that two configurations that derive different grids cannot share one cache key.
 */
function configFingerprint(config: InsightConfig): string {
  const start = config.startTime ?? config.operatingHours?.start ?? DEFAULT_INSIGHT_CONFIG.startTime;
  const end = config.endTime ?? config.operatingHours?.end ?? DEFAULT_INSIGHT_CONFIG.endTime;
  return [config.timeZone, config.incrementMinutes, start, end, config.includeEmpty ? '1' : '0'].join('|');
}

/** Script cache keys are length-limited, so the fingerprint is shortened by an FNV-1a hash. */
function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function numericRevisions(value: object): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number') result[key] = entry;
  }
  return result;
}

/**
 * Compares every numeric revision field of both records, so a revision added to
 * `InsightSourceRevision` later is covered without editing this module.
 */
function revisionMatches(left: object, right: object): boolean {
  const leftValues = numericRevisions(left);
  const rightValues = numericRevisions(right);
  const leftKeys = Object.keys(leftValues);
  const rightKeys = Object.keys(rightValues);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => rightValues[key] === leftValues[key]);
}

/**
 * Keeps the latest derived insight dataset in the Apps Script script cache. The
 * cache is only an accelerator: every miss, corruption, or refusal degrades to a
 * re-derivation and never to an error.
 */
export class CacheInsightRepository implements InsightRepository {
  private readonly cache: ScriptCache;
  private readonly clock: InsightClock;
  private readonly fingerprint: string;
  private readonly key: string;

  constructor(options: CacheInsightRepositoryOptions) {
    this.cache = options.cache;
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.fingerprint = configFingerprint(options.config);
    this.key = `${CACHE_KEY_PREFIX}:${hashKey(this.fingerprint)}`;
  }

  read(): InsightDataset | undefined {
    const raw = this.cache.get(this.key);
    if (!raw) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = CachedInsightSchema.safeParse(payload);
    if (!parsed.success) return undefined;
    if (parsed.data.fingerprint !== this.fingerprint) return undefined;
    if (parsed.data.expiresAt < Date.parse(this.clock.now())) return undefined;
    if (!revisionMatches(parsed.data.sourceRevision, parsed.data.dataset.sourceRevision)) return undefined;
    // `staleReasons` is a union of revision keys; the stored form is a plain string list.
    return parsed.data.dataset as InsightDataset;
  }

  write(dataset: InsightDataset): void {
    const payload = JSON.stringify({
      fingerprint: this.fingerprint,
      expiresAt: Date.parse(this.clock.now()) + CACHE_TTL_SECONDS * 1000,
      sourceRevision: { ...dataset.sourceRevision },
      dataset,
    });
    if (utf8ByteLength(payload) > CACHE_MAX_BYTES) return;
    try {
      this.cache.put(this.key, payload, CACHE_TTL_SECONDS);
    } catch {
      // A refused cache write only costs the next caller a re-derivation.
    }
  }
}
