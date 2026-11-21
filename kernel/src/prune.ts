import { activeBlocks, coveredMessageIds } from "./state.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "./types.js";

export const SUMMARY_HEADER = "[Compressed conversation section]";

// Reserved prefix for rendered-summary ids. Hosts own their message ids and
// must never assign one with this prefix; kernel-generated ids are mNNNNN
// refs and bN block ids.
const SUMMARY_ID_PREFIX = "acp_summary_";

/**
 * The transient visible id of an active block's rendered summary message.
 * This is a VIEW-ONLY representation: it must never be persisted into
 * `effectiveMessageIds`/`directMessageIds` (the durable coverage is the
 * block's raw message ids).
 */
export function summaryMessageId(blockId: string): string {
  return `${SUMMARY_ID_PREFIX}${blockId}`;
}

export function isSummaryMessageId(id: string): boolean {
  return id.startsWith(SUMMARY_ID_PREFIX);
}

/**
 * Base id of a message id: everything before the first `#`. Sub-id
 * projections (`base#callId`, `base#r0`, …) are alternate renderings of the
 * same original message, so coverage is decided per original message — id
 * comparisons normalize to the base (issue #231).
 */
export function baseIdOf(id: string): string {
  const hash = id.indexOf("#");
  return hash > 0 ? id.substring(0, hash) : id;
}

/**
 * True when `id` falls under any covered original message, regardless of
 * which projection form the block recorded and which the current view emits.
 * `coveredBases` must be the set of `baseIdOf(c)` over the covered ids,
 * built once per pass (O(1) per message instead of a scan). The exact
 * membership test is subsumed: a covered id's own base is in the set.
 */
export function isCovered(id: string, coveredBases: Set<string>): boolean {
  return coveredBases.has(baseIdOf(id));
}

/**
 * #4316 layer 3: seq-interval coverage claims. A block that recorded an exact
 * ledger interval (startSeq/endSeq) covers ANY message carrying a ledgerSeq
 * stamp inside that interval — id churn (model switch / re-stamp / re-encode
 * re-mints every content-hash id) cannot invalidate the positional claim.
 * Blocks without bounds contribute nothing; messages without stamps are
 * decided by the id path alone. Both paths run in parallel (union): the id
 * path stays byte-identical for unstamped traffic.
 *
 * The -1/-1 "no claim" sentinel (PR #4725 N1: storage writes it when a
 * block's covered ids cannot be resolved to transcript rows, e.g. migrated
 * pre-unified-storage folds) contributes nothing — with the historical
 * endSeq >= startSeq guard alone it would pass as a REAL interval and, for
 * the [0,0] placeholder it replaces, suppress the seq-0 message as already
 * folded. [0,0] itself stays a legitimate claim: a block can genuinely
 * cover just seq 0.
 */
export function coveredSeqIntervals(
  state: CompressionState,
): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const block of state.blocks) {
    if (!block.active) continue;
    if (
      typeof block.startSeq === "number" &&
      typeof block.endSeq === "number" &&
      block.startSeq >= 0 &&
      block.endSeq >= block.startSeq
    ) {
      intervals.push({ start: block.startSeq, end: block.endSeq });
    }
  }
  return intervals;
}

/** True when `seq` falls inside any active block's exact interval claim. */
export function isCoveredBySeq(
  seq: number | undefined,
  intervals: Array<{ start: number; end: number }>,
): boolean {
  if (typeof seq !== "number" || !Number.isInteger(seq)) return false;
  for (const interval of intervals) {
    if (seq >= interval.start && seq <= interval.end) return true;
  }
  return false;
}

/**
 * True when a message is a rendered block summary (the exact shape prune
 * emits). The id prefix alone is not sufficient — a host-authored message
 * that happens to carry a reserved id must not be treated as a rendered
 * summary (it would be silently dropped from ranges or deleted by rebuild).
 */
export function isRenderedSummaryMessage(
  message: Pick<CoreMessage, "id" | "role" | "contentType">,
): boolean {
  return (
    isSummaryMessageId(message.id) &&
    message.role === "system" &&
    message.contentType === "text"
  );
}

export interface PruneOptions {
  injectSummaries?: boolean;
  /** Learn render-only fallback successors during the live turn pipeline.
   * Direct prune callers (exports/previews) remain read-only by default. */
  rememberFallbackAnchors?: boolean;
  /**
   * Chronological head anchoring for views with NO provider prefix cache at
   * stake (session handoff/restore docs). Default (false) is the pin-safe
   * placement: an anchor whose ids are absent reuses a remembered surviving
   * user successor, otherwise parks before the newest surviving user (#3640).
   * Resolved anchors cannot precede the opening user pin (#2733); unresolved
   * anchors keep the before-opening-user exception when it is the only user.
   */
  headSummaryAnchors?: boolean;
  /**
   * Names that count as a `compress` call for the pending-call exemption in
   * orphan stripping (same predicate family as Config.isCompressTool). Unset =
   * bare-name only, byte-identical to before; without it an MCP-form compress
   * call still awaiting its result is deleted while its bare-name twin survives.
   */
  isCompressTool?: (toolName: string) => boolean;
}

