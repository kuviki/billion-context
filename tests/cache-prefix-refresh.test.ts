import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { beforeCachePrefixRefresh, buildPrefixRefreshBody, noteCompressionForPrefixRefresh, _resetPrefixRefreshForTest, type PrefixRefreshInput } from "../src/cache-prefix-refresh.ts";
import { setLogCapture } from "../src/logger.ts";
import { withFetchTransport } from "../src/fetch-transport.ts";
import { _resetFetchUtilForTest } from "../src/fetch-util.ts";
import type { Session } from "../src/session.ts";
import type { WireProtocol } from "../src/util.ts";

type Json = Record<string, unknown>;
const A = [{ role: "user", content: "stable A 日本語" }];
const B = [{ role: "assistant", content: "large old B" }, { role: "user", content: "old tail" }];
const C = [{ role: "assistant", content: "folded C" }, { role: "user", content: "new tail" }];
const body = (messages: unknown[], extras: Json = {}): Json => ({ model: "plain-model", system: "stable system", max_tokens: 4096, stream: true, messages, ...extras });
const beforeBody = body([...A, ...B]);
const afterBody = body([...A, ...C]);
const session = (): Session => ({ id: "refresh-test" } as unknown as Session);
let server: http.Server;
let url: string;
let mode: "ok" | "timeout" | "disconnect" = "ok";
let status = 200;
let response: Json = { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } };
const requests: { headers: http.IncomingHttpHeaders; body: Json }[] = [];
const logs: string[] = [];

before(async () => {
    server = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString()) as Json });
        if (mode === "timeout") return;
        if (mode === "disconnect") { req.socket.destroy(); return; }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    url = `http://127.0.0.1:${address.port}/v1/messages`;
});
beforeEach(() => {
    _resetPrefixRefreshForTest();
    requests.length = 0;
    logs.length = 0;
    mode = "ok";
    status = 200;
    response = { usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } };
    setLogCapture((_level, message) => logs.push(message));
});
after(async () => {
    setLogCapture(null);
    _resetPrefixRefreshForTest();
    _resetFetchUtilForTest();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
function input(s: Session, value: Json = afterBody, overrides: Partial<PrefixRefreshInput> = {}): PrefixRefreshInput {
    return { session: s, enabled: true, timeoutMs: 300, protocol: "anthropic", body: JSON.stringify(value), url, headers: { "content-type": "application/json", "x-api-key": "secret-test-value", "anthropic-version": "2023-06-01" }, ...overrides };
}
async function prime(s: Session, value: Json = beforeBody, overrides: Partial<PrefixRefreshInput> = {}): Promise<void> {
    const accepted = await beforeCachePrefixRefresh(input(s, value, overrides));
    accepted();
}
async function warm(s: Session, value: Json = afterBody, overrides: Partial<PrefixRefreshInput> = {}): Promise<void> {
    noteCompressionForPrefixRefresh(s);
    const accepted = await beforeCachePrefixRefresh(input(s, value, overrides));
    accepted();
}

test("A+B -> commit -> A+C sends only A once before the caller's main request", async () => {
    const s = session();
    await prime(s);
    assert.equal(requests.length, 0);
    noteCompressionForPrefixRefresh(s);
    const accepted = await beforeCachePrefixRefresh(input(s));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.messages, A);
    assert.equal(requests[0].body.max_tokens, 1);
    assert.equal(requests[0].body.stream, false);
    assert.equal(requests[0].headers["x-api-key"], "secret-test-value");
    const main = await fetch(url, { method: "POST", body: JSON.stringify(afterBody) });
    await main.text();
    accepted();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, afterBody);
    await beforeCachePrefixRefresh(input(s));
    assert.equal(requests.length, 2);
    const record = logs.find(x => x.includes("[cache-prefix-refresh] success"));
    assert(record);
    assert.match(record, /status=200\b/);
    assert.match(record, /durationMs=\d+/);
    assert.match(record, /cached=80 total=100 hit=80\.0% creation=10/);
    assert.match(record, /timeoutMs=300\b/);
    assert.match(record, /retry=0/);
    assert(!record.includes("secret-test-value"));
    assert(!record.includes("stable A"));
});

test("disabled and absent commit send no extra requests; failed main is not a baseline", async () => {
    const s = session();
    await prime(s, beforeBody, { enabled: false });
    await warm(s, afterBody, { enabled: false });
    assert.equal(requests.length, 0);
    await prime(s);
    await beforeCachePrefixRefresh(input(s));
    assert.equal(requests.length, 0);
    const rejected = session();
    await beforeCachePrefixRefresh(input(rejected, beforeBody)); // no accepted receipt
    await warm(rejected);
    assert.equal(requests.length, 0);
});

