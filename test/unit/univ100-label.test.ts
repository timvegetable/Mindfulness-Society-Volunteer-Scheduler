import { describe, expect, it } from 'vitest';
import { formatUniv100Label } from '../../src/shared/domain/univ100-label';

describe('formatUniv100Label', () => {
  it('extracts a section and teacher from a recognizable legacy title', () => {
    expect(formatUniv100Label({ title: 'UNIV100: Professor Ada Example (Department: Biology, Room 110, Section 0123)' }))
      .toBe('UNIV100-0123: Professor Ada Example');
  });

  it('normalizes a canonical section label without losing leading zeroes', () => {
    expect(formatUniv100Label({ title: ' univ 100 - 0012 : Professor Ada Example ' }))
      .toBe('UNIV100-0012: Professor Ada Example');
  });

  it('normalizes a canonical label when no section is present', () => {
    expect(formatUniv100Label({ title: ' univ 100 : Professor Ada Example ' }))
      .toBe('UNIV100: Professor Ada Example');
  });

  it('recognizes a teacher with labelled parenthetical details even without a course prefix', () => {
    expect(formatUniv100Label({ title: 'Professor Ada Example (Department: Biology, Room 110, Section 0123)' }))
      .toBe('UNIV100-0123: Professor Ada Example');
  });

  it('preserves leading zeroes in a section number', () => {
    expect(formatUniv100Label({ title: 'Professor Ada Example (Department: Biology, Room 110, Section: 0007)' }))
      .toBe('UNIV100-0007: Professor Ada Example');
  });

  it('leaves the original title and its details available to callers', () => {
    const title = 'UNIV100: Professor Ada Example (Department: Biology, Room 110, Section 0123)';
    const session = { title };
    expect(formatUniv100Label(session)).toBe('UNIV100-0123: Professor Ada Example');
    expect(session.title).toBe(title);
  });

  it('keeps an ambiguous legacy title intact when its section is unclear', () => {
    const title = 'Professor Ada Example (Department: Biology, Room 110, Section 0123 or Section 0456)';
    expect(formatUniv100Label({ title })).toBe(title);
  });

  it('keeps a course-like legacy title when it does not identify a teacher', () => {
    const title = 'UNIV100: Intro Biology 101 (Department: Biology, Room 110, Section 0123)';
    expect(formatUniv100Label({ title })).toBe(title);
  });

  it('omits the section when a recognizable legacy title has no section', () => {
    expect(formatUniv100Label({ title: 'UNIV100: Professor Ada Example (Department: Biology, Room 110)' }))
      .toBe('UNIV100: Professor Ada Example');
  });
});
