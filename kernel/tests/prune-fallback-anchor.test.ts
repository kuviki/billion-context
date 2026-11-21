import test from "node:test";
import assert from "node:assert/strict";
import { createCore, defaultConfig } from "../src/index.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import { syncBlocks } from "../src/sync.js";
import { patchResponsesInput, responsesToCore } from "../src/wire/responses.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

const message = (
  id: string,
  role: CoreMessage["role"] = "user",
): CoreMessage => ({ id, role, contentType: "text", text: id });
function state(): CompressionState {
  const s = createInitialState();
  for (let n = 1; n <= 2; n++)
    s.blocks.push({
      blockId: `b${n}`,
      runId: `r${n}`,
      tier: 1,
      summary: `Summary ${n}`,
      directMessageIds: [`absent-${n}`],
      effectiveMessageIds: [`absent-${n}`],
      directBlockIds: [],
      compressedTokens: 100,
      createdAt: 0,
      survivedCount: 1,
      generation: "old",
      active: true,
    });
  return s;
}
const input = () => [
  message("opening"),
  message("prior-history", "assistant"),
  message("old-task"),
  message("prior-work", "assistant"),
];
const ids = (ms: CoreMessage[]) => ms.map((m) => m.id);
const learn = { rememberFallbackAnchors: true };

test("unresolved summaries keep their successor through append-only turns and JSON restart", () => {
  const s = state(),
    a = input();
  const first = prune(a, s, learn);
  assert.deepEqual(ids(first), [
    "opening",
    "prior-history",
    "acp_summary_b1",
    "acp_summary_b2",
    "old-task",
    "prior-work",
  ]);
  const restored = JSON.parse(JSON.stringify(s));
  const next = prune(
    [...a, message("finished", "assistant"), message("new-task")],
    restored,
    learn,
  );
  assert.deepEqual(next.slice(0, first.length), first);
  assert.equal(restored.blocks[0].fallbackUserMessageId, "old-task");
});

test("standalone preview and head export do not learn or overwrite fallback", () => {
  const s = state();
  prune(input(), s);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, undefined);
  prune(input(), s, learn);
  const before = JSON.stringify(s);
  const out = prune([...input(), message("later")], s, {
    ...learn,
    headSummaryAnchors: true,
  });
  assert.equal(out[0]!.id, "acp_summary_b1");
  assert.equal(JSON.stringify(s), before);
});

test("real anchors and rendered carriers take priority; missing/covered successor relearns", () => {
  const s = state();
  prune(input(), s, learn);
  const actual = prune(
    [...input(), message("absent-1", "assistant"), message("new-task")],
    s,
    learn,
  );
  assert.ok(
    ids(actual).indexOf("acp_summary_b1") > ids(actual).indexOf("old-task"),
  );
  const rewritten = [message("opening"), message("replacement")];
  assert.equal(prune(rewritten, s, learn)[1]!.id, "acp_summary_b1");
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "replacement");
  s.blocks[1]!.effectiveMessageIds.push("replacement");
  prune([...rewritten, message("new-task")], s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "new-task");
  const existing = prune(
    [
      message("opening"),
      {
        id: "acp_summary_b1",
        role: "system",
        contentType: "text",
        text: "old",
      },
      message("other"),
    ],
    s,
    learn,
  );
  assert.equal(existing[1]!.id, "acp_summary_b1");
});

test("multimodal users anchor before the whole wire item; opening user retains unresolved exception", () => {
  const s = state();
  const split = [
    message("opening"),
    message("work", "assistant"),
    { ...message("question#text"), wireIndex: 2 },
    { ...message("question#image"), wireIndex: 2 },
  ];
  const out = prune(split, s, learn);
  assert.deepEqual(ids(out), [
    "opening",
    "work",
    "acp_summary_b1",
    "acp_summary_b2",
    "question#text",
    "question#image",
  ]);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "question#text");
  assert.equal(
    prune([message("only-user")], state(), learn)[0]!.id,
    "acp_summary_b1",
  );
});

test("fallback does not split a tool call/result exchange", () => {
  const s = state();
  const ms: CoreMessage[] = [
    message("opening"),
    {
      id: "call",
      role: "assistant",
      contentType: "tool-call",
      toolCallId: "t",
      toolName: "read",
      text: "{}",
    },
    {
      id: "result",
      role: "user",
      contentType: "tool-result",
      toolCallId: "t",
      text: "ok",
    },
    message("task"),
  ];
  const out = prune(ms, s, learn);
  assert.equal(ids(out).indexOf("result"), ids(out).indexOf("call") + 1);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "task");
});

