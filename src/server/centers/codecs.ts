import type { SheetCodec } from '../workbook/repository.js';
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
  fromRow(row) {
    return {
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      active: row.active === true || row.active === 'true',
      revision: Number(row.revision ?? 0),
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? '')
    };
  },
  toRow(center) {
    return { ...center };
  }
};

export const centerUserCodec: SheetCodec<CenterUser> = {
  fromRow(row) {
    const roles = (parseList(row.roles) ?? []).filter((role): role is CenterUser['roles'][number] => role === 'volunteer' || role === 'administrator' || role === 'center-contact');
    const centerIds = parseList(row.centerIds);
    const result: CenterUser = {
      id: String(row.id ?? ''),
      email: String(row.email ?? ''),
      roles,
      active: row.active === true || row.active === 'true',
      revision: Number(row.revision ?? 0)
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
  fromRow(row) {
    const result: CandidateSchedule = {
      id: String(row.id ?? ''),
      centerId: String(row.centerId ?? ''),
      weekday: Number(row.weekday ?? 1) as 1 | 2 | 3 | 4 | 5,
      start: String(row.start ?? ''),
      end: String(row.end ?? ''),
      timeZone: String(row.timeZone ?? ''),
      requestedStaffCount: Number(row.requestedStaffCount ?? 0),
      status: String(row.status ?? 'candidate') as CandidateSchedule['status'],
      createdBy: String(row.createdBy ?? ''),
      revision: Number(row.revision ?? 0),
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? '')
    };
    const occurrenceDates = parseJson<unknown>(row.occurrenceDates, undefined);
    if (Array.isArray(occurrenceDates)) result.occurrenceDates = occurrenceDates.filter((date): date is string => typeof date === 'string');
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
