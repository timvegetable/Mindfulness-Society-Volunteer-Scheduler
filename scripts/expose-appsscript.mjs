import { readFile, writeFile } from 'node:fs/promises';

const outputPath = new URL('../dist/apps-script/Code.js', import.meta.url);
const source = await readFile(outputPath, 'utf8');
const trampolines = [
  'function doGet(event) { return VolunteerScheduling.doGet(event); }',
  'function doPost(event) { return VolunteerScheduling.doPost(event); }',
  'function initializeWorkbook() { return VolunteerScheduling.initializeWorkbook(); }',
  'function checkWorkbookSchema() { return VolunteerScheduling.checkWorkbookSchema(); }'
];
const missing = trampolines.filter((line) => !source.includes(line));
if (missing.length > 0) await writeFile(outputPath, `${source}\n${missing.join('\n')}\n`);
