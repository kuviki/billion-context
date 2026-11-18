import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage } from "acp-kernel";
import { canonicalTextOf, normalizedIdentity, planReconciliation, wordBagDigest, type FoldAnchor } from "../src/fold-reconcile.ts";
import { simhashHex } from "../src/affinity-simhash.ts";

// Shape/order fixtures adapted from upstream PR #6801 (804c89baf).
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");

function prose(seed: number, words: number): string {
    const out: string[] = [`msg${seed}`]; // one seed-unique word: no two seeds share a word bag
    for (let i = 0; i < words; i++) out.push(`${WORDS[(seed * 7 + i * 3) % WORDS.length]}${(seed + i) % 97}`);
    return out.join(" ");
}

function anchorFor(text: string): FoldAnchor {
    const canon = canonicalTextOf(text);
    return { r: "assistant", c: "text", b: text.length, wh: wordBagDigest(canon), sh: simhashHex(canon) };
}

function remintedSession(stored: number, inbound: number, words: number) {
    const order = Array.from({ length: stored }, (_, i) => `old_${i}`);
    const anchors: Record<string, FoldAnchor> = {};
    order.forEach((id, i) => { anchors[id] = anchorFor(prose(i, words)); });
    const msgs: CoreMessage[] = Array.from({ length: inbound }, (_, i) => ({ id: `new_${i}`, role: "assistant", contentType: "text", text: prose(100_000 + i, words) }));
    return { order, anchors, msgs, covered: new Set(order) };
}

test("shape pass still pairs re-wrapped user text by unwrapped identity, in order", () => {
    const stored = Array.from({ length: 6 }, (_, i) => prose(i, 12));
    const order = stored.map((_, i) => `old_${i}`);
    const anchors: Record<string, FoldAnchor> = {};
    stored.forEach((text, i) => {
        const canon = canonicalTextOf(text);
        anchors[order[i]] = { r: "user", c: "text", b: text.length, n: normalizedIdentity({ id: order[i], role: "user", contentType: "text", text }), wh: wordBagDigest(canon), sh: simhashHex(canon) };
    });
    // The host re-wraps each line under a fresh id; an unrelated user message sits in front.
    const msgs: CoreMessage[] = [{ id: "noise", role: "user", contentType: "text", text: prose(99, 12) }];
    stored.forEach((text, i) => msgs.push({ id: `new_${i}`, role: "user", contentType: "text", text: text.replace(/ /g, (_, at: number) => (at % 3 === 0 ? "\n" : " ")) }));
    const plan = planReconciliation(order, anchors, msgs, new Set(order));
    for (let i = 0; i < stored.length; i++) assert.deepEqual(plan.claims.get(`old_${i}`), [`new_${i}`]);
    assert.equal(plan.byShape, stored.length);
});

test("shape pass still pairs a re-minted word-bag twin with the first candidate in order", () => {
    const h = remintedSession(8, 8, 40);
    // Two inbound copies of old_3's words under fresh ids: the earlier one wins.
    h.msgs.splice(2, 0, { id: "twin_a", role: "assistant", contentType: "text", text: prose(3, 40) });
    h.msgs.push({ id: "twin_b", role: "assistant", contentType: "text", text: prose(3, 40) });
    const plan = planReconciliation(h.order, h.anchors, h.msgs, h.covered);
    assert.deepEqual(plan.claims.get("old_3"), ["twin_a"]);
    assert.equal(plan.byShape, 1);
    // The census runs over the pre-shape unmatched list: old_3 is still listed
    // there, and the unclaimed twin_b carries its bag — near-duplicate residue.
    // No other anchor shares a bag with any candidate.
    assert.deepEqual(plan.nearDupResidual, ["old_3"]);
    assert.equal(plan.absentEverywhere.length, h.order.length - 1);
});

test("digest work scales with candidates, not residual anchors, and stays invocation-local", (t) => {
    const text = prose(42, 40);
    const canonical = canonicalTextOf(text);
    const wh = wordBagDigest(canonical);
    const sh = simhashHex(canonical);
    const opposite = [...sh].map((c) => (15 - parseInt(c, 16)).toString(16)).join("");
    const msgs: CoreMessage[] = Array.from({ length: 12 }, (_, i) => ({ id: `candidate_${i}`, role: "assistant", contentType: "text", text }));
    const originalMatchAll = String.prototype.matchAll;
    const originalMatch = String.prototype.match;
    let bags = 0;
    let sketches = 0;
    t.mock.method(String.prototype, "matchAll", function (this: string, re: RegExp) {
        if (re.source === /\p{L}+|\p{N}+/gu.source) bags++;
        return originalMatchAll.call(this, re);
    });
    t.mock.method(String.prototype, "match", function (this: string, re: RegExp) {
        if (re.source === /[\p{L}\p{N}_]+/gu.source) sketches++;
        return originalMatch.call(this, re);
    });
    for (const count of [4, 40, 160]) {
        const order = Array.from({ length: count }, (_, i) => `stored_${i}`);
        const anchors = Object.fromEntries(order.map((id) => [id, { r: "assistant", c: "text", b: text.length, wh, sh: opposite }])) as Record<string, FoldAnchor>;
        bags = sketches = 0;
        const plan = planReconciliation(order, anchors, msgs, new Set(order));
        assert.equal(plan.claims.size, 0);
        assert.deepEqual(plan.absentEverywhere, order);
        assert.deepEqual(plan.nearDupResidual, []);
        assert.equal(bags, msgs.length);
        assert.equal(sketches, msgs.length);
    }
    // Reuse and mutate the same objects: no text evidence may leak into a later call.
    for (const m of msgs) m.text = prose(99, 40);
    const order = ["changed"];
    const anchors: Record<string, FoldAnchor> = { changed: { r: "assistant", c: "text", b: text.length, wh, sh } };
    bags = sketches = 0;
    const plan = planReconciliation(order, anchors, msgs, new Set(order));
    assert.deepEqual(plan.absentEverywhere, order);
    assert.equal(bags, msgs.length);
    assert.equal(sketches, 0, "bag mismatch must not eagerly compute a sketch");
    anchors.changed.r = "user";
    bags = sketches = 0;
    assert.deepEqual(planReconciliation(order, anchors, msgs, new Set(order)).absentEverywhere, order);
    assert.equal(bags, 0, "role mismatch must not compute word evidence");
    assert.equal(sketches, 0);
});

test("legacy role-less anchors retain word evidence even against user candidates", () => {
    const text = prose(7, 30);
    const order = Array.from({ length: 4 }, (_, i) => `old_${i}`);
    const anchors = Object.fromEntries(order.map((id) => [id, { ...anchorFor(text), r: undefined }]));
    const msgs: CoreMessage[] = order.map((_, i) => ({ id: `new_${i}`, role: "user", contentType: "text", text }));
    const plan = planReconciliation(order, anchors, msgs, new Set(order));
    order.forEach((id, i) => assert.deepEqual(plan.claims.get(id), [`new_${i}`]));
    assert.equal(plan.byShape, order.length);
});
