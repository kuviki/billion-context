import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore, defaultConfig, type CoreMessage, type CompressionBlock } from "acp-kernel";
import { notePostFold, waitPostFold } from "../src/post-fold-delay.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";

const message = (id: string, text: string): CoreMessage => ({ id, text, role: "system", contentType: "text" });
function fixture() {
    const session = getSession(`post-fold-${Math.random()}`);
    const block: CompressionBlock = { runId: "run", tier: 1, effectiveMessageIds: ["old1", "old2"], compressedTokens: 100, createdAt: 0, survivedCount: 0, generation: "young", blockId: "b1", active: true, summary: "new compact summary", startRef: "m00001", endRef: "m00002", directMessageIds: ["old1", "old2"], directBlockIds: [] };
    session.state.blocks = [block];
    const messages = [message("acp_summary_b1", "[Summary]\n" + block.summary)];
    const wire = JSON.stringify({ input: messages.map(m => ({ role: "user", content: m.text })) });
    const wait = (ms = 25, signal?: AbortSignal, view = messages, body = wire) => waitPostFold(session, view, ms, signal, body);
    return { session, block, messages, wire, wait };
}

test("only committed fold with live rendered carrier delays once, not plain append or retry", async () => {
    const f = fixture();
    assert.equal(await f.wait(), "");
    notePostFold(f.session, [f.block]);
    assert.equal(await f.wait(25, undefined, [message("ordinary", "hello")]), "");
    assert.equal(await f.wait(25, undefined, f.messages, JSON.stringify({ input: "carrier removed by egress" })), "");
    assert.match(await f.wait(), /postFoldDelayMs=25 postFoldWaitedMs=\d+/);
    assert.equal(await f.wait(), "");
});

test("default zero does not wait or leak a future delayed send", async () => {
    const f = fixture(); notePostFold(f.session, [f.block]);
    assert.equal(await f.wait(0), ""); assert.equal(await f.wait(), "");
});

test("concurrent matching sends await one delay; unrelated sends do not wait", async () => {
    const f = fixture(); notePostFold(f.session, [f.block]);
    let done = false;
    const first = f.wait(50).then(v => { done = true; return v; });
    assert.equal(await f.wait(50, undefined, [message("ordinary", "other")]), "");
    assert.equal(done, false);
    const second = f.wait(50).then(v => { assert(done); return v; });
    assert.match(await first, /postFoldDelayMs=50/); assert.equal(await second, "");
});

test("abort restores pending fold and does not cancel another request", async () => {
    const f = fixture(); notePostFold(f.session, [f.block]);
    const controller = new AbortController();
    const first = f.wait(1000, controller.signal);
    const second = f.wait(20);
    controller.abort();
    await assert.rejects(first);
    assert.match(await second, /postFoldDelayMs=20/);
    assert.equal(await f.wait(), "");
});

test("stale summary version cannot consume a later in-place fold", async () => {
    const f = fixture(); notePostFold(f.session, [f.block]);
    for (const stale of [message("acp_summary_b1", "old summary"), { ...message("host", "old summary"), summaryOfBlockId: "b1" }]) {
        assert.equal(await f.wait(1, undefined, [stale]), "");
    }
    assert.match(await f.wait(1), /postFoldDelayMs=1/);
});

test("plugin carrier must match committed range and summary on final wire", async () => {
    const f = fixture(); f.block.compressCallId = "plugin_123"; notePostFold(f.session, [f.block]);
    const call = (endId: string): CoreMessage => ({ id: "call", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "client-call", text: JSON.stringify({ content: [{ startId: "m00001", endId, summary: f.block.summary }] }) });
    assert.equal(await f.wait(1, undefined, [call("m00003")]), "");
    assert.equal(await f.wait(1, undefined, [{ ...call("m00002"), text: call("m00002").text?.replace(f.block.summary, "old summary") }]), "");
    assert.match(await f.wait(1, undefined, [call("m00002")], JSON.stringify({ input: [{ type: "function_call", arguments: call("m00002").text }] })), /postFoldDelayMs=1/);
});

test("real applyRanges commit arms only the actual processTurn fold, not failed or dry-run views", async () => {
    const core = createCore(); const config = defaultConfig(200000);
    const session = getSession(`post-fold-apply-${Math.random()}`);
    const originals: CoreMessage[] = Array.from({ length: 12 }, (_, i) => ({ id: `h_${i}`, role: i % 2 ? "assistant" : "user", contentType: "text", text: `History ${i}: ${"x".repeat(3000)}` }));
    const before = core.processTurn({ messages: originals, state: session.state, config, tokenCount: 9999, renderTags: "text-only" }); session.state = before.state;
    const ctx = { core, config, session, messages: before.messages, log: () => {} };
    const input = parseCompressInput({ content: [{ startId: "m00001", endId: "m00002", summary: "The first two messages described historical details." }] });
    core.applyCompression({ messages: before.messages, state: session.state, config, ranges: input.ranges });
    assert.equal(await waitPostFold(session, before.messages, 1, undefined, JSON.stringify(before.messages)), "", "preview must not arm delay");
    applyRanges(parseCompressInput({ content: [{ startId: "m99998", endId: "m99999", summary: "No such range." }] }), ctx);
    assert.equal(await waitPostFold(session, before.messages, 1, undefined, JSON.stringify(before.messages)), "", "failed apply must not arm delay");
    const result = applyRanges(input, ctx); assert.equal(result.outcome, "applied");
    assert.equal(await waitPostFold(session, before.messages, 1, undefined, JSON.stringify(before.messages)), "");
    const folded = core.processTurn({ messages: originals, state: session.state, config, tokenCount: 9999, renderTags: "text-only" }); session.state = folded.state;
    assert.match(await waitPostFold(session, folded.messages, 1, undefined, JSON.stringify(folded.messages)), /postFoldDelayMs=1/);
    assert.equal(await waitPostFold(session, folded.messages, 1, undefined, JSON.stringify(folded.messages)), "");
    applyRanges(input, { ...ctx, messages: folded.messages });
    assert.equal(await waitPostFold(session, folded.messages, 1, undefined, JSON.stringify(folded.messages)), "", "no-op retry must not arm delay");
});
