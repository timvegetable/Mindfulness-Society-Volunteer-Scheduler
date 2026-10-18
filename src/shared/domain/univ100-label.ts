import type { Session } from './models';

const courseTitle = /^\s*UNIV\s*100(?:\s*[-–]\s*(\d+))?\s*:\s*(.+?)\s*$/i;
const metadataMarker = /\b(?:department|dept\.?|room|location|building|campus|section|sec\.?)\b/i;
const sectionMarker = /\b(?:section|sec\.?)\b/i;

function suffixSection(details: string): string | undefined {
  const sectionNumber = /(?:^|[\s,;])(?:section|sec\.?)\s*(?:(?:number|no\.?)\s*)?[:#-]?\s*(\d+)(?=$|[\s,;.)])/gi;
  const sections = [...new Set([...details.matchAll(sectionNumber)].map((match) => match[1]))];
  return sections.length === 1 ? sections[0] : undefined;
}

function recognizableTeacher(name: string): boolean {
  return !!name && /\p{L}/u.test(name) && !/\d/.test(name) && !/[:;]/.test(name)
    && !/^\s*(?:section|sec\.?|department|dept\.?|room|location|building|campus)\b/i.test(name);
}

export function formatUniv100Label(session: Pick<Session, 'title'>): string {
  const courseMatch = courseTitle.exec(session.title);
  const rawTeacher = courseMatch?.[2] ?? session.title.trim();
  const [, courseSection] = courseMatch ?? [];
  const detailMatch = /^(.*?)\s+\(([^()]*)\)\s*$/.exec(rawTeacher);
  if (!courseMatch && !detailMatch) return session.title;

  let teacher = rawTeacher;
  let section = courseSection;
  if (detailMatch) {
    const titleTeacher = detailMatch[1];
    const details = detailMatch[2];
    if (titleTeacher === undefined || details === undefined || !metadataMarker.test(details)) return session.title;
    teacher = titleTeacher.trim();
    const detailSection = suffixSection(details);
    if (sectionMarker.test(details) && detailSection === undefined) return session.title;
    if (section && detailSection && section !== detailSection) return session.title;
    section ??= detailSection;
  }
  if (!recognizableTeacher(teacher)) return session.title;
  return `UNIV100${section ? `-${section}` : ''}: ${teacher}`;
}