test("actual Responses projection through processTurn learns durable fallback without mutating input state", () => {
  const s = state();
  const items = ["opening", "prior-history", "old-task", "prior-work"].map(
    (text, i) => ({
      type: "message" as const,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: text,
    }),
  );
  const a = responsesToCore({ input: items }).msgs;
  // The ledger interval keeps blocks live even though their original ids are
  // absent. This is a genuinely unresolved anchor after syncBlocks runs.
  a[1]!.ledgerSeq = 10;
  for (const b of s.blocks) {
    b.startSeq = 10;
    b.endSeq = 10;
  }
  const core = createCore();
  const config = defaultConfig(200_000);
  const run = (messages: CoreMessage[], state: CompressionState) =>
    core.processTurn({
      messages,
      state,
      config,
      tokenCount: 100,
      renderTags: "none",
    });
  const first = run(a, s);
  assert.ok(
    first.state.blocks.every(
      (b) => b.active && b.fallbackUserMessageId === a[2]!.id,
    ),
  );
  assert.equal(s.blocks[0]!.fallbackUserMessageId, undefined);
  const b = responsesToCore({
    input: [
      ...items,
      { type: "message", role: "assistant", content: "finished" },
      { type: "message", role: "user", content: "new-task" },
    ],
  }).msgs;
  b[1]!.ledgerSeq = 10;
  const next = run(b, JSON.parse(JSON.stringify(first.state)));
  assert.deepEqual(
    next.messages.slice(0, first.messages.length),
    first.messages,
  );
});

test("carrier roundtrip and temporary no-user view retain the learned successor", () => {
  const s = state(),
    a = input();
  const rendered = prune(a, s, learn);
  assert.deepEqual(prune(rendered, s, learn), rendered);
  prune([message("tool-only-view", "assistant")], s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "old-task");
  assert.deepEqual(
    prune([...a, message("new-task")], s, learn).slice(0, rendered.length),
    rendered,
  );
});

test("partially covered multimodal successor binds a surviving part, before the whole item", () => {
  const s = state();
  s.blocks[1]!.effectiveMessageIds.push("covered-part");
  const a = [
    message("opening"),
    message("work", "assistant"),
    { ...message("covered-part"), wireIndex: 2 },
    { ...message("visible-part"), wireIndex: 2 },
  ];
  const first = prune(a, s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "visible-part");
  assert.deepEqual(ids(first), [
    "opening",
    "work",
    "acp_summary_b1",
    "acp_summary_b2",
    "visible-part",
  ]);
  assert.deepEqual(
    prune([...a, message("later")], s, learn).slice(0, first.length),
    first,
  );
});

test("a covered remembered successor reselects once then stays stable", () => {
  const s = state(),
    a = input();
  prune(a, s, learn);
  s.blocks[1]!.effectiveMessageIds.push("old-task");
  const next = [...a, message("next-task")];
  const first = prune(next, s, learn);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "next-task");
  assert.deepEqual(
    prune([...next, message("later")], s, learn).slice(0, first.length),
    first,
  );
});

