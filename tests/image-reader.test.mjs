import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readPresetImage, IMAGE_PRESETS } from '../src/image-reader.mjs';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { createReferenceSigner } from '../src/reference-journal.mjs';

const KEY = 'fixture-provider-key';
const reply = content => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });

test('reads a preset photo with one image request to the fixed Baseten model', async () => {
  let request;
  const result = await readPresetImage({ preset: 'instruction', provider: 'baseten', apiKey: KEY, fetchImpl: async (url, init) => { request = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return reply('Harbour Print\r\nPlease pay Harbour Print 250000.00 EUR\nto DE00-TEST-0000-1289'); } });
  assert.equal(request.url, 'https://inference.baseten.co/v1/chat/completions');
  assert.equal(request.body.model, 'meta-models/muse-spark-open-1026');
  assert.equal(request.auth, `Bearer ${KEY}`);
  const [text, image] = request.body.messages[0].content;
  assert.equal(text.type, 'text'); assert.match(text.text, /exactly as written/);
  assert.equal(image.type, 'image_url');
  const bytes = readFileSync(new URL('../samples/instruction.jpg', import.meta.url));
  assert.equal(image.image_url.url, `data:image/jpeg;base64,${bytes.toString('base64')}`);
  assert.equal(request.body.tools, undefined);
  assert.equal(result.text, 'Harbour Print\nPlease pay Harbour Print 250000.00 EUR\nto DE00-TEST-0000-1289');
  assert.equal(result.kind, 'instruction'); assert.equal(result.reviewRequired, true);
  assert.equal(result.imageSha256, createHash('sha256').update(bytes).digest('hex'));
});

test('refuses unknown presets, paths and missing keys before any request', async () => {
  let calls = 0; const fetchImpl = async () => { calls += 1; return reply('x'); };
  for (const preset of ['../server.mjs', 'invoice.jpg', '__proto__', 'constructor', undefined, 7]) assert.ok((await readPresetImage({ preset, provider: 'baseten', apiKey: KEY, fetchImpl })).error);
  assert.ok((await readPresetImage({ preset: 'invoice', provider: 'baseten', apiKey: '', fetchImpl })).error);
  assert.ok((await readPresetImage({ preset: 'invoice', provider: 'other', apiKey: KEY, fetchImpl })).error);
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(IMAGE_PRESETS), ['invoice', 'instruction']);
});

test('rejects failed, empty, oversized, control-character and key-echoing replies', async () => {
  const cases = [
    async () => new Response('{}', { status: 500 }),
    async () => reply(''),
    async () => reply('x'.repeat(12001)),
    async () => reply('line\u0007bell'),
    async () => reply(`leak ${KEY}`),
    async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    async () => { throw new Error('network'); },
  ];
  for (const fetchImpl of cases) {
    const result = await readPresetImage({ preset: 'invoice', provider: 'baseten', apiKey: KEY, fetchImpl });
    assert.equal(result.text, undefined); assert.ok(result.error);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  }
  assert.equal((await readPresetImage({ preset: 'invoice', provider: 'baseten', apiKey: KEY, fetchImpl: async () => reply('```\nSupplier: Harbour Print\n```') })).text, 'Supplier: Harbour Print');
});

async function fixture(t, options = {}) {
  const referenceSigner = createReferenceSigner();
  const store = new WorkflowStore({ referenceSigner });
  const server = createServer({ store, referenceSigner, documentFlow: true, apiKey: KEY, agent: async () => { throw new Error('Unexpected execution call'); }, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { origin, post };
}

test('read-image route is document-flow only, preset-bound, and never creates a case or payment', async t => {
  let calls = 0;
  const { origin, post } = await fixture(t, { documentAgent: async () => { throw new Error('Unexpected analysis'); }, imageReader: async ({ preset, apiKey }) => { calls += 1; assert.equal(apiKey, KEY); return { text: `read ${preset}`, kind: preset, imageSha256: 'a'.repeat(64) }; } });
  for (const name of ['invoice.jpg', 'instruction.jpg']) {
    const response = await fetch(`${origin}/samples/${name}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
  }
  for (const path of ['/samples/invoice.html', '/samples/doc.css', '/samples/../server.mjs']) assert.equal((await fetch(origin + path)).status, 404);
  const ok = await post('/api/read-image', { preset: 'invoice' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.text, 'read invoice'); assert.equal(body.reviewRequired, true); assert.equal(JSON.stringify(body).includes(KEY), false);
  for (const bad of [{ preset: 'other' }, { preset: 'invoice', path: '/etc/passwd' }, {}, { preset: ['invoice'] }]) assert.equal((await post('/api/read-image', bad)).status, 400);
  assert.equal((await post('/api/read-image', { preset: 'invoice' }, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal(calls, 1);

  const legacy = await fixture(t, { documentFlow: false, imageReader: async () => { throw new Error('Unexpected read'); } });
  assert.equal((await legacy.post('/api/read-image', { preset: 'invoice' })).status, 403);
  const unconfigured = await fixture(t, { apiKey: '', imageReader: async () => { throw new Error('Unexpected read'); } });
  assert.equal((await unconfigured.post('/api/read-image', { preset: 'invoice' })).status, 503);
  const failing = await fixture(t, { imageReader: async () => ({ error: 'The model did not return a transcription.' }) });
  const failed = await failing.post('/api/read-image', { preset: 'instruction' });
  assert.equal(failed.status, 503); assert.equal((await failed.json()).error, 'The model did not return a transcription.');
});
