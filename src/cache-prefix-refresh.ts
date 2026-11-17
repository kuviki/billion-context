import { createHash } from "node:crypto";
import { credentialFingerprint } from "./cache-ledger.js";
import { DEFAULT_CACHE_REFRESH_TIMEOUT_MS, MAX_CACHE_REFRESH_TIMEOUT_MS } from "./config.js";
import { fetchWithTimeout } from "./fetch-util.js";
import { currentFetchTransport, currentWsDirectHeaders, isWsLaneTransport } from "./fetch-transport.js";
import { log } from "./logger.js";
import type { Session } from "./session.js";
import { usageTotals, type WireProtocol } from "./util.js";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024;
type Json = Record<string, unknown>;
type Snapshot = { body: Json; namespace: string; order: number; skipReason?: string };
type RefreshState = { last?: Snapshot; pending?: Snapshot; active?: Promise<void>; order: number };
let states = new WeakMap<Session, RefreshState>();
const obj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface PrefixRefreshInput {
    session: Session;
    enabled: boolean;
    refreshWebSocketViaSse?: boolean;
    /** A WS anchored fast delta is not a proven full standalone history. */
    incompleteHistory?: boolean;
    timeoutMs?: number;
    protocol: WireProtocol | undefined;
    body: string | Buffer;
    url: string;
    headers: Record<string, string>;
    dispatcher?: object;
    signal?: AbortSignal;
    unsupported?: boolean;
    unsupportedReason?: string;
}

export function noteCompressionForPrefixRefresh(session: Session): void {
    const state = states.get(session);
    if (state?.last && !state.pending) state.pending = state.last;
}

function nativeWebSearch(tool: Json, protocol: WireProtocol | undefined): boolean {
    if (typeof tool.type !== "string" || tool.server_url !== undefined || tool.connector_id !== undefined) return false;
    if (protocol === "responses") return ["web_search", "web_search_2025_08_26", "web_search_preview", "web_search_preview_2025_03_11"].includes(tool.type);
    return protocol === "anthropic" && tool.name === "web_search" && ["web_search_20250305", "web_search_20260209", "web_search_20260318"].includes(tool.type);
}

function remoteToolDeclaration(tool: Json): boolean {
    return typeof tool.type === "string" && tool.type.trim().length > 0 && (tool.type === "mcp" || tool.type === "connector" || tool.server_url !== undefined || tool.connector_id !== undefined);
}

// Explicit BYOT/client search only. Omitted execution means hosted search,
// not a client declaration; unknown fields must not bypass this via MCP gates.
function validClientToolSearch(tool: Json): boolean {
    return tool.type === "tool_search" && tool.execution === "client" && obj(tool.parameters) &&
        (tool.description === undefined || typeof tool.description === "string") &&
        Object.keys(tool).every(k => ["type", "execution", "parameters", "description"].includes(k));
}

function validResponsesNamespace(tool: Json, toolsDisabled = false): boolean {
    const pending: unknown[] = [tool];
    while (pending.length > 0) {
        const item = pending.pop();
        if (!obj(item) || typeof item.type !== "string" || item.type.trim().length === 0) return false;
        if (item.type === "namespace") {
            if (typeof item.name !== "string" || item.name.trim().length === 0 || !Array.isArray(item.tools) || item.tools.length === 0) return false;
            for (const child of item.tools) pending.push(child);
            continue;
        }
        if (item.type === "tool_search" && !toolsDisabled) {
            if (!validClientToolSearch(item)) return false;
            continue;
        }
        if (remoteToolDeclaration(item)) continue;
        if (nativeWebSearch(item, "responses")) continue;
        if (["function", "custom"].includes(item.type) || item.name !== undefined) {
            if (typeof item.name !== "string" || item.name.trim().length === 0) return false;
        }
        if (item.type === "function") {
            if (item.parameters != null && !obj(item.parameters)) return false;
        } else if (item.type === "custom") {
            if (item.format != null && (!obj(item.format) || (item.format.type !== "text" && !(item.format.type === "grammar" && (item.format.syntax === "lark" || item.format.syntax === "regex") && typeof item.format.definition === "string")))) return false;
        }
    }
    return true;
}

