import type { Assignment, AvailabilityException, Backup, Session, SchedulingRun, Volunteer } from '../../shared/domain.js';
import type { RecurringAvailabilityRecord } from '../self-service/types.js';
import type { IdentityMapping, ImportedAvailabilityRecord, ImportRun } from '../imports/types.js';
import type { SheetCodec } from './repository.js';

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function text(value: unknown): string {
  return String(value ?? '');
}

function optionalText(value: unknown): string | undefined {
  const result = text(value).trim();
  return result.length > 0 ? result : undefined;
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const volunteerCodec: SheetCodec<Volunteer> = {
  fromRow(row) {
    const result: Volunteer = {
      id: text(row.id),
      name: text(row.name),
      email: text(row.email),
      lifecycleStatus: text(row.lifecycleStatus) as Volunteer['lifecycleStatus'],
      interviewStatus: text(row.interviewStatus) as Volunteer['interviewStatus'],
      readinessRank: row.readinessRank === '' || row.readinessRank === null || row.readinessRank === undefined ? null : number(row.readinessRank) as Volunteer['readinessRank'],
      recurringAvailability: [],
      revision: number(row.revision),
      createdAt: text(row.createdAt),
      updatedAt: text(row.updatedAt)
    };
    const source = optionalText(row.source);
    if (source !== undefined) result.source = source;
    return result;
  },
  toRow(value) {
    return {
      id: value.id,
      name: value.name,
      email: value.email,
      lifecycleStatus: value.lifecycleStatus,
      interviewStatus: value.interviewStatus,
      readinessRank: value.readinessRank ?? '',
      revision: value.revision,
      source: value.source ?? '',
      createdAt: value.createdAt,
      updatedAt: value.updatedAt
    };
  }
};

export const recurringAvailabilityCodec: SheetCodec<RecurringAvailabilityRecord> = {
  fromRow(row) {
    return {
      id: text(row.id),
      volunteerId: text(row.volunteerId),
      weekday: number(row.weekday) as RecurringAvailabilityRecord['weekday'],
      start: text(row.start),
      end: text(row.end),
      timeZone: text(row.timeZone),
      revision: number(row.revision),
      source: optionalText(row.source),
      updatedAt: optionalText(row.updatedAt)
    };
  },
  toRow(value) {
    return { ...value, source: value.source ?? '', updatedAt: value.updatedAt ?? '' };
  }
};

export const availabilityExceptionCodec: SheetCodec<AvailabilityException> = {
  fromRow(row) {
    const result: AvailabilityException = {
      id: text(row.id),
      volunteerId: text(row.volunteerId),
      date: text(row.date),
      kind: text(row.kind) as AvailabilityException['kind'],
      interval: { start: text(row.start), end: text(row.end), timeZone: text(row.timeZone) },
      revision: number(row.revision)
    };
    const reason = optionalText(row.reason);
    if (reason !== undefined) result.reason = reason;
    return result;
  },
  toRow(value) {
    return {
      id: value.id,
      volunteerId: value.volunteerId,
      date: value.date,
      kind: value.kind,
      start: value.interval.start,
      end: value.interval.end,
      timeZone: value.interval.timeZone,
      reason: value.reason ?? '',
      revision: value.revision
    };
  }
};

export const sessionCodec: SheetCodec<Session> = {
  fromRow(row) {
    const result: Session = {
      id: text(row.id),
      kind: text(row.kind) as Session['kind'],
      date: text(row.date),
      start: text(row.start),
      end: text(row.end),
      timeZone: text(row.timeZone),
      requiredStaffCount: number(row.requiredStaffCount),
      status: text(row.status) as Session['status'],
      revision: number(row.revision)
    };
    const centerId = optionalText(row.centerId);
    const title = optionalText(row.title);
    const sourceCandidateId = optionalText(row.sourceCandidateId);
    const createdAt = optionalText(row.createdAt);
    const updatedAt = optionalText(row.updatedAt);
    if (centerId !== undefined) result.centerId = centerId;
    if (title !== undefined) result.title = title;
    if (sourceCandidateId !== undefined) result.sourceCandidateId = sourceCandidateId;
    if (createdAt !== undefined) result.createdAt = createdAt;
    if (updatedAt !== undefined) result.updatedAt = updatedAt;
    return result;
  },
  toRow(value) {
    return {
      id: value.id,
      kind: value.kind,
      centerId: value.centerId ?? '',
      title: value.title ?? '',
      date: value.date,
      start: value.start,
      end: value.end,
      timeZone: value.timeZone,
      requiredStaffCount: value.requiredStaffCount,
      status: value.status,
      sourceCandidateId: value.sourceCandidateId ?? '',
      revision: value.revision,
      createdAt: value.createdAt ?? '',
      updatedAt: value.updatedAt ?? ''
    };
  }
};

export const assignmentCodec: SheetCodec<Assignment> = {
  fromRow(row) {
    const result: Assignment = {
      id: text(row.id),
      sessionId: text(row.sessionId),
      volunteerId: text(row.volunteerId),
      scheduleRevision: number(row.scheduleRevision),
      status: text(row.status) as Assignment['status'],
      createdAt: text(row.createdAt)
    };
    const cancelledAt = optionalText(row.cancelledAt);
    const cancellationReason = optionalText(row.cancellationReason);
    if (cancelledAt !== undefined) result.cancelledAt = cancelledAt;
    if (cancellationReason !== undefined) result.cancellationReason = cancellationReason;
    return result;
  },
  toRow(value) {
    return {
      id: value.id,
      sessionId: value.sessionId,
      volunteerId: value.volunteerId,
      scheduleRevision: value.scheduleRevision,
      status: value.status,
      createdAt: value.createdAt,
      cancelledAt: value.cancelledAt ?? '',
      cancellationReason: value.cancellationReason ?? ''
    };
  }
};

export const backupCodec: SheetCodec<Backup> = {
  fromRow(row) {
    return {
      id: text(row.id),
      sessionId: text(row.sessionId),
      volunteerId: text(row.volunteerId),
      scheduleRevision: number(row.scheduleRevision),
      position: number(row.position),
      status: text(row.status) as Backup['status']
    };
  },
  toRow(value) {
    return { ...value };
  }
};

export const schedulingRunCodec: SheetCodec<SchedulingRun> = {
  fromRow(row) {
    const result: SchedulingRun = {
      id: text(row.id),
      inputRevision: number(row.inputRevision),
      outputRevision: row.outputRevision === '' || row.outputRevision === null || row.outputRevision === undefined ? null : number(row.outputRevision),
      status: text(row.status) as SchedulingRun['status'],
      startedAt: text(row.startedAt),
      assignmentIds: parseJson<string[]>(row.assignmentIds, []),
      backupIds: parseJson<string[]>(row.backupIds, []),
      shortfalls: parseJson<SchedulingRun['shortfalls']>(row.shortfalls, [])
    };
    const completedAt = optionalText(row.completedAt);
    const diagnostic = optionalText(row.diagnostic);
    if (completedAt !== undefined) result.completedAt = completedAt;
    if (diagnostic !== undefined) result.diagnostic = diagnostic;
    return result;
  },
  toRow(value) {
    return {
      id: value.id,
      inputRevision: value.inputRevision,
      outputRevision: value.outputRevision ?? '',
      status: value.status,
      startedAt: value.startedAt,
      completedAt: value.completedAt ?? '',
      assignmentIds: json(value.assignmentIds),
      backupIds: json(value.backupIds),
      shortfalls: json(value.shortfalls),
      diagnostic: value.diagnostic ?? ''
    };
  }
};

export const importedAvailabilityCodec: SheetCodec<ImportedAvailabilityRecord> = {
  fromRow(row) {
    return {
      id: text(row.id),
      volunteerId: text(row.volunteerId),
      sourceParticipantId: text(row.sourceParticipantId),
      source: 'whenisgood',
      weekday: number(row.weekday) as ImportedAvailabilityRecord['weekday'],
      start: text(row.start),
      end: text(row.end),
      timeZone: text(row.timeZone),
      importedAt: text(row.importedAt),
      importRunId: text(row.importRunId)
    };
  },
  toRow(value) {
    return { ...value };
  }
};

type StoredIdentityMapping = IdentityMapping & { id: string };

export const identityMappingCodec: SheetCodec<StoredIdentityMapping> = {
  fromRow(row) {
    const result: StoredIdentityMapping = {
      id: text(row.id),
      source: text(row.source) as IdentityMapping['source'],
      volunteerId: text(row.volunteerId),
      createdAt: text(row.createdAt),
      updatedAt: text(row.updatedAt),
      updatedBy: text(row.updatedBy)
    };
    const sourceParticipantId = optionalText(row.sourceParticipantId);
    const sourceEmail = optionalText(row.sourceEmail);
    const sourceName = optionalText(row.sourceName);
    if (sourceParticipantId !== undefined) result.sourceParticipantId = sourceParticipantId;
    if (sourceEmail !== undefined) result.sourceEmail = sourceEmail;
    if (sourceName !== undefined) result.sourceName = sourceName;
    return result;
  },
  toRow(value) {
    return {
      id: value.id,
      source: value.source,
      sourceParticipantId: value.sourceParticipantId ?? '',
      sourceEmail: value.sourceEmail ?? '',
      sourceName: value.sourceName ?? '',
      volunteerId: value.volunteerId,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      updatedBy: value.updatedBy
    };
  }
};

export const importRunCodec: SheetCodec<ImportRun> = {
  fromRow(row) {
    const result: ImportRun = {
      id: text(row.id),
      source: 'whenisgood',
      contentHash: text(row.contentHash),
      status: text(row.status) as ImportRun['status'],
      startedAt: text(row.startedAt),
      actorId: text(row.actorId),
      participantCount: number(row.participantCount),
      matchedCount: number(row.matchedCount),
      unmatched: parseJson<ImportRun['unmatched']>(row.unmatched, []),
      stagedAvailability: parseJson<ImportRun['stagedAvailability']>(row.stagedAvailability, [])
    };
    const completedAt = optionalText(row.completedAt);
    const resultId = optionalText(row.resultId);
    const diagnostic = parseJson<ImportRun['diagnostic']>(row.diagnostic, undefined);
    const promotedAt = optionalText(row.promotedAt);
    const promotedBy = optionalText(row.promotedBy);
    if (completedAt !== undefined) result.completedAt = completedAt;
    if (resultId !== undefined) result.resultId = resultId;
    if (diagnostic !== undefined) result.diagnostic = diagnostic;
    if (promotedAt !== undefined) result.promotedAt = promotedAt;
    if (promotedBy !== undefined) result.promotedBy = promotedBy;
    return result;
  },
  toRow(value) {
    return {
      id: value.id,
      source: value.source,
      contentHash: value.contentHash,
      status: value.status,
      startedAt: value.startedAt,
      completedAt: value.completedAt ?? '',
      actorId: value.actorId,
      resultId: value.resultId ?? '',
      participantCount: value.participantCount,
      matchedCount: value.matchedCount,
      unmatched: json(value.unmatched),
      stagedAvailability: json(value.stagedAvailability),
      diagnostic: json(value.diagnostic ?? null),
      promotedAt: value.promotedAt ?? '',
      promotedBy: value.promotedBy ?? ''
    };
  }
};

export const VolunteerSheetCodec = volunteerCodec;
export const RecurringAvailabilitySheetCodec = recurringAvailabilityCodec;
export const AvailabilityExceptionSheetCodec = availabilityExceptionCodec;
export const SessionSheetCodec = sessionCodec;
export const AssignmentSheetCodec = assignmentCodec;
export const BackupSheetCodec = backupCodec;
export const SchedulingRunSheetCodec = schedulingRunCodec;
export const ImportedAvailabilitySheetCodec = importedAvailabilityCodec;
export const IdentityMappingSheetCodec = identityMappingCodec;
export const ImportRunSheetCodec = importRunCodec;
