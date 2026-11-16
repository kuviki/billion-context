import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { DEFAULT_CACHE_REFRESH_TIMEOUT_MS, MAX_CACHE_REFRESH_TIMEOUT_MS, loadConfigFile, parseCacheKeepaliveSettings, parseRouteEntry, type ProviderRoutes } from "../src/config.ts";
import { resolveCacheKeepalive, resolveCacheRefreshAfterCompress, resolveCacheRefreshTimeoutMs } from "../src/cache-keepalive.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-refresh-config-"));
const configPath = path.join(root, "config.json");
const priorConfig = process.env.BILI_CONFIG_FILE;
const priorEnabled = process.env.BILI_CACHE_KEEPALIVE;
const url = "https://refresh.test/v1/messages";

beforeEach(() => {
    process.env.BILI_CONFIG_FILE = configPath;
    delete process.env.BILI_CACHE_KEEPALIVE;
    fs.writeFileSync(configPath, "{}");
});
after(() => {
    if (priorConfig === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = priorConfig;
    if (priorEnabled === undefined) delete process.env.BILI_CACHE_KEEPALIVE;
    else process.env.BILI_CACHE_KEEPALIVE = priorEnabled;
    fs.rmSync(root, { recursive: true, force: true });
});

test("refresh config is default-off and independent of idle enabled and env", () => {
    assert.equal(resolveCacheRefreshAfterCompress(undefined, undefined), false);
    fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: { enabled: true } }));
    assert.equal(resolveCacheRefreshAfterCompress(undefined, undefined), false);
    fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: { enabled: false, refreshAfterCompress: true } }));
    process.env.BILI_CACHE_KEEPALIVE = "0";
    assert.equal(resolveCacheKeepalive(undefined, undefined).enabled, false);
    assert.equal(resolveCacheRefreshAfterCompress(undefined, undefined), true);
});

test("refresh config preserves explicit false across model > route > global", () => {
    fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: { refreshAfterCompress: true } }));
    const routes: ProviderRoutes = {
        "https://refresh.test": {
            cacheKeepalive: { refreshAfterCompress: false },
            models: { one: { cacheKeepalive: { refreshAfterCompress: true } }, two: {} },
        },
    };
    assert.equal(resolveCacheRefreshAfterCompress(routes, url, "one"), true);
    assert.equal(resolveCacheRefreshAfterCompress(routes, url, "two"), false);
    assert.equal(resolveCacheRefreshAfterCompress(routes, url, "unknown"), false);
    assert.equal(resolveCacheRefreshAfterCompress(routes, "https://other.test", "one"), true);
    routes["https://refresh.test"].cacheKeepalive = { refreshAfterCompress: true };
    routes["https://refresh.test"].models!.one = { cacheKeepalive: { refreshAfterCompress: false } };
    assert.equal(resolveCacheRefreshAfterCompress(routes, url, "one"), false);
});

test("refresh config roundtrip preserves booleans and rejects malformed values", () => {
    for (const enabled of [false, true]) {
        const expected = { enabled: false, refreshAfterCompress: enabled };
        assert.deepEqual(parseCacheKeepaliveSettings(expected), expected);
        const route = parseRouteEntry({ cacheKeepalive: expected, models: { m: { cacheKeepalive: expected } } });
        assert.deepEqual(route?.cacheKeepalive, expected);
        assert.deepEqual(route?.models?.m.cacheKeepalive, expected);
        fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: expected }));
        assert.deepEqual(loadConfigFile().cacheKeepalive, expected);
    }
    for (const value of [1, "true", null, {}, []]) {
        assert.throws(() => parseCacheKeepaliveSettings({ refreshAfterCompress: value }), /must be a boolean/);
        assert.throws(() => parseRouteEntry({ models: { m: { cacheKeepalive: { refreshAfterCompress: value } } } }), /must be a boolean/);
    }
});


test("refresh deadline defaults to 10 seconds without enabling either refresh feature", () => {
    assert.equal(DEFAULT_CACHE_REFRESH_TIMEOUT_MS, 10_000);
    assert.equal(MAX_CACHE_REFRESH_TIMEOUT_MS, 120_000);
    assert.equal(resolveCacheRefreshTimeoutMs(undefined, undefined), 10_000);
    fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: { refreshTimeoutMs: 25_000 } }));
    process.env.BILI_CACHE_KEEPALIVE = "1";
    assert.equal(resolveCacheRefreshTimeoutMs(undefined, undefined), 25_000);
    assert.equal(resolveCacheRefreshAfterCompress(undefined, undefined), false);
});

test("refresh deadline resolves model > provider > global and hot reloads", () => {
    fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: { refreshTimeoutMs: 20_000 } }));
    const routes: ProviderRoutes = {
        "https://refresh.test": {
            cacheKeepalive: { refreshTimeoutMs: 30_000 },
            models: { one: { cacheKeepalive: { refreshTimeoutMs: 40_000 } }, two: {} },
        },
    };
    assert.equal(resolveCacheRefreshTimeoutMs(routes, url, "one"), 40_000);
    assert.equal(resolveCacheRefreshTimeoutMs(routes, url, "two"), 30_000);
    assert.equal(resolveCacheRefreshTimeoutMs(routes, url, "unknown"), 30_000);
    assert.equal(resolveCacheRefreshTimeoutMs(routes, url), 30_000);
    assert.equal(resolveCacheRefreshTimeoutMs(routes, "https://other.test", "one"), 20_000);
    fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: { refreshTimeoutMs: 50_000 } }));
    assert.equal(resolveCacheRefreshTimeoutMs(routes, "https://other.test", "one"), 50_000);
    routes["https://refresh.test"].models!.one = { cacheKeepalive: { refreshTimeoutMs: 1 } };
    assert.equal(resolveCacheRefreshTimeoutMs(routes, url, "one"), 1);
});

test("refresh deadline roundtrip accepts inclusive bounds at every tier", () => {
    for (const refreshTimeoutMs of [1, 10_000, 120_000]) {
        const expected = { refreshTimeoutMs };
        assert.deepEqual(parseCacheKeepaliveSettings(expected), expected);
        const route = parseRouteEntry({ cacheKeepalive: expected, models: { m: { cacheKeepalive: expected } } });
        assert.deepEqual(route?.cacheKeepalive, expected);
        assert.deepEqual(route?.models?.m.cacheKeepalive, expected);
        fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: expected }));
        assert.deepEqual(loadConfigFile().cacheKeepalive, expected);
        assert.equal(resolveCacheRefreshTimeoutMs(undefined, undefined), refreshTimeoutMs);
    }
});

test("refresh deadline rejects zero, negative, fractional, non-finite and malformed values", () => {
    for (const refreshTimeoutMs of [0, -1, 0.5, 120_001, Infinity, -Infinity, NaN, "10000", null, true, {}, []]) {
        assert.throws(() => parseCacheKeepaliveSettings({ refreshTimeoutMs }), /refreshTimeoutMs must be an integer/);
        assert.throws(() => parseRouteEntry({ cacheKeepalive: { refreshTimeoutMs } }), /refreshTimeoutMs must be an integer/);
        assert.throws(() => parseRouteEntry({ models: { m: { cacheKeepalive: { refreshTimeoutMs } } } }), /refreshTimeoutMs must be an integer/);
        fs.writeFileSync(configPath, JSON.stringify({ cacheKeepalive: { refreshTimeoutMs } }));
        assert.throws(() => resolveCacheRefreshTimeoutMs(undefined, undefined), /refreshTimeoutMs must be an integer/);
    }
});