// Retain strict client-only definitions for known tool-search results. Opaque
// input items (including additional_tools) are not validated by this helper.
function validClientSearchTools(tools: unknown): boolean {
    if (!Array.isArray(tools) || tools.length === 0) return false;
    if (!validResponsesNamespace({ type: "namespace", name: "search_result", tools })) return false;
    const pending: unknown[] = [...tools];
    while (pending.length > 0) {
        const tool = pending.pop();
        if (!obj(tool) || remoteToolDeclaration(tool)) return false;
        if (tool.execution !== undefined && tool.execution !== "client") return false;
        if (tool.type !== "namespace" && tool.tools !== undefined) return false;
        if (tool.type !== "function" && tool.type !== "custom" && tool.type !== "namespace") return false;
        if (tool.type === "namespace") for (const child of tool.tools as unknown[]) pending.push(child);
    }
    return true;
}

function validClientSearchItem(item: Json, output: boolean): item is Json & { call_id: string } {
    const keys = output ? ["type", "id", "call_id", "execution", "status", "tools"] : ["type", "id", "call_id", "execution", "status", "arguments"];
    if (Object.keys(item).some(k => !keys.includes(k)) || item.execution !== "client" ||
        typeof item.call_id !== "string" || item.call_id.trim() === "" ||
        (item.id != null && typeof item.id !== "string") || (item.status !== undefined && item.status !== "completed")) return false;
    return output ? Array.isArray(item.tools) && (item.tools.length === 0 || validClientSearchTools(item.tools)) : obj(item.arguments);
}

function unsupportedReason(inp: PrefixRefreshInput, body: Json): string | undefined {
    if (inp.unsupportedReason) return inp.unsupportedReason;
    if (inp.unsupported) return "unsupported-wire-transform";
    if (isWsLaneTransport(currentFetchTransport()) && (!inp.refreshWebSocketViaSse || inp.protocol !== "responses")) return "stateful-websocket-transport";
    if (body.previous_response_id) return "previous-response-state";
    if (body.conversation || body.thread_id) return "server-conversation-state";
    if (body.container) return "server-container-state";
    if (body.background === true) return "background-response";
    if (body.mcp_servers != null && (!Array.isArray(body.mcp_servers) || body.mcp_servers.length > 0)) return "server-mcp-tools";
    if (body.web_search_options != null && (inp.protocol !== "openai" || !obj(body.web_search_options))) return "unknown-web-search-options";
    if (body.plugins != null && (!Array.isArray(body.plugins) || body.plugins.length > 0)) return "server-plugins";
    if (body.context_management != null && (!obj(body.context_management) || Object.keys(body.context_management).some(k => k !== "edits") || (body.context_management.edits !== undefined && (!Array.isArray(body.context_management.edits) || body.context_management.edits.length > 0)))) return "server-context-management";
    if (body.audio !== undefined || (Array.isArray(body.modalities) && body.modalities.some(m => m !== "text"))) return "non-text-output-cap-unverified";
    const headers = Object.entries(inp.headers);
    if (headers.some(([k]) => /^(idempotency-key|x-idempotency-key)$/i.test(k))) return "main-request-idempotency-key";
    const beta = headers.find(([k]) => k.toLowerCase() === "anthropic-beta")?.[1] ?? "";
    if (/message-threads/i.test(beta)) return "server-message-threads";
    if (inp.protocol === "anthropic" && obj(body.thinking) && body.thinking.type === "enabled" && !/interleaved-thinking/i.test(beta)) return "thinking-budget-exceeds-output-cap";
    const noTools = body.tool_choice === "none" || (obj(body.tool_choice) && body.tool_choice.type === "none");
    if (body.tools !== undefined && !Array.isArray(body.tools)) return "unknown-tools-shape";
    if (inp.protocol === "responses" && Array.isArray(body.tools)) {
        for (const tool of body.tools) if (obj(tool)) {
            if (!noTools && tool.type === "tool_search" && !validClientToolSearch(tool)) return "server-or-unknown-tools";
            if (tool.type === "namespace" && !validResponsesNamespace(tool, noTools)) return "server-or-unknown-tools";
        }
    }
    if (!noTools && Array.isArray(body.tools) && body.tools.some(t => !obj(t) || (!nativeWebSearch(t, inp.protocol) && (inp.protocol === "anthropic" ? t.type !== undefined && t.type !== "custom" : t.type !== "function" && t.type !== "custom" && !(inp.protocol === "responses" && (t.type === "namespace" || validClientToolSearch(t) || remoteToolDeclaration(t))))))) return "server-or-unknown-tools";
    if (inp.protocol === "responses") {
        const endpoint = new URL(inp.url);
        if (endpoint.hostname === "chatgpt.com" && endpoint.pathname.startsWith("/backend-api/")) return "codex-oauth-output-cap-unsupported";
        const learned = inp.session.metadata?.preflightNoMaxOutputTokens;
        if (obj(learned) && learned[`${inp.url}\u0000${String(body.model)}`] === true) return "learned-output-cap-unsupported";
    }
    return undefined;
}

