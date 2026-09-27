// Sheets helpers for the staging scripts.
//
// The workbook schema is read from the TypeScript source with esbuild (already a
// repository dependency, and the same tool the server bundle uses) so tab names
// and column order keep exactly one source of truth. The read-back path issues the
// *same* `values:batchGet` request the Worker issues, so the digest recorded here
// is the digest the Worker will compute for the same rows.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Loads WORKBOOK_TABS from the repository's own schema module. */
export async function workbookTabs() {
  const result = await build({
    entryPoints: [resolve(REPOSITORY_ROOT, 'src/server/workbook/schema.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent'
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error('The workbook schema could not be bundled.');
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return module.WORKBOOK_TABS;
}

function columnLetters(count) {
  let remaining = count;
  let result = '';
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    result = String.fromCharCode(65 + digit) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return result;
}

function quoted(name) {
  return `'${name.replaceAll("'", "''")}'`;
}

/**
 * Creates a client bound to one spreadsheet. Every method closes over the same
 * schema, so nothing mutable is shared between calls.
 */
export async function createWorkbookApi({ token, spreadsheetId }) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('An access token is required.');
  if (typeof spreadsheetId !== 'string' || spreadsheetId.trim().length === 0) throw new Error('A spreadsheet id is required.');
  const tabs = await workbookTabs();
  const byName = new Map(tabs.map((tab) => [tab.name, tab]));

  const definition = (name) => {
    const found = byName.get(name);
    if (!found) throw new Error(`Unknown workbook tab ${name}.`);
    return found;
  };

  const request = async (path, init) => {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // The body is truncated: a Sheets error is short and never contains row data.
      throw new Error(`Sheets ${init?.method ?? 'GET'} failed with ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return await response.json().catch(() => undefined);
  };

  return {
    tabs,

    async metadata() {
      const meta = await request(`/${spreadsheetId}?fields=properties.timeZone,sheets.properties.title`);
      return { timeZone: meta?.properties?.timeZone, sheets: (meta?.sheets ?? []).map((sheet) => sheet?.properties?.title) };
    },

    /**
     * Pins the spreadsheet's own time zone. Date and time cells are decoded in
     * this zone, so it is staging configuration rather than a preference, and a
     * blank workbook reports `Etc/GMT` until it is set.
     */
    async setTimeZone(timeZone) {
      await request(`/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests: [{ updateSpreadsheetProperties: { properties: { timeZone }, fields: 'timeZone' } }] })
      });
      return (await this.metadata()).timeZone;
    },

    /** Creates any missing tab and rewrites every header row. */
    async ensureTabs() {
      const meta = await this.metadata();
      const missing = tabs.filter((tab) => !meta.sheets.includes(tab.name));
      if (missing.length > 0) {
        await request(`/${spreadsheetId}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({
            requests: missing.map((tab) => ({
              addSheet: { properties: { title: tab.name, gridProperties: { rowCount: 1000, columnCount: Math.max(tab.columns.length, 6), frozenRowCount: 1 } } }
            }))
          })
        });
      }
      await request(`/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: tabs.map((tab) => ({ range: `${quoted(tab.name)}!A1`, values: [[...tab.columns]] }))
        })
      });
      return { missingTabs: missing.map((tab) => tab.name), timeZone: meta.timeZone };
    },

    /** Replaces a tab's data rows. `USER_ENTERED` lets Sheets type the cells. */
    async writeTab(name, rows) {
      const columns = definition(name).columns;
      // Lists are stored the way the workbook codecs store them: a JSON array in
      // one cell (`json()` in src/server/workbook/codecs.ts). Writing a bare array
      // is rejected by the API, and any other encoding would not read back.
      const cell = (value) => {
        if (value === undefined || value === null) return '';
        if (Array.isArray(value)) return JSON.stringify(value);
        return value;
      };
      const values = rows.map((row) => columns.map((column) => cell(row[column])));
      await request(`/${spreadsheetId}/values/${encodeURIComponent(`${quoted(name)}!A2:${columnLetters(columns.length)}`)}:clear`, { method: 'POST', body: JSON.stringify({}) });
      if (values.length === 0) return 0;
      await request(`/${spreadsheetId}/values/${encodeURIComponent(`${quoted(name)}!A2`)}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        body: JSON.stringify({ range: `${quoted(name)}!A2`, majorDimension: 'ROWS', values })
      });
      return values.length;
    },

    /** Reads tabs back exactly as the Worker does. */
    async readTabs(names) {
      const ranges = names.map((name) => `${quoted(name)}!A2:${columnLetters(definition(name).columns.length)}`);
      const query = ranges.map((range) => `ranges=${encodeURIComponent(range)}`).join('&');
      const payload = await request(`/${spreadsheetId}/values:batchGet?${query}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
      const rows = {};
      (payload?.valueRanges ?? []).forEach((valueRange, index) => {
        rows[names[index]] = valueRange?.values ?? [];
      });
      return rows;
    },

    /** The digest the Worker computes for the same rows. */
    async digest(rowsByTab) {
      const canonical = tabs.map((tab) => [tab.name, rowsByTab[tab.name] ?? null]);
      return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    },

    /** Reads every tab and returns the rows plus their digest. */
    async snapshot() {
      const rows = await this.readTabs(tabs.map((tab) => tab.name));
      return { rows, digest: await this.digest(rows) };
    }
  };
}
