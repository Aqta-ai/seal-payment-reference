import assert from "node:assert/strict";
import test from "node:test";
import { runBasetenAgent, tools } from "../src/baseten-agent.mjs";
import { runAgent } from "../src/meta-agent.mjs";
import { DEMO_APPROVAL } from "../src/sandbox.mjs";

const API_KEY = "synthetic-baseten-test-key";
const MODEL = "meta-models/muse-spark-open-1026";
const PRIVATE_REASONING = "Synthetic private reasoning fixture, which must be omitted.";
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

function completion(message) {
  return {
    id: "synthetic-baseten-completion",
    object: "chat.completion",
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", reasoning_content: PRIVATE_REASONING, content: null, ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 1 } },
  };
}

function mockProvider(responses) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://inference.baseten.co/v1/chat/completions");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`);
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.ok(options.signal instanceof AbortSignal);
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

test("Baseten uses the fixed endpoint, model, bounded token settings and closed tools", async () => {
  const provider = mockProvider([completion({ content: "The synthetic documents need review." })]);
  const result = await runBasetenAgent(options(provider, async () => assert.fail("No tool should run"), {
    provider: "meta",
    model: "muse-spark-1.3",
    endpoint: "https://api.meta.ai/v1/chat/completions",
    baseURL: "https://api.meta.ai/v1",
  }));
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "baseten");
  assert.equal(result.model, MODEL);
  assert.equal(provider.requests[0].model, MODEL);
  assert.equal(provider.requests[0].max_tokens, 4096);
  assert.equal(provider.requests[0].reasoning_effort, "low");
  assert.equal(provider.requests[0].stream, false);
  assert.equal(provider.requests[0].parallel_tool_calls, false);
  assert.equal(provider.requests[0].tool_choice, "auto");
  assert.equal(Object.hasOwn(provider.requests[0], "max_completion_tokens"), false);
  assert.deepEqual(provider.requests[0].tools, tools);
  assert.deepEqual(tools.map((tool) => tool.function.name), ["read_documents", "execute_payment", "request_approval"]);
  assert.ok(tools.every((tool) => tool.function.parameters.additionalProperties === false));
  assert.ok(result.trace.every((entry) => entry.provider === "baseten" && entry.model === MODEL));
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
  assert.equal(JSON.stringify(result).includes(PRIVATE_REASONING), false);
  assert.equal(result.trace.find((entry) => entry.type === "model_response").reasoningOmitted, true);
});

test("Baseten dispatches actual arguments, returns local results and pauses on human review", async () => {
  const blocked = { status: "blocked", reason: "Beneficiary account does not match approval.", payment: null };
  const pending = { status: "awaiting_human", pendingReview: { reviewId: "review_demo", tuple: changedTuple } };
  const changedIntent = { approvalId: intent.approvalId, ...changedTuple };
  const calls = [toolCall("read_1", "read_documents", {}), toolCall("pay_changed", "execute_payment", changedIntent), toolCall("review_1", "request_approval", changedTuple)];
  const provider = mockProvider(calls.map((call) => completion({ tool_calls: [call] })));
  const dispatched = [];
  const result = await runBasetenAgent(options(provider, async (name, args) => {
    dispatched.push({ name, args });
    if (name === "read_documents") return documents;
    return name === "execute_payment" ? blocked : pending;
  }));

  assert.equal(result.status, "awaiting_human");
  assert.equal(result.requestCount, 3);
  assert.deepEqual(dispatched, [{ name: "read_documents", args: {} }, { name: "execute_payment", args: changedIntent }, { name: "request_approval", args: changedTuple }]);
  assert.deepEqual(JSON.parse(provider.requests[1].messages.at(-1).content), documents);
  assert.deepEqual(JSON.parse(provider.requests[2].messages.at(-1).content), blocked);
  assert.deepEqual(JSON.parse(toolMessages(result).at(-1).content), pending);
  const trace = result.trace.filter((entry) => entry.type === "tool_result");
  assert.deepEqual(trace.map((entry) => entry.tool_call_id), calls.map((call) => call.id));
  assert.deepEqual(trace.map((entry) => entry.arguments), [{}, changedIntent, changedTuple]);
  assert.deepEqual(trace.map((entry) => entry.result), [documents, blocked, pending]);
  assert.ok(trace.every((entry) => entry.dispatched && Number.isFinite(entry.latencyMs)));
  assert.deepEqual(result.usage, { prompt_tokens: 18, completion_tokens: 6, total_tokens: 24 });
  const responseTrace = result.trace.filter((entry) => entry.type === "model_response");
  assert.equal(responseTrace[0].usage.completion_tokens_details.reasoning_tokens, 1);
  assert.ok(responseTrace.every((entry) => entry.reasoningOmitted && Number.isFinite(entry.latencyMs)));
  assert.equal(JSON.stringify(result).includes(PRIVATE_REASONING), false);
  assert.equal(JSON.stringify(provider.requests).includes(PRIVATE_REASONING), false);
});

