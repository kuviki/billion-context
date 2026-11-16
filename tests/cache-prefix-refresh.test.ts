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

test("wire/model/credential/endpoint/tenant changes never reuse the old cache route", async () => {
    for (const [value, override] of [
        [body([...A, ...C], { model: "changed-model" }), {}],
        [afterBody, { headers: { "x-api-key": "changed-key" } }],
        [afterBody, { url: `${url}?other-route=1` }],
        [afterBody, { protocol: "openai" }],
        [afterBody, { headers: { ...input(session()).headers, "OpenAI-Organization": "org-new" } }],
        [afterBody, { headers: { ...input(session()).headers, "OpenAI-Project": "project-new" } }],
    ] as [Json, Partial<PrefixRefreshInput>][]) {
        const s = session();
        await prime(s);
        await warm(s, value, override);
    }
    assert.equal(requests.length, 0);
    assert.equal(logs.filter(x => x.includes("reason=cache-route-identity-changed") && x.includes("http=not-sent")).length, 6);
});

test("unsupported request families skip, preserving availability", async () => {
    for (const extra of [
        { thinking: { type: "enabled", budget_tokens: 1024 } },
        { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] },
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

const namespaceLeafFunction = { type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, strict: true };
const namespaceLeafCustom = { type: "custom", name: "exec", description: "Client-executed only", format: { type: "text" } };
const toolNamespace = (tools: unknown[], name = "functions"): Json => ({ type: "namespace", name, description: `Tools in ${name}`, tools });
const namespacedBodies = (tools: unknown[]): [Json, Json] => {
    const old = { model: "gpt-5", reasoning: { effort: "medium" }, instructions: "keep instructions", stream: false, tools, input: [...A, ...B] };
    return [old, { ...old, input: [...A, ...C] }];
};

for (const tools of [
    [toolNamespace([namespaceLeafCustom, namespaceLeafFunction])],
    [toolNamespace([toolNamespace([namespaceLeafCustom], "nested"), namespaceLeafFunction])],
]) {
    test("Responses safe namespace wrappers warm once with schema and reasoning intact", async () => {
        const s = session();
        const [old, current] = namespacedBodies(tools);
        const original = JSON.stringify(current);
        await prime(s, old, { protocol: "responses" });
        response = { status: "completed", output: [{ type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "never-run", input: "DO NOT EXECUTE" }] };
        await warm(s, current, { protocol: "responses" });
        await beforeCachePrefixRefresh(input(s, current, { protocol: "responses" }));
        assert.equal(requests.length, 1, "only a warm request; returned calls are discarded, not run or retried");
        assert.equal(JSON.stringify(requests[0].body.tools), JSON.stringify(tools));
        assert.deepEqual(requests[0].body, { ...current, input: A, max_output_tokens: 16, store: false });
        assert.equal(JSON.stringify(current), original);
        assert(logs.some(x => x.includes("[cache-prefix-refresh] success") && x.includes("retry=0")));
    });
}

test("Responses namespace recursively blocks malformed children, even with none", async () => {
    const invalid: unknown[] = [
        { type: "namespace", name: "functions" }, toolNamespace([]), { ...toolNamespace([]), tools: null },
        { ...toolNamespace([namespaceLeafFunction]), name: "" },
        toolNamespace([null]), toolNamespace([{}]), toolNamespace([{ type: "function" }]),
        toolNamespace([{ type: "function", name: "bad", parameters: [] }]),
        toolNamespace([{ type: "custom", name: 1 }]),
        toolNamespace([{ type: "custom", name: "bad", format: [] }]),
        toolNamespace([{ type: "custom", name: "bad", format: { type: "grammar", syntax: "unknown", definition: "x" } }]),
        toolNamespace([{ type: "" }]), toolNamespace([{ type: 1 }]),
        toolNamespace([toolNamespace([{ type: "unknown", name: 1 }], "nested")]),
    ];
    for (const entry of invalid) for (const tool_choice of ["auto", "none"]) {
        const s = session();
        const [old, current] = namespacedBodies([entry]);
        old.tool_choice = tool_choice;
        current.tool_choice = tool_choice;
        await prime(s, old, { protocol: "responses" });
        await warm(s, current, { protocol: "responses" });
    }
    assert.equal(requests.length, 0);
    assert.equal(logs.filter(x => x.includes("reason=server-or-unknown-tools")).length, invalid.length * 2);
});

test("safe namespace support does not weaken Codex OAuth or learned output-cap guards", async () => {
    const [old, current] = namespacedBodies([toolNamespace([namespaceLeafCustom])]);
    const oauth = session();
    const endpoint = "https://chatgpt.com/backend-api/codex/responses";
    await prime(oauth, old, { protocol: "responses", url: endpoint });
    await warm(oauth, current, { protocol: "responses", url: endpoint });
    assert(logs.some(x => x.includes("reason=codex-oauth-output-cap-unsupported")));
    const learned = session();
    learned.metadata = { preflightNoMaxOutputTokens: { [`${url}\u0000gpt-5`]: true } };
    await prime(learned, old, { protocol: "responses" });
    await warm(learned, current, { protocol: "responses" });
    assert(logs.some(x => x.includes("reason=learned-output-cap-unsupported")));
    assert.equal(requests.length, 0);
});

test("namespace-qualified function and custom history already preserve paired calls unchanged", () => {
    for (const type of ["function", "custom_tool"] as const) {
        const call = { type: `${type}_call`, call_id: "paired", name: "exec", namespace: "functions", ...(type === "function" ? { arguments: "{}" } : { input: "code" }) };
        const output = { type: `${type}_call_output`, call_id: "paired", output: "result" };
        const prefix = [...A, call, output];
        const [old, current] = namespacedBodies([toolNamespace([namespaceLeafCustom, namespaceLeafFunction])]);
        old.input = [...prefix, ...B];
        current.input = [...prefix, ...C];
        const complete = buildPrefixRefreshBody(old, current, "responses");
        assert(complete.body);
        assert.deepEqual(JSON.parse(complete.body).input, prefix);
        current.input = [...A, call, { ...output, output: "changed" }, ...C];
        const partial = buildPrefixRefreshBody(old, current, "responses");
        assert(partial.body);
        assert.deepEqual(JSON.parse(partial.body).input, A);
    }
});

// Provider-native variants: OpenAI Responses API reference + Claude web-search tool reference.
// https://developers.openai.com/api/reference/resources/responses/methods/create
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
for (const type of ["web_search", "web_search_2025_08_26", "web_search_preview", "web_search_preview_2025_03_11"]) {
    for (const nested of [false, true]) test(`Responses ${type} nested=${nested} preserves search options and choice`, async () => {
        const search = { type, search_context_size: "low", user_location: { type: "approximate", country: "JP", city: "Tokyo" }, ...(type.startsWith("web_search_preview") ? {} : { external_web_access: false, filters: { allowed_domains: ["example.com"] } }) };
        const tools = nested ? [toolNamespace([namespaceLeafFunction, toolNamespace([search], "search")])] : [search, namespaceLeafFunction];
        const [old, current] = namespacedBodies(tools);
        old.tool_choice = current.tool_choice = { type };
        const original = JSON.stringify(current);
        const s = session();
        await prime(s, old, { protocol: "responses" });
        response = { status: "completed", output: [{ type: "web_search_call", status: "completed", action: { type: "search", query: "discard this synthetic search" } }] };
        await warm(s, current, { protocol: "responses" });
        await beforeCachePrefixRefresh(input(s, current, { protocol: "responses" }));
        assert.equal(requests.length, 1);
        assert.equal(JSON.stringify(requests[0].body.tools), JSON.stringify(tools));
        assert.deepEqual(requests[0].body, { ...current, input: A, max_output_tokens: 16, store: false });
        assert.equal(JSON.stringify(current), original);
        assert(logs.some(x => x.includes("success") && x.includes("retry=0")));
    });
}

for (const type of ["web_search_20250305", "web_search_20260209", "web_search_20260318"]) {
    test(`Anthropic ${type} keeps native search declaration and tool choice`, async () => {
        const extras = { tools: [{ type, name: "web_search", max_uses: 1, allowed_domains: ["example.com"], allowed_callers: ["direct"], user_location: { type: "approximate", country: "JP" }, ...(type === "web_search_20260318" ? { response_inclusion: "excluded" } : {}) }], tool_choice: { type: "tool", name: "web_search" } };
        const s = session();
        const current = body([...A, ...C], extras);
        const original = JSON.stringify(current);
        await prime(s, body([...A, ...B], extras));
        await warm(s, current);
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].body, { ...current, messages: A, max_tokens: 1 });
        assert.equal(JSON.stringify(current), original);
    });
}

for (const options of [{}, { search_context_size: "high", user_location: { type: "approximate", approximate: { country: "JP", city: "Tokyo" } } }]) {
    test("Chat web_search_options is preserved without a separate opt-in", async () => {
        const extras = { web_search_options: options, tool_choice: "auto", stream: true, stream_options: { include_usage: false } };
        const current = body([...A, ...C], extras);
        const s = session();
        response = { choices: [{ finish_reason: "stop" }] };
        await prime(s, body([...A, ...B], extras), { protocol: "openai" });
        await warm(s, current, { protocol: "openai" });
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0].body, { ...current, messages: A, max_tokens: 1 });
    });
}

