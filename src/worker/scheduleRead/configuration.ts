import { makeReadTickets, type ReadTickets } from './tickets';
export interface ScheduleReadBindings {
  SCHEDULE_READ_MODE?: 'disabled' | 'prepare' | 'enabled';
  SCHEDULE_READ_KEY?: string;
  SCHEDULE_READ_AUDIENCE?: string;
  SCHEDULE_READ_PREVIOUS_KEY?: string;
  SCHEDULE_READ_PREVIOUS_FROM?: string;
  SCHEDULE_READ_PREVIOUS_UNTIL?: string;
  OAUTH_CLIENT_ID: string;
}
export function scheduleReadMode(env: ScheduleReadBindings): 'disabled' | 'prepare' | 'enabled' {
  const mode = env.SCHEDULE_READ_MODE ?? 'disabled';
  if (!['disabled', 'prepare', 'enabled'].includes(mode)) throw new Error('Invalid schedule read mode');
  return mode;
}
let cached: { configuration: string; tickets: ReadTickets } | undefined;
export function readTicketsFor(env: ScheduleReadBindings): ReadTickets | undefined {
  if (scheduleReadMode(env) !== 'enabled') return undefined;
  if (!env.SCHEDULE_READ_AUDIENCE || !env.OAUTH_CLIENT_ID) throw new Error('Missing schedule audience');
  const options = { secret: env.SCHEDULE_READ_KEY ?? '', audience: `${env.SCHEDULE_READ_AUDIENCE}:${env.OAUTH_CLIENT_ID}`,
    ...(env.SCHEDULE_READ_PREVIOUS_KEY ? { previousSecret: env.SCHEDULE_READ_PREVIOUS_KEY,
      previousFrom: Number(env.SCHEDULE_READ_PREVIOUS_FROM), previousUntil: Number(env.SCHEDULE_READ_PREVIOUS_UNTIL) } : {}) };
  const configuration = JSON.stringify(options);
  if (cached?.configuration !== configuration) cached = { configuration, tickets: makeReadTickets(options) };
  return cached.tickets;
}
