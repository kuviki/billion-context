import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { getSession } from "../src/session.ts";
import { getCacheLedger } from "../src/cache-ledger.ts";
import { noteCompressionForPrefixRefresh, _resetPrefixRefreshForTest } from "../src/cache-prefix-refresh.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { _resetFetchUtilForTest } from "../src/fetch-util.ts";

process.env.BILI_STORAGE_UNIFIED = "legacy";
_setStoreForTest(new SessionStore({ enabled: false }));
after(() => { _resetFetchUtilForTest(); _resetPrefixRefreshForTest(); });
async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const protocol of ["openai", "anthropic"] as const) for (const stream of [false, true]) for (const search of [false, true]) for (const warmEnabled of [true, false]) {
    test(`real ${protocol} stream=${stream} search=${search} relay delay with warm=${warmEnabled} runs before main and isolates usage`, { timeout: 20_000 }, async () => {
        _resetPrefixRefreshForTest();
        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const sent: Record<string, unknown>[] = [];
        const logs: string[] = [];
        const refreshTimeoutMs = protocol === "openai" ? 700 : 900;
        const upstream = http.createServer(async (req, res) => {
            const parts: Buffer[] = [];
            for await (const part of req) parts.push(Buffer.from(part));
            const value = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
            sent.push(value);
            const warm = value.max_tokens === 1;
            const usage = protocol === "anthropic"
                ? { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: warm ? 999 : 80, cache_creation_input_tokens: 0 }
                : { prompt_tokens: warm ? 999 : 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: warm ? 999 : 80 } };
            const result = protocol === "anthropic"
                ? { id: `msg_${sent.length}`, type: "message", role: "assistant", content: [{ type: "text", text: "reply" }], stop_reason: "end_turn", model: "plain-test", usage }
                : { id: `chatcmpl-${sent.length}`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "reply" }, finish_reason: "stop" }], model: "plain-test", usage };
            res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
            if (!stream) res.end(JSON.stringify(result));
            else if (protocol === "openai") {
                res.write(`data: ${JSON.stringify({ id: "chat_warm", choices: [{ index: 0, delta: { content: "reply" }, finish_reason: "stop" }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
                res.end("data: [DONE]\n\n");
            } else {
                const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
                res.write(event("message_start", { type: "message_start", message: { id: "msg_reply", type: "message", role: "assistant", content: [], model: "plain-test", usage } }));
                res.write(event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
                res.write(event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reply" } }));
                res.write(event("content_block_stop", { type: "content_block_stop", index: 0 }));
                res.write(event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }));
                res.end(event("message_stop", { type: "message_stop" }));
            }
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: origin,
            routes: { [origin]: { models: { "plain-test": { context: 400_000, ...(protocol === "openai" ? { cacheKeepalive: { refreshTimeoutMs: 700, refreshDelayMs: 25 } } : {}) } }, cacheKeepalive: { refreshAfterCompress: warmEnabled, refreshTimeoutMs: 900, refreshDelayMs: 35 } } },
            modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
            compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session", log: false, debug: false,
            passthrough: false, passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false,
            updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
        };
        const proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const sid = `refresh-http-${protocol}-${stream}-${search}-${warmEnabled}`;
        const searchSettings = !search ? {} : protocol === "openai"
            ? { web_search_options: { search_context_size: "low" }, tool_choice: "auto" }
            : { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }, { name: "client_tool", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "auto" } };
        const endpoint = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
        const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${origin}${endpoint}`;
        const post = async (suffix: string) => {
            const response = await fetch(url, {
                method: "POST", signal: AbortSignal.timeout(10_000),
                headers: { "content-type": "application/json", "x-acp-session": sid, "x-api-key": "synthetic-key" },
                body: JSON.stringify({ model: "plain-test", stream, ...searchSettings, ...(protocol === "openai" && stream ? { stream_options: { include_usage: false } } : {}), max_tokens: 4000, messages: [{ role: "user", content: "stable first A" }, { role: "assistant", content: suffix }, { role: "user", content: "stable tail" }] }),
            });
            assert.equal(response.status, 200);
            assert.match(await response.text(), /reply/);
        };
        setLogCapture((_level, message) => logs.push(message));
        try {
            await post("OLD B");
            assert.equal(sent.length, 1);
            noteCompressionForPrefixRefresh(getSession(sid));
            const started = Date.now();
            await post("NEW C");
            const delayMs = protocol === "openai" ? 25 : 35;
            assert(Date.now() - started >= delayMs - 5);
            assert(logs.some(x => x.includes(`delay configuredMs=${delayMs}`) && x.includes(`phase=${warmEnabled ? "warm" : "formal"}`)));
            if (warmEnabled) {
                assert.equal(sent.length, 3, "initial normal, prefix-only warm, post-fold normal");
                assert.equal(sent[1].max_tokens, 1);
                const warmLog = logs.find(x => x.includes("[cache-prefix-refresh] success"));
                assert(warmLog);
                assert.match(warmLog, new RegExp(`timeoutMs=${refreshTimeoutMs}\\b`), "resolved provider/model timeout reaches the real relay hook");
                assert.equal(sent[1].stream, stream);
                assert.deepEqual(sent[1].stream_options, sent[2].stream_options, "preserve stream_options exactly without enabling usage");
                for (const field of ["web_search_options", "tools", "tool_choice"]) assert.deepEqual(sent[1][field], sent[2][field], `warm keeps final formal ${field}`);
                assert.match(JSON.stringify(sent[1].messages), /stable first A/);
                assert.doesNotMatch(JSON.stringify(sent[1].messages), /OLD B|NEW C|stable tail/);
                assert.match(JSON.stringify(sent[2].messages), /NEW C/);
            } else {
                assert.equal(sent.length, 2, "delay-only must not send any warm request");
                assert.match(JSON.stringify(sent[1].messages), /NEW C/);
            }
            const lines = getCacheLedger(getSession(sid)).lines;
            assert.equal(lines.length, 2, "warm usage must not be inserted into conversation ledger");
            assert(lines.every(line => line.input === 100), "warm's synthetic 999-token usage never poisons main accounting");
        } finally {
            setLogCapture(null);
            await close(proxy);
            await close(upstream);
            setRegistryForTest({});
        }
    });
}