test("Chat search setting changes warm the current template rather than blocking", async () => {
    const s = session();
    await prime(s, body([...A, ...B], { web_search_options: { search_context_size: "low" } }), { protocol: "openai" });
    await warm(s, body([...A, ...C], { web_search_options: { search_context_size: "high" } }), { protocol: "openai" });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.web_search_options, { search_context_size: "high" });
    assert.deepEqual(requests[0].body.messages, A);
});

test("native search does not relax unknown top-level tools or other effect guards", async () => {
    const cases: [WireProtocol, Json, string][] = [
        ["responses", { tools: [{ type: "web_search_future" }] }, "server-or-unknown-tools"],
        ["responses", { tools: [{ type: ["web_search"] }] }, "server-or-unknown-tools"],
        ["responses", { tools: [{ type: "web_search" }, { type: "code_interpreter", container: "auto" }] }, "server-or-unknown-tools"],
        ["responses", { tools: [{ type: "unknown" }] }, "server-or-unknown-tools"],
        ["anthropic", { tools: [{ type: "web_search_20990101", name: "web_search" }] }, "server-or-unknown-tools"],
        ["anthropic", { tools: [{ type: "web_search_20250305", name: "not_search" }] }, "server-or-unknown-tools"],
        ["anthropic", { tools: [{ type: "web_search_20250305", name: "web_search" }, { type: "web_fetch_20250910", name: "web_fetch" }] }, "server-or-unknown-tools"],
        ["openai", { web_search_options: [], tool_choice: "auto" }, "unknown-web-search-options"],
        ["openai", { web_search_options: {}, plugins: [{ id: "web" }] }, "server-plugins"],
        ["responses", { web_search_options: {} }, "unknown-web-search-options"],
    ];
    for (const [protocol, extras, reason] of cases) {
        const key = protocol === "responses" ? "input" : "messages";
        const old = { model: "plain", [key]: [...A, ...B], ...extras };
        const current = { ...old, [key]: [...A, ...C] };
        const s = session();
        await prime(s, old, { protocol });
        await warm(s, current, { protocol });
        assert(logs.at(-1)?.includes(`reason=${reason}`));
    }
    assert.equal(requests.length, 0);
});