test("no-op/appended history waits for a materialized fold; repeated commits coalesce", async () => {
    const s = session();
    await prime(s);
    noteCompressionForPrefixRefresh(s);
    noteCompressionForPrefixRefresh(s);
    await prime(s);
    await prime(s, body([...A, ...B, { role: "assistant", content: "ephemeral call" }]));
    assert.equal(requests.length, 0);
    await beforeCachePrefixRefresh(input(s));
    assert.equal(requests.length, 1);
    await beforeCachePrefixRefresh(input(s));
    assert.equal(requests.length, 1);
});

for (const failureStatus of [400, 429, 500, 503]) {
    test(`HTTP ${failureStatus}: exactly one warm, no retry, caller continues`, async () => {
        const s = session();
        await prime(s);
        status = failureStatus;
        response = { error: { message: "do not log secret-test-value" } };
        await warm(s);
        await beforeCachePrefixRefresh(input(s));
        assert.equal(requests.length, 1);
        const line = logs.find(x => x.includes("[cache-prefix-refresh] failed"));
        assert(line);
        assert.match(line, new RegExp(`status=${failureStatus}\\b`));
        assert.match(line, /durationMs=\d+/);
        assert.match(line, /cached=unknown total=unknown hit=unknown/);
        assert.match(line, /timeoutMs=300\b/);
        assert.match(line, /reason=http-error retry=0/);
        assert(!line.includes("secret-test-value"));
    });
}
for (const failureMode of ["timeout", "disconnect"] as const) {
    test(`${failureMode}: bounded single warm attempt, no retry and no exception`, async () => {
        const s = session();
        await prime(s);
        mode = failureMode;
        const started = Date.now();
        await warm(s, afterBody, { timeoutMs: 125 });
        assert(Date.now() - started < 1000, "125ms override must bound the warm instead of using the old 2s or default 10s timeout");
        await beforeCachePrefixRefresh(input(s));
        assert.equal(requests.length, 1);
        assert(logs.some(x => x.includes("[cache-prefix-refresh] failed") && x.includes("retry=0") && x.includes("hit=unknown") && x.includes("timeoutMs=125")));
        if (failureMode === "timeout") assert(logs.some(x => x.includes("reason=timeout")));
        mode = "ok";
        const main = await fetch(url, { method: "POST", body: JSON.stringify(afterBody) });
        assert.equal(main.status, 200);
        await main.text();
        assert.equal(requests.length, 2, "one failed warm followed by the successful main, never a warm retry");
        server.closeAllConnections();
    });
}

test("namespace/model/credentials changes never warm the old namespace", async () => {
    for (const [value, override] of [
        [body([...A, ...C], { model: "changed-model" }), {}],
        [body([...A, ...C], { system: "changed system" }), {}],
        [afterBody, { headers: { "x-api-key": "changed-key" } }],
        [afterBody, { url: `${url}?other-route=1` }],
    ] as [Json, Partial<PrefixRefreshInput>][]) {
        const s = session();
        await prime(s);
        await warm(s, value, override);
    }
    assert.equal(requests.length, 0);
    assert(logs.some(x => x.includes("reason=no-safe-prefix-or-namespace-changed")));
});

test("unsupported request families skip, preserving availability", async () => {
    for (const extra of [
        { thinking: { type: "enabled", budget_tokens: 1024 } },
        { thinking: { type: "adaptive" } },
        { reasoning_effort: "high" },
        { reasoning: { effort: "high" } },
        { tools: [{ type: "web_search_20250305", name: "web_search" }] },
        { conversation: "conv-id" },
        { previous_response_id: "resp-id" },
        { mcp_servers: [{ url: "https://must-not-call.invalid" }] },
        { web_search_options: {} },
        { plugins: [{ id: "server-plugin" }] },
        { audio: { voice: "alloy", format: "wav" } },
        { context_management: { edits: [] } },
        { modalities: ["text", "audio"] },
    ]) {
        const s = session();
        await prime(s);
        await warm(s, body([...A, ...C], extra));
    }
    const s = session();
    await prime(s);
    await warm(s, afterBody, { unsupported: true });
    for (const header of ["Idempotency-Key", "x-idempotency-key"]) {
        const keyed = session();
        await prime(keyed);
        await warm(keyed, afterBody, { headers: { [header]: "same-main-id" } });
    }
    await withFetchTransport(async () => { throw new Error("must not use managed transport"); }, async () => {
        const t = session();
        await prime(t);
        await warm(t);
    });
    assert.equal(requests.length, 0);
    assert(logs.some(x => x.includes("reason=unsupported-request")));
});