export function prune(
  messages: CoreMessage[],
  state: CompressionState,
  options: PruneOptions = {},
): CoreMessage[] {
  const covered = coveredMessageIds(state);
  if (covered.size === 0) return [...messages];
  const coveredBases = new Set<string>();
  for (const id of covered) coveredBases.add(baseIdOf(id));

  const inject = options.injectSummaries ?? true;
  const isCompressTool =
    options.isCompressTool ?? ((name: string) => name === "compress");
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user",
  );
  // Keep unresolved summaries before a surviving user, but remember that
  // user's identity in the live pipeline: chasing the latest user every turn
  // moves old summaries through an otherwise append-only cached prefix.
  const seqIntervals = coveredSeqIntervals(state);
  const userAnchors = new Map<string, number>();
  const allUserAnchors = new Map<string, number>();
  let fallbackIndex = messages.length;
  const userSuccessors = new Map<number, string>();
  if (inject && !options.headSummaryAnchors) {
    for (let start = 0; start < messages.length;) {
      const head = messages[start]!;
      let end = start + 1;
      const wire = wireIndexOf(head);
      if (head.role === "user" && wire !== undefined) {
        while (
          end < messages.length &&
          messages[end]!.role === "user" &&
          wireIndexOf(messages[end]!) === wire
        )
          end++;
      }
      if (head.role === "user") {
        // Bind a surviving part, but insert before its WHOLE wire item. Walk
        // each run once, even for very wide multimodal user messages.
        for (let i = start; i < end; i++) {
          const message = messages[i]!;
          if (message.contentType === "tool-result") continue;
          allUserAnchors.set(message.id, start);
          if (
            start !== firstUserIndex &&
            (isCovered(message.id, coveredBases) ||
              isCoveredBySeq(message.ledgerSeq, seqIntervals))
          )
            continue;
          userAnchors.set(message.id, start);
          if (!userSuccessors.has(start)) userSuccessors.set(start, message.id);
          fallbackIndex = start;
        }
      }
      start = end;
    }
  }

  const baseIndexById = new Map<string, number>();
  const summaryIndexById = new Map<string, number>();
  messages.forEach((message, index) => {
    const base = baseIdOf(message.id);
    const existing = baseIndexById.get(base);
    if (existing === undefined || index < existing)
      baseIndexById.set(base, index);
    if (isRenderedSummaryMessage(message))
      summaryIndexById.set(message.id, index);
  });

  // #4311: a wire-visible compress call already carries the full summary
  // draft in its arguments, and the call+receipt pair stays protected —
  // re-rendering the block summary duplicates that text on the wire. Skip
  // the anchor for blocks whose ORIGINATING call is visible in THIS view
  // (the exchange itself is the model-visible recap); blocks whose call is
  // gone (folded away, gateway-dropped) or that never had one (system folds,
  // codex/dsh forged-summary lanes) keep their render. The skip must key on
  // the exact compressCallId — never on range overlap — so a RE-FOLD that
  // covers similar ground still renders its own summary.
  const visibleCompressCallIds = new Set<string>();
  if (inject) {
    for (const message of messages) {
      if (
        message.contentType === "tool-call" &&
        message.toolCallId &&
        typeof message.toolName === "string" &&
        isCompressTool(message.toolName)
      ) {
        visibleCompressCallIds.add(message.toolCallId);
      }
    }
  }
  const anchors = inject
    ? collectSummaryAnchors(
        state,
        baseIndexById,
        summaryIndexById,
        options.headSummaryAnchors ? 0 : fallbackIndex,
        visibleCompressCallIds,
        options.headSummaryAnchors ? new Map() : userAnchors,
        allUserAnchors,
        userSuccessors,
        options.rememberFallbackAnchors === true && !options.headSummaryAnchors,
        !options.headSummaryAnchors,
      )
    : [];
  // Summary ids of every block this session has ever created — active or
  // consumed. Rendered copies of ACTIVE blocks are replaced by the fresh
  // render at their anchor; copies of CONSUMED blocks (superseded by a chain
  // re-fold) must be dropped too, or the loop path keeps rendering them
  // next to the successor summary forever (#2733). Only when summaries are
  // actually injected: with injectSummaries off there is no fresh render to
  // substitute, so dropping here would silently delete already-rendered
  // summaries from the view instead of keeping them.
  const knownSummaryIds = new Set(
    inject ? state.blocks.map((block) => summaryMessageId(block.blockId)) : [],
  );

  const result = stripOrphanedReasoning(
    stripOrphanedToolResults(
      stripOrphanedToolCalls(
        rebuildMessages(
          messages,
          coveredBases,
          // #4316 layer 3: positional claims, built once per prune pass.
          seqIntervals,
          firstUserIndex,
          anchors,
          knownSummaryIds,
          options.headSummaryAnchors === true,
          state.blocks,
        ),
        isCompressTool,
      ),
    ),
  );
  if (
    inject &&
    options.rememberFallbackAnchors &&
    !options.headSummaryAnchors &&
    firstUserIndex >= 0
  ) {
    const blocks = new Map(
      state.blocks.map((block) => [summaryMessageId(block.blockId), block]),
    );
    let predecessor: string | null = null;
    for (const message of result) {
      if (!isRenderedSummaryMessage(message)) continue;
      const block = blocks.get(message.id);
      if (!block) continue;
      block.renderedSummaryPredecessorId = predecessor;
      predecessor = block.blockId;
    }
  }
  return result;
}