for (const tool of [{ type: "code_interpreter", container: { type: "auto" } }, { type: "file_search", vector_store_ids: ["vs_synthetic"] }, { type: "image_generation" }, { type: "unknown", vendor_option: { keep: true } }, { type: "web_search_future" }]) {
    test(`nested ${tool.type} warms with calls disabled and leaves formal request unchanged`, async () => {
        for (const tool_choice of [undefined, "auto", "required", "none", { type: "none" }, { type: "unknown" }]) {
            const tools = [toolNamespace([namespaceLeafCustom, { type: "web_search" }, toolNamespace([tool], "nested")])];
            const [old, current] = namespacedBodies(tools);
            if (tool_choice !== undefined) old.tool_choice = current.tool_choice = tool_choice;
            const original = JSON.stringify(current);
            const s = session();
            const start = requests.length;
            await prime(s, old, { protocol: "responses" });
            response = { status: "completed", output: [{ type: "custom_tool_call", name: "exec", call_id: "never-run", input: "DO NOT EXECUTE" }] };
            await warm(s, current, { protocol: "responses" });
            assert.equal(requests.length, start + 1);
            assert.equal(JSON.stringify(requests[start].body.tools), JSON.stringify(tools));
            assert.deepEqual(requests[start].body, { ...current, input: A, max_output_tokens: 16, store: false, tool_choice: "none" });
            assert.equal(JSON.stringify(current), original);
            const main = await fetch(url, { method: "POST", body: JSON.stringify(current) });
            await main.text();
            await beforeCachePrefixRefresh(input(s, current, { protocol: "responses" }));
            assert.equal(requests.length, start + 2, "exactly warm then normal; returned calls never execute or retry");
            assert.deepEqual(requests[start + 1].body, current);
        }
    });
}


test("allowing native search declarations does not reinterpret historical server-tool blocks", () => {
    for (const protocol of ["anthropic", "responses"] as const) {
        const key = protocol === "responses" ? "input" : "messages";
        const history = protocol === "responses" ? { type: "web_search_call", status: "completed", action: { type: "search", query: "old query" } }
            : { role: "assistant", content: [{ type: "server_tool_use", id: "srvtoolu_old", name: "web_search", input: { query: "old query" } }] };
        const previous = { [key]: [...A, history, ...B] };
        const current = { [key]: [...A, history, ...C] };
        const plan = buildPrefixRefreshBody(previous, current, protocol);
        assert(plan.body);
        assert.deepEqual(JSON.parse(plan.body)[key], A);
    }
});

