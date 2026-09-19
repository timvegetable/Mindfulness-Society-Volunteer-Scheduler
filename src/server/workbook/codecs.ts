import type { Assignment, AvailabilityException, Backup, Session, SchedulingRun, Volunteer } from '../../shared/domain.js';
import type { RecurringAvailabilityRecord } from '../self-service/types.js';
import type { IdentityMapping, ImportedAvailabilityRecord, ImportRun } from '../imports/types.js';
import type { SheetCodec } from './repository.js';
import { cellClock, cellDate, cellInstant, cellNumber, cellText, optionalCellInstant, optionalCellText } from './sheet-values.js';

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

export const volunteerCodec: SheetCodec<Volunteer> = {
  fromRow(row, context) {
    const result: Volunteer = {
      id: cellText(row.id),
      name: cellText(row.name),
      email: cellText(row.email),
      lifecycleStatus: cellText(row.lifecycleStatus) as Volunteer['lifecycleStatus'],
      interviewStatus: cellText(row.interviewStatus) as Volunteer['interviewStatus'],
      readinessRank: row.readinessRank === '' || row.readinessRank === null || row.readinessRank === undefined ? null : cellNumber(row.readinessRank) as Volunteer['readinessRank'],
      recurringAvailability: [],
      revision: cellNumber(row.revision),
      createdAt: cellInstant(row.createdAt, context),
      updatedAt: cellInstant(row.updatedAt, context)
    };
    const source = optionalCellText(row.source);
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
  fromRow(row, context) {
    return {
      id: cellText(row.id),
      volunteerId: cellText(row.volunteerId),
      weekday: cellNumber(row.weekday) as RecurringAvailabilityRecord['weekday'],
      start: cellClock(row.start, context),
      end: cellClock(row.end, context),
      timeZone: cellText(row.timeZone),
      revision: cellNumber(row.revision),
      source: optionalCellText(row.source),
      updatedAt: optionalCellInstant(row.updatedAt, context)
    };
  },
  toRow(value) {
    return { ...value, source: value.source ?? '', updatedAt: value.updatedAt ?? '' };
  }
};

export const availabilityExceptionCodec: SheetCodec<AvailabilityException> = {
  fromRow(row, context) {
    const result: AvailabilityException = {
      id: cellText(row.id),
      volunteerId: cellText(row.volunteerId),
      date: cellDate(row.date, context),
      kind: cellText(row.kind) as AvailabilityException['kind'],
      interval: { start: cellClock(row.start, context), end: cellClock(row.end, context), timeZone: cellText(row.timeZone) },
      revision: cellNumber(row.revision)
    };
    const reason = optionalCellText(row.reason);
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
  fromRow(row, context) {
    const result: Session = {
      id: cellText(row.id),
      kind: cellText(row.kind) as Session['kind'],
      date: cellDate(row.date, context),
      start: cellClock(row.start, context),
      end: cellClock(row.end, context),
      timeZone: cellText(row.timeZone),
      requiredStaffCount: cellNumber(row.requiredStaffCount),
      status: cellText(row.status) as Session['status'],
      revision: cellNumber(row.revision)
    };
    const centerId = optionalCellText(row.centerId);
    const title = optionalCellText(row.title);
    const sourceCandidateId = optionalCellText(row.sourceCandidateId);
    const createdAt = optionalCellInstant(row.createdAt, context);
    const updatedAt = optionalCellInstant(row.updatedAt, context);
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
  fromRow(row, context) {
    const result: Assignment = {
      id: cellText(row.id),
      sessionId: cellText(row.sessionId),
      volunteerId: cellText(row.volunteerId),
      scheduleRevision: cellNumber(row.scheduleRevision),
      status: cellText(row.status) as Assignment['status'],
      createdAt: cellInstant(row.createdAt, context)
    };
    const cancelledAt = optionalCellInstant(row.cancelledAt, context);
    const cancellationReason = optionalCellText(row.cancellationReason);
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
  fromRow(row, context) {
    return {
      id: cellText(row.id),
      sessionId: cellText(row.sessionId),
      volunteerId: cellText(row.volunteerId),
      scheduleRevision: cellNumber(row.scheduleRevision),
      position: cellNumber(row.position),
      status: cellText(row.status) as Backup['status']
    };
  },
  toRow(value) {
    return { ...value };
  }
};

export const schedulingRunCodec: SheetCodec<SchedulingRun> = {
  fromRow(row, context) {
    const result: SchedulingRun = {
      id: cellText(row.id),
      inputRevision: cellNumber(row.inputRevision),
      outputRevision: row.outputRevision === '' || row.outputRevision === null || row.outputRevision === undefined ? null : cellNumber(row.outputRevision),
      status: cellText(row.status) as SchedulingRun['status'],
      startedAt: cellInstant(row.startedAt, context),
      assignmentIds: parseJson<string[]>(row.assignmentIds, []),
      backupIds: parseJson<string[]>(row.backupIds, []),
      shortfalls: parseJson<SchedulingRun['shortfalls']>(row.shortfalls, [])
    };
    const completedAt = optionalCellInstant(row.completedAt, context);
    const diagnostic = optionalCellText(row.diagnostic);
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
  fromRow(row, context) {
    return {
      id: cellText(row.id),
      volunteerId: cellText(row.volunteerId),
      sourceParticipantId: cellText(row.sourceParticipantId),
      source: 'whenisgood',
      weekday: cellNumber(row.weekday) as ImportedAvailabilityRecord['weekday'],
      start: cellClock(row.start, context),
      end: cellClock(row.end, context),
      timeZone: cellText(row.timeZone),
      importedAt: cellInstant(row.importedAt, context),
      importRunId: cellText(row.importRunId)
    };
  },
  toRow(value) {
    return { ...value };
  }
};

type StoredIdentityMapping = IdentityMapping & { id: string };

export const identityMappingCodec: SheetCodec<StoredIdentityMapping> = {
  fromRow(row, context) {
    const result: StoredIdentityMapping = {
      id: cellText(row.id),
      source: cellText(row.source) as IdentityMapping['source'],
      volunteerId: cellText(row.volunteerId),
      createdAt: cellInstant(row.createdAt, context),
      updatedAt: cellInstant(row.updatedAt, context),
      updatedBy: cellText(row.updatedBy)
    };
    const sourceParticipantId = optionalCellText(row.sourceParticipantId);
    const sourceEmail = optionalCellText(row.sourceEmail);
    const sourceName = optionalCellText(row.sourceName);
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
  fromRow(row, context) {
    const result: ImportRun = {
      id: cellText(row.id),
      source: 'whenisgood',
      contentHash: cellText(row.contentHash),
      status: cellText(row.status) as ImportRun['status'],
      startedAt: cellInstant(row.startedAt, context),
      actorId: cellText(row.actorId),
      participantCount: cellNumber(row.participantCount),
      matchedCount: cellNumber(row.matchedCount),
      unmatched: parseJson<ImportRun['unmatched']>(row.unmatched, []),
      stagedAvailability: parseJson<ImportRun['stagedAvailability']>(row.stagedAvailability, [])
    };
    const completedAt = optionalCellInstant(row.completedAt, context);
    const resultId = optionalCellText(row.resultId);
    const diagnostic = parseJson<ImportRun['diagnostic']>(row.diagnostic, undefined);
    const promotedAt = optionalCellInstant(row.promotedAt, context);
    const promotedBy = optionalCellText(row.promotedBy);
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
