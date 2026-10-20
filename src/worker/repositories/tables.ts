import type { Snapshot, StagedParticipant } from '../../shared/domain/models';

type TableKey = Exclude<keyof Snapshot, 'dataRevision' | 'schedulingInputRevision' | 'synchronizedDataRevision' | 'synchronizedSourceHash'>;
type SqlValue = string | number | null;

interface Table {
  key: TableKey;
  name: string;
  columns: readonly string[];
  properties: readonly string[];
  json?: readonly string[];
  booleans?: readonly string[];
  schedulingInput?: boolean;
}

function table(key: TableKey, name: string, columns: string, extra: Omit<Table, 'key' | 'name' | 'columns' | 'properties'> = {}): Table {
  const names = columns.split(' ');
  return { key, name, columns: names, properties: names.map(property), ...extra };
}

/** Parent tables precede their children, so inserts preserve foreign keys. */
export const tables: readonly Table[] = [
  table('centers', 'centers', 'id name active created_at updated_at', { booleans: ['active'] }),
  table('volunteers', 'volunteers', 'id name email lifecycle_status interview_status readiness_rank source created_at updated_at', { schedulingInput: true }),
  table('volunteerChanges', 'volunteer_changes', 'id occurred_at actor_id actor_email volunteer_id volunteer_name kind fields', { json: ['fields'] }),
  table('users', 'users', 'id email roles volunteer_id center_ids active', { json: ['roles', 'center_ids'], booleans: ['active'] }),
  table('recurringAvailability', 'recurring_availability', 'id volunteer_id weekday start_time end_time time_zone source updated_at', { schedulingInput: true }),
  table('availabilityExceptions', 'availability_exceptions', 'id volunteer_id date kind start_time end_time time_zone reason updated_at', { schedulingInput: true }),
  table('candidateSchedules', 'candidate_schedules', 'id center_id weekday start_time end_time time_zone requested_staff_count status created_by created_at updated_at'),
  table('sessions', 'sessions', 'id kind center_id title date start_time end_time time_zone required_staff_count status source_candidate_id created_at updated_at', { schedulingInput: true }),
  table('schedulingRuns', 'scheduling_runs', 'id input_revision output_revision status started_at completed_at assignment_ids backup_ids shortfalls diagnostic', { json: ['assignment_ids', 'backup_ids', 'shortfalls'] }),
  table('assignments', 'assignments', 'id session_id volunteer_id schedule_revision status created_at cancelled_at cancellation_reason'),
  table('backups', 'backups', 'id session_id volunteer_id schedule_revision position status'),
  table('imports', 'imports', 'id source content_hash status started_at completed_at actor_id result_id participant_count matched_count unmatched staged_availability diagnostic promoted_at promoted_by', { json: ['unmatched', 'staged_availability'] }),
  table('importMappings', 'import_mappings', 'id source source_participant_id source_email source_name volunteer_id created_at updated_at updated_by'),
  table('synchronizations', 'synchronizations', 'id generation check_id last_attempt_at last_success_at effective_change_at outcome diagnostic participant_count matched_count pending_count participants pending', { json: ['participants', 'pending'] }),
  table('calendarSubscriptions', 'calendar_subscriptions', 'id volunteer_id token_hash token_ciphertext token_iv enabled created_at updated_at', { booleans: ['enabled'] }),
  table('importedAvailability', 'imported_availability', 'id volunteer_id source_participant_id source weekday start_time end_time time_zone imported_at import_run_id'),
];

function property(column: string): string {
  if (column === 'start_time') return 'start';
  if (column === 'end_time') return 'end';
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function restoreLegacyShortfalls(rows: unknown[]): unknown[] {
  return rows.map(item => {
    if (typeof item === 'object' && item !== null && 'unfilled' in item && !('missing' in item)) {
      const { unfilled, ...fields } = item;
      return { ...fields, missing: unfilled };
    }
    return item;
  });
}

export function restoreLegacyParticipants(rows: unknown[]): unknown[] {
  const participants = new Map<string, Omit<StagedParticipant, 'intervals'> & { intervals: unknown[] }>();
  const restored: unknown[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || 'intervals' in row
      || !('id' in row) || typeof row.id !== 'string'
      || !('volunteerId' in row) || typeof row.volunteerId !== 'string'
      || !('weekday' in row) || !('start' in row) || !('end' in row) || !('timeZone' in row)) {
      restored.push(row); continue;
    }
    const id = 'sourceParticipantId' in row && typeof row.sourceParticipantId === 'string' && row.sourceParticipantId
      ? row.sourceParticipantId : row.id;
    const key = JSON.stringify([id, row.volunteerId]);
    let participant = participants.get(key);
    if (!participant) {
      participant = { id, name: '', email: null, volunteerId: row.volunteerId, intervals: [] };
      participants.set(key, participant); restored.push(participant);
    }
    // Preserve interval values for the normal response schema to validate.
    const interval = { weekday: row.weekday, start: row.start, end: row.end, timeZone: row.timeZone };
    participant.intervals.push(interval);
  }
  return restored;
}

