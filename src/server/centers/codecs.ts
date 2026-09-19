import type { SheetCodec } from '../workbook/repository.js';
import { cellBoolean, cellClock, cellDate, cellInstant, cellNumber, cellText } from '../workbook/sheet-values.js';
import type { CandidateSchedule, Center, CenterUser } from './models.js';

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseList(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = parseJson<unknown>(trimmed, undefined);
  if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}


export const centerCodec: SheetCodec<Center> = {
  fromRow(row, context) {
    return {
      id: cellText(row.id),
      name: cellText(row.name),
      active: cellBoolean(row.active),
      revision: cellNumber(row.revision),
      createdAt: cellInstant(row.createdAt, context),
      updatedAt: cellInstant(row.updatedAt, context)
    };
  },
  toRow(center) {
    return { ...center };
  }
};

export const centerUserCodec: SheetCodec<CenterUser> = {
  fromRow(row, context) {
    const roles = (parseList(row.roles) ?? []).filter((role): role is CenterUser['roles'][number] => role === 'volunteer' || role === 'administrator' || role === 'center-contact');
    const centerIds = parseList(row.centerIds);
    const result: CenterUser = {
      id: cellText(row.id),
      email: cellText(row.email),
      roles,
      active: cellBoolean(row.active),
      revision: cellNumber(row.revision)
    };
    if (typeof row.volunteerId === 'string' && row.volunteerId.length > 0) result.volunteerId = row.volunteerId;
    if (Array.isArray(centerIds)) result.centerIds = [...centerIds];
    return result;
  },
  toRow(user) {
    const row: Record<string, unknown> = {
      id: user.id,
      email: user.email,
      roles: json(user.roles),
      active: user.active,
      revision: user.revision
    };
    if (user.volunteerId) row.volunteerId = user.volunteerId;
    if (user.centerIds) row.centerIds = json(user.centerIds);
    return row;
  }
};

export const candidateScheduleCodec: SheetCodec<CandidateSchedule> = {
  fromRow(row, context) {
    const result: CandidateSchedule = {
      id: cellText(row.id),
      centerId: cellText(row.centerId),
      weekday: cellNumber(row.weekday, 1) as 1 | 2 | 3 | 4 | 5,
      start: cellClock(row.start, context),
      end: cellClock(row.end, context),
      timeZone: cellText(row.timeZone),
      requestedStaffCount: cellNumber(row.requestedStaffCount),
      status: cellText(row.status) as CandidateSchedule['status'],
      createdBy: cellText(row.createdBy),
      revision: cellNumber(row.revision),
      createdAt: cellInstant(row.createdAt, context),
      updatedAt: cellInstant(row.updatedAt, context)
    };
    const occurrenceDates = parseJson<unknown>(row.occurrenceDates, undefined);
    if (Array.isArray(occurrenceDates)) result.occurrenceDates = occurrenceDates.map((date) => cellDate(date, context));
    return result;
  },
  toRow(candidate) {
    const row: Record<string, unknown> = { ...candidate };
    if (candidate.occurrenceDates) row.occurrenceDates = json(candidate.occurrenceDates);
    return row;
  }
};

export const CenterSheetCodec = centerCodec;
export const CenterUserSheetCodec = centerUserCodec;
export const CandidateScheduleSheetCodec = candidateScheduleCodec;
