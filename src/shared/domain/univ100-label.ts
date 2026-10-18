import type { Session } from "./models";

const courseTitle = /^\s*UNIV\s*100(?:\s*[-–]\s*(\d+))?\s*:\s*([\s\S]+?)\s*$/i;
const metadataMarker =
  /\b(?:department|dept\.?|room|location|building|campus|section|sec\.?)\b/i;
const sectionLabel = /\b(?:section|sec\.?)(?=\s|[:#-]|$)/gi;
const sectionNumber =
  /\b(?:section|sec\.?)\s*(?:(?:number|no\.?)\s*)?[:#-]?\s*(\d+)(?=$|[\s,;.)])/gi;
const numericValue = /\b\d+\b/g;
const locationMarker =
  /\b(?:room|building|location|campus|center|hall|suite)\b[^0-9()]*$/i;

interface ParentheticalSuffix {
  teacher: string;
  groups: string[];
}

function parentheticalSuffix(value: string): ParentheticalSuffix | undefined {
  const firstGroup = value.indexOf("(");
  const teacher = (firstGroup < 0 ? value : value.slice(0, firstGroup)).trim();
  if (!teacher) return undefined;
  if (firstGroup < 0) return { teacher, groups: [] };

  const groups: string[] = [];
  let cursor = firstGroup;
  while (cursor < value.length) {
    while (/\s/.test(value[cursor] ?? "")) cursor++;
    if (cursor === value.length) break;
    if (value[cursor] !== "(") return undefined;

    const start = cursor + 1;
    let depth = 1;
    cursor++;
    while (cursor < value.length && depth > 0) {
      if (value[cursor] === "(") depth++;
      else if (value[cursor] === ")") depth--;
      cursor++;
    }
    if (depth !== 0) return undefined;
    const group = value.slice(start, cursor - 1).trim();
    if (!group) return undefined;
    groups.push(group);
  }
  return groups.length ? { teacher, groups } : undefined;
}

function labelledSection(groups: readonly string[]): {
  valid: boolean;
  section?: string;
} {
  const details = groups.join(" ");
  const groupRanges: { text: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const [index, text] of groups.entries()) {
    if (index) offset++;
    groupRanges.push({ text, start: offset, end: offset + text.length });
    offset += text.length;
  }
  const labels = [...details.matchAll(sectionLabel)];
  const sectionMatches = [...details.matchAll(sectionNumber)];
  const values = sectionMatches
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  const uniqueValues = [...new Set(values)];
  if (values.length !== labels.length || uniqueValues.length > 1)
    return { valid: false };

  const sectionRanges = sectionMatches.flatMap((match) => {
    const section = match[1];
    if (section === undefined || match.index === undefined) return [];
    const start = match.index + match[0].lastIndexOf(section);
    return [[start, start + section.length]];
  });
  for (const number of details.matchAll(numericValue)) {
    const start = number.index;
    const end = start + number[0].length;
    if (
      sectionRanges.some(
        ([sectionStart, sectionEnd]) =>
          start === sectionStart && end === sectionEnd,
      )
    )
      continue;
    const group = groupRanges.find(
      (range) => start >= range.start && end <= range.end,
    );
    if (
      !group ||
      !locationMarker.test(group.text.slice(0, start - group.start))
    )
      return { valid: false };
  }
  return { valid: true, section: uniqueValues[0] };
}

function recognizableTeacher(name: string): boolean {
  return (
    !!name &&
    /\p{L}/u.test(name) &&
    !/\d/.test(name) &&
    !/[:;]/.test(name) &&
    !/^\s*(?:section|sec\.?|department|dept\.?|room|location|building|campus)\b/i.test(
      name,
    )
  );
}

function label(teacher: string, section?: string): string {
  return `UNIV100${section ? `-${section}` : ""}: ${teacher}`;
}

export function formatUniv100Label(session: Pick<Session, "title">): string {
  const courseMatch = courseTitle.exec(session.title);
  if (courseMatch) {
    const courseDetails = courseMatch[2];
    if (courseDetails === undefined) return session.title;
    const teacherAndDetails = parentheticalSuffix(courseDetails);
    if (!teacherAndDetails || !recognizableTeacher(teacherAndDetails.teacher))
      return session.title;
    const detailsSection = labelledSection(teacherAndDetails.groups);
    if (!detailsSection.valid) return session.title;
    const courseSection = courseMatch[1];
    if (
      courseSection &&
      detailsSection.section &&
      courseSection !== detailsSection.section
    )
      return session.title;
    return label(
      teacherAndDetails.teacher,
      courseSection ?? detailsSection.section,
    );
  }

  const teacherAndDetails = parentheticalSuffix(session.title.trim());
  if (
    !teacherAndDetails ||
    !teacherAndDetails.groups.length ||
    !recognizableTeacher(teacherAndDetails.teacher) ||
    teacherAndDetails.groups.some((group) => !metadataMarker.test(group))
  )
    return session.title;
  const detailsSection = labelledSection(teacherAndDetails.groups);
  if (!detailsSection.valid) return session.title;
  return label(teacherAndDetails.teacher, detailsSection.section);
}