interface SummaryAnchor {
  blockId: string;
  summary: string;
  topic?: string;
  insertAt: number;
  /** True when no anchor id was present in the input (the substrate is off
   *  the wire). Unresolved anchors reuse a surviving user successor (or
   *  choose the newest surviving user initially/on rewrite) and are exempt
   *  from the first-user-pin lower bound of firstUserIndex + 1:
   *  riding AFTER the user's current question is the functional bug #3640
   *  (the model answered the stale recap instead of the question for five
   *  consecutive turns), and the rendered summary is role "system", so
   *  leading the view is provider-safe. */
  unresolved?: boolean;
  fallbackBlockId?: string;
  fallbackRawIndex?: number;
}

/** Resolve only unambiguous direct coverage, following consumed blocks to a
 * visible active descendant. This is a render relation, not a coverage claim. */
function summaryReplacements(
  blocks: CompressionBlock[],
  visibleCompressCallIds: Set<string>,
): (block: CompressionBlock) => string | undefined {
  const byId = new Map(blocks.map((block) => [block.blockId, block]));
  const parents = new Map<string, string[]>();
  const byMessage = new Map<string, string[]>();
  const wanted = new Set(
    blocks.flatMap((block) =>
      block.active && block.fallbackUserMessageId !== undefined
        ? [baseIdOf(block.fallbackUserMessageId)]
        : [],
    ),
  );
  for (const block of blocks) {
    for (const child of block.directBlockIds) {
      const list = parents.get(child) ?? [];
      list.push(block.blockId);
      parents.set(child, list);
    }
    for (const id of block.directMessageIds ?? []) {
      const base = baseIdOf(id);
      if (!wanted.has(base)) continue;
      const list = byMessage.get(base) ?? [];
      list.push(block.blockId);
      byMessage.set(base, list);
    }
  }
  const cache = new Map<string, Set<string>>();
  const visibleOwners = (id: string): Set<string> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const found = new Set<string>();
    const seen = new Set<string>();
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]!;
      if (seen.has(next)) continue;
      seen.add(next);
      const block = byId.get(next);
      if (!block) continue;
      if (
        block.active &&
        !block.retired &&
        !(
          block.compressCallId &&
          visibleCompressCallIds.has(block.compressCallId)
        )
      ) {
        found.add(next);
      }
      for (const parent of parents.get(next) ?? []) queue.push(parent);
    }
    cache.set(id, found);
    return found;
  };
  return (block) => {
    if (block.fallbackUserMessageId === undefined) return undefined;
    const owners = new Set<string>();
    for (const producer of byMessage.get(
      baseIdOf(block.fallbackUserMessageId),
    ) ?? []) {
      if (producer === block.blockId) continue;
      for (const owner of visibleOwners(producer)) {
        if (owner !== block.blockId) owners.add(owner);
      }
    }
    if (owners.size > 1) return undefined;
    if (owners.size === 1) return owners.values().next().value;
    if (block.fallbackSummaryBlockId === undefined) return undefined;
    const previous = visibleOwners(block.fallbackSummaryBlockId);
    if (previous.size !== 1 || previous.has(block.blockId)) return undefined;
    return previous.values().next().value;
  };
}

