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

for (const protocol of ["openai", "anthropic"] as const) {
    test(`real ${protocol} relay runs provider-enabled prefix refresh before main and isolates usage`, { timeout: 20_000 }, async () => {
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
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: origin,
            routes: { [origin]: { models: { "plain-test": { context: 400_000, ...(protocol === "openai" ? { cacheKeepalive: { refreshTimeoutMs: 700 } } : {}) } }, cacheKeepalive: { refreshAfterCompress: true, refreshTimeoutMs: 900 } } },
            modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
            compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session", log: false, debug: false,
            passthrough: false, passthroughSource: null, autoUpdate: false, autoRestartOnUpdate: false,
            updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            compat: { roles: {} }, streamErrorShape: "protocol", mitm: { enabled: false, domains: [] },
        };
        const proxy = await startServer(opts);
        if (!proxy.listening) await once(proxy, "listening");
        const sid = `refresh-http-${protocol}`;
        const endpoint = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
        const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${origin}${endpoint}`;
        const post = async (suffix: string) => {
            const response = await fetch(url, {
                method: "POST", signal: AbortSignal.timeout(10_000),
                headers: { "content-type": "application/json", "x-acp-session": sid, "x-api-key": "synthetic-key" },
                body: JSON.stringify({ model: "plain-test", stream: false, max_tokens: 4000, messages: [{ role: "user", content: "stable first A" }, { role: "assistant", content: suffix }, { role: "user", content: "stable tail" }] }),
            });
            assert.equal(response.status, 200);
            assert.match(await response.text(), /reply/);
        };
        setLogCapture((_level, message) => logs.push(message));
        try {
            await post("OLD B");
            assert.equal(sent.length, 1);
            noteCompressionForPrefixRefresh(getSession(sid));
            await post("NEW C");
            assert.equal(sent.length, 3, "initial normal, prefix-only warm, post-fold normal");
            assert.equal(sent[1].max_tokens, 1);
            const warmLog = logs.find(x => x.includes("[cache-prefix-refresh] success"));
            assert(warmLog);
            assert.match(warmLog, new RegExp(`timeoutMs=${refreshTimeoutMs}\\b`), "resolved provider/model timeout reaches the real relay hook");
            assert.equal(sent[1].stream, false);
            assert.match(JSON.stringify(sent[1].messages), /stable first A/);
            assert.doesNotMatch(JSON.stringify(sent[1].messages), /OLD B|NEW C|stable tail/);
            assert.match(JSON.stringify(sent[2].messages), /NEW C/);
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
