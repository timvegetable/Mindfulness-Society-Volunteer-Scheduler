import { verifyReadSession } from './identity';
import { readSchedule } from './reader';
import type { ScheduleReadBindings } from './configuration';
/** Private service-binding entrypoint without the scheduler or generic dispatcher. */
export default {
  async fetch(request: Request, env: ScheduleReadBindings & { DB: D1Database }) {
    if (new URL(request.url).pathname === '/internal/read-session') return verifyReadSession(request, env);
    if (new URL(request.url).pathname === '/internal/session') return (await import('./exchange')).exchangeSession(request, env);
    return readSchedule(request, env);
  },
};