/** D1 assembles each domain record once, avoiding its per-column JS conversion. */
const projections = new Map<Table, string>();
export function rowProjection(table: Table): string {
  const cached = projections.get(table);
  if (cached) return cached;
  const fields = table.columns.flatMap((column, index) => {
    const value = table.json?.includes(column) ? `json(CASE WHEN json_valid(COALESCE(${column},'[]')) THEN COALESCE(${column},'[]') ELSE '' END)`
      : table.booleans?.includes(column) ? `json(CASE WHEN ${column}=1 THEN 'true' ELSE 'false' END)` : column;
    return [`'${table.properties[index]}'`, value];
  });
  const query = `SELECT json_object(${fields.join(',')}) AS body FROM ${table.name} ORDER BY ${table.key === 'imports' ? 'rowid' : 'id'}`;
  projections.set(table, query);
  return query;
}

export function decodeProjectedRow(table: Table, body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') throw new Error('Missing stored record');
  return restoreProjectedRow(table, JSON.parse(body) as Record<string, unknown>);
}

function restoreProjectedRow(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  if (table.key === 'imports' && Array.isArray(row.stagedAvailability)) row.stagedAvailability = restoreLegacyParticipants(row.stagedAvailability);
  if (table.key === 'schedulingRuns' && Array.isArray(row.shortfalls)) {
    row.shortfalls = restoreLegacyShortfalls(row.shortfalls);
  }
  return row;
}

export function encodeRow(table: Table, row: object): SqlValue[] {
  const fields = row as Record<string, unknown>;
  return table.columns.map((column, index) => {
    const value = fields[table.properties[index]!];
    if (table.json?.includes(column)) return JSON.stringify(value ?? []);
    if (table.booleans?.includes(column)) return value ? 1 : 0;
    if (value == null) return null;
    // One UTF-8 storage boundary: native bindings otherwise replace lone UTF-16
    // surrogates differently from the prepared JSON projection. Valid pairs stay intact.
    if (typeof value === 'string') return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
    if (typeof value === 'number') return value;
    throw new Error(`Unexpected storage value in ${table.name}.${column}`);
  });
}

/** Predict the values and binary ID order a subsequent D1 read will observe.
 * Prepared views run before commit, when newly created optional fields may still
 * be absent; storage encodes those fields as null.
 */
export function projectWrittenRows(table: Table, rows: readonly object[]): Record<string, unknown>[] {
  const encoder = new TextEncoder();
  return rows.map(row => {
    const values = encodeRow(table, row);
    const projected: Record<string, unknown> = {};
    for (const [index, column] of table.columns.entries()) {
      const value = values[index]!;
      projected[table.properties[index]!] = table.json?.includes(column) ? JSON.parse(String(value))
        : table.booleans?.includes(column) ? value === 1 : value;
    }
    return { row: restoreProjectedRow(table, projected), order: encoder.encode(String(projected.id)) };
  }).sort((a, b) => {
    for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) {
      if (a.order[i] !== b.order[i]) return a.order[i]! - b.order[i]!;
    }
    return a.order.length - b.order.length;
  }).map(item => item.row);
}

export function tableDiff(table: Table, before: Snapshot, after: Snapshot): { removed: string[]; changed: SqlValue[][] } {
  // Shared rows belong to immutable portions of the snapshot. Only changed rows
  // need SQL encoding; nested changes in cloned mutation snapshots still compare by value.
  if (before[table.key] === after[table.key]) return { removed: [], changed: [] };
  const previous = new Map(before[table.key].map(row => [row.id, row]));
  const next = new Map(after[table.key].map(row => [row.id, row]));
  if (next.size !== after[table.key].length) throw new Error(`Duplicate IDs in ${table.name}`);
  const removed = [...previous.keys()].filter(id => !next.has(id));
  const changed: SqlValue[][] = [];
  for (const [id, row] of next) {
    const old = previous.get(id);
    if (old === row) continue;
    const values = encodeRow(table, row);
    if (!old || JSON.stringify(encodeRow(table, old)) !== JSON.stringify(values)) changed.push(values);
  }
  return { removed, changed };
}