for (const [protocol, budgetKey, budget] of [
    ["anthropic", "max_tokens", 1], ["openai", "max_tokens", 1], ["openai", "max_completion_tokens", 1], ["responses", "max_output_tokens", 16],
] as const) {
    test(`${protocol} output cap uses only ${budgetKey}=${budget}`, () => {
        const key = protocol === "responses" ? "input" : "messages";
        const current: Json = { model: "plain", [key]: [...A, ...C], stream: true, store: true, max_tokens: 9999, max_output_tokens: 9999, stream_options: { include_usage: true } };
        if (budgetKey === "max_completion_tokens") current.max_completion_tokens = 9999;
        const previous = { ...current, [key]: [...A, ...B] };
        const plan = buildPrefixRefreshBody(previous, current, protocol);
        assert(plan.body);
        const request = JSON.parse(plan.body) as Json;
        assert.deepEqual(request[key], A);
        assert.equal(request[budgetKey], budget);
        for (const other of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) if (other !== budgetKey) assert(!(other in request));
        assert.equal(request.stream, false);
        assert(!("stream_options" in request));
        if (protocol === "openai") assert.equal(request.n, 1);
        if (protocol === "openai" || protocol === "responses") assert.equal(request.store, false);
    });
}

test("tool calls/results stay paired and invalid partial groups back off", () => {
    const pairs: [WireProtocol, Json[], Json][] = [
        ["anthropic", [{ role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "tool", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "result" }] }], { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "changed" }] }],
        ["openai", [{ role: "assistant", tool_calls: [{ id: "call-a", type: "function", function: { name: "tool", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call-a", content: "result" }], { role: "tool", tool_call_id: "call-a", content: "changed" }],
        ["responses", [{ type: "function_call", call_id: "call-a", name: "tool", arguments: "{}" }, { type: "function_call_output", call_id: "call-a", output: "result" }], { type: "function_call_output", call_id: "call-a", output: "changed" }],
    ];
    for (const [protocol, pair, changedResult] of pairs) {
        const key = protocol === "responses" ? "input" : "messages";
        const previous = { [key]: [...A, ...pair, ...B] };
        const current = { [key]: [...A, ...pair, ...C] };
        const complete = buildPrefixRefreshBody(previous, current, protocol);
        assert(complete.body);
        assert.deepEqual(JSON.parse(complete.body)[key], [...A, ...pair]);
        const partial = buildPrefixRefreshBody(previous, { [key]: [...A, pair[0], changedResult, ...C] }, protocol);
        assert(partial.body);
        assert.deepEqual(JSON.parse(partial.body)[key], A);
    }
});

test("no safe common user prefix skips; signed thinking is neither rewritten nor partially retained", () => {
    assert.equal(buildPrefixRefreshBody({ messages: B }, { messages: C }, "anthropic").body, undefined);
    const signed = { role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "sig" }, { type: "text", text: "kept" }] };
    const old = { messages: [...A, signed, ...B] };
    const current = { messages: [...A, signed, ...C] };
    const original = JSON.stringify(current);
    const plan = buildPrefixRefreshBody(old, current, "anthropic");
    assert(plan.body);
    assert.deepEqual(JSON.parse(plan.body).messages, A);
    assert.equal(JSON.stringify(current), original);
});

for (const [protocol, usage] of [
    ["openai", { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } }],
    ["openai", { prompt_tokens: 100, prompt_cache_hit_tokens: 80 }],
    ["responses", { input_tokens: 100, input_tokens_details: { cached_tokens: 80 } }],
] as const) {
    test(`${protocol} hit rate uses inclusive totals, supports usage variants`, async () => {
        const key = protocol === "responses" ? "input" : "messages";
        const s = session();
        const old = { model: "plain", [key]: [...A, ...B] };
        const current = { model: "plain", [key]: [...A, ...C] };
        await prime(s, old, { protocol });
        response = { usage };
        await warm(s, current, { protocol });
        assert.equal(requests.length, 1);
        assert(logs.some(x => /cached=80 total=100 hit=80\.0%/.test(x)));
    });
}

test("successful response without usage reports unknown, not false 0%", async () => {
    const s = session();
    await prime(s);
    response = { content: [{ type: "text", text: "discard secret output" }] };
    await warm(s);
    assert(logs.some(x => x.includes("success status=200") && x.includes("cached=unknown total=unknown hit=unknown")));
    assert(logs.every(x => !x.includes("discard secret output")));
});

test("concurrent post-fold callers share the single warm attempt", async () => {
    const s = session();
    await prime(s);
    noteCompressionForPrefixRefresh(s);
    const accepted = await Promise.all([beforeCachePrefixRefresh(input(s)), beforeCachePrefixRefresh(input(s))]);
    for (const receipt of accepted) receipt();
    assert.equal(requests.length, 1);
});

for (const timeoutMs of [undefined, 120_000]) {
    test(`refresh timeout ${timeoutMs ?? "default 10000"} is a ceiling, not a fixed delay`, { timeout: 3000 }, async () => {
        const s = session();
        await prime(s);
        const started = Date.now();
        await warm(s, afterBody, { timeoutMs });
        assert(Date.now() - started < 2000, "successful warm returns immediately, without sleeping until its deadline");
        assert.equal(requests.length, 1);
        const record = logs.find(x => x.includes("[cache-prefix-refresh] success"));
        assert(record);
        assert.match(record, new RegExp(`timeoutMs=${timeoutMs ?? 10000}\\b`));
        assert.match(record, /retry=0/);
    });
}