for (const statusCode of [400, 429, 503]) test(`native search warm HTTP ${statusCode} is attempted once, then main continues`, async () => {
    const [old, current] = namespacedBodies([toolNamespace([{ type: "web_search" }])]);
    const s = session();
    await prime(s, old, { protocol: "responses" });
    status = statusCode;
    await warm(s, current, { protocol: "responses" });
    assert.equal(requests.length, 1);
    assert(logs.some(x => x.includes(`failed status=${statusCode}`) && x.includes("retry=0")));
    status = 200;
    const main = await fetch(url, { method: "POST", body: JSON.stringify(current) });
    assert.equal(main.status, 200);
    await main.text();
    assert.equal(requests.length, 2);
});


for (const nested of [false, true]) test(`Responses remote MCP/connector nested=${nested} warms with calls off and exact declarations`, async () => {
    for (const tool of [
        { type: "mcp", server_label: "remote", server_url: "https://not-called.invalid", authorization: "synthetic-not-a-secret", require_approval: "always", allowed_tools: ["read_item"] },
        { type: "mcp", server_label: "connected", connector_id: "connector_synthetic", require_approval: "always" },
        { type: "connector", name: "remote" },
        { type: "unknown", server_url: "https://not-called.invalid" },
        { type: "unknown", connector_id: "connector_synthetic" },
        { type: "web_search", server_url: "https://not-called.invalid" },
    ]) for (const tool_choice of [undefined, "auto", "none", { type: "none" }, { type: "mcp", server_label: "remote", name: "read_item" }]) {
        const tools = nested ? [toolNamespace([namespaceLeafFunction, toolNamespace([tool], "nested")])] : [tool];
        const [old, current] = namespacedBodies(tools);
        if (tool_choice !== undefined) old.tool_choice = current.tool_choice = tool_choice;
        const original = JSON.stringify(current);
        const s = session();
        const start = requests.length;
        await prime(s, old, { protocol: "responses" });
        response = { status: "completed", output: [{ type: "mcp_list_tools", server_label: "remote", tools: [] }] };
        await warm(s, current, { protocol: "responses" });
        await beforeCachePrefixRefresh(input(s, current, { protocol: "responses" }));
        assert.equal(requests.length, start + 1, "one mock warm only; bili does not contact or execute remote tools");
        assert.equal(JSON.stringify(requests[start].body.tools), JSON.stringify(tools));
        assert.deepEqual(requests[start].body, { ...current, input: A, max_output_tokens: 16, store: false, tool_choice: "none" });
        assert.equal(JSON.stringify(current), original);
        assert(logs.at(-1)?.includes("retry=0"));
        assert(!logs.some(x => x.includes("synthetic-not-a-secret") || x.includes("not-called.invalid")));
    }
});