function collectSummaryAnchors(
  state: CompressionState,
  baseIndexById: Map<string, number>,
  summaryIndexById: Map<string, number>,
  fallbackIndex: number,
  // #4311: call ids of compress exchanges visible in the current view;
  // blocks created by one of these skip their anchor render (see the
  // collection site above for the rationale and the safety conditions).
  visibleCompressCallIds: Set<string>,
  userAnchors: Map<string, number>,
  allUserAnchors: Map<string, number>,
  userSuccessors: Map<number, string>,
  rememberFallback: boolean,
  allowReplacements: boolean,
): SummaryAnchor[] {
  const anchors: SummaryAnchor[] = [];
  let replacement: ReturnType<typeof summaryReplacements> | undefined;
  for (const block of activeBlocks(state)) {
    // #5765 retire: the user marked this block out of the resident view — its
    // summary is intentionally NOT re-rendered here. Its folded messages stay
    // covered (coveredMessageIds counts every active block), and any stale
    // rendered copy from a previous view is dropped by rebuildMessages via
    // knownSummaryIds (built from ALL blocks, retired included). decompress /
    // search_context are unaffected — they read stored content, not anchors.
    if (block.retired) continue;
    // #4311: the originating call is on the wire — its arguments carry the
    // summary text, so injecting the block render would duplicate it. The
    // stale render (if a previously-pruned view carried one) is dropped by
    // rebuildMessages via knownSummaryIds and NOT re-injected here.
    if (
      block.compressCallId &&
      visibleCompressCallIds.has(block.compressCallId)
    )
      continue;
    // Prefer the position of an already-rendered summary (hosts may pass a
    // previously-pruned view): keeps the summary stable in place instead of
    // jumping to index 0 when the raw ids are no longer in the input.
    const existingIndex = summaryIndexById.get(summaryMessageId(block.blockId));
    if (existingIndex !== undefined) {
      anchors.push({
        blockId: block.blockId,
        summary: block.summary,
        topic: block.topic,
        insertAt: existingIndex,
      });
      continue;
    }
    // #2733: anchor on the block's DIRECT range — the ids this fold itself
    // covered — not the merged effective set. Consumption folds the consumed
    // block's effectiveMessageIds into the new block, so the merged set reaches
    // back to the earliest id any ancestor ever covered; anchoring on it
    // re-anchors the new summary at that far-earlier position, rewriting bytes
    // the provider already cached there (observed in production as the
    // post-fold prefix match collapsing to the ~11K immutable head on every
    // re-fold). Anchoring on the direct ids confines the churn to the region
    // the fold actually rewrote. Legacy persisted blocks predate the field —
    // fall back to the effective set for them.
    const anchorIds =
      block.directMessageIds && block.directMessageIds.length > 0
        ? block.directMessageIds
        : block.effectiveMessageIds;
    let earliest: number | null = null;
    for (const id of anchorIds) {
      const index = baseIndexById.get(baseIdOf(id));
      if (index !== undefined && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    const remembered =
      block.fallbackUserMessageId === undefined
        ? undefined
        : userAnchors.get(block.fallbackUserMessageId);
    const unresolvedIndex = remembered ?? fallbackIndex;
    let fallbackBlockId: string | undefined;
    if (
      allowReplacements &&
      earliest === null &&
      remembered === undefined &&
      block.fallbackUserMessageId !== undefined
    ) {
      replacement ??= summaryReplacements(state.blocks, visibleCompressCallIds);
      fallbackBlockId = replacement(block);
    }
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      // Unresolved (no anchor id present in this input): park before the
      // remembered user successor, or select one on the first render.
      // Tail-parking (the pre-#3640 behavior) let stale summaries land after
      // the user's current question, which the model then answered instead.
      insertAt: earliest ?? unresolvedIndex,
      unresolved: earliest === null,
      fallbackBlockId,
      fallbackRawIndex:
        fallbackBlockId && block.fallbackUserMessageId
          ? allUserAnchors.get(block.fallbackUserMessageId)
          : undefined,
    });
  }
  const byId = new Map(anchors.map((anchor) => [anchor.blockId, anchor]));
  const blocksById = new Map(
    state.blocks.map((block) => [block.blockId, block]),
  );
  const valid = new Map<string, boolean>();
  for (const anchor of anchors) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: SummaryAnchor | undefined = anchor;
    let ok = true;
    while (current) {
      const cached = valid.get(current.blockId);
      if (cached !== undefined) {
        ok = cached;
        break;
      }
      if (seen.has(current.blockId)) {
        ok = false;
        break;
      }
      seen.add(current.blockId);
      path.push(current.blockId);
      if (current.fallbackBlockId === undefined) break;
      current = byId.get(current.fallbackBlockId);
      if (!current) ok = false;
    }
    for (const id of path) valid.set(id, ok);
  }
  for (const anchor of anchors) {
    if (!anchor.unresolved) continue;
    if (!valid.get(anchor.blockId)) anchor.fallbackBlockId = undefined;
    if (!rememberFallback) continue;
    const block = blocksById.get(anchor.blockId)!;
    if (anchor.fallbackBlockId !== undefined) {
      block.fallbackSummaryBlockId = anchor.fallbackBlockId;
    } else {
      const successor = userSuccessors.get(anchor.insertAt);
      // A transient tool-only/no-user view is not evidence of a rewrite.
      if (successor !== undefined) {
        block.fallbackUserMessageId = successor;
        delete block.fallbackSummaryBlockId;
      }
    }
  }
  anchors.sort((left, right) => left.insertAt - right.insertAt);
  return anchors;
}

/**
 * A rendered summary replaces the messages its block covers, so it takes the
 * position of the earliest covered message. That position can fall inside a
 * unit the provider validates as a whole, and a summary may never be placed
 * inside such a unit:
 *
 * - A parallel tool burst: a range that covers one call and its result leaves
 *   the burst's other calls visible, and the summary then lands between an
 *   assistant `tool_calls` message and the tool results answering it. Strict
 *   upstreams reject the whole request in that shape ("an assistant message
 *   with 'tool_calls' must be followed by tool messages responding to each
 *   'tool_call_id'"), so an anchor that would separate a call from its result
 *   is moved past that result.
 * - A single assistant message: consecutive assistant cores (a reasoning run,
 *   its text and its tool calls) merge into one wire message. An anchor landing
 *   between them splits the message, and its tool calls then reach the provider
 *   without the reasoning run they were produced with — DeepSeek thinking mode
 *   rejects that ("The `reasoning_content` in the thinking mode must be passed
 *   back to the API"), so an anchor inside an assistant run is moved back to the
 *   run's start.
 */
