import { serializeCalendarFeed } from '../../shared/domain/calendar-feed';
import { readCalendarFeedSnapshot } from '../repositories/database';
import type { Bindings } from '../runtime/live';
import { hashCalendarToken } from './tokens';

const responseHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

function unavailable(status: 404 | 405 | 500): Response {
  const message = status === 404 ? 'Calendar not found.' : status === 405 ? 'Use GET.' : 'Calendar feed is temporarily unavailable.';
  return new Response(message, { status, headers: { ...responseHeaders,
    'Content-Type': 'text/plain; charset=utf-8', ...(status === 405 ? { Allow: 'GET' } : {}) } });
}

/** The path credential is intentionally never included in a log or an error response. */
export async function personalCalendarFeed(request: Request, env: Bindings): Promise<Response> {
  const match = new URL(request.url).pathname.match(/^\/calendar\/([A-Za-z0-9_-]{43})\.ics$/);
  if (!match) return unavailable(404);
  if (request.method !== 'GET') return unavailable(405);
  try {
    const token = match[1]!;
    const { snapshot, subscription } = await readCalendarFeedSnapshot(env.DB, await hashCalendarToken(token));
    if (!subscription) return unavailable(404);
    const account = snapshot.users.find((user) => user.active && user.volunteerId === subscription.volunteerId && user.roles.includes('volunteer'));
    if (!account) return unavailable(404);
    const feed = await serializeCalendarFeed(snapshot, subscription.volunteerId, new Date());
    return new Response(feed, { headers: { ...responseHeaders, 'Content-Type': 'text/calendar; charset=utf-8' } });
  } catch {
    return unavailable(500);
  }
}
