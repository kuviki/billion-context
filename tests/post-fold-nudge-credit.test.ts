import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCore,
  createInitialState,
  defaultConfig,
  type CoreMessage,
} from "acp-kernel";
import { effectiveTokenCount } from "../src/server.js";
import {
  noteOutboundContextEstimates,
  settleUsageReport,
} from "../src/cache-ledger.js";
import {
  _resetSessionsForTest,
  zeroStats,
  type Session,
} from "../src/session.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { executeProxyTool } from "../src/loop/core.js";

function session(): Session {
  return {
    id: "post-fold-credit",
    meta: {},
    metadata: {},
    stats: {
      ...zeroStats(),
      lastInputTokens: 180_353,
      lastInputTokensSource: "usage",
      lastUsageGradeTokens: 269_449,
      contextTokensSource: "usage",
      lastUsagePayloadUpper: 604_273,
      compressCreditTokens: 89_096,
    },
    state: createInitialState(),
    createdAt: 0,
    lastSeen: 0,
    blockContents: new Map(),
    inFlight: 0,
    persisted: false,
    pendingRetrievals: [],
  };
}

function rawHistory(): CoreMessage[] {
  return [
    {
      id: "covered",
      role: "user",
      contentType: "text",
      text: "x".repeat(10_000_000),
    },
  ];
}

test("post-fold credit sizing: uses the net credit after a large full-history resend", () => {
  const s = session();
  assert.deepEqual(effectiveTokenCount(s, rawHistory()), {
    tokens: 180_353,
    source: "usage",
  });
  assert.equal(
    s.stats.compressCreditTokens,
    89_096,
    "reading sizing must not consume or subtract the credit again",
  );
  assert.deepEqual(effectiveTokenCount(s, rawHistory()), {
    tokens: 180_353,
    source: "usage",
  });
});

test("post-fold credit sizing: a fully drained baseline cannot resurrect the older grade", () => {
  const s = session();
  s.stats.lastInputTokens = 0;
  s.stats.compressCreditTokens = 300_000;
  assert.deepEqual(effectiveTokenCount(s, rawHistory()), {
    tokens: 0,
    source: "usage",
  });
});

test("post-fold credit sizing: a later unreported send retains the stale-anchor fallback", () => {
  const s = session();
  noteOutboundContextEstimates(s, {
    upperBound: 350_000,
    scaledText: 190_000,
    imageTokens: 0,
    calibrated: true,
  });
  assert.deepEqual(effectiveTokenCount(s, rawHistory()), {
    tokens: 350_000,
    source: "estimate",
  });
});

test("post-fold credit sizing: estimate-grade baselines do not acquire usage authority", () => {
  const s = session();
  s.stats.lastInputTokens = 719_521;
  s.stats.lastInputTokensSource = "estimate";
  assert.deepEqual(effectiveTokenCount(s, rawHistory()), {
    tokens: 269_449,
    source: "usage",
  });
});

test("post-fold credit sizing: settled post-fold usage replaces the credit-adjusted baseline", () => {
  const s = session();
  s.stats.compressCreditTokens = 0; // prepare materializes the fold before this settle
  s.stats.localInputEstimate = 400_000;
  settleUsageReport(s, { total: 174_000, reportedCached: 20_000 });
  assert.deepEqual(effectiveTokenCount(s, rawHistory()), {
    tokens: 174_000,
    source: "usage",
  });
  assert.equal(
    s.stats.inputTokens,
    174_000,
    "cumulative billing remains the provider's measured total",
  );
});

test("post-fold credit sizing: real compression does not cause an immediate pressure T2", () => {
  _resetSessionsForTest();
  _setStoreForTest(new SessionStore({ enabled: false }));
  const s = session();
  s.stats = {
    ...zeroStats(),
    lastInputTokens: 269_449,
    lastUsageGradeTokens: 269_449,
    lastInputTokensSource: "usage",
    contextTokensSource: "usage",
    lastUsagePayloadUpper: 604_273,
  };
  const raw: CoreMessage[] = [
    {
      id: "old",
      role: "user",
      contentType: "text",
      text: "x".repeat(10_000_000),
    },
    { id: "a", role: "user", contentType: "text", text: "a".repeat(20_000) },
    {
      id: "b",
      role: "assistant",
      contentType: "text",
      text: "b".repeat(20_000),
    },
    ...Array.from({ length: 8 }, (_, i): CoreMessage => ({
      id: `tail${i}`,
      role: i % 2 ? "assistant" : "user",
      contentType: "text",
      text: `Recent ${i}`,
    })),
  ];
  s.state.blocks = [
    {
      blockId: "b1",
      runId: "r1",
      tier: 1,
      active: true,
      generation: "old",
      survivedCount: 20,
      summary: "Archived decision. ".repeat(2_000),
      compressedTokens: 2_500_000,
      createdAt: 0,
      directMessageIds: ["old"],
      effectiveMessageIds: ["old"],
      directBlockIds: [],
    },
  ];
  s.state.nextBlockId = 2;
  const core = createCore();
  const config = defaultConfig(375_000);
  config.preserveRecentTokens = 0; // the eight tail messages provide the recent zone
  config.nudge.maxContextLimitPct = 0.7;
  config.nudge.growthFloor = config.nudge.growthCap = 80_000;
  config.nudge.tierGrowthTokens = { t2: 50_000, t3: 50_000 };
  const before = core.processTurn({
    messages: raw,
    state: s.state,
    config,
    tokenCount: s.stats.lastInputTokens,
    renderTags: "none",
  });
  s.state = before.state;
  const start = s.state.messageRefs.byRaw.a;
  const end = s.state.messageRefs.byRaw.b;
  const receipt = executeProxyTool(
    "compress",
    {
      content: [
        {
          startId: start,
          endId: end,
          summary:
            "Newly archived task result, completed implementation checks and the final review decision.",
        },
      ],
    },
    {
      core,
      config,
      messages: before.messages,
      compressMessages: raw,
      session: s,
      log: () => {},
    },
    "credit-compress",
  );
  assert.equal(receipt.outcome, "applied", receipt.text);
  assert.ok(s.stats.compressCreditTokens > 0);
  assert.ok(
    s.stats.lastInputTokens < 375_000 * 0.7,
    "the fold brought the adjusted baseline below pressure",
  );
  const sizing = effectiveTokenCount(s, raw);
  assert.equal(sizing.tokens, s.stats.lastInputTokens);
  const after = core.processTurn({
    messages: raw,
    state: s.state,
    config,
    tokenCount: sizing.tokens,
    renderTags: "none",
  });
  assert.ok(after.nudge);
  assert.equal(after.nudge.shouldInject, false);
  assert.ok(
    after.nudge.breakdown.pendingT2 > after.nudge.breakdown.minPressureBenefit,
  );
  assert.ok(after.nudge.breakdown.pendingT2 < 50_000);
  const oldCounter = core.processTurn({
    messages: raw,
    state: structuredClone(s.state),
    config,
    tokenCount: 269_449,
    renderTags: "none",
  });
  assert.ok(oldCounter.nudge);
  assert.equal(
    oldCounter.nudge.tier,
    2,
    "the old pre-fold value reproduces the pressure distillation",
  );
});