// Per-rebuild indexes for anchor pairing (#498). Building these once per
// rebuild costs O(N); rebuilding them per anchor made prune O(anchors × N).
interface AnchorPairingIndex {
  /** Start of the maximal consecutive assistant-role run containing i; -1 when `messages[i]` is not assistant. */
  runStart: Int32Array;
  /** Farthest `firstResultIndex(callId) + 1` across assistant tool-call messages at positions `< i`; 0 when none. Length N+1. */
  prefixEnd: Int32Array;
}

function buildAnchorPairingIndex(messages: CoreMessage[]): AnchorPairingIndex {
  const n = messages.length;

  // A duplicate call id can appear on multiple results; the earliest position
  // is the pairing boundary.
  const resultIndexByCallId = new Map<string, number>();
  messages.forEach((message, at) => {
    if (message.contentType !== "tool-result") return;
    if (typeof message.toolCallId !== "string") return;
    if (!resultIndexByCallId.has(message.toolCallId)) {
      resultIndexByCallId.set(message.toolCallId, at);
    }
  });

  const runStart = new Int32Array(n).fill(-1);
  for (let i = 0; i < n;) {
    if (messages[i]!.role !== "assistant") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && messages[j + 1]!.role === "assistant") j++;
    for (let k = i; k <= j; k++) runStart[k] = i;
    i = j + 1;
  }

  const prefixEnd = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const message = messages[i]!;
    let end = 0;
    if (
      message.role === "assistant" &&
      message.contentType === "tool-call" &&
      typeof message.toolCallId === "string"
    ) {
      const resultIndex = resultIndexByCallId.get(message.toolCallId);
      if (resultIndex !== undefined) end = resultIndex + 1;
    }
    prefixEnd[i + 1] = Math.max(prefixEnd[i]!, end);
  }

  return { runStart, prefixEnd };
}

function pairSafeAnchorIndex(
  messages: CoreMessage[],
  index: number,
  ix: AnchorPairingIndex,
): number {
  const n = messages.length;
  let safe = index;
  // Only assistant cores that reach the wire matter; a covered core between
  // them is dropped, and the runs then merge in the rendered view. Both steps
  // below therefore walk the input, where the covered ids are still present.
  if (safe > 0 && safe < n) {
    const start = ix.runStart[safe]!;
    if (start >= 0 && messages[safe - 1]!.role === "assistant") {
      safe = start;
    }
  }

  // Degenerate inputs outside [0, n] have no prefix to scan; the original
  // full-scan behavior returned them unchanged.
  if (safe < 0 || safe > n) return safe;

  // Each move lands just past a result, so the loop reaches a fixed point; the
  // bound only guards against a malformed message list. Entries whose result
  // ends at or before `safe` contribute ≤ safe and are absorbed by
  // max(safe, ·), so the unfiltered prefix max agrees with the filtered scan.
  for (let guard = 0; guard < n; guard++) {
    const next = Math.max(safe, ix.prefixEnd[safe]!);
    if (next === safe) break;
    safe = next;
  }
  return safe;
}

/** #3642: the wire message index a core was flattened from (set by every
 *  codec; kernel-rendered cores carry none). Declared locally so prune stays
 *  free of wire-module imports. */
type WireIndexedCore = { wireIndex?: number };
const wireIndexOf = (m: CoreMessage): number | undefined =>
  (m as WireIndexedCore).wireIndex;

