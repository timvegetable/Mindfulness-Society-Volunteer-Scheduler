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

/** Bundles the repository's own schema module and imports it. */
async function loadSchema() {
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
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

/** Loads WORKBOOK_TABS from the repository's own schema module. */
export async function workbookTabs() {
  return (await loadSchema()).WORKBOOK_TABS;
}

/**
 * The schema's control tabs. They are deliberately outside WORKBOOK_TABS — that
 * list defines the fixture identity digest — so anything creating or digesting
 * them has to ask for them explicitly.
 */
export async function workbookControlTabs() {
  return (await loadSchema()).WORKBOOK_CONTROL_TABS;
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
  const controlTabs = await workbookControlTabs();
  let calls = 0;
  // Reads resolve control tabs as well; the exported `tabs` list and the digest
  // stay domain-only so the pinned fixture identity is unaffected.
  const byName = new Map([...tabs, ...controlTabs].map((tab) => [tab.name, tab]));

  const definition = (name) => {
    const found = byName.get(name);
    if (!found) throw new Error(`Unknown workbook tab ${name}.`);
    return found;
  };

  let sheetIds;

  const request = async (path, init) => {
    calls += 1;
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
    },

    controlTabs,
    callCount: () => calls,

    /** The spreadsheet's tab titles with their numeric sheet ids. */
    async sheetIds() {
      if (sheetIds) return sheetIds;
      const meta = await request(`/${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
      sheetIds = new Map((meta?.sheets ?? []).flatMap((sheet) => {
        const title = sheet?.properties?.title;
        const id = sheet?.properties?.sheetId;
        return typeof title === 'string' && typeof id === 'number' ? [[title, id]] : [];
      }));
      return sheetIds;
    },

    /** Creates the named tabs when missing and writes their schema header rows. */
    async ensureTabsFor(names) {
      const meta = await this.metadata();
      const definitions = new Map([...tabs, ...controlTabs].map((tab) => [tab.name, tab]));
      const missing = names.filter((name) => !meta.sheets.includes(name));
      if (missing.length > 0) {
        await request(`/${spreadsheetId}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({
            requests: missing.map((name) => ({
              addSheet: { properties: { title: name, gridProperties: { rowCount: 1000, columnCount: Math.max(definitions.get(name)?.columns.length ?? 6, 6), frozenRowCount: 1 } } }
            }))
          })
        });
        sheetIds = undefined;
      }
      await request(`/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: names.map((name) => ({ range: `${quoted(name)}!A1`, values: [[...(definitions.get(name)?.columns ?? [])]] }))
        })
      });
      return { created: missing };
    },

    /** Writes one tab's header row. */
    async writeHeader(name, header) {
      await request(`/${spreadsheetId}/values/${encodeURIComponent(`${quoted(name)}!A1`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ range: `${quoted(name)}!A1`, majorDimension: 'ROWS', values: [[...header]] })
      });
    },

    /** Writes every named header row in one batched call. */
    async writeHeaders(entries) {
      if (entries.length === 0) return { written: 0 };
      await request(`/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: entries.map((entry) => ({ range: `${quoted(entry.name)}!A1`, values: [[...entry.header]] }))
        })
      });
      return { written: entries.length };
    },

    /**
     * Adds every protected range in one batched call. One call per protection is
     * what exhausted the 60-writes-per-minute-per-user Sheets quota on the first
     * rehearsal run.
     */
    async addProtectedRanges(entries) {
      if (entries.length === 0) return { outcomes: [] };
      const ids = await this.sheetIds();
      const requests = [];
      const outcomes = [];
      for (const entry of entries) {
        const sheetId = ids.get(entry.name);
        if (typeof sheetId !== 'number') {
          outcomes.push({ name: entry.name, applied: false, reason: `no tab named ${entry.name}` });
          continue;
        }
        requests.push({
          addProtectedRange: {
            protectedRange: {
              range: {
                sheetId,
                startRowIndex: entry.range.startRowIndex,
                startColumnIndex: entry.range.startColumnIndex,
                ...(entry.range.endRowIndex === undefined ? {} : { endRowIndex: entry.range.endRowIndex }),
                ...(entry.range.endColumnIndex === undefined ? {} : { endColumnIndex: entry.range.endColumnIndex })
              },
              description: entry.description,
              warningOnly: entry.warningOnly
            }
          }
        });
        outcomes.push({ name: entry.name, applied: true });
      }
      try {
        await request(`/${spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
        return { outcomes };
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 160) : 'unknown';
        return { outcomes: outcomes.map((outcome) => (outcome.applied ? { name: outcome.name, applied: false, reason } : outcome)) };
      }
    },

    /** Adds one protected range, the way the initializer asks for it. */
    async addProtectedRange(name, range, description, warningOnly) {
      const ids = await this.sheetIds();
      const sheetId = ids.get(name);
      if (typeof sheetId !== 'number') throw new Error(`The spreadsheet has no tab named ${name}`);
      const protectedRange = {
        range: {
          sheetId,
          startRowIndex: range.startRowIndex,
          startColumnIndex: range.startColumnIndex,
          ...(range.endRowIndex === undefined ? {} : { endRowIndex: range.endRowIndex }),
          ...(range.endColumnIndex === undefined ? {} : { endColumnIndex: range.endColumnIndex })
        },
        description,
        warningOnly
      };
      try {
        await request(`/${spreadsheetId}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [{ addProtectedRange: { protectedRange } }] }) });
        return { applied: true };
      } catch (error) {
        // The identity may not be allowed to protect ranges it does not own.
        // Report it instead of pretending the protection exists.
        return { applied: false, reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown' };
      }
    },

    /** Creates the control tabs and writes their header rows, if missing. */
    async ensureControlTabs() {
      const meta = await this.metadata();
      const missing = controlTabs.filter((tab) => !meta.sheets.includes(tab.name));
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
          data: controlTabs.map((tab) => ({ range: `${quoted(tab.name)}!A1`, values: [[...tab.columns]] }))
        })
      });
      return { createdTabs: missing.map((tab) => tab.name) };
    },

    /** Every tab the rehearsal compares: domain rows plus control state. */
    async readAllTabs() {
      const names = [...tabs.map((tab) => tab.name), ...controlTabs.map((tab) => tab.name)];
      const rows = await this.readTabs(names);
      const digests = {};
      for (const name of names) {
        digests[name] = createHash('sha256').update(JSON.stringify(rows[name] ?? [])).digest('hex');
      }
      return { rows, digests };
    },

    /** Writes one control record row (the caller supplies the serialized row). */
    async writeControlRow(name, row) {
      await request(`/${spreadsheetId}/values/${encodeURIComponent(`${quoted(name)}!A2`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ range: `${quoted(name)}!A2`, majorDimension: 'ROWS', values: [row] })
      });
      return 1;
    }
  };
}
