import type { Center, Session } from './models';
import { formatUniv100Label } from './univ100-label';

export function sessionCenters(
  sessions: readonly Pick<Session, 'kind' | 'centerId'>[],
  centers: readonly Center[],
): Pick<Center, 'id' | 'name'>[] {
  const referenced = new Set(sessions.flatMap(session => session.kind === 'center' && session.centerId ? [session.centerId] : []));
  return centers.filter(center => referenced.has(center.id)).map(({ id, name }) => ({ id, name }));
}

export function formatSessionTitle(
  session: Pick<Session, 'kind' | 'centerId' | 'title'>,
  centers: readonly Pick<Center, 'id' | 'name'>[],
): string {
  if (session.kind === 'univ100') return formatUniv100Label(session);
  if (session.kind === 'center' && session.centerId) {
    const center = centers.find(item => item.id === session.centerId);
    if (center) return center.name;
  }
  return session.title.replace(/^Center session:\s*/i, '').trim() || 'Session';
}