function orderSummaryAnchors(
  anchors: SummaryAnchor[],
  blocks: CompressionBlock[],
): SummaryAnchor[] {
  if (!anchors.some((anchor) => anchor.fallbackBlockId !== undefined)) {
    return anchors.sort((left, right) => left.insertAt - right.insertAt);
  }
  const byId = new Map(anchors.map((anchor) => [anchor.blockId, anchor]));
  const blocksById = new Map(blocks.map((block) => [block.blockId, block]));
  const fallbackLimits = new Map(
    anchors
      .filter((anchor) => anchor.fallbackBlockId)
      .map((anchor) => [
        anchor.blockId,
        Math.min(anchor.insertAt, anchor.fallbackRawIndex ?? Infinity),
      ]),
  );
  const predecessor = new Map<string, string>();
  for (const anchor of anchors) {
    let previous = blocksById.get(anchor.blockId)?.renderedSummaryPredecessorId;
    const seen = new Set([anchor.blockId]);
    while (previous && !byId.has(previous) && !seen.has(previous)) {
      seen.add(previous);
      previous = blocksById.get(previous)?.renderedSummaryPredecessorId;
    }
    if (previous && byId.has(previous) && !seen.has(previous)) {
      predecessor.set(anchor.blockId, previous);
    }
  }
  const children = new Map<string, string[]>();
  for (const [id, previous] of predecessor) {
    const list = children.get(previous) ?? [];
    list.push(id);
    children.set(previous, list);
  }
  // A partial view can leave multiple successors for an old predecessor.
  // Such a fork does not prove their relative order.
  for (const ids of children.values()) {
    if (ids.length > 1) for (const id of ids) predecessor.delete(id);
  }
  const successor = new Map<string, string>();
  for (const [id, previous] of predecessor) successor.set(previous, id);
  const chains: SummaryAnchor[][] = [];
  for (const anchor of anchors) {
    if (predecessor.has(anchor.blockId)) continue;
    const chain: SummaryAnchor[] = [];
    const seen = new Set<string>();
    let id: string | undefined = anchor.blockId;
    while (id !== undefined && !seen.has(id)) {
      seen.add(id);
      chain.push(byId.get(id)!);
      id = successor.get(id);
    }
    if (id === undefined) chains.push(chain);
  }

  // A remembered user may be replaced by a whole fold. Fit the displaced
  // summary between its previously visible neighbours when they still agree;
  // resolved anchors themselves remain authoritative.
  for (let round = 0; round <= anchors.length; round++) {
    const before = anchors.map((anchor) => anchor.insertAt);
    const resolved = new Set<string>();
    for (const anchor of anchors) {
      const path: SummaryAnchor[] = [];
      let current: SummaryAnchor | undefined = anchor;
      while (current?.fallbackBlockId && !resolved.has(current.blockId)) {
        path.push(current);
        current = byId.get(current.fallbackBlockId);
      }
      for (let i = path.length - 1; i >= 0; i--) {
        const item = path[i]!;
        const target = byId.get(item.fallbackBlockId!);
        if (target) {
          item.insertAt = Math.min(
            target.insertAt,
            fallbackLimits.get(item.blockId)!,
          );
        }
        resolved.add(item.blockId);
      }
    }
    for (const chain of chains) {
      for (let start = 0; start < chain.length;) {
        if (!chain[start]!.fallbackBlockId) {
          start++;
          continue;
        }
        let end = start + 1;
        while (end < chain.length && chain[end]!.fallbackBlockId) end++;
        const lower = start > 0 ? chain[start - 1]!.insertAt : -Infinity;
        let upper = end < chain.length ? chain[end]!.insertAt : Infinity;
        for (let i = start; i < end; i++) {
          upper = Math.min(upper, fallbackLimits.get(chain[i]!.blockId)!);
        }
        if (lower <= upper) {
          for (let i = start; i < end; i++) {
            chain[i]!.insertAt = Math.max(
              lower,
              Math.min(upper, chain[i]!.insertAt),
            );
          }
          for (let i = end - 2; i >= start; i--) {
            chain[i]!.insertAt = Math.min(
              chain[i]!.insertAt,
              chain[i + 1]!.insertAt,
            );
          }
        }
        start = end;
      }
    }
    if (anchors.every((anchor, i) => anchor.insertAt === before[i])) break;
  }

  anchors.sort((left, right) => left.insertAt - right.insertAt);
  const output: SummaryAnchor[] = [];
  for (let start = 0; start < anchors.length;) {
    let end = start + 1;
    while (
      end < anchors.length &&
      anchors[end]!.insertAt === anchors[start]!.insertAt
    )
      end++;
    const group = anchors.slice(start, end);
    const groupIds = new Set(group.map((anchor) => anchor.blockId));
    const oldEdges: Array<[string, string]> = [];
    const replacementEdges: Array<[string, string]> = [];
    for (const anchor of group) {
      const previous = predecessor.get(anchor.blockId);
      if (
        previous &&
        groupIds.has(previous) &&
        (anchor.fallbackBlockId || byId.get(previous)?.fallbackBlockId)
      ) {
        oldEdges.push([previous, anchor.blockId]);
      }
      if (anchor.fallbackBlockId && groupIds.has(anchor.fallbackBlockId)) {
        replacementEdges.push([anchor.blockId, anchor.fallbackBlockId]);
      }
    }
    const sortGroup = (
      edges: Array<[string, string]>,
    ): SummaryAnchor[] | undefined => {
      const indegree = new Map(group.map((anchor) => [anchor.blockId, 0]));
      const outgoing = new Map<string, Set<string>>();
      for (const [from, to] of edges) {
        const list = outgoing.get(from) ?? new Set<string>();
        if (!list.has(to)) indegree.set(to, indegree.get(to)! + 1);
        list.add(to);
        outgoing.set(from, list);
      }
      const queue = group.filter(
        (anchor) => indegree.get(anchor.blockId) === 0,
      );
      for (let i = 0; i < queue.length; i++) {
        for (const next of outgoing.get(queue[i]!.blockId) ?? []) {
          const count = indegree.get(next)! - 1;
          indegree.set(next, count);
          if (count === 0) queue.push(byId.get(next)!);
        }
      }
      return queue.length === group.length ? queue : undefined;
    };
    output.push(
      ...(sortGroup([...oldEdges, ...replacementEdges]) ??
        sortGroup(oldEdges) ??
        group),
    );
    start = end;
  }
  return output;
}