test("Baseten resumes operator history and stops immediately after the local commit", async () => {
  const approvedIntent = { ...intent, beneficiaryAccount: changedTuple.beneficiaryAccount, approvalId: "apr_demo_reviewed" };
  const messages = [
    { role: "assistant", content: null, reasoning_content: PRIVATE_REASONING, tool_calls: [toolCall("review_1", "request_approval", changedTuple)] },
    { role: "tool", tool_call_id: "review_1", content: JSON.stringify({ status: "awaiting_human" }) },
    { role: "user", content: `Operator update: approved exactly ${JSON.stringify(approvedIntent)}` },
  ];
  const provider = mockProvider([completion({ tool_calls: [toolCall("pay_resumed", "execute_payment", approvedIntent)] })]);
  const dispatched = [];
  const result = await runBasetenAgent(options(provider, async (name, args) => {
    dispatched.push({ name, args });
    return { status: "committed", payment: args };
  }, { messages }));
  assert.equal(result.status, "completed");
  assert.equal(result.requestCount, 1);
  assert.deepEqual(dispatched, [{ name: "execute_payment", args: approvedIntent }]);
  assert.deepEqual(provider.requests[0].messages.at(-1), messages.at(-1));
  assert.equal(Object.hasOwn(provider.requests[0].messages[1], "reasoning_content"), false);
  assert.equal(JSON.stringify(result).includes(PRIVATE_REASONING), false);
  assert.equal(toolMessages(result).at(-1).tool_call_id, "pay_resumed");
});

test("reasoning alone is not treated as final content or an executable tool", async () => {
  const provider = mockProvider([completion({ content: null })]);
  const result = await runBasetenAgent(options(provider, async () => assert.fail("No tool should run")));
  assert.equal(result.status, "error");
  assert.equal(result.error, "Baseten returned neither content nor a tool call.");
  assert.equal(toolMessages(result).length, 0);
  assert.equal(JSON.stringify(result).includes(PRIVATE_REASONING), false);
});

test("Baseten rejects malformed arguments and unknown tools before dispatch", async (t) => {
  const malformed = [
    toolCall("bad_1", "approve", intent),
    toolCall("bad_1", "read_documents", { extra: true }),
    toolCall("bad_1", "execute_payment", { ...intent, amountMinor: "25000000" }),
    toolCall("bad_1", "request_approval", intent),
    { id: "bad_1", type: "function", function: { name: "read_documents", arguments: "{" } },
  ];
  for (const call of malformed) {
    await t.test(call.function.name, async () => {
      const provider = mockProvider([completion({ tool_calls: [call] })]);
      let dispatched = false;
      const result = await runBasetenAgent(options(provider, async () => { dispatched = true; }));
      assert.equal(result.status, "error");
      assert.equal(dispatched, false);
      assert.equal(toolMessages(result)[0].tool_call_id, "bad_1");
      assert.equal(JSON.parse(toolMessages(result)[0].content).code, "INVALID_TOOL_CALL");
      assert.equal(result.trace.find((entry) => entry.type === "tool_result").dispatched, false);
    });
  }
});