for (const searchHistory of [false, true]) test(`real Responses relay preserves declaration/search history=${searchHistory} in warm prefix before formal request`, { timeout: 20_000 }, async () => {
    _resetPrefixRefreshForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const sent: Record<string, unknown>[] = [];
    const upstream = http.createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        const value = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
        sent.push(value);
        const warm = value.max_output_tokens === 16;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `resp_${sent.length}`, object: "response", status: "completed", model: "plain-test", output: warm
            ? [{ type: "function_call", id: "fc_warm", call_id: "never-dispatch", name: "acp_status", arguments: "{}" }]
            : [{ type: "message", id: "msg_reply", role: "assistant", content: [{ type: "output_text", text: "reply", annotations: [] }] }],
            usage: { input_tokens: warm ? 999 : 100, output_tokens: 1, input_tokens_details: { cached_tokens: warm ? 999 : 80 } } }));
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const opts: ProxyOptions = {
        port: 0, host: "127.0.0.1", upstream: origin,
        routes: { [origin]: { models: { "plain-test": { context: 400_000 } }, cacheKeepalive: { refreshAfterCompress: true, refreshTimeoutMs: 900 } } },
        modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false,
        passthrough: false, passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false,
        updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts); if (!proxy.listening) await once(proxy, "listening");
    const sid = `refresh-http-responses-declarations-${searchHistory}`;
    const declarations = { type: "additional_tools", role: "developer", id: "synthetic-tools", tools: [{ type: "namespace", name: "functions", description: "Synthetic tools", tools: [{ type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] }] };
    const listing = { type: "mcp_list_tools", id: "synthetic-list", server_label: "synthetic-server", tools: [{ name: "read_file", input_schema: { type: "object", properties: {} } }] };
    const search = { type: "tool_search", execution: "client", parameters: { type: "object", properties: { query: { type: "string" } } } };
    const opaqueInterior = [{ type: "vendor_cache_note", payload: { exact: ["keep", 7] } }, { ...declarations, id: "synthetic-mid-tools" }];
    const pair = [
        { type: "tool_search_call", execution: "client", status: "completed", call_id: "synthetic-search", arguments: { query: "read" } },
        { type: "tool_search_output", execution: "client", status: "completed", call_id: "synthetic-search", tools: declarations.tools },
    ];
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${origin}/v1/responses`;
    const post = async (suffix: string) => {
        const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", "x-acp-session": sid, authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model: "plain-test", stream: false, max_output_tokens: 4000, tool_choice: "auto", ...(searchHistory ? { tools: [search] } : {}), input: [declarations, ...(searchHistory ? [listing] : []), { type: "message", role: "user", content: "stable A" }, ...(searchHistory ? [...opaqueInterior, ...pair] : []), { type: "message", role: "assistant", content: suffix }, { type: "message", role: "user", content: "stable tail" }] }) });
        assert.equal(response.status, 200); assert.match(await response.text(), /reply/);
    };
    try {
        await post("OLD B"); assert.equal(sent.length, 1);
        noteCompressionForPrefixRefresh(getSession(sid));
        await post("NEW C");
        assert.equal(sent.length, 3, "normal, prefix warm, normal only; warm acp_status was discarded");
        const warm = sent[1], formal = sent[2];
        assert.equal(warm.max_output_tokens, 16);
        const warmInput = warm.input as unknown[], formalInput = formal.input as unknown[];
        assert.deepEqual(warmInput[0], declarations);
        assert.deepEqual(formalInput[0], declarations);
        if (searchHistory) {
            for (const item of [listing, ...opaqueInterior, ...pair]) assert.ok(warmInput.some(x => JSON.stringify(x) === JSON.stringify(item)), "listing and completed client search pair retained byte-for-byte");
            assert.ok((warm.tools as unknown[]).some(x => JSON.stringify(x) === JSON.stringify(search)));
        }
        assert.deepEqual(warmInput, formalInput.slice(0, warmInput.length));
        assert.match(JSON.stringify(warmInput), /stable A/);
        assert.doesNotMatch(JSON.stringify(warmInput), /OLD B|NEW C|stable tail/);
        assert.match(JSON.stringify(formalInput), /NEW C/);
        const expected = { ...formal, input: warmInput, max_output_tokens: 16, store: false };
        assert.deepEqual(warm, expected, "only history/output cap/store differ from formal request");
        const lines = getCacheLedger(getSession(sid)).lines;
        assert.equal(lines.length, 2);
        assert(lines.every(line => line.input === 100), "discarded warm usage stays out of conversation accounting");
    } finally {
        await close(proxy); await close(upstream); setRegistryForTest({});
    }
});
