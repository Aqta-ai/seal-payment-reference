import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';

async function fixture(t) {
  const referenceSigner = createReferenceSigner();
  const store = new WorkflowStore({ referenceSigner });
  const server = createServer({ store, referenceSigner, documentFlow: true, apiKey: 'fixture-provider-key', agent: async () => { throw new Error('Unexpected execution call'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the glasses page loads under the same strict headers and starts a session', async t => {
  const origin = await fixture(t);
  const page = await fetch(origin + '/glasses');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.ok(page.headers.get('set-cookie'));
  const html = await page.text();
  assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false);
  assert.equal(/\sstyle=/.test(html), false);
  for (const path of ['/glasses.js', '/glasses.css']) assert.equal((await fetch(origin + path)).status, 200);
});

test('a glasses approval without a confirmed operator request is refused', async t => {
  const origin = await fixture(t);
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const source = readFileSync(new URL('../glasses.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const CASE = ') + 13, source.indexOf('let current')).trim().replace(/;$/, '');
  const created = await (await fetch(origin + '/api/document-workflows', { method: 'POST', headers, body: JSON.stringify(Function(`return ${body}`)()) })).json();
  assert.ok(created.workflowId);
  const approve = await fetch(`${origin}/api/workflows/${created.workflowId}/approve`, { method: 'POST', headers, body: JSON.stringify({ reviewId: 'x', digest: 'y', expectedRevision: 1, confirm: true }) });
  assert.equal(approve.status, 403);
});

test('the glasses client sets text safely and adds no new route', () => {
  const source = readFileSync(new URL('../glasses.js', import.meta.url), 'utf8');
  assert.equal(/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(source), false);
  assert.deepEqual([...new Set(source.match(/\/api\/[a-z-]+/g))].sort(), ['/api/config', '/api/document-workflows', '/api/workflows']);
  assert.equal(/text-transform/.test(readFileSync(new URL('../glasses.css', import.meta.url), 'utf8')), false);
});