test("compressing a remembered successor keeps older summaries in place across reload and loss of that successor", () => {
  const s = state();
  s.blocks[0]!.effectiveMessageIds.push("covered-1");
  s.blocks[1]!.effectiveMessageIds.push("covered-2");
  s.nextBlockId = 3;
  const messages = [
    message("opening"),
    message("covered-1", "assistant"),
    message("covered-2", "assistant"),
    message("u1"),
    message("work", "assistant"),
    message("u2"),
    message("current"),
  ];
  s.messageRefs = assignRefs(messages, {
    existing: s.messageRefs,
    nextIndex: 1,
  }).map;
  s.blocks[0]!.fallbackUserMessageId = "u1";
  s.blocks[1]!.fallbackUserMessageId = "u2";
  assert.deepEqual(ids(prune(messages, s, learn)), [
    "opening",
    "acp_summary_b1",
    "u1",
    "work",
    "acp_summary_b2",
    "u2",
    "current",
  ]);

  const config = defaultConfig(200_000);
  config.preserveRecentMessages = 0;
  config.preserveRecentTokens = 0;
  config.compress.minCompressRange = 0;
  config.compress.minSummaryLength = 0;
  config.compress.maxSummaryLength = 0;
  const compressed = createCore().applyCompression({
    messages,
    state: s,
    config,
    ranges: [
      {
        startRef: s.messageRefs.byRaw.u1!,
        endRef: s.messageRefs.byRaw.work!,
        summary: "New summary",
      },
    ],
  });
  assert.equal(compressed.result.blocksCreated, 1);
  const next = syncBlocks(messages, compressed.state).state;
  assert.deepEqual(ids(prune(messages, next, learn)), [
    "opening",
    "acp_summary_b1",
    "acp_summary_b3",
    "acp_summary_b2",
    "u2",
    "current",
  ]);

  const restored = JSON.parse(JSON.stringify(next)) as CompressionState;
  const shortened = messages.filter((m) => m.id !== "u1");
  const afterReload = syncBlocks(shortened, restored).state;
  assert.deepEqual(ids(prune(shortened, afterReload, learn)), [
    "opening",
    "acp_summary_b1",
    "acp_summary_b3",
    "acp_summary_b2",
    "u2",
    "current",
  ]);
});

test("a fold covering several successors preserves the previously rendered order, not block creation order", () => {
  const s = state();
  s.blocks[0]!.fallbackUserMessageId = "u2";
  s.blocks[1]!.fallbackUserMessageId = "u1";
  const messages = [
    message("opening"),
    message("u1"),
    message("u2"),
    message("current"),
  ];
  assert.deepEqual(ids(prune(messages, s, learn)), [
    "opening",
    "acp_summary_b2",
    "u1",
    "acp_summary_b1",
    "u2",
    "current",
  ]);
  s.blocks.push({
    ...s.blocks[0]!,
    blockId: "b3",
    directMessageIds: ["u1", "u2"],
    effectiveMessageIds: ["u1", "u2"],
    fallbackUserMessageId: undefined,
    renderedSummaryPredecessorId: undefined,
  });
  assert.deepEqual(ids(prune(messages, s, learn)), [
    "opening",
    "acp_summary_b2",
    "acp_summary_b1",
    "acp_summary_b3",
    "current",
  ]);
});

test("a replacement follows its consumed block lineage without crossing an older summary", () => {
  const s = state();
  s.blocks[0]!.fallbackUserMessageId = "u1";
  s.blocks[1]!.fallbackUserMessageId = "u2";
  const messages = [
    message("opening"),
    message("u1"),
    message("work", "assistant"),
    message("u2"),
    message("later-work", "assistant"),
    message("current"),
  ];
  prune(messages, s, learn);
  s.blocks.push({
    ...s.blocks[0]!,
    blockId: "b3",
    directMessageIds: ["u1", "work"],
    effectiveMessageIds: ["u1", "work"],
    fallbackUserMessageId: undefined,
    renderedSummaryPredecessorId: undefined,
  });
  assert.deepEqual(ids(prune(messages, s, learn)), [
    "opening",
    "acp_summary_b1",
    "acp_summary_b3",
    "acp_summary_b2",
    "u2",
    "later-work",
    "current",
  ]);
  s.blocks[2]!.active = false;
  s.blocks.push({
    ...s.blocks[2]!,
    blockId: "b4",
    active: true,
    directMessageIds: ["later-work"],
    effectiveMessageIds: ["u1", "work", "later-work"],
    directBlockIds: ["b3"],
    renderedSummaryPredecessorId: undefined,
  });
  const restored = JSON.parse(JSON.stringify(s)) as CompressionState;
  assert.deepEqual(ids(prune(messages, restored, learn)), [
    "opening",
    "acp_summary_b1",
    "acp_summary_b2",
    "u2",
    "acp_summary_b4",
    "current",
  ]);
  assert.equal(restored.blocks[0]!.fallbackSummaryBlockId, "b4");
});

test("an original anchor returning takes priority over remembered summary order", () => {
  const s = state();
  s.blocks[0]!.fallbackUserMessageId = "u1";
  s.blocks[1]!.fallbackUserMessageId = "u2";
  const messages = [
    message("opening"),
    message("u1"),
    message("u2"),
    message("current"),
  ];
  prune(messages, s, learn);
  s.blocks.push({
    ...s.blocks[0]!,
    blockId: "b3",
    directMessageIds: ["u1"],
    effectiveMessageIds: ["u1"],
    fallbackUserMessageId: undefined,
    renderedSummaryPredecessorId: undefined,
  });
  prune(messages, s, learn);
  const edited = [
    ...messages.slice(0, -1),
    message("absent-1", "assistant"),
    message("current"),
  ];
  const out = ids(prune(edited, s, learn));
  assert.ok(out.indexOf("acp_summary_b2") < out.indexOf("acp_summary_b1"));
});

