// Prints the body of one version's section from CHANGELOG.md.
// Usage: node scripts/changelog-section.mjs <version>   (for example 0.1.1)
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/changelog-section.mjs <version>');
  process.exit(2);
}
const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (l.startsWith('## [') || /^\[[^\]]+\]: /.test(l)));
if (end < 0) end = lines.length;
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`The ${version} section of CHANGELOG.md is empty`);
  process.exit(1);
}
console.log(body);
