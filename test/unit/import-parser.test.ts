import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseWhenIsGood, stageParticipants } from '../../src/shared/imports/whenIsGood';
import type { ImportParticipant, Volunteer } from '../../src/shared/domain/models';
const fixture = (name: string) => readFileSync(new URL(`../fixtures/import-${name}.html`, import.meta.url), 'utf8');
const zone = 'America/New_York';
const volunteer = (id: string, email: string): Volunteer => ({ id, email, name: id, lifecycleStatus: 'active', interviewStatus: 'complete', readinessRank: 1 });
describe('WhenIsGood parser', () => {
  it.each(['normal', 'native'])('parses %s participants, creates stable IDs and merges adjacent intervals', format => {
    const result = parseWhenIsGood(fixture(format), zone);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.participants).toEqual([
      { id: 'a', name: 'Alice', email: format === 'normal' ? 'alice@example.test' : null, intervals: [{ weekday: 1, start: '09:00', end: '11:00', timeZone: zone }] },
      { id: 'participant-2', name: 'Unmatched', email: format === 'normal' ? 'other@example.test' : null, intervals: [] },
    ]);
  });
  it('decodes entities and nested keyed collections, alternate fields, dates, minute and AM/PM clocks', () => {
    const result = parseWhenIsGood(fixture('alternate'), zone);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.participants).toEqual([{ id: 'p1', name: 'Dana & Lee', email: 'dana@example.test', intervals: [
      { weekday: 1, start: '09:00', end: '11:00', timeZone: zone },
      { weekday: 2, start: '13:30', end: '15:00', timeZone: zone },
      { weekday: 7, start: '09:00', end: '10:00', timeZone: 'Europe/London' },
    ] }]);
  });
  it('handles brackets and escaped quotes inside names and array tuples', () => {
    const html = `<script>if (true) { x = ${JSON.stringify({ attendees: [{ label: 'A "quoted" [name]', uid: 'u', slots: [['Wed', '12:00 am', '12:30 am'], [5, 780, 840, zone]] }] })}; }</script>`;
    const result = parseWhenIsGood(html, zone);
    expect(result.ok && result.participants[0]?.intervals.map(item => item.start)).toEqual(['00:00', '13:00']);
  });
  it('does not execute script and reports unrecognizable results', () => {
    expect(parseWhenIsGood(fixture('invalid'), zone)).toEqual({ ok: false, error: expect.any(String) });
  });
  it('ignores malformed dates, clocks, zones and reversed intervals', () => {
    const result = parseWhenIsGood(JSON.stringify({ users: [{ name: 'A', times: [
      ['2026-02-30', '09:00', '10:00'], [1, '25:00', '26:00'], [1, '11:00', '10:00'], [1, '09:00', '10:00', 'bad-zone'], [2, '09:00', '10:00'],
    ] }] }), zone);
    expect(result.ok && result.participants[0]?.intervals).toEqual([{ weekday: 2, start: '09:00', end: '10:00', timeZone: zone }]);
  });
});
describe('participant matching', () => {
  const participants: ImportParticipant[] = [{ id: 'a', name: 'Alice', email: ' ALICE@example.test ', intervals: [] }, { id: 'b', name: 'Bob', email: null, intervals: [] }];
  it('matches normalized email and preserves unmatched participants', () => {
    const result = stageParticipants(participants, [volunteer('v1', 'alice@example.test')], []);
    expect(result.matchedCount).toBe(1);
    expect(result.unmatched).toEqual([participants[1]]);
    expect(result.stagedAvailability.map(item => item.volunteerId)).toEqual(['v1', null]);
  });
  it('falls back to a unique normalized name while leaving ambiguous names for review', () => {
    const roster = [
      { ...volunteer('v1', 'alice@example.test'), name: 'Alice' },
      { ...volunteer('v2', 'bob@example.test'), name: ' Bob  Smith ' },
      { ...volunteer('v3', 'other@example.test'), name: 'Alice' },
    ];
    const result = stageParticipants([
      { id: 'a', name: 'Alice', email: 'alice@example.test', intervals: [] },
      { id: 'b', name: 'bob smith', email: null, intervals: [] },
      { id: 'c', name: 'Alice', email: null, intervals: [] },
      { id: 'd', name: 'Unknown', email: null, intervals: [] },
    ], roster, []);
    expect(result.stagedAvailability.map(item => item.volunteerId)).toEqual(['v1', 'v2', null, null]);
    expect(result.matchedCount).toBe(2);
  });
  it('manual participant ID mapping overrides automatic email and other mappings', () => {
    const result = stageParticipants(participants, [volunteer('v1', 'alice@example.test'), volunteer('v2', 'second@example.test')], [
      { id: 'm1', source: 'whenIsGood', sourceEmail: 'alice@example.test', volunteerId: 'v1' },
      { id: 'm2', source: 'whenIsGood', sourceParticipantId: 'a', volunteerId: 'v2' },
      { id: 'm3', source: 'whenIsGood', sourceName: ' Bob ', volunteerId: 'v1' },
    ]);
    expect(result.stagedAvailability.map(item => item.volunteerId)).toEqual(['v2', 'v1']);
  });
  it('does not guess ambiguous email or name matches or apply another source mapping', () => {
    expect(stageParticipants(participants, [volunteer('v1', 'alice@example.test'), volunteer('v2', 'alice@example.test')], [{ id: 'm', source: 'other', sourceParticipantId: 'a', volunteerId: 'v1' }]).matchedCount).toBe(0);
  });
});