test("a remembered replacement never moves an unresolved recap after the current user", () => {
  const s = state();
  s.blocks.pop();
  s.blocks[0]!.fallbackUserMessageId = "u1";
  s.blocks.push({
    ...s.blocks[0]!,
    blockId: "b3",
    directMessageIds: ["u1", "late"],
    effectiveMessageIds: ["u1", "late"],
    fallbackUserMessageId: undefined,
  });
  const messages = [
    message("opening"),
    message("current"),
    message("late", "assistant"),
  ];
  assert.deepEqual(ids(prune(messages, s, learn)), [
    "opening",
    "acp_summary_b1",
    "current",
    "acp_summary_b3",
  ]);
});

test("a folded successor part keeps the recap before the whole multimodal user item", () => {
  const s = state();
  s.blocks[0]!.fallbackUserMessageId = "question-image";
  s.blocks[1]!.directMessageIds = ["question-text"];
  s.blocks[1]!.effectiveMessageIds = ["question-text"];
  const messages = [
    message("opening"),
    message("work", "assistant"),
    { ...message("question-text"), wireIndex: 2 },
    { ...message("question-image"), wireIndex: 2 },
    message("current"),
  ];
  const before = ids(prune(messages, s, learn));
  assert.ok(
    before.indexOf("acp_summary_b1") < before.indexOf("question-image"),
  );
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "question-image");
  s.blocks[1]!.active = false;
  s.blocks.push({
    ...s.blocks[0]!,
    blockId: "b3",
    directMessageIds: ["question-image"],
    effectiveMessageIds: ["question-image"],
    fallbackUserMessageId: undefined,
    renderedSummaryPredecessorId: undefined,
  });
  const after = ids(prune(messages, s, learn));
  assert.ok(after.indexOf("acp_summary_b1") < after.indexOf("question-text"));
});

test("a replacement anchor preserves the surviving tool call and result pair", () => {
  const s = state();
  s.blocks.pop();
  s.blocks[0]!.fallbackUserMessageId = "u1";
  const messages: CoreMessage[] = [
    message("opening"),
    {
      id: "call-1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "read",
      toolCallId: "c1",
      text: "{}",
    },
    {
      id: "call-2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "read",
      toolCallId: "c2",
      text: "{}",
    },
    {
      id: "result-1",
      role: "user",
      contentType: "tool-result",
      toolCallId: "c1",
      text: "one",
    },
    {
      id: "result-2",
      role: "user",
      contentType: "tool-result",
      toolCallId: "c2",
      text: "two",
    },
    message("u1"),
    message("current"),
  ];
  prune(messages, s, learn);
  s.blocks.push({
    ...s.blocks[0]!,
    blockId: "b3",
    directMessageIds: ["call-2", "result-2", "u1"],
    effectiveMessageIds: ["call-2", "result-2", "u1"],
    fallbackUserMessageId: undefined,
    renderedSummaryPredecessorId: undefined,
  });
  const out = ids(prune(messages, s, learn));
  assert.equal(out.indexOf("result-1"), out.indexOf("call-1") + 1);
  assert.ok(out.indexOf("acp_summary_b1") < out.indexOf("current"));
  assert.ok(out.indexOf("acp_summary_b3") < out.indexOf("current"));
});

test("ambiguous replacement ownership and cyclic replacements are not remembered", () => {
  const s = state();
  s.blocks[0]!.fallbackUserMessageId = "u1";
  const messages = [message("opening"), message("u1"), message("current")];
  prune(messages, s, learn);
  for (const id of ["b3", "b4"]) {
    s.blocks.push({
      ...s.blocks[0]!,
      blockId: id,
      directMessageIds: ["u1"],
      effectiveMessageIds: ["u1"],
      fallbackUserMessageId: undefined,
      renderedSummaryPredecessorId: undefined,
    });
  }
  prune(messages, s, learn);
  assert.equal(s.blocks[0]!.fallbackSummaryBlockId, undefined);
  assert.equal(s.blocks[0]!.fallbackUserMessageId, "current");

  const cyclic = state();
  cyclic.blocks[0]!.directMessageIds = ["u1"];
  cyclic.blocks[0]!.fallbackUserMessageId = "u2";
  cyclic.blocks[1]!.directMessageIds = ["u2"];
  cyclic.blocks[1]!.fallbackUserMessageId = "u1";
  prune([message("opening"), message("current")], cyclic, learn);
  assert.ok(
    cyclic.blocks.every((block) => block.fallbackSummaryBlockId === undefined),
  );
});

