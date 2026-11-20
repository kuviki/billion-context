import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesWsHistory } from "../src/responses-ws.ts";

type Item = Record<string, unknown>;

const user: Item = { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] };
const assistant: Item = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "answer" }] };
const tool: Item = { type: "function_call_output", call_id: "call_1", output: "ok" };
const next: Item = { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] };

function checkpoint(input: Item[] = [user], output: Item[] = [assistant], codex = true): { history: ResponsesWsHistory; request: Item } {
    const history = new ResponsesWsHistory(undefined, codex);
    const request: Item = {
        model: "codex-model", instructions: "instruction", tools: [{ type: "function", name: "test" }],
        prompt_cache_key: "session", input, client_metadata: { turn_id: "old" },
        access_programs: ["old"], generate: false, stream_options: { trace: "old" },
    };
    history.commit(request, { id: "resp_1", status: "completed", output });
    return { history, request };
}

test("Codex continuation sends current per-response options and allows an empty suffix", () => {
    const { history, request } = checkpoint();
    const current = {
        ...request, input: [user, assistant], client_metadata: { turn_id: "new", tracing: "current" },
        access_programs: ["new"], generate: true, stream_options: { trace: "current" },
    };
    const sent = history.continuation(current);
    assert.deepEqual(sent, { ...current, previous_response_id: "resp_1", input: [] });
    assert.deepEqual(request.client_metadata, { turn_id: "old" });
    const { generate: _generate, ...withoutGenerate } = current;
    assert.deepEqual(history.continuation(withoutGenerate), { ...withoutGenerate, previous_response_id: "resp_1", input: [] });
});

test("Codex continuation still rejects changes to context, model options, and unknown request fields", () => {
    const { history, request } = checkpoint();
    const input = [user, assistant, next];
    const changes: Item[] = [
        { model: "other" }, { instructions: "different" }, { tools: [] }, { tool_choice: "none" },
        { reasoning: { effort: "high" } }, { text: { verbosity: "high" } },
        { prompt_cache_key: "different" }, { store: true }, { include: ["different"] },
        { future_parameter: { value: true } },
    ];
    for (const change of changes) {
        const current = { ...request, ...change, input };
        assert.deepEqual(history.continuation(current), current, `must resend on ${Object.keys(change)[0]}`);
    }
    for (const changedInput of [[user], [{ ...user, content: "changed" }, assistant, next], [user, { ...assistant, status: "in_progress" }, next]]) {
        const current = { ...request, input: changedInput };
        assert.deepEqual(history.continuation(current), current);
    }
});

test("Codex history ignores only permitted passthrough details during comparison", () => {
    const before = { ...user, internal_chat_message_metadata_passthrough: { turn_id: "same", create_time: 1, content_token_count: 3, content_item_kinds: ["unknown"] } };
    const after = { ...user, internal_chat_message_metadata_passthrough: { turn_id: "same", create_time: 1, content_token_count: 8 } };
    const { history, request } = checkpoint([before]);
    const current = { ...request, input: [after, assistant, next] };
    assert.deepEqual(history.continuation(current), { ...current, input: [next], previous_response_id: "resp_1" });
    assert.equal((before.internal_chat_message_metadata_passthrough as Item).turn_id, "same");
    assert.equal((after.internal_chat_message_metadata_passthrough as Item).turn_id, "same");
    const guarded: Item[] = [
        { turn_id: "different" },
        { create_time: 2 },
        { content_item_kinds: [] },
        { content_item_kinds: ["user"] },
        { content_item_metadata: [{ provenance: { type: "tool", name: "changed" } }] },
        { executed_tool_calls: [{ name: "exec", arguments: "a", tool_result_metadata: { status: "changed" } }] },
        { tool_calls_complete: true }, { future_metadata: { sensitive: true } }, { create_time: "invalid" },
    ];
    for (const extra of guarded) {
        const changed = { ...after, internal_chat_message_metadata_passthrough: { ...after.internal_chat_message_metadata_passthrough, ...extra } };
        const rejected = { ...request, input: [changed, assistant, next] };
        assert.deepEqual(history.continuation(rejected), rejected, `must preserve ${Object.keys(extra)[0]}`);
    }
});

test("tool metadata, output bytes, encrypted reasoning, and unknown item metadata cannot be hidden", () => {
    const metadata = { executed_tool_calls: [{ name: "run", arguments: "one", tool_result_metadata: { exit_code: 0 } }] };
    const oldTool = { ...tool, internal_chat_message_metadata_passthrough: metadata };
    const { history, request } = checkpoint([user, oldTool]);
    const changes = [
        { ...oldTool, output: "error" },
        { ...oldTool, internal_chat_message_metadata_passthrough: { executed_tool_calls: [{ name: "run", arguments: "one", tool_result_metadata: { exit_code: 1 } }] } },
        { ...oldTool, internal_chat_message_metadata_passthrough: { executed_tool_calls: [{ name: "run", arguments: "two", tool_result_metadata: { exit_code: 0 } }] } },
    ];
    for (const changed of changes) {
        const current = { ...request, input: [user, changed, assistant, next] };
        assert.deepEqual(history.continuation(current), current);
    }
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ciphertext-one" };
    const reasoningCase = checkpoint([user, reasoning]);
    const changedReasoning = { ...reasoningCase.request, input: [user, { ...reasoning, encrypted_content: "ciphertext-two" }, assistant, next] };
    assert.deepEqual(reasoningCase.history.continuation(changedReasoning), changedReasoning);
    const unknown = { type: "future_item", internal_chat_message_metadata_passthrough: { turn_id: "old" } };
    const unknownCase = checkpoint([unknown]);
    const changedUnknown = { ...unknownCase.request, input: [{ ...unknown, internal_chat_message_metadata_passthrough: { turn_id: "new" } }, assistant, next] };
    assert.deepEqual(unknownCase.history.continuation(changedUnknown), changedUnknown);
});

test("generic and plugin policy keeps the existing strict request comparison", () => {
    const { history, request } = checkpoint([user], [assistant], false);
    const differentMetadata = { ...request, client_metadata: { turn_id: "new" }, input: [user, assistant, next] };
    assert.deepEqual(history.continuation(differentMetadata), differentMetadata);
    const empty = { ...request, input: [user, assistant] };
    assert.deepEqual(history.continuation(empty), empty);
    const appended = { ...request, input: [user, assistant, next] };
    assert.deepEqual(history.continuation(appended), { ...appended, input: [next], previous_response_id: "resp_1" });
});
