#!/usr/bin/env node
// Checks the store listing text in docs/STORE_SUBMISSION.md against the stores' character limits.
//
// Every listing field in that document sits in a fenced block whose info string is
//   text <id> limit=<max> count=<n>
// The script counts the block's characters (code points, newlines included), fails when a field is over its limit
// or when the stated count is stale, and prints a table. Usage: node scripts/check-store-listing.mjs [file]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] || new URL('../docs/STORE_SUBMISSION.md', import.meta.url).pathname);
const text = readFileSync(file, 'utf8');
const pattern = /^```text (\S+) limit=(\d+) count=(\d+)\n([\s\S]*?)\n```$/gm;

let problems = 0;
let fields = 0;
console.log(`${'field'.padEnd(20)} ${'chars'.padStart(5)} / limit`);
for (const [, id, limit, stated, value] of text.matchAll(pattern)) {
  fields += 1;
  const count = [...value].length;
  const notes = [];
  if (count > Number(limit)) notes.push('OVER LIMIT');
  if (count !== Number(stated)) notes.push(`stated count ${stated} is stale`);
  if (id.includes('keywords') && /,\s|\s,/.test(value)) notes.push('spaces around commas');
  if (notes.length) problems += 1;
  console.log(`${id.padEnd(20)} ${String(count).padStart(5)} / ${limit}${notes.length ? `  <- ${notes.join('; ')}` : ''}`);
}
if (!fields) { console.error('No listing blocks found.'); process.exit(1); }
if (problems) { console.error(`\n${problems} field(s) need attention.`); process.exit(1); }
console.log(`\n${fields} fields within limits.`);
