import { createHash } from "node:crypto";
import { credentialFingerprint } from "./cache-ledger.js";
import { DEFAULT_CACHE_REFRESH_TIMEOUT_MS, MAX_CACHE_REFRESH_TIMEOUT_MS } from "./config.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { currentFetchTransport } from "./fetch-transport.js";
import { log } from "./logger.js";
import type { Session } from "./session.js";
import { usageTotals, type WireProtocol } from "./util.js";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_BYTES = 64 * 1024;
type Json = Record<string, unknown>;
type Snapshot = { body: Json; namespace: string; order: number };
type RefreshState = { last?: Snapshot; pending?: Snapshot; active?: Promise<void>; order: number };
let states = new WeakMap<Session, RefreshState>();
const ignored = new Set(["messages", "input", "stream", "stream_options", "max_tokens", "max_completion_tokens", "max_output_tokens"]);
const obj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface PrefixRefreshInput {
    session: Session;
    enabled: boolean;
    timeoutMs?: number;
    protocol: WireProtocol | undefined;
    body: string | Buffer;
    url: string;
    headers: Record<string, string>;
    dispatcher?: object;
    signal?: AbortSignal;
    unsupported?: boolean;
}

export function noteCompressionForPrefixRefresh(session: Session): void {
    const state = states.get(session);
    if (state?.last && !state.pending) state.pending = state.last;
}

function parseSnapshot(inp: PrefixRefreshInput): Snapshot | undefined {
    if (inp.unsupported || currentFetchTransport() || typeof inp.body !== "string" || Buffer.byteLength(inp.body) > MAX_SNAPSHOT_BYTES) return;
    if (inp.protocol !== "anthropic" && inp.protocol !== "openai" && inp.protocol !== "responses") return;
    const body: unknown = JSON.parse(inp.body);
    if (!obj(body)) return;
    if (body.previous_response_id || body.conversation || body.thread_id || body.mcp_servers || body.container || body.background) return;
    if (body.web_search_options !== undefined || body.plugins !== undefined || body.context_management !== undefined || body.audio !== undefined) return;
    if (Array.isArray(body.modalities) && body.modalities.some(m => m !== "text")) return;
    if (obj(body.thinking) && body.thinking.type !== "disabled") return;
    if (body.reasoning_effort !== undefined && body.reasoning_effort !== "none") return;
    if (body.reasoning !== undefined && (!obj(body.reasoning) || body.reasoning.effort !== "none")) return;
    if (body.enable_thinking === true) return;
    if (inp.url.includes("chatgpt.com/backend-api/")) return;
    if (Object.entries(inp.headers).some(([k, v]) => /^(idempotency-key|x-idempotency-key)$/i.test(k) || (k.toLowerCase() === "anthropic-beta" && /message-threads/i.test(v)))) return;
    if (Array.isArray(body.tools) && body.tools.some(t => !obj(t) || (inp.protocol === "anthropic" ? t.type !== undefined && t.type !== "custom" : t.type !== "function"))) return;
    const stable: Json = {};
    for (const key of Object.keys(body).sort()) if (!ignored.has(key)) stable[key] = body[key];
    const providerHeaders = Object.entries(inp.headers).filter(([k]) => /^(anthropic-version|anthropic-beta|openai-organization|openai-project)$/i.test(k)).map(([k, v]) => [k.toLowerCase(), v]).sort();
    const namespace = createHash("sha256").update(JSON.stringify([inp.url, inp.protocol, credentialFingerprint(inp.headers), providerHeaders, stable])).digest("hex");
    return { body, namespace, order: 0 };
}

