import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Harness } from '../helpers/route-state-fixtures.js';
import { startHarness, getRoutes, insertKey, insertModel, addUsage, addRequest, addCooldown, findRoute, nextMonthStartMs, dumpAllTables } from '../helpers/route-state-fixtures.js';
import { resetLeases, acquireLease } from '../../services/ratelimit.js';

describe('route-state-monthly-pure', () => {
  let h: Harness;

  beforeAll(() => {
    h = startHarness();
  });

  beforeEach(() => {
    resetLeases();
  });

  it('monthly budget with ~1M and ~1K', async () => {
    const platform = 'groq';
    const now = Date.now();

    // Part 1: ~1M
    const modelId1 = 'test-monthly-1M';
    insertModel(h.db, platform, modelId1, { budget: '~1M', enabled: 1 });
    const keyId1 = insertKey(h.db, platform, 'key-1M', { scopeJson: null });
    const budgetKeys1 = (h.db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy','unknown')").get(platform) as {count: number}).count;
    expect(budgetKeys1).toBe(1);

    addRequest(h.db, platform, modelId1, keyId1, 'success', 100, 50);
    addRequest(h.db, platform, modelId1, keyId1, 'success', 10, 5);
    addRequest(h.db, platform, modelId1, keyId1, 'error', 999, 0);
    addRequest(h.db, platform, modelId1, keyId1, 'success', 1000, 100, '2000-01-15 10:00:00');

    const res1 = await getRoutes(h);
    const route1 = findRoute(res1.body, platform, modelId1, keyId1);
    expect(route1).toBeDefined();
    expect(route1.monthly.month).toBe(new Date().toISOString().slice(0, 7));
    expect(route1.monthly.published_budget_text).toBe('~1M');
    expect(route1.monthly.published_budget_tokens).toBe(1000000 * budgetKeys1);
    expect(route1.monthly.used_tokens_this_month).toBe(165);
    expect(route1.monthly.used_requests_this_month).toBe(2);
    expect(route1.monthly.usable_this_month).toBe(true);
    const expectedResetsAt1 = nextMonthStartMs(now);
    expect(Math.abs(route1.monthly.resets_at - expectedResetsAt1)).toBeLessThanOrEqual(5000);

    // Part 2: ~1K
    const modelId2 = 'test-monthly-1K';
    insertModel(h.db, platform, modelId2, { budget: '~1K', enabled: 1 });
    const keyId2 = insertKey(h.db, platform, 'key-1K', { scopeJson: null });
    const budgetKeys2 = (h.db.prepare("SELECT COUNT(*) as count FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy','unknown')").get(platform) as {count: number}).count;
    expect(budgetKeys2).toBe(2);

    addRequest(h.db, platform, modelId2, keyId2, 'success', 5000 * budgetKeys2, 0);

    const res2 = await getRoutes(h);
    const route2 = findRoute(res2.body, platform, modelId2, keyId2);
    expect(route2).toBeDefined();
    expect(route2.monthly.published_budget_text).toBe('~1K');
    expect(route2.monthly.published_budget_tokens).toBe(1000 * budgetKeys2);
    expect(route2.monthly.used_tokens_this_month).toBe(5000 * budgetKeys2);
    expect(route2.monthly.usable_this_month).toBe(false);
    expect(route2.monthly.used_tokens_this_month).toBeGreaterThanOrEqual(route2.monthly.published_budget_tokens);
  });

  it('monthly budget unknown', async () => {
    const platform = 'groq';
    const modelId = 'test-monthly-empty';
    insertModel(h.db, platform, modelId, { budget: '', enabled: 1 });
    const keyId = insertKey(h.db, platform, 'key-empty', { scopeJson: null });

    const res = await getRoutes(h);
    const route = findRoute(res.body, platform, modelId, keyId);
    expect(route).toBeDefined();
    expect(route.monthly.published_budget_tokens).toBeNull();
    expect(route.monthly.usable_this_month).toBeNull();
    expect(route.monthly.published_budget_text).toBe('');
  });

  it('pure read', async () => {
    const platform = 'groq';
    const now = Date.now();

    // Model with active cooldown
    const modelIdActive = 'test-pure-active';
    insertModel(h.db, platform, modelIdActive, { enabled: 1 });
    const keyIdActive = insertKey(h.db, platform, 'key-active', { scopeJson: null });
    addCooldown(h.db, platform, modelIdActive, keyIdActive, now + 10000, 'heuristic');

    // Model with expired cooldown
    const modelIdExpired = 'test-pure-expired';
    insertModel(h.db, platform, modelIdExpired, { enabled: 1 });
    const keyIdExpired = insertKey(h.db, platform, 'key-expired', { scopeJson: null });
    addCooldown(h.db, platform, modelIdExpired, keyIdExpired, now - 10000, 'authoritative');

    // Usage rows
    addUsage(h.db, platform, modelIdActive, keyIdActive, 'request', 0, now);
    addUsage(h.db, platform, modelIdActive, keyIdActive, 'tokens', 100, now);
    addUsage(h.db, platform, modelIdExpired, keyIdExpired, 'request', 0, now);

    // Request rows
    addRequest(h.db, platform, modelIdActive, keyIdActive, 'success', 100, 50);
    addRequest(h.db, platform, modelIdExpired, keyIdExpired, 'error', 999, 0);

    // Acquire a lease
    await acquireLease(platform, modelIdActive, keyIdActive, 60000);

    const before = dumpAllTables(h.db);

    await getRoutes(h, '');
    await getRoutes(h, '?estimated_tokens=500');
    await getRoutes(h, '');

    const after = dumpAllTables(h.db);

    const tableNames = Object.keys(before);
    for (const name of tableNames) {
      expect(after[name], name).toEqual(before[name]);
    }

    const countRow = h.db.prepare("SELECT COUNT(*) as count FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?").get(platform, modelIdExpired, keyIdExpired) as {count: number};
    expect(countRow.count).toBe(1);
  });
});
