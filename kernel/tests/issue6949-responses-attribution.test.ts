import test from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import { hasUnrecoverableMediaPayload } from "../src/protected.js";
import {
  responsesToCore,
  coreToResponses,
  patchResponsesInput,
} from "../src/wire/responses.js";
import type { ResponseInputMessage } from "../src/wire/responses.js";

function item(): ResponseInputMessage {
  return {
    type: "message",
    role: "developer",
    id: "synthetic-note",
    content: [
      {
        type: "input_text",
        text: "Synthetic harness clock note. ".repeat(250),
      },
    ],
    internal_chat_message_metadata_passthrough: {
      turn_id: "synthetic-turn",
      content_item_kinds: ["harness_context"],
      content_item_metadata: [{ provenance: { type: "harness", hook: false } }],
    },
  };
}
function project(raw = item()) {
  return responsesToCore({
    input: [
      { type: "message", role: "user", content: "opening" },
      raw,
      { type: "message", role: "assistant", content: "previous answer" },
      { type: "message", role: "user", content: "latest question" },
    ],
  });
}
function config() {
  const c = defaultConfig(200_000);
  c.preserveRecentMessages = 0;
  c.preserveRecentTokens = 0;
  c.compress.minCompressRange = 0;
  c.compress.minSummaryLength = 0;
  return c;
}

test("#6949 known Codex harness attribution is text, raw wire bytes survive unchanged and tagged paths", () => {
  const raw = item(),
    p = project(raw),
    m = p.msgs[1]!;
  assert.equal(hasUnrecoverableMediaPayload(m), false);
  assert.deepEqual(patchResponsesInput(p, p.msgs), [
    { type: "message", role: "user", content: "opening" },
    raw,
    { type: "message", role: "assistant", content: "previous answer" },
    { type: "message", role: "user", content: "latest question" },
  ]);
  assert.deepEqual(
    coreToResponses(JSON.parse(JSON.stringify(p.msgs)))[1],
    raw,
    "restored raw sidecar remains exact",
  );
  const core = createCore(),
    turn = core.processTurn({
      messages: p.msgs,
      state: createInitialState(),
      config: config(),
      tokenCount: 2000,
      renderTags: "all",
    });
  const ref = turn.state.messageRefs.byRaw[m.id]!;
  assert.match(ref, /^m\d+$/);
  const tagged = turn.messages.find((x) => x.id === m.id)!;
  assert.ok(tagged.text!.includes(ref));
  for (const wire of [
    patchResponsesInput(p, turn.messages),
    coreToResponses(turn.messages),
  ]) {
    assert.ok(Array.isArray(wire));
    const out = wire.find(
      (x) =>
        x.type === "message" &&
        (x as ResponseInputMessage).role === "developer",
    ) as ResponseInputMessage;
    assert.equal(out.id, raw.id);
    assert.deepEqual(
      out.internal_chat_message_metadata_passthrough,
      raw.internal_chat_message_metadata_passthrough,
    );
    assert.deepEqual(out.content, [{ type: "input_text", text: tagged.text }]);
  }
  const folded = core.applyCompression({
    messages: p.msgs,
    state: turn.state,
    config: config(),
    ranges: [
      {
        startRef: ref,
        endRef: ref,
        summary: "Synthetic harness note summarized.",
      },
    ],
  });
  assert.equal(folded.result.blocksCreated, 1, JSON.stringify(folded.result));
  assert.ok(folded.state.blocks[0]!.effectiveMessageIds.includes(m.id));
});

test("#6949 existing BLOCKED binding migrates without rewriting old carrier bytes", () => {
  const raw = item(),
    p = project(raw),
    id = p.msgs[1]!.id;
  const state = createInitialState();
  state.messageRefs.byRaw[id] = "BLOCKED";
  const core = createCore();
  const first = core.processTurn({
    messages: p.msgs,
    state,
    config: config(),
    tokenCount: 2000,
    renderTags: "all",
  });
  const ref = first.state.messageRefs.byRaw[id]!;
  assert.match(ref, /^m\d+$/);
  assert.ok(first.state.renderDeferredRefs?.includes(ref));
  const second = core.processTurn({
    messages: p.msgs,
    state: JSON.parse(JSON.stringify(first.state)),
    config: config(),
    tokenCount: 2000,
    renderTags: "all",
  });
  for (const turn of [first, second]) {
    const m = turn.messages.find((x) => x.id === id)!;
    assert.equal(m.text, p.msgs[1]!.text);
    assert.deepEqual(coreToResponses([m])[0], raw);
  }
});