function safeEnds(items: unknown[], protocol: WireProtocol): Set<number> {
    const ends = new Set<number>();
    const calls = new Set<string>();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!obj(item)) break;
        let user = item.role === "user";
        if (protocol === "anthropic") {
            if (item.role !== "user" && item.role !== "assistant") break;
            const content = item.content;
            if (typeof content !== "string" && !Array.isArray(content)) break;
            let invalid = false;
            for (const block of Array.isArray(content) ? content : []) {
                if (!obj(block)) { invalid = true; break; }
                if (block.type === "tool_use") {
                    if (typeof block.id !== "string" || calls.has(block.id)) { invalid = true; break; }
                    calls.add(block.id);
                } else if (block.type === "tool_result") {
                    if (typeof block.tool_use_id !== "string" || !calls.delete(block.tool_use_id)) { invalid = true; break; }
                } else if (block.type !== "text" && block.type !== "image" && block.type !== "document") {
                    invalid = true; break;
                }
            }
            if (invalid) break;
        } else if (protocol === "openai") {
            if (!["system", "developer", "user", "assistant", "tool"].includes(String(item.role))) break;
            if (item.reasoning_content || item.reasoning || item.function_call) break;
            if (Array.isArray(item.tool_calls)) {
                let invalid = false;
                for (const call of item.tool_calls) {
                    if (!obj(call) || typeof call.id !== "string" || calls.has(call.id)) { invalid = true; break; }
                    calls.add(call.id);
                }
                if (invalid) break;
            }
            if (item.role === "tool") {
                if (typeof item.tool_call_id !== "string" || !calls.delete(item.tool_call_id)) break;
                user = true;
            }
        } else {
            if (item.type === "function_call") {
                if (typeof item.call_id !== "string" || calls.has(item.call_id)) break;
                calls.add(item.call_id);
            } else if (item.type === "function_call_output") {
                if (typeof item.call_id !== "string" || !calls.delete(item.call_id)) break;
                user = true;
            } else if (item.type !== undefined && item.type !== "message") break;
            else if (!["user", "assistant", "system", "developer"].includes(String(item.role))) break;
        }
        if (user && calls.size === 0) ends.add(i + 1);
    }
    return ends;
}

export function buildPrefixRefreshBody(previous: Json, current: Json, protocol: WireProtocol): { body?: string; unchanged: boolean } {
    const key = protocol === "responses" ? "input" : "messages";
    const oldItems = previous[key];
    const items = current[key];
    if (!Array.isArray(oldItems) || !Array.isArray(items)) return { unchanged: false };
    let count = 0;
    while (count < Math.min(oldItems.length, items.length) && equal(oldItems[count], items[count])) count++;
    if (count === oldItems.length) return { unchanged: true };
    const ends = safeEnds(items.slice(0, count), protocol);
    while (count > 0 && !ends.has(count)) count--;
    if (count === 0) return { unchanged: false };
    const warm: Json = { ...current, [key]: items.slice(0, count), stream: false };
    delete warm.stream_options;
    delete warm.max_tokens;
    delete warm.max_completion_tokens;
    delete warm.max_output_tokens;
    if (protocol === "openai") { warm.n = 1; delete warm.best_of; if (warm.store === true) warm.store = false; }
    if (protocol === "responses") { warm.max_output_tokens = 16; warm.store = false; }
    else if (protocol === "openai" && current.max_completion_tokens !== undefined) warm.max_completion_tokens = 1;
    else warm.max_tokens = 1;
    return { body: JSON.stringify(warm), unchanged: false };
}

