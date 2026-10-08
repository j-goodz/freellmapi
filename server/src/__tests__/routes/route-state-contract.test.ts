import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { startHarness, getRoutes, insertKey, insertModel, findRoute, addCooldown, type Harness } from '../helpers/route-state-fixtures.js';
import { resetLeases } from '../../services/ratelimit.js';

let h: Harness;

beforeAll(() => {
  h = startHarness();
});

beforeEach(() => {
  resetLeases();
});

describe('GET /v1/routes contract', () => {
  // 1. AUTH
  it('returns 401 with authentication_error when no key provided', async () => {
    const { status, body } = await getRoutes(h, '', {});
    expect(status).toBe(401);
    expect(body).toEqual({ error: { message: 'Invalid API key', type: 'authentication_error' } });
  });

  it('returns 401 with authentication_error when wrong key provided', async () => {
    const { status, body } = await getRoutes(h, '', { Authorization: 'Bearer wrong-key' });
    expect(status).toBe(401);
    expect(body).toEqual({ error: { message: 'Invalid API key', type: 'authentication_error' } });
  });

  it('returns 200 with x-api-key header', async () => {
    const { status } = await getRoutes(h, '', { 'x-api-key': h.unifiedKey });
    expect(status).toBe(200);
  });

  it('returns 200 with Authorization Bearer header', async () => {
    const { status } = await getRoutes(h, '', { Authorization: 'Bearer ' + h.unifiedKey });
    expect(status).toBe(200);
  });

  // 2. CONTRACT (schema-change tripwire)
  it('returns response matching exact schema with all required fields and no secrets', async () => {
    const modelId = 'test-model-' + Date.now();
    const keyId = insertKey(h.db, 'groq', 'contract-key');
    insertModel(h.db, 'groq', modelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '~1M', enabled: 1 });

    const { status, body } = await getRoutes(h);
    expect(status).toBe(200);

    expect(body.schema_version).toBe(1);
    expect(typeof body.generated_at).toBe('string');
    expect(typeof body.generated_at_ms).toBe('number');
    expect(body.estimated_tokens).toBe(1);

    expect(Object.keys(body.counts).sort()).toEqual(['available', 'routes', 'unavailable']);
    expect(body.counts.routes).toBe(body.routes.length);
    expect(body.counts.available + body.counts.unavailable).toBe(body.counts.routes);

    const route = findRoute(body, 'groq', modelId, keyId);
    expect(route).toBeDefined();

    const expectedRouteKeys = [
      'available_now', 'cooldown_source', 'daily', 'display_name', 'key_id',
      'key_label', 'key_ref', 'model_db_id', 'model_id', 'minute', 'monthly',
      'platform', 'reason', 'until'
    ].sort();
    expect(Object.keys(route).sort()).toEqual(expectedRouteKeys);

    const expectedWindowKeys = ['requests_limit', 'requests_used', 'resets_at', 'tokens_limit', 'tokens_used'].sort();
    expect(Object.keys(route.daily).sort()).toEqual(expectedWindowKeys);
    expect(Object.keys(route.minute).sort()).toEqual(expectedWindowKeys);

    const expectedMonthlyKeys = [
      'budget_keys', 'month', 'published_budget_text', 'published_budget_tokens',
      'resets_at', 'usable_this_month', 'used_requests_this_month', 'used_tokens_this_month'
    ].sort();
    expect(Object.keys(route.monthly).sort()).toEqual(expectedMonthlyKeys);

    expect(route.key_ref).toMatch(/^[0-9a-f]{12}$/);
    expect(route.key_label).toBe('contract-key');

    const json = JSON.stringify(body);
    expect(json).not.toContain('test-secret-abc');
    expect(json).not.toContain('0'.repeat(64));
  });

  // 3. AVAILABLE
  it('returns available_now true with null reason/until/cooldown_source for clean model', async () => {
    const modelId = 'available-model-' + Date.now();
    const keyId = insertKey(h.db, 'groq', 'available-key');
    insertModel(h.db, 'groq', modelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '', enabled: 1 });

    const { status, body } = await getRoutes(h);
    expect(status).toBe(200);

    const route = findRoute(body, 'groq', modelId, keyId);
    expect(route.available_now).toBe(true);
    expect(route.reason).toBeNull();
    expect(route.until).toBeNull();
    expect(route.cooldown_source).toBeNull();
  });

  // 4. REASON no_key
  it('returns reason no_key when model has no usable key', async () => {
    // Use a platform with no keys in DB
    const platform = 'nokey-platform-' + Date.now();
    const modelId = 'nokey-model-' + Date.now();
    insertModel(h.db, platform, modelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '', enabled: 1 });

    // Verify no keys exist for this platform
    const keys = h.db.prepare("SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')").all(platform);
    expect(keys.length).toBe(0);

    const { status, body } = await getRoutes(h);
    expect(status).toBe(200);

    const route = findRoute(body, platform, modelId);
    expect(route).toBeDefined();
    expect(route.reason).toBe('no_key');
    expect(route.available_now).toBe(false);
    expect(route.key_id).toBeNull();
    expect(route.key_label).toBeNull();
    expect(route.key_ref).toBeNull();
    expect(route.until).toBeNull();
  });

  // 18. MULTI-KEY
  it('returns separate routes per key and evaluates each independently', async () => {
    const platform = 'multikey-platform-' + Date.now();
    const modelId = 'multikey-model-' + Date.now();
    const keyId1 = insertKey(h.db, platform, 'key-one');
    const keyId2 = insertKey(h.db, platform, 'key-two');
    insertModel(h.db, platform, modelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '', enabled: 1 });

    const now = Date.now();
    addCooldown(h.db, platform, modelId, keyId1, now + 60000, 'heuristic');

    const { status, body } = await getRoutes(h);
    expect(status).toBe(200);

    const route1 = findRoute(body, platform, modelId, keyId1);
    const route2 = findRoute(body, platform, modelId, keyId2);

    expect(route1).toBeDefined();
    expect(route2).toBeDefined();
    expect(route1.key_id).toBe(keyId1);
    expect(route2.key_id).toBe(keyId2);
    expect(route1.reason).toBe('cooldown');
    expect(route1.available_now).toBe(false);
    expect(route2.available_now).toBe(true);
    expect(route2.reason).toBeNull();
  });

  // 20. COUNTS
  it('counts.available matches routes with available_now true, counts.unavailable matches the rest', async () => {
    const modelId = 'counts-model-' + Date.now();
    const keyId1 = insertKey(h.db, 'groq', 'counts-key-1');
    const keyId2 = insertKey(h.db, 'groq', 'counts-key-2');
    insertModel(h.db, 'groq', modelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '', enabled: 1 });

    const now = Date.now();
    addCooldown(h.db, 'groq', modelId, keyId1, now + 60000, 'heuristic');

    const { status, body } = await getRoutes(h);
    expect(status).toBe(200);

    const routes = body.routes.filter((r: any) => r.platform === 'groq' && r.model_id === modelId);
    const available = routes.filter((r: any) => r.available_now === true).length;
    const unavailable = routes.filter((r: any) => r.available_now === false).length;

    expect(body.counts.routes).toBe(body.routes.length);
    expect(body.counts.available).toBe(body.routes.filter((r: any) => r.available_now).length);
    expect(body.counts.unavailable).toBe(body.routes.filter((r: any) => !r.available_now).length);
    expect(available + unavailable).toBe(routes.length);
    expect(routes.find((r: any) => r.key_id === keyId1).available_now).toBe(false);
    expect(routes.find((r: any) => r.key_id === keyId2).available_now).toBe(true);
  });

  // 21. DISABLED MODEL
  it('does not include disabled models in routes', async () => {
    const modelId = 'disabled-model-' + Date.now();
    const keyId = insertKey(h.db, 'groq', 'disabled-key');
    insertModel(h.db, 'groq', modelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '', enabled: 0 });

    const { status, body } = await getRoutes(h);
    expect(status).toBe(200);

    const route = findRoute(body, 'groq', modelId, keyId);
    expect(route).toBeUndefined();
  });

  // 22. SCOPED KEY
  it('excludes routes for keys whose scope does not allow the model', async () => {
    const platform = 'scoped-platform-' + Date.now();
    const modelId = 'scoped-model-' + Date.now();
    const otherModelId = 'other-model-' + Date.now();

    // Key scoped to only allow otherModelId
    const scopedKeyId = insertKey(h.db, platform, 'scoped-key', { scopeJson: JSON.stringify([otherModelId]) });
    // Unscoped key
    const unscopedKeyId = insertKey(h.db, platform, 'unscoped-key', { scopeJson: null });

    insertModel(h.db, platform, modelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '', enabled: 1 });
    insertModel(h.db, platform, otherModelId, { rpm: 60, rpd: 1000, tpm: 10000, tpd: 100000, budget: '', enabled: 1 });

    const { status, body } = await getRoutes(h);
    expect(status).toBe(200);

    const scopedRoute = findRoute(body, platform, modelId, scopedKeyId);
    const unscopedRoute = findRoute(body, platform, modelId, unscopedKeyId);

    expect(scopedRoute).toBeUndefined();
    expect(unscopedRoute).toBeDefined();
    expect(unscopedRoute.key_id).toBe(unscopedKeyId);
  });
});
