import { readFile, writeFile } from 'node:fs/promises';

const outputPath = new URL('../dist/apps-script/Code.js', import.meta.url);
const source = await readFile(outputPath, 'utf8');
const footer = '\nfunction doGet(event) { return VolunteerScheduling.doGet(event); }\nfunction doPost(event) { return VolunteerScheduling.doPost(event); }\n';
if (!source.includes('function doGet(event) { return VolunteerScheduling.doGet(event); }')) await writeFile(outputPath, `${source}${footer}`);