function parseSnapshot(inp: PrefixRefreshInput): { snapshot?: Snapshot; reason?: string } {
    if (Buffer.byteLength(inp.body) > MAX_SNAPSHOT_BYTES) return { reason: "snapshot-byte-limit" };
    if (inp.protocol !== "anthropic" && inp.protocol !== "openai" && inp.protocol !== "responses") return { reason: "unsupported-protocol" };
    let body: unknown;
    try { body = JSON.parse(inp.body.toString()); } catch { return { reason: "non-json-wire-body" }; }
    if (!obj(body)) return { reason: "non-object-wire-body" };
    if (isWsLaneTransport(currentFetchTransport())) {
        if (inp.incompleteHistory || body.previous_response_id) return { reason: "incomplete-websocket-history" };
        if (body.generate === false || (obj(body.prompt_cache_options) && body.prompt_cache_options.prewarm === true)) return { reason: "websocket-client-prewarm" };
    }
    const tenantHeaders = Object.entries(inp.headers).filter(([k]) => /^(openai-organization|openai-project)$/i.test(k)).map(([k, v]) => [k.toLowerCase(), v]).sort();
    const namespace = createHash("sha256").update(JSON.stringify([inp.url, inp.protocol, body.model, credentialFingerprint(inp.headers), tenantHeaders])).digest("hex");
    return { snapshot: { body, namespace, order: 0, skipReason: unsupportedReason(inp, body) } };
}

function safeEnds(items: unknown[], protocol: WireProtocol, body: Json): Set<number> {
    const ends = new Set<number>();
    const calls = new Set<string>();
    const searchCalls = new Set<string>();
    const seenSearchCalls = new Set<string>();
    let reasoningPending = false;
    const noAnthropicPrefill = (obj(body.thinking) && body.thinking.type !== "disabled") || /claude-(?:opus-4-[67]|sonnet-4-6|mythos-preview)(?:-|$)/i.test(String(body.model));
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!obj(item)) break;
        if (protocol === "anthropic") {
            if (item.role !== "user" && item.role !== "assistant") break;
            if (typeof item.content !== "string" && !Array.isArray(item.content)) break;
            let invalid = false;
            for (const block of Array.isArray(item.content) ? item.content : []) {
                if (!obj(block)) { invalid = true; break; }
                if (block.type === "tool_use") {
                    if (typeof block.id !== "string" || calls.has(block.id)) { invalid = true; break; }
                    calls.add(block.id);
                } else if (block.type === "tool_result") {
                    if (typeof block.tool_use_id !== "string" || !calls.delete(block.tool_use_id)) { invalid = true; break; }
                } else if (!["text", "image", "document", "thinking", "redacted_thinking"].includes(String(block.type))) { invalid = true; break; }
            }
            if (invalid) break;
            if (item.role === "assistant" && noAnthropicPrefill) continue;
        } else if (protocol === "openai") {
            if (!["system", "developer", "user", "assistant", "tool", "function"].includes(String(item.role))) break;
            let invalid = false;
            for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : []) {
                if (!obj(call) || typeof call.id !== "string" || calls.has(call.id)) { invalid = true; break; }
                calls.add(call.id);
            }
            if (invalid) break;
            if (obj(item.function_call)) {
                if (typeof item.function_call.name !== "string" || calls.has(`legacy:${item.function_call.name}`)) break;
                calls.add(`legacy:${item.function_call.name}`);
            }
            if (item.role === "tool" && (typeof item.tool_call_id !== "string" || !calls.delete(item.tool_call_id))) break;
            if (item.role === "function" && (typeof item.name !== "string" || !calls.delete(`legacy:${item.name}`))) break;
        } else {
            // Unlike opaque history, these input commands can authorize a
            // remote action or request a fresh compaction when replayed.
            if (item.type === "mcp_approval_response" || item.type === "compaction_trigger") break;
            if (item.status === "in_progress") break;
            if (item.type === "tool_search_call") {
                if (!validClientSearchItem(item, false) || calls.has(item.call_id) || seenSearchCalls.has(item.call_id)) break;
                calls.add(item.call_id);
                searchCalls.add(item.call_id);
                seenSearchCalls.add(item.call_id);
                reasoningPending = false;
            } else if (item.type === "tool_search_output") {
                if (!validClientSearchItem(item, true) || !searchCalls.delete(item.call_id)) break;
                calls.delete(item.call_id);
            } else if (item.type === "function_call" || item.type === "custom_tool_call") {
                if (typeof item.call_id !== "string" || calls.has(item.call_id)) break;
                calls.add(item.call_id);
                reasoningPending = false;
            } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
                if (typeof item.call_id !== "string" || searchCalls.has(item.call_id) || !calls.delete(item.call_id)) break;
            } else if (item.type === "reasoning") {
                reasoningPending = true;
            } else if (item.type === "message" || (item.type === undefined && ["user", "assistant", "system", "developer"].includes(String(item.role)))) {
                if (!["user", "assistant", "system", "developer"].includes(String(item.role))) break;
                if (item.role === "assistant") reasoningPending = false;
            } else {
                // Exact shared whole items may ride inside a legal prefix,
                // but cannot end it or resolve pending known calls/reasoning.
                continue;
            }
        }
        if (calls.size === 0 && !reasoningPending) ends.add(i + 1);
    }
    return ends;
}

