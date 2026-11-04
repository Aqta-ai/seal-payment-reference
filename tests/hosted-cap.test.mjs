import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { WorkflowStore } from '../src/workflow.mjs';
import { DemoOwnerStore } from '../src/demo-owners.mjs';
import { demoAccessFixture, hostedRequest, withResponseCookies } from './demo-access-fixture.mjs';
import { MODEL_BUDGET_EXHAUSTED } from '../src/model-budget.mjs';

const ORIGIN = 'https://demo.example.test', HOST = 'demo.example.test';
const agent = async ({ beforeModelRequest }) => beforeModelRequest()
  ? { status: 'completed', requestCount: 1, trace: [] }
  : { ...MODEL_BUDGET_EXHAUSTED, requestCount: 0, trace: [] };

test('the hosted config says it is hosted, and an environment cap is a whole number', async t => {
  const store = new WorkflowStore(), demoOwners = new DemoOwnerStore(), access = demoAccessFixture();
  const server = createServer({ store, agent, apiKey: 'test-only-provider-key', demoAccess: access.demoAccess, demoOwners, hosted: { origin: ORIGIN } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); demoOwners.close(); });
  const request = hostedRequest(server, { host: HOST, origin: ORIGIN });
  const user = access.signIn();
  const page = await request('GET', '/', { cookie: user.cookie });
  const cookie = withResponseCookies(user.cookie, page.headers['set-cookie'] || []);
  const config = (await request('GET', '/api/config', { cookie })).json();
  assert.equal(config.hosted, true);
  assert.equal(config.simulation, true);
});

test('a bad SANDBOX_GLOBAL_MODEL_CALLS_DAY refuses to start the hosted server', () => {
  const previous = process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY;
  process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY = 'twelve';
  try {
    const store = new WorkflowStore(), demoOwners = new DemoOwnerStore(), access = demoAccessFixture();
    assert.throws(() => createServer({ store, agent, apiKey: 'k', demoAccess: access.demoAccess, demoOwners, hosted: { origin: ORIGIN } }), /whole number/);
    store.close(); demoOwners.close();
  } finally {
    if (previous === undefined) delete process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY; else process.env.SANDBOX_GLOBAL_MODEL_CALLS_DAY = previous;
  }
});
