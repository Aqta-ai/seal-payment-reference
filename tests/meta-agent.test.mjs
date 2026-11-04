import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_APPROVAL } from "../src/sandbox.mjs";
import { runAgent, tools } from "../src/meta-agent.mjs";

const API_KEY = "synthetic-test-key";
const tuple = {
  operationId: "invoice_demo_250k",
  supplierId: DEMO_APPROVAL.supplierId,
  beneficiaryAccount: DEMO_APPROVAL.beneficiaryAccount,
  amountMinor: DEMO_APPROVAL.amountMinor,
  currency: DEMO_APPROVAL.currency,
};
const intent = { approvalId: DEMO_APPROVAL.id, ...tuple };
const changedTuple = { ...tuple, beneficiaryAccount: "DE00-TEST-0000-9542" };
const documents = { invoice: tuple, approval: { ...DEMO_APPROVAL, operationId: tuple.operationId } };

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function completion(message, extra = {}) {
  return {
    id: "synthetic-completion",
    model: "muse-spark-1.3",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
    ...extra,
  };
}

function mockProvider(responses) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.meta.ai/v1/chat/completions");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`);
      requests.push(JSON.parse(options.body));
      assert.ok(responses.length, "Unexpected extra provider request");
      const next = responses.shift();
      return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? next), {
        status: next.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

function options(provider, toolHandler, overrides = {}) {
  return { documents, apiKey: API_KEY, fetchImpl: provider.fetchImpl, toolHandler, ...overrides };
}

function toolMessages(result) {
  return result.messages.filter((message) => message.role === "tool");
}

test("the only tools are read, execute and request approval with closed schemas", () => {
  assert.deepEqual(tools.map((tool) => tool.function.name), ["read_documents", "execute_payment", "request_approval"]);
  assert.equal(tools.some((tool) => /^(approve|approval)$/.test(tool.function.name)), false);
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.deepEqual(tool.function.parameters.required, Object.keys(tool.function.parameters.properties));
  }
  assert.deepEqual(tools[0].function.parameters.required, []);
  assert.equal(Object.hasOwn(tools[2].function.parameters.properties, "approvalId"), false);
});

