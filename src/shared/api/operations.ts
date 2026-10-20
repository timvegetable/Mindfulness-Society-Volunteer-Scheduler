import type { Role } from '../domain/models';

export const operations = [
  'admin.sync.read', 'admin.sync.now',
  'session.me', 'volunteer.dashboard', 'volunteer.availability.recurring.update',
  'volunteer.availability.exception.create', 'volunteer.assignment.cancel',
  'volunteer.calendar.read', 'volunteer.calendar.enable', 'volunteer.calendar.reset', 'volunteer.calendar.disable',
  'admin.schedule.read', 'admin.schedule.preview', 'admin.schedule.rerun',
  'admin.import.whenIsGood.preview', 'admin.import.whenIsGood.promote',
  'admin.import.mapping.upsert', 'admin.insights.read', 'center.candidate.read',
  'center.candidate.update', 'admin.center.candidate.confirm',
  'admin.volunteer.read', 'admin.volunteer.update', 'admin.volunteer.remove',
] as const;
export type Operation = typeof operations[number];
export const mutatingOperations = new Set<Operation>([
  'admin.sync.now',
  'volunteer.availability.recurring.update', 'volunteer.availability.exception.create',
  'volunteer.assignment.cancel', 'volunteer.calendar.enable', 'volunteer.calendar.reset', 'volunteer.calendar.disable',
  'admin.schedule.rerun', 'admin.import.whenIsGood.preview',
  'admin.import.whenIsGood.promote', 'admin.import.mapping.upsert', 'center.candidate.update',
  'admin.center.candidate.confirm', 'admin.volunteer.update', 'admin.volunteer.remove',
]);
export function isMutation(operation: Operation): boolean { return mutatingOperations.has(operation); }
export const operationRoles: Record<Operation, readonly Role[]> = {
  'admin.sync.read': ['administrator'], 'admin.sync.now': ['administrator'],
  'session.me': ['volunteer', 'center-contact', 'administrator'],
  'volunteer.dashboard': ['volunteer'],
  'volunteer.availability.recurring.update': ['volunteer'],
  'volunteer.availability.exception.create': ['volunteer'],
  'volunteer.assignment.cancel': ['volunteer'],
  'volunteer.calendar.read': ['volunteer'], 'volunteer.calendar.enable': ['volunteer'],
  'volunteer.calendar.reset': ['volunteer'], 'volunteer.calendar.disable': ['volunteer'],
  'admin.schedule.read': ['administrator'], 'admin.schedule.preview': ['administrator'],
  'admin.schedule.rerun': ['administrator'], 'admin.import.whenIsGood.preview': ['administrator'],
  'admin.import.whenIsGood.promote': ['administrator'], 'admin.import.mapping.upsert': ['administrator'],
  'admin.insights.read': ['administrator'], 'center.candidate.read': ['administrator', 'center-contact'],
  'center.candidate.update': ['administrator', 'center-contact'], 'admin.center.candidate.confirm': ['administrator'],
  'admin.volunteer.read': ['administrator'], 'admin.volunteer.update': ['administrator'],
  'admin.volunteer.remove': ['administrator'],
};
