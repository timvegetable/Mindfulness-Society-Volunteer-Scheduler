import type { Snapshot } from '../../shared/domain/models';
import { decodeResult } from '../api/validation';
import { scheduleView } from '../api/handlers/context';
import type { CommitStatement } from '../repositories/database';
import { tables, projectWrittenRows } from '../repositories/tables';
import { representationTables, partCharacters, representationDigest, representationVersion } from './storage';

export interface PreparedSchedule { parts: string[]; digest: string; inputRevision: number | null }
/** The existing view and boundary schema own all selection and validation rules. */
export async function prepareSchedule(state: Snapshot): Promise<PreparedSchedule> {
  const stored = { ...state };
  for (const table of tables.filter(table => representationTables.some(key => key === table.key))) {
    (stored as unknown as Record<string, unknown>)[table.key] = projectWrittenRows(table, state[table.key]);
  }
  const view = decodeResult('admin.schedule.read', { ...scheduleView(stored), dataRevision: state.dataRevision,
    schedulingInputRevision: state.schedulingInputRevision });
  const { stale: _stale, dataRevision: _data, schedulingInputRevision: _input, centers: _centers, ...core } = view;
  const body = JSON.stringify(core);
  const parts: string[] = [];
  for (let offset = 0; offset < body.length;) {
    let end = Math.min(offset + partCharacters, body.length);
    if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1]!) && /[\uDC00-\uDFFF]/.test(body[end]!)) end--;
    parts.push(body.slice(offset, end)); offset = end;
  }
  return { parts, digest: await representationDigest(body, view.run?.inputRevision ?? null), inputRevision: view.run?.inputRevision ?? null };
}
export function preparedScheduleStatements(prepared: PreparedSchedule): CommitStatement[] {
  const statements: CommitStatement[] = [{ sql: 'DELETE FROM schedule_read_parts', values: [] }];
  for (let offset = 0; offset < prepared.parts.length; offset += 16) {
    statements.push({ sql: `INSERT INTO schedule_read_parts(part,body)
      SELECT CAST(key AS INTEGER)+?, value FROM json_each(?)`,
      values: [offset, JSON.stringify(prepared.parts.slice(offset, offset + 16))] });
  }
  statements.push({ sql: `INSERT INTO schedule_read_manifest(id,schema_version,source_version,input_revision,part_count,digest)
    VALUES ('schedule',?,COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='scheduleViewRevision'),0),?,?,?)
    ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version,source_version=excluded.source_version,
      input_revision=excluded.input_revision,part_count=excluded.part_count,digest=excluded.digest`,
    values: [representationVersion, prepared.inputRevision, prepared.parts.length, prepared.digest] });
  return statements;
}