export function buildPrefixRefreshBody(previous: Json, current: Json, protocol: WireProtocol): { body?: string; unchanged: boolean; reason?: string } {
    const key = protocol === "responses" ? "input" : "messages";
    const oldItems = previous[key];
    const items = current[key];
    if (!Array.isArray(oldItems) || !Array.isArray(items)) return { unchanged: false, reason: "non-array-history" };
    let count = 0;
    while (count < Math.min(oldItems.length, items.length) && equal(oldItems[count], items[count])) count++;
    if (count === oldItems.length) return { unchanged: true };
    const ends = safeEnds(items.slice(0, count), protocol, current);
    while (count > 0 && !ends.has(count)) count--;
    if (count === 0) return { unchanged: false, reason: protocol === "responses" && current.instructions ? "static-only-responses-unverified" : "no-legal-common-prefix" };
    const warm: Json = { ...current, [key]: items.slice(0, count) };
    delete warm.max_tokens;
    delete warm.max_completion_tokens;
    delete warm.max_output_tokens;
    if (protocol === "openai") {
        if (warm.n !== undefined && warm.n !== 1) warm.n = 1;
        if (warm.best_of !== undefined && warm.best_of !== 1) warm.best_of = 1;
        if (warm.store === true) warm.store = false;
    }
    const reasoningChat = current.reasoning_effort !== undefined || current.reasoning !== undefined || current.enable_thinking === true || /(?:^|\/)(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/i.test(String(current.model));
    if (protocol === "responses") { warm.max_output_tokens = 16; warm.store = false; }
    else if (protocol === "openai" && (current.max_completion_tokens !== undefined || reasoningChat)) warm.max_completion_tokens = 1;
    else warm.max_tokens = 1;
    return { body: JSON.stringify(warm), unchanged: false };
}

type ApiResult = { api: string; reason: string; usage?: Json };
function responseResult(text: string, stream: boolean, protocol: WireProtocol): ApiResult {
    let usage: Json | undefined;
    let api = "unknown";
    let reason = "api-status-unavailable";
    let terminal = false;
    let malformed = false;
    const stop = (v: unknown) => {
        if (v === "length" || v === "max_tokens" || v === "max_output_tokens") { api = "output-limit"; reason = "api-output-limit"; }
        else if (v === "content_filter" || v === "model_context_window_exceeded") { api = "incomplete"; reason = "api-incomplete"; }
        else if (["stop", "end_turn", "stop_sequence", "tool_calls", "function_call", "tool_use"].includes(String(v))) { api = "completed"; reason = "completed"; }
    };
    const accept = (value: unknown, event = "") => {
        if (!obj(value)) { malformed = true; return; }
        const type = typeof value.type === "string" ? value.type : event;
        if (obj(value.usage)) usage = { ...usage, ...value.usage };
        if (obj(value.response) && obj(value.response.usage)) usage = { ...usage, ...value.response.usage };
        if (api === "failed") return;
        if (value.error || type === "error" || type === "response.failed" || value.status === "failed") { api = "failed"; reason = "api-error"; terminal = true; return; }
        if (protocol === "anthropic") {
            if (obj(value.message) && obj(value.message.usage)) usage = { ...usage, ...value.message.usage };
            stop(value.stop_reason);
            if (obj(value.delta)) stop(value.delta.stop_reason);
            if (type === "message_stop") terminal = true;
        } else if (protocol === "openai") {
            for (const choice of Array.isArray(value.choices) ? value.choices : []) {
                if (obj(choice) && typeof choice.finish_reason === "string") stop(choice.finish_reason);
            }
        } else {
            const result = obj(value.response) ? value.response : value;
            if (obj(result.usage)) usage = { ...usage, ...result.usage };
            if (type === "response.completed" || result.status === "completed") { api = "completed"; reason = "completed"; terminal = true; }
            if (type === "response.incomplete" || result.status === "incomplete") {
                api = "incomplete"; reason = "api-incomplete"; terminal = true;
                if (obj(result.incomplete_details) && result.incomplete_details.reason === "max_output_tokens") stop("max_output_tokens");
            }
            if (result.error || result.status === "failed") { api = "failed"; reason = "api-error"; terminal = true; }
        }
    };
    if (stream) {
        for (const block of text.split(/\r?\n\r?\n/)) {
            const lines = block.split(/\r?\n/);
            const data = lines.filter(x => x.startsWith("data:")).map(x => x.slice(5).trimStart()).join("\n");
            if (!data) continue;
            if (data === "[DONE]") { if (protocol === "openai") terminal = true; continue; }
            try { accept(JSON.parse(data), lines.find(x => x.startsWith("event:"))?.slice(6).trim()); }
            catch { malformed = true; }
        }
        if (!terminal && api !== "failed") { api = "stream-truncated"; reason = "missing-stream-terminal"; }
    } else {
        try { accept(JSON.parse(text)); } catch { malformed = true; }
    }
    if (malformed && api !== "failed") { api = "unknown"; reason = "malformed-response"; }
    return { api, reason, usage };
}

async function sendRefresh(inp: PrefixRefreshInput, body: string): Promise<void> {
    const timeoutMs = Number.isSafeInteger(inp.timeoutMs) && inp.timeoutMs! > 0 && inp.timeoutMs! <= MAX_CACHE_REFRESH_TIMEOUT_MS
        ? inp.timeoutMs! : DEFAULT_CACHE_REFRESH_TIMEOUT_MS;
    const directSse = isWsLaneTransport(currentFetchTransport()) && inp.refreshWebSocketViaSse === true;
    if (directSse) {
        const warm = JSON.parse(body) as Json;
        delete warm.type;
        delete warm.previous_response_id;
        delete warm.generate;
        delete warm.background;
        delete warm.stream_id;
        warm.stream = true;
        body = JSON.stringify(warm);
    }
    const effectiveHeaders = directSse ? currentWsDirectHeaders(inp.url, inp.headers) : inp.headers;
    const headers = Object.fromEntries(Object.entries(effectiveHeaders).filter(([k]) => !(directSse ? /^(content-length|transfer-encoding|connection|upgrade|sec-websocket-.+)$/i : /^(content-length|transfer-encoding|connection)$/i).test(k)));
    if (directSse) headers.accept = "text/event-stream";
    const controller = new AbortController();
    const signal = inp.signal ? AbortSignal.any([inp.signal, controller.signal]) : controller.signal;
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    let cleanup: (() => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let abort: (() => void) | undefined;
    const started = Date.now();
    let status: number | undefined;
    let replyLimit = false;
    try {
        const aborted = new Promise<never>((_resolve, reject) => {
            abort = () => { reject(new Error("refresh aborted")); void reader?.cancel().catch(() => undefined); };
            if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
        const work = async () => {
            const result = await fetchWithTimeout(inp.url, { method: "POST", headers, body, dispatcher: inp.dispatcher, redirect: "error" }, timeoutMs, signal, directSse);
            cleanup = result.clearTimer;
            if (signal.aborted) { cleanup(); void result.response.body?.cancel().catch(() => undefined); throw new Error("refresh aborted"); }
            status = result.response.status;
            reader = result.response.body?.getReader();
            let bytes = 0;
            const chunks: Buffer[] = [];
            if (reader) {
                try {
                    while (!signal.aborted) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        bytes += chunk.value.byteLength;
                        if (bytes > MAX_REPLY_BYTES) { replyLimit = true; void reader.cancel().catch(() => undefined); break; }
                        chunks.push(Buffer.from(chunk.value));
                    }
                } finally { try { reader.releaseLock(); } catch { /* Pending cancellation is best-effort. */ } }
            }
            const resultText = Buffer.concat(chunks).toString("utf8");
            const stream = /text\/event-stream/i.test(result.response.headers.get("content-type") ?? "") || /^\s*(event:|data:)/.test(resultText);
            const parsed = replyLimit ? { api: "unknown", reason: "response-byte-limit" } : responseResult(resultText, stream, inp.protocol!);
            return { ok: result.response.ok, ...parsed };
        };
        const result = await Promise.race([work(), aborted]);
        let metrics = "cached=unknown total=unknown hit=unknown";
        if (result.usage && inp.protocol) {
            const totals = usageTotals(inp.protocol, result.usage);
            const hit = totals.total !== undefined && totals.total > 0 && totals.cached !== undefined ? `${(100 * totals.cached / totals.total).toFixed(1)}%` : "unknown";
            metrics = `cached=${totals.cached ?? "unknown"} total=${totals.total ?? "unknown"} hit=${hit} creation=${totals.creation ?? "unknown"}`;
        }
        const failed = !result.ok || result.api === "failed" || result.api === "incomplete" || result.api === "stream-truncated" || result.reason === "malformed-response" || replyLimit;
        const outcome = failed ? "failed" : result.api === "unknown" ? "unknown" : "success";
        log("info", `[${inp.session.id}] [cache-prefix-refresh] ${outcome} status=${status} durationMs=${Date.now() - started} timeoutMs=${timeoutMs} http=${result.ok ? "success" : "failed"} api=${result.api} ${metrics} cacheScope=warm mainHit=unobserved reason=${result.ok ? result.reason : "http-error"} retry=0`);
    } catch {
        log("info", `[${inp.session.id}] [cache-prefix-refresh] failed status=${status ?? "unknown"} durationMs=${Date.now() - started} timeoutMs=${timeoutMs} http=${status === undefined ? "not-completed" : status < 300 ? "success" : "failed"} api=unknown cached=unknown total=unknown hit=unknown cacheScope=warm mainHit=unobserved reason=${controller.signal.aborted ? "timeout" : inp.signal?.aborted ? "aborted" : "network-or-body-error"} retry=0; continuing main request`);
    } finally {
        clearTimeout(deadline);
        if (abort) signal.removeEventListener("abort", abort);
        cleanup?.();
    }
}

function logSkip(inp: PrefixRefreshInput, reason: string): void {
    log("info", `[${inp.session.id}] [cache-prefix-refresh] skipped status=none durationMs=0 http=not-sent api=not-sent cached=unknown total=unknown hit=unknown cacheScope=warm mainHit=unobserved reason=${reason} retry=0`);
}

/** Returns a receipt to call only after the MAIN request is accepted. */
export async function beforeCachePrefixRefresh(inp: PrefixRefreshInput): Promise<() => void> {
    const noop = () => undefined;
    if (!inp.enabled) { states.delete(inp.session); return noop; }
    try {
        const parsed = parseSnapshot(inp);
        const snapshot = parsed.snapshot;
        if (!snapshot) {
            if (states.get(inp.session)?.pending) logSkip(inp, parsed.reason ?? "unsupported-request");
            states.delete(inp.session); return noop;
        }
        const state = states.get(inp.session) ?? { order: 0 };
        states.set(inp.session, state);
        snapshot.order = ++state.order;
        if (state.active) await state.active;
        const pending = state.pending;
        if (pending) {
            const plan = pending.namespace === snapshot.namespace ? buildPrefixRefreshBody(pending.body, snapshot.body, inp.protocol!) : { unchanged: false, reason: "cache-route-identity-changed" };
            if (!plan.unchanged) {
                delete state.pending;
                const reason = snapshot.skipReason ?? plan.reason;
                if (plan.body && !reason && !inp.signal?.aborted) {
                    const active = sendRefresh(inp, plan.body);
                    state.active = active;
                    try { await active; } finally { if (state.active === active) delete state.active; }
                } else logSkip(inp, inp.signal?.aborted ? "client-aborted" : reason ?? "no-legal-common-prefix");
            }
        }
        return () => {
            if (states.get(inp.session) === state && (!state.last || state.last.order < snapshot.order)) state.last = snapshot;
        };
    } catch {
        states.delete(inp.session);
        logSkip(inp, "invalid-request-shape");
        return noop;
    }
}

export function _resetPrefixRefreshForTest(): void {
    states = new WeakMap();
}
