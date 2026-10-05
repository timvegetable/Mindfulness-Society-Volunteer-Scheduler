import type { Role } from '../domain/models';

export const operations = [
  'session.me', 'volunteer.dashboard', 'volunteer.availability.recurring.update',
  'volunteer.availability.exception.create', 'volunteer.assignment.cancel',
  'admin.schedule.read', 'admin.schedule.preview', 'admin.schedule.rerun',
  'admin.import.whenIsGood.preview', 'admin.import.whenIsGood.promote',
  'admin.import.mapping.upsert', 'admin.insights.read', 'center.candidate.read',
  'center.candidate.update', 'admin.center.candidate.confirm',
] as const;
export type Operation = typeof operations[number];
export const mutatingOperations = new Set<Operation>([
  'volunteer.availability.recurring.update', 'volunteer.availability.exception.create',
  'volunteer.assignment.cancel', 'admin.schedule.rerun', 'admin.import.whenIsGood.preview',
  'admin.import.whenIsGood.promote', 'admin.import.mapping.upsert', 'center.candidate.update',
  'admin.center.candidate.confirm',
]);
export function isMutation(operation: Operation): boolean { return mutatingOperations.has(operation); }
export const operationRoles: Record<Operation, readonly Role[]> = {
  'session.me': ['volunteer', 'center-contact', 'administrator'],
  'volunteer.dashboard': ['volunteer'],
  'volunteer.availability.recurring.update': ['volunteer'],
  'volunteer.availability.exception.create': ['volunteer'],
  'volunteer.assignment.cancel': ['volunteer'],
  'admin.schedule.read': ['administrator'], 'admin.schedule.preview': ['administrator'],
  'admin.schedule.rerun': ['administrator'], 'admin.import.whenIsGood.preview': ['administrator'],
  'admin.import.whenIsGood.promote': ['administrator'], 'admin.import.mapping.upsert': ['administrator'],
  'admin.insights.read': ['administrator'], 'center.candidate.read': ['administrator', 'center-contact'],
  'center.candidate.update': ['administrator', 'center-contact'], 'admin.center.candidate.confirm': ['administrator'],
};
