import type { CoreMessage, CompressionBlock } from "acp-kernel";
import { COMPRESS_TOOL_NAME } from "./compress-tool.js";
import { isPluginFoldCallId } from "./plugin.js";
import type { Session } from "./session.js";

/** Carrier-evidence index for stripKernelSummaries (#2042).
 *
 *  #1567 hardening: a plugin-fold block's in-place anchor is redundant ONLY
 *  while the client's own compress pair for that exact fold actually rides
 *  the (post-prepare) history. The pair is recognized by tool name plus the
 *  folded range quoted in its call args — flat {startId,endId} or
 *  {content:[{startId,endId}]}, both accepted by the plugin tool API. This
 *  restores the self-verifying carrier handoff a raw prefix strip lost: a
 *  pruned or contract-violating client (pair absent) keeps the anchor, so an
 *  active fold never ends up with zero carriers. It also covers kernel-side
 *  pruning: hideConsumedCompressCalls (KEEP_LAST_ORPHANED) runs in the
 *  pipeline BEFORE this strip, so an older pair already hidden from the wire
 *  is absent here and its anchor correctly survives. Unparseable args count
 *  as no match (anchor kept — fail-safe direction). Blocks predating range
 *  recording (no startRef/endRef) degrade to "any compress call present",
 *  the pre-hardening prefix-strip behavior.
 *
 *  #2042: the evidence is collected in ONE pass over the (post-kernel)
 *  history instead of rescanning it per active block (O(B×N) → O(N+B+R)).
 *  It MUST be rebuilt from THIS history on every call — the kernel may have
 *  pruned earlier pairs since prepare, so no pre-prepare cache may be
 *  reused. Compress-call args are parsed lazily (only when an active plugin
 *  block with recorded refs needs exact matching) and each call's args are
 *  parsed at most ONCE, whereas the old per-block scan reparsed them for
 *  every block. */
function buildCarrierIndex(messages: CoreMessage[]): { callIds: Set<string>; compressCalls: CoreMessage[]; ensureRangePairs: () => Map<string, Set<string>> } {
    const callIds = new Set<string>();
    const compressCalls: CoreMessage[] = [];
    for (const m of messages) {
        if (m.contentType !== "tool-call") continue;
        if (m.toolCallId) callIds.add(m.toolCallId);
        if (m.toolName === COMPRESS_TOOL_NAME) compressCalls.push(m);
    }
    let rangePairs: Map<string, Set<string>> | null = null;
    const ensureRangePairs = (): Map<string, Set<string>> => {
        if (!rangePairs) {
            rangePairs = new Map<string, Set<string>>();
            for (const c of compressCalls) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(c.text ?? "");
                } catch {
                    continue;
                }
                const obj = parsed as { startId?: string; endId?: string; content?: unknown };
                const ranges: Array<{ startId?: string; endId?: string }> = Array.isArray(obj?.content) ? (obj.content as Array<{ startId?: string; endId?: string }>) : [obj];
                for (const r of ranges) {
                    if (typeof r?.startId !== "string" || !r.startId || typeof r?.endId !== "string" || !r.endId) continue;
                    let ends = rangePairs.get(r.startId);
                    if (!ends) { ends = new Set<string>(); rangePairs.set(r.startId, ends); }
                    ends.add(r.endId);
                }
            }
        }
        return rangePairs;
    };
    return { callIds, compressCalls, ensureRangePairs };
}

export function carriedFoldBlockIds(messages: CoreMessage[], blocks: CompressionBlock[]): Set<string> {
    const { callIds, compressCalls, ensureRangePairs } = buildCarrierIndex(messages);
    const carried = new Set<string>();
    for (const b of blocks) {
        if (!b.active || !b.compressCallId) continue;
        // #1567: plugin tool API folds are minted a synthetic plugin_<ts> callId
        // the client can never echo, so the plain id match is unsatisfiable for
        // them — yet the client's own re-sent compress pair IS their carrier by
        // contract, making the in-place anchor redundant. Strip it, but only
        // while that pair actually rides the (post-prepare) history: a pruned
        // or contract-violating client must never lose the summary outright
        // (zero carriers).
        // Preflight blocks (no compressCallId) keep skipping above: no tool
        // call exists for them, so their anchor is the only carrier.
        const present = isPluginFoldCallId(b.compressCallId)
            ? (!b.startRef || !b.endRef ? compressCalls.length > 0 : ensureRangePairs().get(b.startRef)?.has(b.endRef) ?? false)
            : callIds.has(b.compressCallId);
        if (present) {
            carried.add(b.blockId);
        }
    }
    return carried;
}

type Pending = { blocks: Map<string, string>; active?: Promise<void>; activeBlocks?: Map<string, string> };
const pending = new WeakMap<Session, Pending>();

/** Only successful committed folds call this; previews/no-ops never arm it. */
export function notePostFold(session: Session, blocks: CompressionBlock[]): void {
    if (!blocks.length) return;
    const state = pending.get(session) ?? { blocks: new Map<string, string>() };
    for (const block of blocks) if (block.active) state.blocks.set(block.blockId, block.summary);
    pending.set(session, state);
}

async function abortableWait(work: Promise<void>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) return work;
    let cancel = () => {};
    const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason ?? new Error("Aborted"));
        signal.addEventListener("abort", cancel, { once: true });
    });
    try { await Promise.race([work, aborted]); } finally { signal.removeEventListener("abort", cancel); }
}