test("Baseten rejects a parallel batch safely and pairs every tool result", async () => {
  const calls = [toolCall("read_1", "read_documents", {}), toolCall("pay_1", "execute_payment", intent)];
  const provider = mockProvider([completion({ tool_calls: calls })]);
  let dispatched = false;
  const result = await runBasetenAgent(options(provider, async () => { dispatched = true; }));
  assert.equal(result.status, "error");
  assert.equal(dispatched, false);
  assert.deepEqual(toolMessages(result).map((message) => message.tool_call_id), calls.map((call) => call.id));
  assert.ok(toolMessages(result).every((message) => JSON.parse(message.content).code === "PARALLEL_TOOL_CALLS_REJECTED"));
});

test("Baseten never reads or returns a provider HTTP error body", async () => {
  let reads = 0;
  const result = await runBasetenAgent({
    apiKey: API_KEY,
    toolHandler: async () => assert.fail("No tool should run"),
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => { reads += 1; return `private body Authorization: Bearer ${API_KEY}`; } }),
  });
  assert.equal(result.status, "error");
  assert.equal(result.error, "Baseten request failed (HTTP 401).");
  assert.equal(reads, 0);
  assert.equal(result.requestCount, 1);
  const trace = result.trace.find((entry) => entry.type === "model_response");
  assert.equal(trace.response, null);
  assert.equal(trace.responseOmitted, "provider_error");
  assert.equal(JSON.stringify(result).includes("private body"), false);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("Baseten omits invalid JSON and provider error objects without retries", async (t) => {
  for (const body of [`private invalid JSON ${API_KEY}`, { error: { message: `private error ${API_KEY}`, headers: { Authorization: `Bearer ${API_KEY}` } } }]) {
    await t.test("provider error body", async () => {
      const provider = mockProvider([{ body }]);
      const result = await runBasetenAgent(options(provider, async () => assert.fail("No tool should run")));
      assert.equal(result.status, "error");
      assert.equal(result.requestCount, 1);
      assert.equal(result.trace.find((entry) => entry.type === "model_response").response, null);
      assert.equal(JSON.stringify(result).includes("private"), false);
      assert.equal(JSON.stringify(result).includes(API_KEY), false);
    });
  }
});

test("Baseten omits malformed provider response bodies before returning a protocol error", async (t) => {
  for (const body of [{ choices: [], privateField: "private provider error fixture" }, completion({ tool_calls: { privateField: "private provider error fixture" } })]) {
    await t.test("malformed provider message", async () => {
      const provider = mockProvider([body]);
      const result = await runBasetenAgent(options(provider, async () => assert.fail("No tool should run")));
      assert.equal(result.status, "error");
      assert.equal(result.requestCount, 1);
      const responseTrace = result.trace.find((entry) => entry.type === "model_response");
      assert.equal(responseTrace.response, null);
      assert.equal(responseTrace.responseOmitted, "malformed_response");
      assert.equal(JSON.stringify(result).includes("private provider error fixture"), false);
      assert.equal(JSON.stringify(result).includes(PRIVATE_REASONING), false);
    });
  }
});

test("Baseten redacts keys in successful content and refuses key-bearing tool arguments", async (t) => {
  const payload = completion({ content: `Returned key ${API_KEY}` });
  payload[API_KEY] = "synthetic key-named field fixture";
  const provider = mockProvider([payload]);
  const result = await runBasetenAgent(options(provider, async () => assert.fail("No tool should run")));
  assert.equal(result.status, "completed");
  assert.match(result.messages.at(-1).content, /\[redacted\]/);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);

  for (const escaped of [false, true]) {
    await t.test(escaped ? "escaped key" : "literal key", async () => {
      const call = toolCall("pay_1", "execute_payment", { ...intent, beneficiaryAccount: API_KEY });
      if (escaped) {
        const encodedKey = Array.from(API_KEY, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
        call.function.arguments = call.function.arguments.replace(API_KEY, encodedKey);
      }
      const localProvider = mockProvider([completion({ tool_calls: [call] })]);
      let dispatched = false;
      const rejected = await runBasetenAgent(options(localProvider, async () => { dispatched = true; }));
      assert.equal(rejected.status, "error");
      assert.equal(dispatched, false);
      assert.equal(JSON.stringify(rejected).includes(API_KEY), false);
    });
  }
});

