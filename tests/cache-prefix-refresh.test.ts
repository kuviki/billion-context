import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { beforeCachePrefixRefresh, buildPrefixRefreshBody, noteCompressionForPrefixRefresh, _resetPrefixRefreshForTest, type PrefixRefreshInput } from "../src/cache-prefix-refresh.ts";
import { setLogCapture } from "../src/logger.ts";
import { markWsLaneTransport, withFetchTransport } from "../src/fetch-transport.ts";
import { _resetFetchUtilForTest } from "../src/fetch-util.ts";
import type { Session } from "../src/session.ts";
import type { WireProtocol } from "../src/util.ts";

type Json = Record<string, unknown>;
const A = [{ role: "user", content: "stable A 日本語" }];
const B = [{ role: "assistant", content: "large old B" }, { role: "user", content: "old tail" }];
const C = [{ role: "assistant", content: "folded C" }, { role: "user", content: "new tail" }];
const body = (messages: unknown[], extras: Json = {}): Json => ({ model: "plain-model", system: "stable system", max_tokens: 4096, stream: false, messages, ...extras });
const beforeBody = body([...A, ...B]);
const afterBody = body([...A, ...C]);
const session = (): Session => ({ id: "refresh-test" } as unknown as Session);
let server: http.Server;
let url: string;
let mode: "ok" | "timeout" | "disconnect" | "stream-timeout" = "ok";
let responseType = "application/json";
let status = 200;
let response: Json | string = { stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } };
const requests: { headers: http.IncomingHttpHeaders; body: Json }[] = [];
const logs: string[] = [];

before(async () => {
    server = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString()) as Json });
        if (mode === "timeout") return;
        if (mode === "disconnect") { req.socket.destroy(); return; }
        res.writeHead(status, { "content-type": responseType });
        const bytes = typeof response === "string" ? response : JSON.stringify(response);
        if (mode === "stream-timeout") { res.write(bytes); return; }
        res.end(bytes);
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
    responseType = "application/json";
    response = { stop_reason: "end_turn", usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } };
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
        assert.match(line, /http=failed/);
        assert.match(line, /retry=0/);
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
    assert(logs.some(x => x.includes("[cache-prefix-refresh] skipped") && x.includes("http=not-sent")));
});

test("unsupported request families skip, preserving availability", async () => {
    for (const extra of [
        { thinking: { type: "enabled", budget_tokens: 1024 } },
        { tools: [{ type: "web_search_20250305", name: "web_search" }] },
        { conversation: "conv-id" },
        { previous_response_id: "resp-id" },
        { mcp_servers: [{ url: "https://must-not-call.invalid" }] },
        { web_search_options: {} },
        { plugins: [{ id: "server-plugin" }] },
        { audio: { voice: "alloy", format: "wav" } },
        { context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } },
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
    await withFetchTransport(markWsLaneTransport(async () => { throw new Error("must not use websocket transport"); }), async () => {
        const t = session();
        await prime(t);
        await warm(t);
    });
    assert.equal(requests.length, 0);
    assert(logs.some(x => x.includes("[cache-prefix-refresh] skipped") && x.includes("http=not-sent")));
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
        assert.equal(request.stream, true);
        assert.deepEqual(request.stream_options, current.stream_options);
        if (protocol === "openai") assert(!("n" in request), "do not synthesize an absent n");
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
    const old = { model: "claude-sonnet-4-6", messages: [...A, signed, ...B] };
    const current = { model: "claude-sonnet-4-6", messages: [...A, signed, ...C] };
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
        response = protocol === "responses" ? { status: "completed", usage } : { choices: [{ finish_reason: "stop" }], usage };
        await warm(s, current, { protocol });
        assert.equal(requests.length, 1);
        assert(logs.some(x => /cached=80 total=100 hit=80\.0%/.test(x)));
    });
}