/** Called only at actual model-send seams, never for auxiliary summarizers.
 * The current rendered carrier, not session age or a prefix diff, proves that
 * this request contains the committed fold. Network retries stay below it. */
export async function waitPostFold(session: Session, messages: CoreMessage[], configuredMs: number | undefined, signal?: AbortSignal, wireBody?: string | Buffer): Promise<string> {
    const state = pending.get(session);
    if (!state) return "";
    const ms = typeof configuredMs === "number" && Number.isInteger(configuredMs) && configuredMs > 0 && configuredMs <= 120000 ? configuredMs : 0;
    if (!ms) { if (!state.active) pending.delete(session); return ""; }
    if (!state.blocks.size && !state.active) { pending.delete(session); return ""; }
    signal?.throwIfAborted();
    const carried = carriedFoldBlockIds(messages, session.state.blocks);
    const visibleIds = new Set(messages.map(message => message.id));
    // A plugin can replay an older compress call for the same range after an
    // in-place refold. Match its summary generation as well as the range.
    const pluginSummaries = new Map<string, Set<string>>();
    for (const message of messages) {
        if (message.contentType !== "tool-call" || message.toolName !== COMPRESS_TOOL_NAME) continue;
        try {
            const args = JSON.parse(message.text ?? "") as { content?: unknown; startId?: unknown; endId?: unknown; summary?: unknown };
            const ranges = Array.isArray(args?.content) ? args.content : [args];
            for (const range of ranges) if (range && typeof range.startId === "string" && typeof range.endId === "string" && typeof range.summary === "string") {
                const key = JSON.stringify([range.startId, range.endId]);
                const summaries = pluginSummaries.get(key) ?? new Set<string>();
                summaries.add(range.summary.trim()); pluginSummaries.set(key, summaries);
            }
        } catch { /* malformed calls are not evidence */ }
    }
    for (const block of session.state.blocks) {
        if (carried.has(block.blockId) && isPluginFoldCallId(block.compressCallId) &&
            !pluginSummaries.get(JSON.stringify([block.startRef, block.endRef]))?.has(block.summary.trim())) carried.delete(block.blockId);
        // A proxy loop can retain the pre-fold view when refreshFolded fails.
        // Its new compress call is not evidence that originals were replaced.
        if (carried.has(block.blockId) && !isPluginFoldCallId(block.compressCallId) &&
            !block.directMessageIds.some(id => !visibleIds.has(id)) &&
            !block.directBlockIds.some(id => !visibleIds.has(`acp_summary_${id}`))) carried.delete(block.blockId);
    }
    for (const message of messages) {
        if (message.id.startsWith("acp_summary_")) {
            const id = message.id.slice("acp_summary_".length);
            const summary = state.blocks.get(id) ?? state.activeBlocks?.get(id);
            if (summary !== undefined && (message.text ?? "").includes(summary.trim())) carried.add(id);
        }
        if (message.summaryOfBlockId) {
            const summary = state.blocks.get(message.summaryOfBlockId) ?? state.activeBlocks?.get(message.summaryOfBlockId);
            if (summary !== undefined && (message.text ?? "").includes(summary.trim())) carried.add(message.summaryOfBlockId);
        }
    }
    while (state.active) {
        if (![...carried].some(id => state.activeBlocks?.has(id) || state.blocks.has(id))) return "";
        await abortableWait(state.active.catch(() => undefined), signal);
        return waitPostFold(session, messages, configuredMs, signal, wireBody);
    }
    // Final egress may remove carriers or replace JSON with an opaque envelope.
    // In that case leave the fold pending rather than delay an unrelated send.
    const leaves: string[] = [];
    try {
        const stack: unknown[] = [JSON.parse(wireBody?.toString() ?? "")];
        while (stack.length) {
            const value = stack.pop();
            if (typeof value === "string") {
                leaves.push(value);
                // Tool-call arguments are themselves JSON strings.
                if (value.startsWith("{")) { try { stack.push(JSON.parse(value)); } catch { /* ordinary prose */ } }
            } else if (value && typeof value === "object") for (const child of Object.values(value)) stack.push(child);
        }
    } catch { return ""; }
    const selected = new Map<string, string>();
    const live = new Map(session.state.blocks.filter(b => b.active).map(b => [b.blockId, b.summary]));
    for (const [id, summary] of state.blocks) {
        if (live.get(id) !== summary) { state.blocks.delete(id); continue; }
        if (carried.has(id) && summary.trim() !== "" && leaves.some(text => text.includes(summary.trim()))) { selected.set(id, summary); state.blocks.delete(id); }
    }
    if (!selected.size) { if (!state.blocks.size && !state.active) pending.delete(session); return ""; }
    const start = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
    const active = abortableWait(work, signal);
    state.active = active;
    state.activeBlocks = selected;
    try { await active; }
    catch (error) {
        for (const [id, summary] of selected) if (!state.blocks.has(id)) state.blocks.set(id, summary);
        throw error;
    } finally { clearTimeout(timer); if (state.active === active) { delete state.active; delete state.activeBlocks; } }
    if (!state.blocks.size && !state.active) pending.delete(session);
    return ` postFoldDelayMs=${ms} postFoldWaitedMs=${Math.round(performance.now() - start)}`;
}