function rebuildMessages(
  messages: CoreMessage[],
  coveredBases: Set<string>,
  // #4316 layer 3: exact ledger-interval claims of active blocks (positional
  // coverage, immune to id churn), threaded from prune().
  seqIntervals: Array<{ start: number; end: number }>,
  firstUserIndex: number,
  anchors: SummaryAnchor[],
  knownSummaryIds: Set<string>,
  headAnchors: boolean,
  blocks: CompressionBlock[],
): CoreMessage[] {
  // #3642: canonical granularity splits one wire message into one core per
  // content part, so the opening user message can be a RUN of user cores
  // (text + image + …) sharing one wireIndex. The first-user pin protects
  // the OPENING WIRE MESSAGE, not merely its first core: a multimodal
  // opening keeps its image bytes through folds (pre-split the merged core
  // carried them in its sidecar and the single-core pin preserved both).
  // Kernel-rendered cores (no wireIndex) never extend the run, and neither
  // does an adjacent but different wire message. Run length 1 keeps the
  // legacy shape byte-for-byte.
  let firstUserPinEnd = firstUserIndex + 1;
  if (firstUserIndex >= 0) {
    const firstWire = wireIndexOf(messages[firstUserIndex]!);
    if (firstWire !== undefined) {
      while (
        firstUserPinEnd < messages.length &&
        messages[firstUserPinEnd]!.role === "user" &&
        wireIndexOf(messages[firstUserPinEnd]!) === firstWire
      ) {
        firstUserPinEnd++;
      }
    }
  }
  const ix = anchors.length > 0 ? buildAnchorPairingIndex(messages) : null;
  const safeAnchors = orderSummaryAnchors(
    anchors
    .map((anchor) => ({
      ...anchor,
      insertAt: ix
        ? pairSafeAnchorIndex(messages, anchor.insertAt, ix)
        : anchor.insertAt,
        fallbackRawIndex:
          anchor.fallbackRawIndex === undefined
            ? undefined
            : ix
              ? pairSafeAnchorIndex(messages, anchor.fallbackRawIndex, ix)
              : anchor.fallbackRawIndex,
    }))
    // #2733: a summary may NEVER precede the session's first user message.
    // The pin is the provider prefix-cache head; a block whose range roots
    // at (or before) the pinned message would otherwise flush its summary
    // ahead of the pin — the first history item changes and the cached
    // prefix collapses for every subsequent request. Anchors resolve against
    // baseIndexById BEFORE the pin logic runs here, so this clamp is the
    // single choke point that guarantees pin-first ordering. Handoff views
    // (headAnchors) have no prefix cache at stake and keep chronological
    // head placement for summaries of older, absent material.
    .map((anchor) => ({
      ...anchor,
      // #2733/#3642: a summary may NEVER precede the pinned opening wire
      // message — now measured to the END of the opening core run
      // (firstUserPinEnd), so an anchor can never land between the opening
      // message's split parts either.
      insertAt: headAnchors
        ? anchor.insertAt
        : Math.max(
            anchor.insertAt,
            anchor.unresolved === true ? firstUserIndex : firstUserPinEnd,
          ),
        fallbackRawIndex:
          anchor.fallbackRawIndex === undefined
            ? undefined
            : headAnchors
              ? anchor.fallbackRawIndex
              : Math.max(
                  anchor.fallbackRawIndex,
                  anchor.unresolved === true ? firstUserIndex : firstUserPinEnd,
                ),
      })),
    blocks,
  );
  const result: CoreMessage[] = [];
  const pending = [...safeAnchors];

  for (let index = 0; index < messages.length; index++) {
    while (pending.length > 0 && pending[0]!.insertAt === index) {
      result.push(renderSummary(pending.shift()!));
    }
    // First-user-message pin: the session's opening user message survives
    // prune even when covered by an active block. This check deliberately
    // PRECEDES the covered check below — swapping them would let a compress
    // range strip the last guaranteed user message off the wire. Strict
    // providers reject conversations with no user message. See DESIGN.md §8.1.
    // #3642: the pin spans the opening wire message's whole core run.
    if (index === firstUserIndex && firstUserIndex >= 0) {
      for (let k = index; k < firstUserPinEnd; k++) {
        result.push(messages[k]!);
      }
      index = firstUserPinEnd - 1;
      continue;
    }
    if (isCovered(messages[index]!.id, coveredBases)) continue;
    // #4316 layer 3: positional coverage — a stamped message inside any
    // active block's exact ledger interval is covered even when its id was
    // re-minted (the id check above just missed it by construction). Runs
    // after the pin and the id path so unstamped behavior is untouched.
    if (isCoveredBySeq(messages[index]!.ledgerSeq, seqIntervals)) continue;
    // A stale copy of a block's summary from a previously-pruned view:
    // the freshly rendered one above replaces it. Active blocks re-render
    // at their anchor; consumed blocks (chain re-fold) are covered by their
    // successor's summary — either way the old copy must not survive.
    // Only rendered-summary shaped messages whose id maps to a block we
    // created qualify — a host message that merely reuses the reserved
    // prefix is content, not a stale copy.
    if (
      isRenderedSummaryMessage(messages[index]!) &&
      knownSummaryIds.has(messages[index]!.id)
    )
      continue;
    result.push(messages[index]!);
  }

  while (pending.length > 0) {
    result.push(renderSummary(pending.shift()!));
  }

  return result;
}