test("successful response without usage reports unknown, not false 0%", async () => {
    const s = session();
    await prime(s);
    response = { stop_reason: "end_turn", content: [{ type: "text", text: "discard secret output" }] };
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

function sse(type: string | undefined, value: unknown): string {
    return `${type ? `event: ${type}\n` : ""}data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}
function streamFixture(protocol: WireProtocol, end: "complete" | "limit" | "error" | "truncated"): string {
    if (protocol === "anthropic") {
        const start = sse("message_start", { type: "message_start", message: { id: "msg_warm", usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } } });
        if (end === "error") return start + sse("error", { type: "error", error: { type: "overloaded_error", message: "secret server error body" } });
        if (end === "truncated") return start;
        return start + sse("message_delta", { type: "message_delta", delta: { stop_reason: end === "limit" ? "max_tokens" : "end_turn" }, usage: { output_tokens: 1 } }) + sse("message_stop", { type: "message_stop" });
    }
    if (protocol === "responses") {
        const start = sse("response.created", { type: "response.created", response: { id: "resp_warm", status: "in_progress" } });
        if (end === "error") return start + sse("response.failed", { type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "secret server error body" } } });
        if (end === "truncated") return start;
        const status = end === "limit" ? "incomplete" : "completed";
        return start + sse(`response.${status}`, { type: `response.${status}`, response: { status, ...(end === "limit" ? { incomplete_details: { reason: "max_output_tokens" } } : {}), usage: { input_tokens: 100, output_tokens: 16, input_tokens_details: { cached_tokens: 80 } } } });
    }
    const start = sse(undefined, { id: "chat_warm", choices: [{ index: 0, delta: { content: "discarded output" }, finish_reason: null }] });
    if (end === "error") return start + sse(undefined, { error: { code: "server_error", message: "secret server error body" } });
    if (end === "truncated") return start;
    return start + sse(undefined, { choices: [{ index: 0, delta: {}, finish_reason: end === "limit" ? "length" : "stop" }] }) + sse(undefined, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80 } } }) + sse(undefined, "[DONE]");
}
function streamingBodies(protocol: WireProtocol): [Json, Json] {
    const key = protocol === "responses" ? "input" : "messages";
    return [{ model: "plain", [key]: [...A, ...B], stream: true }, { model: "plain", [key]: [...A, ...C], stream: true }];
}
for (const protocol of ["openai", "anthropic", "responses"] as const) {
    for (const end of ["complete", "limit", "error", "truncated"] as const) {
        test(`${protocol} SSE ${end}: retain streaming, consume terminal usage, classify API separately, no retry`, async () => {
            const s = session();
            const [old, current] = streamingBodies(protocol);
            await prime(s, old, { protocol });
            responseType = "text/event-stream";
            response = streamFixture(protocol, end);
            await warm(s, current, { protocol });
            await beforeCachePrefixRefresh(input(s, current, { protocol }));
            assert.equal(requests.length, 1);
            assert.equal(requests[0].body.stream, true);
            assert(!("stream_options" in requests[0].body), "do not inject include_usage");
            const record = logs.find(x => x.includes("[cache-prefix-refresh]") && x.includes("status=200"));
            assert(record);
            assert.match(record, /http=success/);
            assert.match(record, new RegExp(`api=${end === "complete" ? "completed" : end === "limit" ? "output-limit" : end === "error" ? "failed" : "stream-truncated"}\\b`));
            assert.match(record, /cacheScope=warm mainHit=unobserved/);
            assert.match(record, /retry=0/);
            if (end === "complete" || end === "limit") assert.match(record, /cached=80 total=100 hit=80\.0%/);
            assert(!record.includes("secret server error body"));
            assert(!record.includes("discarded output"));
        });
    }
    test(`${protocol} SSE malformed and never-ending responses fail once within timeout`, async () => {
        for (const hang of [false, true]) {
            const s = session();
            const [old, current] = streamingBodies(protocol);
            await prime(s, old, { protocol });
            responseType = "text/event-stream";
            response = hang ? streamFixture(protocol, "truncated") : "data: {malformed-json\n\n";
            mode = hang ? "stream-timeout" : "ok";
            const before = requests.length;
            const started = Date.now();
            await warm(s, current, { protocol, timeoutMs: 125 });
            assert(Date.now() - started < 1000);
            await beforeCachePrefixRefresh(input(s, current, { protocol }));
            assert.equal(requests.length, before + 1);
            const record = logs.filter(x => x.includes("[cache-prefix-refresh]")).at(-1)!;
            assert.match(record, /retry=0/);
            assert(!record.includes("api=completed"));
            assert(!record.includes("api=output-limit"));
            if (hang) assert.match(record, /reason=timeout/);
            else { assert.match(record, /api=unknown\b/); assert.match(record, /reason=malformed-response\b/); }
            server.closeAllConnections();
        }
    });
}

test("normal request options stay exact except prefix and explicit output/safety limits", () => {
    for (const protocol of ["openai", "anthropic", "responses"] as const) {
        const key = protocol === "responses" ? "input" : "messages";
        for (const stream of [undefined, false, true]) {
            const current: Json = { model: "plain", [key]: [...A, ...C], temperature: 0.4, top_p: 0.8, metadata: { trace: "keep-me" }, tool_choice: "auto", ...(stream === undefined ? {} : { stream }), stream_options: { include_usage: false, custom_option: "unchanged" } };
            const previous = { ...current, [key]: [...A, ...B] };
            const plan = buildPrefixRefreshBody(previous, current, protocol);
            assert(plan.body);
            const warmBody = JSON.parse(plan.body) as Json;
            const expected = { ...current, [key]: A, ...(protocol === "responses" ? { max_output_tokens: 16, store: false } : { max_tokens: 1 }) };
            assert.deepEqual(warmBody, expected);
        }
    }
    for (const [n, best_of] of [[1, 1], [3, 4]]) {
        const current = body([...A, ...C], { n, best_of });
        const plan = buildPrefixRefreshBody(body([...A, ...B], { n, best_of }), current, "openai");
        assert(plan.body);
        assert.equal(JSON.parse(plan.body).n, 1);
        assert.equal(JSON.parse(plan.body).best_of, 1);
    }
});

test("OpenAI reasoning options stay enabled and use max_completion_tokens=1 without existing cap", async () => {
    for (const extras of [{ reasoning_effort: "medium" }, { model: "o1" }, { model: "o3-mini" }, { model: "o4-mini" }, { model: "gpt-5" }]) {
        const old = { model: "plain", messages: [...A, ...B], stream: false, ...extras };
        const current = { ...old, messages: [...A, ...C] };
        const s = session();
        await prime(s, old, { protocol: "openai" });
        await warm(s, current, { protocol: "openai" });
        const outgoing = requests.at(-1)!.body;
        assert.equal(outgoing.max_completion_tokens, 1);
        assert(!("max_tokens" in outgoing));
        assert.equal(outgoing.reasoning_effort, old.reasoning_effort);
    }
    assert.equal(requests.length, 5);
});

test("Responses encrypted reasoning and complete assistant prefix stay byte-exact", async () => {
    const prefix = [{ type: "message", role: "user", content: "u1" }, { type: "reasoning", id: "rs_1", encrypted_content: "opaque+/signed==", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] }];
    const old = { model: "gpt-5", reasoning: { effort: "medium", summary: "auto" }, stream: false, input: [...prefix, { role: "user", content: "old u2" }] };
    const current = { ...old, input: [...prefix, { role: "user", content: "new u2" }] };
    const s = session();
    await prime(s, old, { protocol: "responses" });
    await warm(s, current, { protocol: "responses" });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.input, prefix);
    assert.deepEqual(requests[0].body.reasoning, old.reasoning);
    assert.equal(requests[0].body.max_output_tokens, 16);
});

test("ordinary assistant endings are legal; known Claude no-prefill models back off", () => {
    const prefix = [...A, { role: "assistant", content: "unchanged answer" }];
    for (const protocol of ["openai", "responses", "anthropic"] as const) {
        const key = protocol === "responses" ? "input" : "messages";
        const previous = { model: "plain", [key]: [...prefix, { role: "user", content: "old" }] };
        const current = { ...previous, [key]: [...prefix, { role: "user", content: "new" }] };
        const plan = buildPrefixRefreshBody(previous, current, protocol);
        assert(plan.body);
        assert.deepEqual(JSON.parse(plan.body)[key], prefix);
    }
    const old = body([...prefix, { role: "user", content: "old" }], { model: "claude-sonnet-4-6" });
    const current = body([...prefix, { role: "user", content: "new" }], { model: "claude-sonnet-4-6" });
    const plan = buildPrefixRefreshBody(old, current, "anthropic");
    assert(plan.body);
    assert.deepEqual(JSON.parse(plan.body).messages, A);
});

test("metadata and request tracing changes do not invalidate a stable prompt namespace", async () => {
    const s = session();
    await prime(s, body([...A, ...B], { metadata: { trace_id: "old" }, request_id: "old-request" }));
    await warm(s, body([...A, ...C], { metadata: { trace_id: "new" }, request_id: "new-request" }), { headers: { ...input(s).headers, "x-request-id": "new-request" } });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.metadata, { trace_id: "new" });
    assert.equal(requests[0].body.request_id, "new-request");
});

test("managed HTTP transport is used once; adaptive thinking is preserved", async () => {
    const sent: Json[] = [];
    await withFetchTransport(async (_url, options) => {
        sent.push(JSON.parse(String(options.body)) as Json);
        return new Response(JSON.stringify({ stop_reason: "max_tokens", usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } }));
    }, async () => {
        const s = session();
        const extras = { thinking: { type: "adaptive" } };
        await prime(s, body([...A, ...B], extras));
        await warm(s, body([...A, ...C], extras));
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].thinking, { type: "adaptive" });
    assert.equal(requests.length, 0, "must not bypass the managed HTTP transport with a new network request");
});

for (const [protocol, reply, api] of [
    ["openai", { error: { code: "server_error", message: "private API failure" } }, "failed"],
    ["anthropic", { type: "error", error: { type: "overloaded_error", message: "private API failure" } }, "failed"],
    ["responses", { status: "failed", error: { code: "server_error", message: "private API failure" } }, "failed"],
    ["responses", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 } } }, "output-limit"],
    ["responses", { status: "incomplete", incomplete_details: { reason: "content_filter" } }, "incomplete"],
] as const) {
    test(`${protocol} JSON HTTP 200 does not hide API ${api}`, async () => {
        const s = session();
        const key = protocol === "responses" ? "input" : "messages";
        const old = { model: "plain", [key]: [...A, ...B], stream: false };
        const current = { ...old, [key]: [...A, ...C] };
        await prime(s, old, { protocol });
        response = reply;
        await warm(s, current, { protocol });
        await beforeCachePrefixRefresh(input(s, current, { protocol }));
        assert.equal(requests.length, 1);
        const record = logs.find(x => x.includes("[cache-prefix-refresh]") && x.includes("status=200"))!;
        assert(record);
        assert.match(record, /http=success/);
        assert.match(record, new RegExp(`\\[cache-prefix-refresh\\] ${api === "output-limit" ? "success" : "failed"} `));
        assert.match(record, new RegExp(`api=${api}\\b`));
        assert.match(record, /cacheScope=warm mainHit=unobserved/);
        assert.match(record, /retry=0/);
        assert(!record.includes("private API failure"));
    });
}

test("reply larger than 64 KiB is bounded and never reported as completed", async () => {
    const s = session();
    await prime(s);
    response = { content: [{ type: "text", text: "x".repeat(70 * 1024) }], stop_reason: "end_turn", usage: { input_tokens: 100, cache_read_input_tokens: 80 } };
    await warm(s);
    await beforeCachePrefixRefresh(input(s));
    assert.equal(requests.length, 1);
    const record = logs.filter(x => x.includes("[cache-prefix-refresh]")).at(-1)!;
    assert(record);
    assert.match(record, /retry=0/);
    assert(!record.includes("api=completed"));
    assert(!record.includes("hit=80.0%"));
});

for (const protocol of ["openai", "anthropic", "responses"] as const) {
    test(`${protocol} HTTP 200 without API completion is explicitly unknown`, async () => {
        const s = session();
        const [old, current] = streamingBodies(protocol);
        await prime(s, old, { protocol });
        response = { usage: { input_tokens: 100, prompt_tokens: 100 } };
        await warm(s, current, { protocol });
        const record = logs.filter(x => x.includes("[cache-prefix-refresh]")).at(-1)!;
        assert.match(record, /\[cache-prefix-refresh\] unknown status=200/);
        assert.match(record, /http=success api=unknown/);
    });
    test(`${protocol} SSE API failure cannot be overwritten by later completion`, async () => {
        const s = session();
        const [old, current] = streamingBodies(protocol);
        await prime(s, old, { protocol });
        responseType = "text/event-stream";
        response = streamFixture(protocol, "error") + streamFixture(protocol, "complete");
        await warm(s, current, { protocol });
        assert.equal(requests.length, 1);
        const record = logs.filter(x => x.includes("[cache-prefix-refresh]")).at(-1)!;
        assert.match(record, /\[cache-prefix-refresh\] failed status=200/);
        assert.match(record, /http=success api=failed/);
        assert.match(record, /retry=0/);
    });
}

for (const protocol of ["anthropic", "responses"] as const) {
    test(`${protocol} foreign DONE marker cannot replace its protocol terminal event`, async () => {
        const s = session();
        const [old, current] = streamingBodies(protocol);
        await prime(s, old, { protocol });
        responseType = "text/event-stream";
        response = streamFixture(protocol, "truncated")
            + (protocol === "anthropic" ? sse("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" } }) : "")
            + "data: [DONE]\n\n";
        await warm(s, current, { protocol });
        assert.equal(requests.length, 1);
        const record = logs.filter(x => x.includes("[cache-prefix-refresh]")).at(-1)!;
        assert.match(record, /\[cache-prefix-refresh\] failed status=200/);
        assert.match(record, /api=stream-truncated\b/);
        assert.match(record, /retry=0/);
    });
}

test("empty server context edits preserve normal request behavior", async () => {
    const s = session();
    const extras = { context_management: { edits: [] } };
    await prime(s, body([...A, ...B], extras));
    await warm(s, body([...A, ...C], extras));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.context_management, extras.context_management);
});

test("Chat content_filter is API incomplete rather than success, while HTTP is successful", async () => {
    const s = session();
    await prime(s, beforeBody, { protocol: "openai" });
    response = { choices: [{ finish_reason: "content_filter" }] };
    await warm(s, afterBody, { protocol: "openai" });
    assert.equal(requests.length, 1);
    assert(logs.some(x => x.includes("[cache-prefix-refresh] failed") && x.includes("http=success api=incomplete")));
});

test("manual thinking with explicit interleaved support preserves its budget and cap", async () => {
    const s = session();
    const extras = { thinking: { type: "enabled", budget_tokens: 1024 } };
    const overrides = { headers: { ...input(s).headers, "anthropic-beta": "interleaved-thinking-2025-05-14" } };
    await prime(s, body([...A, ...B], extras), overrides);
    await warm(s, body([...A, ...C], extras), overrides);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.thinking, extras.thinking);
    assert.equal(requests[0].body.max_tokens, 1);
});

test("externally effectful and unknown tool configuration shapes have specific skips", async () => {
    for (const [extras, reason] of [
        [{ tools: { web_search: true } }, "unknown-tools-shape"],
        [{ mcp_servers: { url: "https://not-called.invalid" } }, "server-mcp-tools"],
        [{ plugins: { id: "web" } }, "server-plugins"],
    ] as [Json, string][]) {
        const s = session();
        await prime(s, body([...A, ...B], extras));
        await warm(s, body([...A, ...C], extras));
        assert(logs.some(x => x.includes(`reason=${reason}`)));
    }
    assert.equal(requests.length, 0);
});

test("Chat preserves a meaningful static system/developer-only prefix without dummy messages", () => {
    const prefix = [{ role: "system", content: "stable system" }, { role: "developer", content: "stable developer" }];
    const old = { messages: [...prefix, { role: "user", content: "old" }] };
    const current = { messages: [...prefix, { role: "user", content: "new" }] };
    const plan = buildPrefixRefreshBody(old, current, "openai");
    assert(plan.body);
    assert.deepEqual(JSON.parse(plan.body).messages, prefix);
    assert.equal(buildPrefixRefreshBody({ instructions: "stable", input: B }, { instructions: "stable", input: C }, "responses").reason, "static-only-responses-unverified");
    assert.equal(buildPrefixRefreshBody({ system: "stable", messages: B }, { system: "stable", messages: C }, "anthropic").body, undefined);
});

test("signed thinking without active thinking is preserved whole on a prefill-capable model", () => {
    const signed = { role: "assistant", content: [{ type: "thinking", thinking: "keep", signature: "opaque-signature" }, { type: "redacted_thinking", data: "opaque-redacted" }, { type: "text", text: "answer" }] };
    const prefix = [...A, signed];
    const old = body([...prefix, { role: "user", content: "old" }], { model: "claude-sonnet-4-5" });
    const current = body([...prefix, { role: "user", content: "new" }], { model: "claude-sonnet-4-5" });
    const plan = buildPrefixRefreshBody(old, current, "anthropic");
    assert(plan.body);
    assert.deepEqual(JSON.parse(plan.body).messages, prefix);
    assert.deepEqual(current.messages, [...prefix, { role: "user", content: "new" }]);
});