test("actual model arguments dispatch and the actual local read result returns to the next request", async () => {
  const readCall = toolCall("read_1", "read_documents", {});
  const payCall = toolCall("pay_1", "execute_payment", intent);
  const provider = mockProvider([
    completion({ content: null, tool_calls: [readCall] }),
    completion({ content: null, tool_calls: [payCall] }),
  ]);
  const dispatched = [];
  const paymentResult = { status: "committed", payment: { ...intent, id: "pay_1" } };
  const result = await runAgent(options(provider, async (name, args) => {
    dispatched.push({ name, args });
    return name === "read_documents" ? documents : paymentResult;
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.provider, "meta");
  assert.equal(result.model, "muse-spark-1.3");
  assert.ok(result.trace.every((entry) => entry.provider === "meta" && entry.model === "muse-spark-1.3"));
  assert.equal(result.requestCount, 2);
  assert.deepEqual(dispatched, [{ name: "read_documents", args: {} }, { name: "execute_payment", args: intent }]);
  const secondRequest = provider.requests[1];
  assert.deepEqual(secondRequest.messages.at(-2).tool_calls, [readCall]);
  assert.deepEqual(secondRequest.messages.at(-1), { role: "tool", tool_call_id: "read_1", content: JSON.stringify(documents) });
  assert.equal(provider.requests[0].model, "muse-spark-1.3");
  assert.equal(provider.requests[0].tool_choice, "auto");
  assert.equal(provider.requests[0].parallel_tool_calls, false);
  assert.equal(provider.requests[0].reasoning_effort, "minimal");
  assert.equal(provider.requests[0].max_completion_tokens, 2048);
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
  assert.deepEqual(JSON.parse(toolMessages(result).at(-1).content), paymentResult);
  const payTrace = result.trace.find((entry) => entry.type === "tool_result" && entry.name === "execute_payment");
  assert.equal(payTrace.tool_call_id, "pay_1");
  assert.deepEqual(payTrace.arguments, intent);
  assert.deepEqual(payTrace.result, paymentResult);
  assert.equal(payTrace.dispatched, true);
  assert.ok(Number.isFinite(payTrace.latencyMs));
  const responses = result.trace.filter((entry) => entry.type === "model_response");
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[1].response.choices[0].message.tool_calls, [payCall]);
  assert.ok(responses.every((entry) => Number.isFinite(entry.latencyMs) && entry.usage.total_tokens === 8));
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("a refused requested tuple is returned to the model, which can request review and pause", async () => {
  const changedIntent = { approvalId: intent.approvalId, ...changedTuple };
  const blocked = { status: "blocked", reason: "Beneficiary account does not match approval.", payment: null };
  const pending = { status: "awaiting_human", pendingReview: { reviewId: "review_demo", tuple: changedTuple } };
  const provider = mockProvider([
    completion({ tool_calls: [toolCall("read_1", "read_documents", {})] }),
    completion({ tool_calls: [toolCall("pay_changed", "execute_payment", changedIntent)] }),
    completion({ tool_calls: [toolCall("review_1", "request_approval", changedTuple)] }),
  ]);
  const dispatched = [];
  const result = await runAgent(options(provider, async (name, args) => {
    dispatched.push({ name, args });
    if (name === "read_documents") return documents;
    return name === "execute_payment" ? blocked : pending;
  }));

  assert.equal(result.status, "awaiting_human");
  assert.equal(result.requestCount, 3);
  assert.deepEqual(dispatched[1], { name: "execute_payment", args: changedIntent });
  assert.deepEqual(dispatched[2], { name: "request_approval", args: changedTuple });
  assert.deepEqual(JSON.parse(provider.requests[2].messages.at(-1).content), blocked);
  assert.equal(toolMessages(result).at(-1).tool_call_id, "review_1");
  assert.deepEqual(JSON.parse(toolMessages(result).at(-1).content), pending);
});

test("saved history plus a truthful operator update can resume to an exact committed tuple", async () => {
  const pauseProvider = mockProvider([completion({ tool_calls: [toolCall("review_1", "request_approval", changedTuple)] })]);
  const paused = await runAgent(options(pauseProvider, async () => ({ status: "awaiting_human", pendingReview: { reviewId: "review_demo", tuple: changedTuple } })));
  const newIntent = { approvalId: "apr_demo_reviewed", ...changedTuple };
  const operatorMessage = { role: "user", content: `Operator update: the exact requested tuple has been approved: ${JSON.stringify(newIntent)}` };
  const provider = mockProvider([completion({ tool_calls: [toolCall("pay_resumed", "execute_payment", newIntent)] })]);
  const actualCalls = [];
  const resumed = await runAgent(options(provider, async (name, args) => {
    actualCalls.push({ name, args });
    return { status: "committed", payment: args };
  }, { messages: [...paused.messages, operatorMessage] }));

  assert.equal(resumed.status, "completed");
  assert.equal(resumed.requestCount, 1);
  assert.deepEqual(actualCalls, [{ name: "execute_payment", args: newIntent }]);
  assert.deepEqual(provider.requests[0].messages.at(-1), operatorMessage);
  assert.equal(provider.requests[0].messages.filter((message) => message.role === "system").length, 1);
  assert.deepEqual(provider.requests[0].messages.at(-2), toolMessages(paused).at(-1));
  assert.equal(toolMessages(resumed).at(-1).tool_call_id, "pay_resumed");
});

test("a human-needed local result pauses without another request", async () => {
  const provider = mockProvider([completion({ tool_calls: [toolCall("read_1", "read_documents", {})] })]);
  const result = await runAgent(options(provider, async () => ({ status: "needs_human", reason: "The local documents are unavailable." })));
  assert.equal(result.status, "awaiting_human");
  assert.equal(provider.requests.length, 1);
  assert.equal(toolMessages(result).length, 1);
});

test("unknown tools cannot dispatch, including an invented approval tool", async () => {
  const provider = mockProvider([completion({ tool_calls: [toolCall("bad_1", "approve", intent)] })]);
  let dispatched = false;
  const result = await runAgent(options(provider, async () => { dispatched = true; }));
  assert.equal(result.status, "error");
  assert.equal(dispatched, false);
  assert.equal(toolMessages(result)[0].tool_call_id, "bad_1");
  assert.equal(JSON.parse(toolMessages(result)[0].content).code, "INVALID_TOOL_CALL");
  assert.equal(result.trace.find((entry) => entry.type === "tool_result").dispatched, false);
});

test("malformed arguments fail closed before the local handler", async (t) => {
  const cases = [
    { name: "read_documents", args: { extra: true } },
    { name: "execute_payment", args: { ...intent, unexpected: true } },
    { name: "execute_payment", args: tuple },
    { name: "execute_payment", args: { ...intent, supplierId: false } },
    { name: "execute_payment", args: { ...intent, approvalId: " " } },
    { name: "execute_payment", args: { ...intent, amountMinor: "25000000" } },
    { name: "execute_payment", args: { ...intent, amountMinor: -1 } },
    { name: "execute_payment", args: { ...intent, amountMinor: 1.5 } },
    { name: "execute_payment", args: { ...intent, amountMinor: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "execute_payment", args: { ...intent, currency: "eur" } },
    { name: "request_approval", args: intent },
    { name: "request_approval", args: null },
    { name: "request_approval", args: [] },
    { name: "read_documents", rawArguments: "{" },
    { name: "read_documents", rawArguments: {} },
  ];
  for (const [index, invalid] of cases.entries()) {
    await t.test(`invalid argument case ${index + 1}`, async () => {
      const call = toolCall("invalid_1", invalid.name, invalid.args);
      if (Object.hasOwn(invalid, "rawArguments")) call.function.arguments = invalid.rawArguments;
      const provider = mockProvider([completion({ tool_calls: [call] })]);
      let dispatched = false;
      const result = await runAgent(options(provider, async () => { dispatched = true; }));
      assert.equal(result.status, "error");
      assert.equal(dispatched, false);
      assert.equal(toolMessages(result).length, 1);
      assert.equal(toolMessages(result)[0].tool_call_id, "invalid_1");
      assert.equal(JSON.parse(toolMessages(result)[0].content).code, "INVALID_TOOL_CALL");
    });
  }
});

test("a multi-call response is rejected as a complete batch and every call gets a result", async () => {
  const calls = [toolCall("pay_1", "execute_payment", intent), toolCall("review_1", "request_approval", changedTuple)];
  const provider = mockProvider([completion({ tool_calls: calls })]);
  let dispatched = false;
  const result = await runAgent(options(provider, async () => { dispatched = true; }));
  assert.equal(result.status, "error");
  assert.equal(dispatched, false);
  assert.deepEqual(toolMessages(result).map((message) => message.tool_call_id), calls.map((call) => call.id));
  assert.ok(toolMessages(result).every((message) => JSON.parse(message.content).code === "PARALLEL_TOOL_CALLS_REJECTED"));
});

test("a malformed tool envelope gets a paired rejection and no dispatch", async () => {
  const malformed = { type: "function", function: { name: "read_documents", arguments: "{}" } };
  const provider = mockProvider([completion({ tool_calls: [malformed] })]);
  let dispatched = false;
  const result = await runAgent(options(provider, async () => { dispatched = true; }));
  assert.equal(result.status, "error");
  assert.equal(dispatched, false);
  const assistant = result.messages.find((message) => message.role === "assistant");
  assert.equal(toolMessages(result)[0].tool_call_id, assistant.tool_calls[0].id);
  assert.equal(result.trace.find((entry) => entry.type === "model_response").response.choices[0].message.tool_calls[0].id, undefined);
});

test("a model response without a tool is preserved without inventing local calls", async () => {
  const provider = mockProvider([completion({ content: "I need more information before proposing a payment." })]);
  let dispatched = false;
  const result = await runAgent(options(provider, async () => { dispatched = true; }));
  assert.equal(result.status, "completed");
  assert.equal(dispatched, false);
  assert.equal(toolMessages(result).length, 0);
  assert.equal(result.messages.at(-1).content, "I need more information before proposing a payment.");
});

test("an empty or malformed provider message does not fabricate a call", async (t) => {
  for (const payload of [completion({ content: null }), completion({ tool_calls: {} }), { choices: [] }]) {
    await t.test("invalid provider message", async () => {
      const provider = mockProvider([payload]);
      let dispatched = false;
      const result = await runAgent(options(provider, async () => { dispatched = true; }));
      assert.equal(result.status, "error");
      assert.equal(dispatched, false);
      assert.equal(toolMessages(result).length, 0);
    });
  }
});

test("provider errors are returned once and keys and headers are redacted", async () => {
  const provider = mockProvider([{ status: 401, body: { error: { message: `Rejected ${API_KEY}`, headers: { Authorization: `Bearer ${API_KEY}`, "X-Other": "private" } }, apiKey: API_KEY } }]);
  const result = await runAgent(options(provider, async () => assert.fail("No tool should run")));
  assert.equal(result.status, "error");
  assert.equal(result.error, "Meta request failed (HTTP 401).");
  assert.equal(result.requestCount, 1);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.trace.find((entry) => entry.type === "model_response").response.error.headers, "[redacted]");
});

test("an unparseable provider response is preserved safely and not retried", async () => {
  const provider = mockProvider([{ body: `invalid JSON ${API_KEY}` }]);
  const result = await runAgent(options(provider, async () => assert.fail("No tool should run")));
  assert.equal(result.status, "error");
  assert.equal(result.requestCount, 1);
  assert.equal(result.error, "Meta returned an invalid JSON response.");
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.match(result.trace.find((entry) => entry.type === "model_response").response, /\[redacted\]/);
});

test("network and local handler errors do not expose raw errors or credentials", async () => {
  const network = await runAgent({ apiKey: API_KEY, toolHandler: async () => documents, fetchImpl: async () => { throw new Error(`Authorization: Bearer ${API_KEY}`); } });
  assert.equal(network.status, "error");
  assert.equal(network.requestCount, 1);
  assert.equal(network.error, "Meta request could not be completed.");
  assert.equal(JSON.stringify(network).includes(API_KEY), false);

  const provider = mockProvider([completion({ tool_calls: [toolCall("read_1", "read_documents", {})] })]);
  const local = await runAgent(options(provider, async () => { throw new Error(`headers: ${API_KEY}`); }));
  assert.equal(local.status, "error");
  assert.equal(JSON.stringify(local).includes(API_KEY), false);
  assert.equal(JSON.parse(toolMessages(local)[0].content).code, "TOOL_HANDLER_ERROR");
});

test("the API key cannot be passed to a local handler through model arguments", async () => {
  const provider = mockProvider([completion({ tool_calls: [toolCall("pay_1", "execute_payment", { ...intent, beneficiaryAccount: API_KEY })] })]);
  let dispatched = false;
  const result = await runAgent(options(provider, async () => { dispatched = true; }));
  assert.equal(result.status, "error");
  assert.equal(dispatched, false);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("JSON escapes cannot hide a key from the local argument check", async () => {
  const call = toolCall("pay_1", "execute_payment", { ...intent, beneficiaryAccount: API_KEY });
  const encodedKey = Array.from(API_KEY, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  call.function.arguments = call.function.arguments.replace(API_KEY, encodedKey);
  const provider = mockProvider([completion({ tool_calls: [call] })]);
  let dispatched = false;
  const result = await runAgent(options(provider, async () => { dispatched = true; }));
  assert.equal(result.status, "error");
  assert.equal(dispatched, false);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(result.trace.find((entry) => entry.type === "tool_result").rawArguments, "[redacted response containing key]");
});

test("the trace retains dispatched arguments even if the local handler mutates its copy", async () => {
  const provider = mockProvider([completion({ tool_calls: [toolCall("pay_1", "execute_payment", intent)] })]);
  const result = await runAgent(options(provider, async (_name, args) => {
    args.beneficiaryAccount = changedTuple.beneficiaryAccount;
    return { status: "blocked" };
  }, { maxRequests: 1 }));
  assert.deepEqual(result.trace.find((entry) => entry.type === "tool_result").arguments, intent);
});

test("unstructured provider errors containing headers omit those headers", async () => {
  const provider = mockProvider([{ status: 500, body: 'invalid JSON headers: { "X-Secret": "private" }' }]);
  const result = await runAgent(options(provider, async () => assert.fail("No tool should run")));
  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.trace.find((entry) => entry.type === "model_response").response, "[redacted response containing headers]");
});

test("the configured request cap stops after paired tool results without retries", async () => {
  const provider = mockProvider([
    completion({ tool_calls: [toolCall("read_1", "read_documents", {})] }),
    completion({ tool_calls: [toolCall("read_2", "read_documents", {})] }),
  ]);
  let dispatches = 0;
  const result = await runAgent(options(provider, async () => { dispatches += 1; return documents; }, { maxRequests: 2 }));
  assert.equal(result.status, "limit");
  assert.equal(result.requestCount, 2);
  assert.equal(provider.requests.length, 2);
  assert.equal(dispatches, 2);
  assert.equal(toolMessages(result).length, 2);
  const zero = await runAgent(options(provider, async () => assert.fail("No tool should run"), { maxRequests: 0 }));
  assert.equal(zero.status, "limit");
  assert.equal(zero.requestCount, 0);
});

test("a timeout bounds a provider implementation even if it ignores the abort signal", async () => {
  let signal;
  const result = await runAgent({
    apiKey: API_KEY,
    timeoutMs: 5,
    toolHandler: async () => assert.fail("No tool should run"),
    fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  assert.equal(result.status, "error");
  assert.equal(result.error, "Meta request timed out.");
  assert.equal(result.requestCount, 1);
  assert.equal(signal.aborted, true);
});

test("invalid configuration fails before any provider request", async (t) => {
  const configurations = [{ apiKey: "" }, { maxRequests: -1 }, { timeoutMs: 0 }, { messages: "invalid" }, { messages: [{ role: "unknown" }] }];
  for (const configuration of configurations) {
    await t.test("invalid configuration", async () => {
      const result = await runAgent({ apiKey: API_KEY, toolHandler: async () => documents, fetchImpl: async () => assert.fail("No provider call should run"), ...configuration });
      assert.equal(result.status, "error");
      assert.equal(result.requestCount, 0);
    });
  }
});
