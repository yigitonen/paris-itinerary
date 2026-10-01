import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Execute the actual header builders without starting Deno's HTTP server or
// contacting providers. These tests catch incorrect native-origin handling.
for (const [file, builder] of [['./index.ts', 'corsHeaders'], ['../places/index.ts', 'cors']]) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const headerCode = source.slice(source.indexOf('const allowedOrigins'), source.indexOf('function json'));
  const headersFor = runInNewContext(`${stripTypeScriptTypes(headerCode)}; ${builder}`, {
    Deno: { env: { get: () => '' } }
  });
  test(`${file} permits the configured iOS and Android app origins`, () => {
    for (const origin of ['roamly://localhost', 'https://localhost']) {
      const headers = headersFor(new Request('https://api.example.com', { headers: { Origin: origin } }));
      assert.equal(headers['Access-Control-Allow-Origin'], origin);
      assert.equal(headers.Vary, 'Origin');
    }
  });
  test(`${file} does not permit untrusted origins`, () => {
    const headers = headersFor(new Request('https://api.example.com', { headers: { Origin: 'https://untrusted.example' } }));
    assert.equal(headers['Access-Control-Allow-Origin'], undefined);
  });
}