test("long chains of successor summaries remain ordered after a restart", () => {
  const s = createInitialState();
  const count = 1500;
  for (let n = 0; n < count; n++) {
    s.blocks.push({
      blockId: `b${n}`,
      runId: "r",
      tier: 1,
      summary: "summary",
      directMessageIds: [`u${n}`],
      effectiveMessageIds: [`u${n}`],
      directBlockIds: [],
      compressedTokens: 1,
      createdAt: 0,
      survivedCount: 1,
      generation: "old",
      active: true,
      ...(n + 1 < count ? { fallbackUserMessageId: `u${n + 1}` } : {}),
    });
  }
  const messages = [
    message("opening"),
    message(`u${count - 1}`, "assistant"),
    message("current"),
  ];
  const expected = [
    "opening",
    ...Array.from({ length: count }, (_, n) => `acp_summary_b${n}`),
    "current",
  ];
  assert.deepEqual(ids(prune(messages, s, learn)), expected);
  assert.deepEqual(
    ids(
      prune(messages, JSON.parse(JSON.stringify(s)) as CompressionState, learn),
    ),
    expected,
  );
});

test("Responses projection retains summary order through a real fold and a later resend", () => {
  const input = [
    ["user", "opening"],
    ["assistant", "covered-1"],
    ["assistant", "covered-2"],
    ["user", "u1"],
    ["assistant", "work"],
    ["user", "u2"],
    ["user", "current"],
  ].map(([role, content]) => ({
    type: "message" as const,
    role: role as "user" | "assistant",
    content: content!,
  }));
  const projection = responsesToCore({ input });
  const idOf = (text: string) =>
    projection.msgs.find((msg) => msg.text === text)!.id;
  const s = state();
  s.nextBlockId = 3;
  s.blocks[0]!.effectiveMessageIds.push(idOf("covered-1"));
  s.blocks[1]!.effectiveMessageIds.push(idOf("covered-2"));
  s.blocks[0]!.fallbackUserMessageId = idOf("u1");
  s.blocks[1]!.fallbackUserMessageId = idOf("u2");
  const core = createCore();
  const config = defaultConfig(200_000);
  config.preserveRecentMessages = 0;
  config.preserveRecentTokens = 0;
  config.compress.minCompressRange = 0;
  config.compress.minSummaryLength = 0;
  config.compress.maxSummaryLength = 0;
  const run = (messages: CoreMessage[], state: CompressionState) =>
    core.processTurn({
      messages,
      state,
      config,
      tokenCount: 100,
      renderTags: "none",
    });
  const before = run(projection.msgs, s);
  const compressed = core.applyCompression({
    messages: projection.msgs,
    state: before.state,
    config,
    ranges: [
      {
        startRef: before.state.messageRefs.byRaw[idOf("u1")]!,
        endRef: before.state.messageRefs.byRaw[idOf("work")]!,
        summary: "Summary 3",
      },
    ],
  });
  assert.equal(compressed.result.blocksCreated, 1);
  const after = run(projection.msgs, compressed.state);
  const wire = JSON.stringify(patchResponsesInput(projection, after.messages));
  assert.ok(wire.indexOf("Summary 1") < wire.indexOf("Summary 3"));
  assert.ok(wire.indexOf("Summary 3") < wire.indexOf("Summary 2"));
  assert.ok(wire.indexOf("Summary 2") < wire.indexOf("current"));
  const appended = responsesToCore({
    input: [...input, { type: "message", role: "user", content: "next" }],
  });
  const resend = run(
    appended.msgs,
    JSON.parse(JSON.stringify(after.state)) as CompressionState,
  );
  assert.deepEqual(
    patchResponsesInput(appended, resend.messages).slice(0, -1),
    patchResponsesInput(projection, after.messages),
  );
});
