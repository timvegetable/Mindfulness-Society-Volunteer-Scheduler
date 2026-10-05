import type { Snapshot } from '../../shared/domain/models';

type TableKey = Exclude<keyof Snapshot, 'dataRevision' | 'schedulingInputRevision'>;
type SqlValue = string | number | null;

interface Table {
  key: TableKey;
  name: string;
  columns: readonly string[];
  json?: readonly string[];
  booleans?: readonly string[];
  schedulingInput?: boolean;
}

function table(key: TableKey, name: string, columns: string, extra: Omit<Table, 'key' | 'name' | 'columns'> = {}): Table {
  return { key, name, columns: columns.split(' '), ...extra };
}

/** Parent tables precede their children, so inserts preserve foreign keys. */
export const tables: readonly Table[] = [
  table('centers', 'centers', 'id name active created_at updated_at', { booleans: ['active'] }),
  table('volunteers', 'volunteers', 'id name email lifecycle_status interview_status readiness_rank source created_at updated_at', { schedulingInput: true }),
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
  table('importedAvailability', 'imported_availability', 'id volunteer_id source_participant_id source weekday start_time end_time time_zone imported_at import_run_id'),
];

function property(column: string): string {
  if (column === 'start_time') return 'start';
  if (column === 'end_time') return 'end';
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function decodeJson(table: Table, column: string, value: unknown): unknown {
  const decoded: unknown = JSON.parse(typeof value === 'string' ? value : '[]');
  // Older scheduling runs persisted the missing staff count as "unfilled".
  if (table.name === 'scheduling_runs' && column === 'shortfalls' && Array.isArray(decoded)) {
    return decoded.map(item => {
      if (typeof item === 'object' && item !== null && 'unfilled' in item && !('missing' in item)) {
        const { unfilled, ...fields } = item;
        return { ...fields, missing: unfilled };
      }
      return item;
    });
  }
  return decoded;
}

export function decodeRow(table: Table, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(table.columns.map(column => {
    const value = row[column];
    const decoded: unknown = table.json?.includes(column)
      ? decodeJson(table, column, value)
      : table.booleans?.includes(column) ? value === 1 : value;
    return [property(column), decoded];
  }));
}

export function encodeRow(table: Table, row: object): SqlValue[] {
  const fields = row as Record<string, unknown>;
  return table.columns.map(column => {
    const value = fields[property(column)];
    if (table.json?.includes(column)) return JSON.stringify(value ?? []);
    if (table.booleans?.includes(column)) return value ? 1 : 0;
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number') return value;
    throw new Error(`Unexpected storage value in ${table.name}.${column}`);
  });
}

export function tableDiff(table: Table, before: Snapshot, after: Snapshot): { removed: string[]; changed: SqlValue[][] } {
  const previous = new Map(before[table.key].map(row => [row.id, encodeRow(table, row)]));
  const next = new Map(after[table.key].map(row => [row.id, encodeRow(table, row)]));
  if (next.size !== after[table.key].length) throw new Error(`Duplicate IDs in ${table.name}`);
  const removed = [...previous.keys()].filter(id => !next.has(id));
  const changed = [...next].filter(([id, values]) => JSON.stringify(previous.get(id)) !== JSON.stringify(values)).map(([, values]) => values);
  return { removed, changed };
}
