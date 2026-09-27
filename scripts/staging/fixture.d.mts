// Types for the staging fixture generator, so the Node test suite can pin the
// contract dimensions without pulling an untyped `.mjs` into the program.

export type FixtureSizeName = 'representative' | 'larger';

export type FixtureRow = Record<string, unknown>;

export type Fixture = {
  size: FixtureSizeName;
  startDate: string;
  sessionStart: string;
  schedulingTimeZone: string;
  accounts: Record<'administrator' | 'multi' | 'volunteer' | 'centerContact', string>;
  revisions: {
    dataRevision: number;
    schedulingInputRevision: number;
    schedulingOutputRevision: number;
    tabRevision: number;
  };
  counts: Record<string, number>;
  tabs: Record<string, FixtureRow[]>;
};

export declare const FIXTURE_SIZES: Record<FixtureSizeName, { label: FixtureSizeName; centers: number; volunteers: number; availabilityWeekdays: number[]; exceptions: number; sessions: number; assignments: number; backups: number; completedRuns: number; assignedVolunteers: number }>;

export declare const FIXTURE_REVISIONS: Fixture['revisions'];

export declare const DEFAULT_ACCOUNTS: Fixture['accounts'];

export declare const DENIAL_VARIANTS: Array<{ name: string; edit: Record<string, unknown> | null; expected: string }>;

export declare function nextMonday(date: string): string;

export declare function buildFixture(options: { size: FixtureSizeName; startDate?: string; schedulingTimeZone?: string; accounts?: Partial<Fixture['accounts']> }): Fixture;
