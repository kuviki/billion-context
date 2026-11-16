import test from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { responsesToCore, type ResponseInputMessage } from "acp-kernel/wire";
import type { Session } from "../src/session.ts";
import { handleAcpStatus } from "../src/acp-status.ts";

function makeCtx(messages: CoreMessage[]): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "acp-status-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}


test("#6949 decoded Codex harness text gets a numeric ref and appears in acp_status ranges", () => {
    const note: ResponseInputMessage = { type: "message", role: "developer", id: "synthetic-note", content: [{ type: "input_text", text: "Synthetic harness note. ".repeat(500) }], internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn", content_item_kinds: ["harness_context"], content_item_metadata: [{ provenance: { type: "harness", hook: false } }] } };
    const p = responsesToCore({ input: [{ type: "message", role: "user", content: "Opening question" }, note, { type: "message", role: "assistant", content: "Past answer" }, { type: "message", role: "user", content: "New question" }] });
    const ctx = makeCtx(p.msgs);
    ctx.config.preserveRecentMessages = 0;
    ctx.config.preserveRecentTokens = 0;
    ctx.config.compress.minCompressRange = 0;
    const turn = ctx.core.processTurn({ messages: p.msgs, state: ctx.session.state, config: ctx.config, tokenCount: 4000, renderTags: "none" });
    ctx.session.state = turn.state;
    ctx.messages = turn.messages;
    const ref = turn.state.messageRefs.byRaw[p.msgs[1]!.id]!;
    assert.match(ref, /^m\d+$/);
    const uncompressed = handleAcpStatus({ scope: "uncompressed", view: "messages" }, ctx).text;
    assert.ok(uncompressed.includes(ref), uncompressed);
    assert.ok(!uncompressed.includes("BLOCKED"), uncompressed);
    const issueReport = handleAcpStatus({ scope: "uncompressed", view: "ranges" }, ctx).text;
    const refNumber = Number(ref.slice(1));
    assert.ok([...issueReport.matchAll(/m(\d+)–m(\d+)/g)].some(m => Number(m[1]) <= refNumber && Number(m[2]) >= refNumber), issueReport);
    assert.ok(!issueReport.includes("BLOCKED"), issueReport);
    const report = handleAcpStatus({}, ctx).text;
    const ranges = report.slice(report.indexOf("Compressible ranges"));
    const n = Number(ref.slice(1));
    assert.ok([...ranges.matchAll(/m(\d+)–m(\d+)/g)].some(m => Number(m[1]) <= n && Number(m[2]) >= n), ranges);
});
