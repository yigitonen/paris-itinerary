import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const lines = source.split('\n');

// Interpolations that are safe by construction (loop indexes and constant category keys).
const SAFE_EXPRESSIONS = new Set(['index', 'category']);
// Mid-attribute interpolations that cannot carry trip text: numbers, the constant cover path, and ternaries between two literals.
const SAFE_INNER = [/^(progress|completion\(trip\)|coverUrl\(trip\))$/, /^[^?'"`]+(===[^?]+)?\?\s*'[\w-]*'\s*:\s*'[\w-]*'$/];

// Lines owned by another workstream that still interpolate an unescaped attribute value.
// Add `[line text fragment, 'owning workstream']` pairs here only with a reason.
const ALLOWLIST = [];

function unsafeAttributes(pattern, extraSafe = []) {
  const found = [];
  lines.forEach((line, i) => {
    for (const match of line.matchAll(pattern)) {
      const expression = match[1].trim();
      if (expression.startsWith('escapeHtml(') || SAFE_EXPRESSIONS.has(expression) || extraSafe.some((safe) => safe.test(expression))) continue;
      if (ALLOWLIST.some(([fragment]) => line.includes(fragment))) continue;
      found.push(`main.js:${i + 1} ${match[0].trim().slice(0, 80)}`);
    }
  });
  return found;
}

test('every attribute that starts with an interpolation is escaped', () => {
  assert.deepEqual(unsafeAttributes(/\s[a-z-]+="\$\{([^}]*)\}"/g), []);
});

test('no interpolation inside a quoted attribute value is left unescaped', () => {
  assert.deepEqual(unsafeAttributes(/\s[a-z-]+="[^"$]*\$\{([^}]*)\}/g, SAFE_INNER), []);
});

test('trip-derived text and numbers are escaped or coerced before reaching innerHTML', () => {
  for (const unsafe of ['${trip.currency}', '${trip.budgetTotal.toLocaleString', '${trip.style.toLocaleUpperCase', '${trip.durationDays', "'Google Places' : 'OpenStreetMap'"]) {
    assert.equal(source.includes(unsafe), false, `main.js still contains ${unsafe}`);
  }
});

test('cover images are looked up without prototype keys', () => {
  const line = lines.find((item) => item.startsWith('const coverUrl'));
  assert.ok(line?.includes('Object.hasOwn(COVER_IMAGES'), 'coverUrl must check own keys');
});
