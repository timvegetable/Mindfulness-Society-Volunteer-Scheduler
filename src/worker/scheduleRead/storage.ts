/** Wire/storage constants shared with the small reader; no generic application runtime. */
export const representationVersion = 1;
export const representationTables = ['volunteers', 'sessions', 'schedulingRuns', 'assignments', 'backups'] as const;
export const representationMetaKey = 'scheduleViewRevision';
export const partCharacters = 16384;
export async function representationDigest(body: string, inputRevision: number | null): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${representationVersion}:${inputRevision ?? 'none'}\n${body}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
