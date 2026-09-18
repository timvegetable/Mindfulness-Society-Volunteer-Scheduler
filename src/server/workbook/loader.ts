import { z } from 'zod';
import type { Center } from '../centers/models.js';
import { CenterSchema } from '../centers/models.js';
import type { Session, Volunteer } from '../../shared/domain.js';
import { SessionSchema, VolunteerSchema } from '../../shared/domain.js';
import { initializeWorkbook, type InitializationResult, type SpreadsheetLike } from './initializer.js';
import { repositories, type RuntimeRepositories, type ScriptProperties } from '../runtime.js';
import { WORKBOOK_SCHEMA_VERSION } from './schema.js';

/** Payload emitted by scripts/build-migration-payload.mjs from the reviewed exports. */
export type MigrationPayload = {
  generatedAt?: string;
  volunteers?: unknown[];
  centers?: unknown[];
  sessions?: unknown[];
};

const MigrationPayloadSchema = z.object({
  generatedAt: z.string().optional(),
  volunteers: z.array(z.unknown()).optional(),
  centers: z.array(z.unknown()).optional(),
  sessions: z.array(z.unknown()).optional()
});

export type MigrationRejection = { tab: 'Volunteers' | 'Centers' | 'Sessions'; index: number; issues: string[] };

export type MigrationValidation = {
  accepted: { volunteers: number; centers: number; sessions: number };
  rejected: MigrationRejection[];
  problems: string[];
  rows: { volunteers: Volunteer[]; centers: Center[]; sessions: Session[] };
};

export type MigrationLoadReport = {
  schemaVersion: number;
  initialized: InitializationResult;
  tables: { tab: string; accepted: number; written: number; revision: number }[];
  rejected: MigrationRejection[];
  problems: string[];
  applied: boolean;
  outcome: string;
};

function rowsOf(payload: MigrationPayload, key: 'volunteers' | 'centers' | 'sessions'): unknown[] {
  const value = payload[key];
  return Array.isArray(value) ? value : [];
}

function validateRows<T>(
  tab: MigrationRejection['tab'],
  values: readonly unknown[],
  parse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } },
  rejected: MigrationRejection[]
): T[] {
  const rows: T[] = [];
  values.forEach((value, index) => {
    const parsed = parse(value);
    if (parsed.success) {
      rows.push(parsed.data);
      return;
    }
    rejected.push({ tab, index, issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(row)'}: ${issue.message}`) });
  });
  return rows;
}

/**
 * Validate a migration payload without touching the workbook. Every row must pass
 * its tab schema; the loader refuses a partial load so a bad row can never leave
 * the workbook half-migrated.
 */
export function validateMigrationPayload(payload: unknown): MigrationValidation {
  const problems: string[] = [];
  const rejected: MigrationRejection[] = [];
  const parsed = MigrationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      accepted: { volunteers: 0, centers: 0, sessions: 0 },
      rejected,
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(payload)'}: ${issue.message}`),
      rows: { volunteers: [], centers: [], sessions: [] }
    };
  }
  const source: MigrationPayload = parsed.data;
  const volunteers = validateRows('Volunteers', rowsOf(source, 'volunteers'), (value) => VolunteerSchema.safeParse(value), rejected);
  const centers = validateRows('Centers', rowsOf(source, 'centers'), (value) => CenterSchema.safeParse(value), rejected);
  const sessions = validateRows('Sessions', rowsOf(source, 'sessions'), (value) => SessionSchema.safeParse(value), rejected);
  if (volunteers.length === 0) problems.push('payload contains no volunteers');
  if (sessions.length === 0) problems.push('payload contains no sessions');

  const volunteerIds = new Set(volunteers.map((row) => row.id));
  if (volunteerIds.size !== volunteers.length) problems.push('payload contains duplicate volunteer ids');
  const sessionIds = new Set(sessions.map((row) => row.id));
  if (sessionIds.size !== sessions.length) problems.push('payload contains duplicate session ids');
  const centerIds = new Set(centers.map((center) => center.id));
  sessions.forEach((session, index) => {
    if (session.kind === 'center' && !centerIds.has(session.centerId ?? '')) {
      rejected.push({ tab: 'Sessions', index, issues: [`centerId: unknown center ${session.centerId} for session ${session.id}`] });
    }
  });
  return { accepted: { volunteers: volunteers.length, centers: centers.length, sessions: sessions.length }, rejected, problems, rows: { volunteers, centers, sessions } };
}

function writeTab<T extends { id: string }>(repository: { replace(rows: readonly T[], expectedRevision: number, actorId: string, source: string): { number: number }; revision(): { number: number } }, rows: readonly T[], actorId: string): { written: number; revision: number } {
  const revision = repository.replace(rows, repository.revision().number, actorId, 'migration-load');
  return { written: rows.length, revision: revision.number };
}

/**
 * Load the reviewed migration payload into the workbook. Requires the workbook to
 * be initialized; writes only when every row validated and `apply` is true, so a
 * rejected row leaves all three tabs untouched.
 */
export function applyMigrationPayload(
  spreadsheet: SpreadsheetLike,
  properties: ScriptProperties,
  payload: unknown,
  options: { apply: boolean; actorId?: string }
): MigrationLoadReport {
  const initialized = initializeWorkbook(spreadsheet);
  const validation = validateMigrationPayload(payload);
  const report: MigrationLoadReport = {
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    initialized,
    tables: [],
    rejected: validation.rejected,
    problems: validation.problems,
    applied: false,
    outcome: ''
  };
  if (validation.rejected.length > 0) {
    report.outcome = `refused: ${validation.rejected.length} row(s) failed validation; nothing was written`;
    return report;
  }
  if (validation.problems.length > 0) {
    report.outcome = `refused: ${validation.problems.join('; ')}`;
    return report;
  }
  const store = repositories(spreadsheet, properties);
  if (!options.apply) {
    report.tables = [
      { tab: 'Volunteers', accepted: validation.accepted.volunteers, written: 0, revision: store.volunteers.revision().number },
      { tab: 'Centers', accepted: validation.accepted.centers, written: 0, revision: store.centers.revision().number },
      { tab: 'Sessions', accepted: validation.accepted.sessions, written: 0, revision: store.sessions.revision().number }
    ];
    report.outcome = 'validated only; no rows were written (apply was false)';
    return report;
  }
  const actorId = options.actorId ?? 'migration';
  const volunteers = writeTab(store.volunteers, validation.rows.volunteers, actorId);
  const centers = writeTab(store.centers, validation.rows.centers, actorId);
  const sessions = writeTab(store.sessions, validation.rows.sessions, actorId);
  report.tables = [
    { tab: 'Volunteers', accepted: validation.accepted.volunteers, ...volunteers },
    { tab: 'Centers', accepted: validation.accepted.centers, ...centers },
    { tab: 'Sessions', accepted: validation.accepted.sessions, ...sessions }
  ];
  report.applied = true;
  report.outcome = `wrote ${volunteers.written} volunteers, ${centers.written} centers, and ${sessions.written} sessions`;
  return report;
}