test("#6949 id and non-positional timestamps permit existing text shapes, head still hoists", () => {
  for (const content of [
    "text",
    [
      { type: "input_text", text: "one" },
      { type: "output_text", text: "two" },
    ],
  ]) {
    const raw = {
      type: "message",
      role: "system",
      id: "synthetic",
      content,
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn",
        create_time: 123.5,
      },
    } as ResponseInputMessage;
    assert.equal(hasUnrecoverableMediaPayload(project(raw).msgs[1]!), false);
    const head = responsesToCore({
      input: [raw, { type: "message", role: "user", content: "question" }],
    });
    assert.equal(head.systemParts.length, 1);
    assert.equal(head.msgs.length, 1);
  }
});

test("#6949 unknown state, malformed envelopes, non-text and unsupported provenance remain BLOCKED", () => {
  const variants: Record<string, unknown>[] = [
    { id: 1 },
    { unknown_control: true },
    { content: [{ type: "tool_addition", name: "tool" }] },
    { content: [{ type: "input_text", text: "text", unknown_control: true }] },
    { content: [{ type: "input_text", text: 123 }] },
    ...[
      null,
      [],
      "metadata",
      { turn_id: 4 },
      { create_time: "now" },
      { executed_tool_calls: [] },
      { tool_calls_complete: true },
      { cell_id: "cell" },
      { content_token_count: 1 },
      { unknown: true },
      { content_item_kinds: [] },
      { content_item_kinds: [5] },
      { content_item_metadata: [] },
      {
        content_item_metadata: [
          { provenance: { type: "harness", hook: true } },
        ],
      },
      ...[
        "tool",
        "developer_instructions",
        "skills",
        "agents_md",
        "unknown",
        "future",
      ].map((type) => ({ content_item_metadata: [{ provenance: { type } }] })),
      {
        content_item_metadata: [
          { provenance: { type: "harness", hook: false, unknown: true } },
        ],
      },
    ].map((metadata) => ({
      internal_chat_message_metadata_passthrough: metadata,
    })),
    {
      content: [
        { type: "input_text", text: "one" },
        { type: "input_text", text: "two" },
      ],
    },
  ];
  for (const change of variants) {
    const raw = { ...item(), ...change } as ResponseInputMessage;
    const p = project(raw),
      m = p.msgs[1]!;
    assert.equal(hasUnrecoverableMediaPayload(m), true, JSON.stringify(change));
    const t = createCore().processTurn({
      messages: p.msgs,
      state: createInitialState(),
      config: config(),
      tokenCount: 2000,
      renderTags: "none",
    });
    assert.equal(
      t.state.messageRefs.byRaw[m.id],
      "BLOCKED",
      JSON.stringify(change),
    );
    assert.deepEqual(
      coreToResponses([m])[0],
      raw,
      "protected raw message unchanged",
    );
  }
});

test("#6949 protected same-id sibling prevents stale BLOCKED migration", () => {
  const p = project(),
    allowed = p.msgs[1]!;
  const protectedSibling = {
    ...allowed,
    rawResponsesItem: { ...item(), unknown_control: true },
  };
  const state = createInitialState();
  state.messageRefs.byRaw[allowed.id] = "BLOCKED";
  const t = createCore().processTurn({
    messages: [...p.msgs, protectedSibling],
    state,
    config: config(),
    tokenCount: 2000,
    renderTags: "all",
  });
  assert.equal(t.state.messageRefs.byRaw[allowed.id], "BLOCKED");
  assert.ok(!t.state.renderDeferredRefs?.length);
});

test("#6949 non-positional metadata survives multi-part text rewrites in both codecs", () => {
  const raw = {
    ...item(),
    content: [
      { type: "input_text", text: "one" },
      { type: "input_text", text: "two" },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn" },
  } as ResponseInputMessage;
  const p = project(raw);
  const changed = p.msgs.map((m, i) =>
    i === 1 ? { ...m, text: "Rewritten text" } : m,
  );
  for (const wire of [
    patchResponsesInput(p, changed),
    coreToResponses(changed),
  ]) {
    assert.ok(Array.isArray(wire));
    const out = wire.find(
      (x) =>
        x.type === "message" &&
        (x as ResponseInputMessage).role === "developer",
    ) as ResponseInputMessage;
    assert.equal(out.id, raw.id);
    assert.deepEqual(
      out.internal_chat_message_metadata_passthrough,
      raw.internal_chat_message_metadata_passthrough,
    );
    assert.deepEqual(out.content, [
      { type: "input_text", text: "Rewritten text" },
    ]);
  }
});