for (const protocol of ["anthropic", "openai", "responses"] as const) {
    test(`${protocol} changed prompt/settings warm shared history using only the upcoming template`, async () => {
        const key = protocol === "responses" ? "input" : "messages";
        const oldSettings: Json = protocol === "anthropic"
            ? { system: "old system", tools: [{ name: "old_tool", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "auto" }, thinking: { type: "disabled" } }
            : protocol === "responses"
                ? { instructions: "old instructions", tools: [namespaceLeafFunction], tool_choice: "auto", reasoning: { effort: "low" }, text: { format: { type: "text" } } }
                : { system: "old system", tools: [{ type: "function", function: { name: "old_tool", parameters: { type: "object" } } }], tool_choice: "auto", reasoning_effort: "low", response_format: { type: "text" }, web_search_options: { search_context_size: "low" } };
        const newSettings: Json = protocol === "anthropic"
            ? { system: [{ type: "text", text: "new system" }], tools: [{ name: "new_tool", input_schema: { type: "object", properties: { value: { type: "string" } } } }], tool_choice: { type: "auto", disable_parallel_tool_use: true }, thinking: { type: "adaptive" } }
            : protocol === "responses"
                ? { instructions: "new instructions", tools: [toolNamespace([namespaceLeafCustom])], tool_choice: "required", reasoning: { effort: "medium" }, text: { format: { type: "json_object" } } }
                : { system: "new system", tools: [{ type: "function", function: { name: "new_tool", parameters: { type: "object", properties: { value: { type: "string" } } } } }], tool_choice: { type: "function", function: { name: "new_tool" } }, reasoning_effort: "medium", response_format: { type: "json_object" }, web_search_options: { search_context_size: "high" } };
        const old: Json = { model: "plain", [key]: [...A, ...B], stream: false, max_tokens: 4000, prompt_cache_key: "old-hint", prompt_cache_retention: "in_memory", parallel_tool_calls: true, user: "old-user", safety_identifier: "old-id", ...oldSettings };
        const current: Json = { model: "plain", [key]: [...A, ...C], stream: true, stream_options: { include_usage: false }, max_tokens: 6000, prompt_cache_key: "new-hint", prompt_cache_retention: "24h", parallel_tool_calls: false, user: "new-user", safety_identifier: "new-id", ...newSettings };
        const original = JSON.stringify(current);
        const s = session();
        await prime(s, old, { protocol });
        response = protocol === "responses" ? { status: "completed" } : protocol === "openai" ? { choices: [{ finish_reason: "stop" }] } : { stop_reason: "end_turn" };
        await warm(s, current, { protocol });
        assert.equal(requests.length, 1);
        const expected: Json = { ...current, [key]: A };
        delete expected.max_tokens;
        if (protocol === "responses") { expected.max_output_tokens = 16; expected.store = false; }
        else if (protocol === "openai") expected.max_completion_tokens = 1;
        else expected.max_tokens = 1;
        assert.deepEqual(requests[0].body, expected);
        assert.equal(JSON.stringify(current), original);
        assert(!logs.some(x => x.includes("cache-route-identity-changed")));
    });
}

test("previous accepted but warm-unsupported requests are usable history, not a veto", async () => {
    for (const previous of [
        { extras: { system: "old system" }, headers: { "Idempotency-Key": "old-main-only" } },
        { extras: { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }], tool_choice: { type: "tool", name: "web_fetch" } }, headers: {} },
        { extras: { thinking: { type: "enabled", budget_tokens: 1024 } }, headers: {} },
        { extras: {}, headers: { "anthropic-beta": "message-threads-2026-01-01" } },
    ]) {
        const s = session();
        const old = body([...A, ...B], previous.extras);
        const oldHeaders = { ...input(s).headers, ...previous.headers } as Record<string, string>;
        const start = requests.length;
        const accepted = await beforeCachePrefixRefresh(input(s, old, { headers: oldHeaders }));
        const oldMain = await fetch(url, { method: "POST", headers: oldHeaders, body: JSON.stringify(old) });
        assert.equal(oldMain.status, 200);
        await oldMain.text();
        accepted();
        assert.equal(requests.length, start + 1);
        const current = body([...A, ...C], { system: "upcoming system", tools: [], tool_choice: { type: "auto" } });
        await warm(s, current);
        assert.equal(requests.length, start + 2, "the accepted old unsupported request must not suppress the current valid warm");
        assert.deepEqual(requests[start + 1].body, { ...current, messages: A, max_tokens: 1 });
        assert.equal(requests[start + 1].headers["idempotency-key"], undefined);
        assert.equal(requests[start + 1].headers["anthropic-beta"], undefined);
        await beforeCachePrefixRefresh(input(s, current));
        assert.equal(requests.length, start + 2, "the same fold still warms only once");
    }
});

test("Anthropic version and non-stateful beta changes use current headers without partitioning", async () => {
    const s = session();
    const oldHeaders = { ...input(s).headers, "anthropic-version": "2023-01-01", "anthropic-beta": "old-beta" };
    const currentHeaders = { ...input(s).headers, "anthropic-version": "2023-06-01", "anthropic-beta": "interleaved-thinking-2025-05-14" };
    await prime(s, beforeBody, { headers: oldHeaders });
    await warm(s, afterBody, { headers: currentHeaders });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(requests[0].headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
});

test("current unsupported checks still win after prompt settings change", async () => {
    for (const current of [
        { extras: { tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }, override: {} },
        { extras: { system: "new system" }, override: { headers: { ...input(session()).headers, "Idempotency-Key": "current-main-only" } } },
        { extras: { mcp_servers: [{ url: "https://not-called.invalid" }] }, override: {} },
    ]) {
        const s = session();
        await prime(s);
        await warm(s, body([...A, ...C], current.extras), current.override);
    }
    assert.equal(requests.length, 0);
    assert(logs.some(x => x.includes("reason=server-or-unknown-tools")));
    assert(logs.some(x => x.includes("reason=main-request-idempotency-key")));
    assert(logs.some(x => x.includes("reason=server-mcp-tools")));
});