function renderSummary(anchor: SummaryAnchor): CoreMessage {
  const body = anchor.summary.trim();
  const topicLine = anchor.topic
    ? `${SUMMARY_HEADER} — ${anchor.topic}`
    : SUMMARY_HEADER;
  const text = body.length === 0 ? topicLine : `${topicLine}\n${body}`;
  return {
    id: summaryMessageId(anchor.blockId),
    role: "system",
    contentType: "text",
    text,
  };
}

/**
 * Drop tool-results whose declaring tool-call is not visible *before* them.
 *
 * Pairing is by order, not by id-set membership (#3046): a bare set cannot tell
 * two instances apart when a host re-issues the same tool-call id for different
 * calls (Agent Teams `name:index` ids). The upstream contract is directional —
 * a `role: "tool"` message must follow the assistant that declared its
 * `tool_call_id` — so a result is valid iff some call carrying the same id sits
 * EARLIER in the view. A result whose own call was folded away used to survive
 * because a different same-id call was still visible (possibly later); that
 * shipped an unpaired half and bricked the session with a 400. Walking forward
 * and remembering which ids a call has opened drops exactly that orphan and
 * nothing else: unique-id sessions behave identically to the old set lookup,
 * and one call still answers any number of same-id results (precedence is
 * checked, not multiplicity).
 */
function stripOrphanedToolResults(messages: CoreMessage[]): CoreMessage[] {
  const openCallIds = new Set<string>();
  const drop = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.contentType === "tool-call") {
      if (m.toolCallId) openCallIds.add(m.toolCallId);
    } else if (m.contentType === "tool-result" && m.toolCallId) {
      if (!openCallIds.has(m.toolCallId)) drop.add(i);
    }
  }
  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}

/**
 * Drop tool-calls that no visible tool-result answers *after* them.
 *
 * Mirror of {@link stripOrphanedToolResults} (#3046): the upstream requires an
 * assistant `tool_calls` entry to be followed by a response for each id, so a
 * call is valid iff some result carrying the same id sits LATER in the view. A
 * call whose answering result was folded away used to survive because a
 * different same-id result was still visible (possibly earlier); that shipped
 * an unanswered tool_call and bricked the session. Walking backward and
 * remembering which ids a result has answered keeps precedence-only semantics;
 * compress calls stay exempt (their result is managed by
 * hideConsumedCompressCalls, not this guard) — matched through the host's
 * isCompressTool predicate so MCP-form compress calls are treated like their
 * bare-name twins (#3222).
 */
function stripOrphanedToolCalls(
  messages: CoreMessage[],
  isCompressTool: (toolName: string) => boolean,
): CoreMessage[] {
  const answeredCallIds = new Set<string>();
  const drop = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.contentType === "tool-result") {
      if (m.toolCallId) answeredCallIds.add(m.toolCallId);
    } else if (m.contentType === "tool-call" && m.toolCallId) {
      if (typeof m.toolName === "string" && isCompressTool(m.toolName))
        continue;
      if (!answeredCallIds.has(m.toolCallId)) drop.add(i);
    }
  }
  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}

/**
 * Defense-in-depth for reasoning/text pairing (analogue of
 * {@link stripOrphanedToolCalls}). A `reasoning` message is only meaningful
 * when immediately followed — after any same-run reasoning — by its companion
 * assistant text/tool-call; strict thinking models (DeepSeek et al.) reject
 * reasoning_content that has lost its response with HTTP 400. Compress-time
 * boundary expansion normally keeps the pair in one block, so this only fires
 * for degenerate straddles (block-boundary ranges, malformed input, or a
 * reasoning that never had a companion): drop the dangling run rather than
 * ship a 400-triggering half-pair. Runs AFTER tool stripping, since removing
 * an orphaned tool-call can leave its preceding reasoning dangling too.
 */
function stripOrphanedReasoning(messages: CoreMessage[]): CoreMessage[] {
  const drop = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue;
    if (messages[i]!.contentType !== "reasoning") continue;
    let j = i;
    while (
      j + 1 < messages.length &&
      messages[j + 1]!.contentType === "reasoning"
    ) {
      j++;
    }
    const companion = messages[j + 1];
    const hasCompanion =
      companion !== undefined &&
      companion.role === "assistant" &&
      (companion.contentType === "text" ||
        companion.contentType === "tool-call");
    if (!hasCompanion) {
      for (let k = i; k <= j; k++) drop.add(k);
    }
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, i) => !drop.has(i));
}
