import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { makeDatabase, type DatabaseService } from '../../src/worker/services/Database';

export interface TestDatabase {
  db: D1Database;
  service: DatabaseService;
  dispose: () => Promise<void>;
}

/** Real workerd/Miniflare D1, including D1 transactional batch semantics. */
export async function createTestDatabase(options: { seed?: boolean; scheduleReads?: boolean } = {}): Promise<TestDatabase> {
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("local D1 integration test"); } };',
    compatibilityDate: '2026-10-04',
    d1Databases: ['DB'],
  }));
  try {
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    const schema = await readFile(new URL('../../schema.sql', import.meta.url), 'utf8');
    await applySql(db, schema);
    if (options.seed !== false) {
      const seed = await readFile(new URL('../fixtures/seed.sql', import.meta.url), 'utf8');
      await applySql(db, seed);
    }
    return { db, service: makeDatabase(db, options.scheduleReads), dispose: () => miniflare.dispose() };
  } catch (error) {
    await miniflare.dispose();
    throw error;
  }
}

/** Used only for the fixed local DDL and synthetic test fixture. */
export async function applySql(db: D1Database, sql: string): Promise<void> {
  const statements: string[] = [];
  let pending = '';
  for (const piece of sql.split(';')) {
    pending += piece + ';';
    if (/CREATE\s+TRIGGER/i.test(pending) && !/END;\s*$/i.test(pending)) continue;
    const statement = pending.trim(); pending = '';
    if (statement !== ';') statements.push(statement);
  }
  await db.batch(statements.map(statement => db.prepare(statement)));
}