async function sendRefresh(inp: PrefixRefreshInput, body: string): Promise<void> {
    const timeoutMs = Number.isSafeInteger(inp.timeoutMs) && inp.timeoutMs! > 0 && inp.timeoutMs! <= MAX_CACHE_REFRESH_TIMEOUT_MS
        ? inp.timeoutMs! : DEFAULT_CACHE_REFRESH_TIMEOUT_MS;
    const headers = Object.fromEntries(Object.entries(inp.headers).filter(([k]) => !/^(content-length|transfer-encoding|connection)$/i.test(k)));
    const controller = new AbortController();
    const signal = inp.signal ? AbortSignal.any([inp.signal, controller.signal]) : controller.signal;
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    let cleanup: (() => void) | undefined;
    const started = Date.now();
    let status: number | undefined;
    try {
        const result = await fetchWithTimeout(inp.url, { method: "POST", headers, body, dispatcher: inp.dispatcher, redirect: "error" }, timeoutMs, signal);
        cleanup = result.clearTimer;
        status = result.response.status;
        const reader = result.response.body?.getReader();
        let bytes = 0;
        const chunks: Buffer[] = [];
        if (reader) {
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > MAX_REPLY_BYTES) { await reader.cancel(); break; }
                    chunks.push(Buffer.from(chunk.value));
                }
            } finally { reader.releaseLock(); }
        }
        let metrics = "cached=unknown total=unknown hit=unknown";
        try {
            const reply: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (obj(reply) && obj(reply.usage) && inp.protocol) {
                const totals = usageTotals(inp.protocol, reply.usage);
                const hit = totals.total !== undefined && totals.total > 0 && totals.cached !== undefined ? `${(100 * totals.cached / totals.total).toFixed(1)}%` : "unknown";
                metrics = `cached=${totals.cached ?? "unknown"} total=${totals.total ?? "unknown"} hit=${hit} creation=${totals.creation ?? "unknown"}`;
            }
        } catch { /* Response content is discarded; missing usage stays unknown. */ }
        log("info", `[${inp.session.id}] [cache-prefix-refresh] ${result.response.ok ? "success" : "failed"} status=${status} durationMs=${Date.now() - started} timeoutMs=${timeoutMs} ${metrics} reason=${result.response.ok ? "completed" : "http-error"} retry=0`);
    } catch {
        log("info", `[${inp.session.id}] [cache-prefix-refresh] failed status=${status ?? "unknown"} durationMs=${Date.now() - started} timeoutMs=${timeoutMs} cached=unknown total=unknown hit=unknown reason=${controller.signal.aborted ? "timeout" : inp.signal?.aborted ? "aborted" : "network-or-body-error"} retry=0; continuing main request`);
    } finally {
        clearTimeout(deadline);
        cleanup?.();
    }
}

/** Returns a receipt to call only after the MAIN request is accepted. */
export async function beforeCachePrefixRefresh(inp: PrefixRefreshInput): Promise<() => void> {
    const noop = () => undefined;
    if (!inp.enabled) { states.delete(inp.session); return noop; }
    try {
        const snapshot = parseSnapshot(inp);
        if (!snapshot) {
            if (states.get(inp.session)?.pending) log("info", `[${inp.session.id}] [cache-prefix-refresh] skipped status=none durationMs=0 cached=unknown total=unknown hit=unknown reason=unsupported-request retry=0`);
            states.delete(inp.session); return noop;
        }
        const state = states.get(inp.session) ?? { order: 0 };
        states.set(inp.session, state);
        snapshot.order = ++state.order;
        if (state.active) await state.active;
        const pending = state.pending;
        if (pending) {
            const plan = pending.namespace === snapshot.namespace ? buildPrefixRefreshBody(pending.body, snapshot.body, inp.protocol!) : { unchanged: false };
            if (!plan.unchanged) {
                delete state.pending;
                if (plan.body && !inp.signal?.aborted) {
                    const active = sendRefresh(inp, plan.body);
                    state.active = active;
                    try { await active; } finally { if (state.active === active) delete state.active; }
                } else log("info", `[${inp.session.id}] [cache-prefix-refresh] skipped status=none durationMs=0 cached=unknown total=unknown hit=unknown reason=no-safe-prefix-or-namespace-changed retry=0`);
            }
        }
        return () => {
            if (states.get(inp.session) === state && (!state.last || state.last.order < snapshot.order)) state.last = snapshot;
        };
    } catch {
        states.delete(inp.session);
        log("info", `[${inp.session.id}] [cache-prefix-refresh] skipped status=none durationMs=0 cached=unknown total=unknown hit=unknown reason=unsupported-request retry=0`);
        return noop;
    }
}

export function _resetPrefixRefreshForTest(): void {
    states = new WeakMap();
}
