#!/usr/bin/env node
// Synthetic, production-shaped non-production workbook comparison. No private
// workbook data, credential, network call, or production endpoint is used.
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { performance } from 'node:perf_hooks';

const headers = {
  Users: ['id', 'email', 'roles', 'volunteerId', 'centerIds', 'active', 'revision'],
  Volunteers: ['id', 'name', 'email', 'lifecycleStatus', 'interviewStatus', 'readinessRank', 'revision', 'source', 'createdAt', 'updatedAt'],
  RecurringAvailability: ['id', 'volunteerId', 'weekday', 'start', 'end', 'timeZone', 'revision', 'source', 'updatedAt'],
  Sessions: ['id', 'kind', 'centerId', 'title', 'date', 'start', 'end', 'timeZone', 'requiredStaffCount', 'status', 'sourceCandidateId', 'revision', 'createdAt', 'updatedAt'],
  Centers: ['id', 'name', 'active', 'revision', 'createdAt', 'updatedAt']
};
const rows = {
  Users: [['admin', 'admin@example.test', '["administrator"]', '', '[]', true, 0]],
  Volunteers: Array.from({ length: 40 }, (_, i) => [`vol-${i}`, `Volunteer ${i}`, `vol-${i}@example.test`, 'active', 'complete', i + 1, 0, 'synthetic', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']),
  RecurringAvailability: Array.from({ length: 200 }, (_, i) => [`avail-${i}`, `vol-${Math.floor(i / 5)}`, i % 5 + 1, '09:00', '17:00', 'America/New_York', 0, 'synthetic', '2026-09-01T00:00:00.000Z']),
  Sessions: Array.from({ length: 20 }, (_, i) => [`session-${i}`, 'center', `center-${i % 5}`, `Session ${i}`, '2026-10-05', '10:00', '11:00', 'America/New_York', 1, 'locked', '', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']),
  Centers: Array.from({ length: 5 }, (_, i) => [`center-${i}`, `Center ${i}`, true, 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'])
};

function services() {
  const logs = [];
  const workbook = {
    getSpreadsheetTimeZone: () => 'America/New_York',
    getSheetByName(name) {
      const values = rows[name] ?? [];
      return {
        getName: () => name,
        getLastRow: () => values.length + 1,
        getRange(row, column, count, width) {
          return { getValues: () => values.slice(row - 2, row - 2 + count).map((entry) => entry.slice(column - 1, column - 1 + width)) };
        },
        appendRow: () => { throw new Error('read-only fixture'); }
      };
    }
  };
  return {
    logs,
    console: { log: (line) => { if (typeof line === 'string' && line.startsWith('read-phases ')) logs.push(line); }, warn: () => undefined },
    SpreadsheetApp: { getActiveSpreadsheet: () => workbook },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (name) => ({ OAUTH_AUDIENCE: 'synthetic-client', WRITE_ENABLED: 'false' })[name] ?? null, setProperty: () => { throw new Error('read-only fixture'); } }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ aud: 'synthetic-client', sub: 'synthetic-subject', email: 'admin@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600 }) }) }
  };
}

function request(operation, credential = 'synthetic-credential') {
  return { postData: { contents: JSON.stringify({ operation, payload: {}, idempotencyKey: `synthetic-${Math.random()}`, ...(credential === null ? {} : { credential }) }) } };
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2; };
const sourceFiles = [
  ['unminified', 'dist/apps-script-unminified-trial/Code.js'],
  ['minified', 'dist/apps-script/Code.js']
];
for (const [variant, file] of sourceFiles) {
  const source = await readFile(file, 'utf8');
  const startup = [], schedule = [], insights = [];
  for (let i = 0; i < 24; i += 1) {
    const context = services();
    const started = performance.now();
    runInNewContext(source, context, { filename: file });
    startup.push(performance.now() - started);
    const app = context.VolunteerScheduling;
    for (const [operation, bucket] of [['admin.schedule.read', schedule], ['admin.insights.read', insights]]) {
      const began = performance.now();
      const response = JSON.parse(app.doPost(request(operation)));
      bucket.push(performance.now() - began);
      if (response.ok !== true) throw new Error(`${variant} ${operation} failed: ${response.error?.code}`);
    }
    const phases = context.logs.map((line) => JSON.parse(line.slice('read-phases '.length)));
    if (phases.length !== 2 || phases.some((record) => !record.success || !record.phasesMs || !record.sheetCallCount)) throw new Error(`${variant} lost phase timings`);
    const denied = JSON.parse(app.doPost(request('admin.schedule.read', null)));
    if (denied.ok !== false || denied.error?.code !== 'UNAUTHORIZED') throw new Error(`${variant} changed error handling`);
    if (typeof app.doGet !== 'function' || typeof app.doPost !== 'function' || typeof app.describeSignIn !== 'function') throw new Error(`${variant} lost an Apps Script entry point`);
  }
  console.log(JSON.stringify({ variant, trials: startup.length, startupMedianMs: +median(startup).toFixed(2), scheduleMedianMs: +median(schedule).toFixed(2), insightsMedianMs: +median(insights).toFixed(2) }));
}