test("Baseten network and tool errors use fixed safe messages", async () => {
  const network = await runBasetenAgent({ apiKey: API_KEY, toolHandler: async () => documents, fetchImpl: async () => { throw new Error(`private headers: ${API_KEY}`); } });
  assert.equal(network.status, "error");
  assert.equal(network.error, "Baseten request could not be completed.");
  assert.equal(network.requestCount, 1);
  assert.equal(JSON.stringify(network).includes("private headers"), false);
  assert.equal(JSON.stringify(network).includes(API_KEY), false);

  const provider = mockProvider([completion({ tool_calls: [toolCall("read_1", "read_documents", {})] })]);
  const local = await runBasetenAgent(options(provider, async () => { throw new Error(`private headers: ${API_KEY}`); }));
  assert.equal(local.status, "error");
  assert.equal(JSON.parse(toolMessages(local)[0].content).code, "TOOL_HANDLER_ERROR");
  assert.equal(JSON.stringify(local).includes("private headers"), false);
  assert.equal(JSON.stringify(local).includes(API_KEY), false);
});

test("Baseten enforces the six-request cap and disallows larger request or timeout bounds", async () => {
  const provider = mockProvider(Array.from({ length: 6 }, (_entry, index) => completion({ tool_calls: [toolCall(`read_${index}`, "read_documents", {})] })));
  const capped = await runBasetenAgent(options(provider, async () => documents));
  assert.equal(capped.status, "limit");
  assert.equal(capped.requestCount, 6);
  assert.equal(provider.requests.length, 6);
  assert.equal(toolMessages(capped).length, 6);
  for (const bound of [{ maxRequests: 7 }, { timeoutMs: 20001 }]) {
    const result = await runBasetenAgent(options(provider, async () => assert.fail("No tool should run"), bound));
    assert.equal(result.status, "error");
    assert.equal(result.requestCount, 0);
  }
});

test("Baseten aborts a timed-out request once even if fetch ignores its signal", async () => {
  let requests = 0;
  let signal;
  const result = await runBasetenAgent({
    apiKey: API_KEY,
    timeoutMs: 5,
    toolHandler: async () => assert.fail("No tool should run"),
    fetchImpl: async (_url, options) => { requests += 1; signal = options.signal; return new Promise(() => {}); },
  });
  assert.equal(result.status, "error");
  assert.equal(result.error, "Baseten request timed out.");
  assert.equal(requests, 1);
  assert.equal(result.requestCount, 1);
  assert.equal(signal.aborted, true);
});

test("Baseten defaults to its own environment key without changing the Meta default", async () => {
  const previous = process.env.BASETEN_API_KEY;
  try {
    process.env.BASETEN_API_KEY = API_KEY;
    const provider = mockProvider([completion({ content: "The synthetic task is paused." })]);
    const result = await runBasetenAgent({ toolHandler: async () => documents, fetchImpl: provider.fetchImpl });
    assert.equal(result.status, "completed");
    assert.equal(result.provider, "baseten");
  } finally {
    if (previous === undefined) delete process.env.BASETEN_API_KEY;
    else process.env.BASETEN_API_KEY = previous;
  }
});

test("unknown provider selection fails before fetching", async () => {
  const result = await runAgent({ provider: "unknown", apiKey: API_KEY, toolHandler: async () => documents, fetchImpl: async () => assert.fail("No provider call should run") });
  assert.equal(result.status, "error");
  assert.equal(result.requestCount, 0);
  assert.equal(result.provider, null);
  assert.equal(result.model, null);
});
