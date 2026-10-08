import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  startHarness,
  getRoutes,
  findRoute,
  insertKey,
  insertModel,
  addUsage,
  addCooldown,
} from '../helpers/route-state-fixtures.js';
import { acquireLease, resetLeases } from '../../services/ratelimit.js';

describe('route-state gates', () => {
  let h: any;

  beforeAll(() => {
    h = startHarness();
  });

  beforeEach(() => {
    resetLeases();
  });

  // 5. REASON cooldown (persisted, authoritative)
  it('cooldown: persisted authoritative', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'cooldown-auth-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId);
    const now = Date.now();
    addCooldown(h.db, 'groq', modelId, keyId, now + 600000, 'authoritative');
    const res = await getRoutes(h);
    const route = findRoute(res.body, 'groq', modelId, keyId);
    expect(route.reason).toBe('cooldown');
    expect(route.until).toBe(now + 600000);
    expect(route.cooldown_source).toBe('authoritative');
  });

  // 5b. REASON cooldown (persisted, heuristic)
  it('cooldown: persisted heuristic', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'cooldown-heur-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId);
    const now = Date.now();
    addCooldown(h.db, 'groq', modelId, keyId, now + 600000, 'heuristic');
    const res = await getRoutes(h);
    const route = findRoute(res.body, 'groq', modelId, keyId);
    expect(route.reason).toBe('cooldown');
    expect(route.until).toBe(now + 600000);
    expect(route.cooldown_source).toBe('heuristic');
  });

  // 6. EXPIRED cooldown is not a cooldown
  it('expired cooldown is not a cooldown', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'expired-cool-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId);
    const now = Date.now();
    addCooldown(h.db, 'groq', modelId, keyId, now - 1000, 'heuristic');
    const res = await getRoutes(h);
    const route = findRoute(res.body, 'groq', modelId, keyId);
    expect(route.available_now).toBe(true);
    expect(route.reason).toBeNull();
  });

  // 7. REASON provider_daily_cap
  it('provider_daily_cap', async () => {
    process.env.PROVIDER_DAILY_REQUEST_CAP_GROQ = '2';
    try {
      const keyId = insertKey(h.db, 'groq', 'test-key');
      const modelId = 'prov-daily-' + Math.random().toString(36).slice(2, 6);
      insertModel(h.db, 'groq', modelId);
      const now = Date.now();
      addUsage(h.db, 'groq', modelId, keyId, 'request', 0, now);
      addUsage(h.db, 'groq', modelId, keyId, 'request', 0, now);
      const res = await getRoutes(h);
      const route = findRoute(res.body, 'groq', modelId, keyId);
      expect(route.reason).toBe('provider_daily_cap');
      expect(route.until).toBeGreaterThan(now);
      expect(route.until).toBeLessThanOrEqual(now + 86400000);
    } finally {
      delete process.env.PROVIDER_DAILY_REQUEST_CAP_GROQ;
    }
  });

  // 8. REASON provider_minute_cap
  it('provider_minute_cap', async () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_GROQ = '1';
    try {
      const keyId = insertKey(h.db, 'groq', 'test-key');
      const modelId = 'prov-min-' + Math.random().toString(36).slice(2, 6);
      insertModel(h.db, 'groq', modelId);
      const now = Date.now();
      addUsage(h.db, 'groq', modelId, keyId, 'request', 0, now);
      const res = await getRoutes(h);
      const route = findRoute(res.body, 'groq', modelId, keyId);
      expect(route.reason).toBe('provider_minute_cap');
      expect(route.until).toBeGreaterThan(now);
      expect(route.until).toBeLessThanOrEqual(now + 60001 + 5000);
    } finally {
      delete process.env.PROVIDER_MINUTE_REQUEST_CAP_GROQ;
    }
  });

  // 9. REASON key_concurrency
  it('key_concurrency', async () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '1';
    try {
      const keyId = insertKey(h.db, 'groq', 'test-key');
      const modelId = 'key-conc-' + Math.random().toString(36).slice(2, 6);
      insertModel(h.db, 'groq', modelId);
      acquireLease('groq', modelId, keyId, 1);
      const res = await getRoutes(h);
      const route = findRoute(res.body, 'groq', modelId, keyId);
      expect(route.reason).toBe('key_concurrency');
      expect(route.until).toBeNull();
    } finally {
      delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
    }
  });

  // 9b. After reset, available again
  it('key_concurrency: available after reset', async () => {
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '1';
    try {
      const keyId = insertKey(h.db, 'groq', 'test-key');
      const modelId = 'key-conc-reset-' + Math.random().toString(36).slice(2, 6);
      insertModel(h.db, 'groq', modelId);
      acquireLease('groq', modelId, keyId, 1);
      resetLeases();
      const res = await getRoutes(h);
      const route = findRoute(res.body, 'groq', modelId, keyId);
      expect(route.available_now).toBe(true);
      expect(route.reason).toBeNull();
    } finally {
      delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
    }
  });

  // 10. REASON request_limit, minute window
  it('request_limit: minute window', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'req-min-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId, { rpm: 2 });
    const now = Date.now();
    addUsage(h.db, 'groq', modelId, keyId, 'request', 0, now);
    addUsage(h.db, 'groq', modelId, keyId, 'request', 0, now);
    const res = await getRoutes(h);
    const route = findRoute(res.body, 'groq', modelId, keyId);
    expect(route.reason).toBe('request_limit');
    expect(route.until).toBeGreaterThan(now);
    expect(route.until).toBeLessThanOrEqual(now + 60000 + 5000);
    expect(route.minute.requests_used).toBe(2);
    expect(route.minute.requests_limit).toBe(2);
  });

  // 11. REASON request_limit, daily window
  it('request_limit: daily window', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'req-daily-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId, { rpd: 3 });
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    addUsage(h.db, 'groq', modelId, keyId, 'request', 0, oneHourAgo);
    addUsage(h.db, 'groq', modelId, keyId, 'request', 0, oneHourAgo);
    addUsage(h.db, 'groq', modelId, keyId, 'request', 0, oneHourAgo);
    const res = await getRoutes(h);
    const route = findRoute(res.body, 'groq', modelId, keyId);
    expect(route.reason).toBe('request_limit');
    expect(route.daily.requests_used).toBe(3);
    expect(route.daily.requests_limit).toBe(3);
    const expectedResetsAt = oneHourAgo + 86400000;
    expect(route.daily.resets_at).toBeGreaterThan(expectedResetsAt - 5000);
    expect(route.daily.resets_at).toBeLessThan(expectedResetsAt + 5000);
    expect(route.until).toBe(route.daily.resets_at);
    expect(route.minute.requests_used).toBe(0);
    expect(route.minute.resets_at).toBeNull();
  });

  // 12. REASON token_limit
  it('token_limit: tpm breach', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'tok-tpm-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId, { tpm: 100 });
    const now = Date.now();
    addUsage(h.db, 'groq', modelId, keyId, 'tokens', 100, now);
    const res = await getRoutes(h);
    const route = findRoute(res.body, 'groq', modelId, keyId);
    expect(route.reason).toBe('token_limit');
    expect(route.minute.tokens_used).toBe(100);
  });

  // 12b. estimated_tokens honoured
  it('token_limit: estimated_tokens query', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'tok-est-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId, { tpm: 50 });
    // default estimated_tokens=1 -> available
    const resDefault = await getRoutes(h);
    const routeDefault = findRoute(resDefault.body, 'groq', modelId, keyId);
    expect(routeDefault.available_now).toBe(true);
    expect(routeDefault.reason).toBeNull();
    // with ?estimated_tokens=500 -> token_limit
    const res500 = await getRoutes(h, '?estimated_tokens=500');
    const route500 = findRoute(res500.body, 'groq', modelId, keyId);
    expect(route500.reason).toBe('token_limit');
    expect(res500.body.estimated_tokens).toBe(500);
  });

  // 13. REASON provider_token_cap
  it('provider_token_cap', async () => {
    process.env.PROVIDER_DAILY_TOKEN_CAP_GROQ = '10';
    try {
      const keyId = insertKey(h.db, 'groq', 'test-key');
      const modelId = 'prov-tok-' + Math.random().toString(36).slice(2, 6);
      insertModel(h.db, 'groq', modelId);
      const now = Date.now();
      addUsage(h.db, 'groq', modelId, keyId, 'tokens', 10, now);
      const res = await getRoutes(h);
      const route = findRoute(res.body, 'groq', modelId, keyId);
      expect(route.reason).toBe('provider_token_cap');
    } finally {
      delete process.env.PROVIDER_DAILY_TOKEN_CAP_GROQ;
    }
  });



  // 15. GATE ORDER: cooldown beats request_limit
  it('gate order: cooldown before request_limit', async () => {
    const keyId = insertKey(h.db, 'groq', 'test-key');
    const modelId = 'gate-order-' + Math.random().toString(36).slice(2, 6);
    insertModel(h.db, 'groq', modelId, { rpm: 2 });
    const now = Date.now();
    // Persisted cooldown
    addCooldown(h.db, 'groq', modelId, keyId, now + 600000, 'authoritative');
    // Breach rpm limit
    addUsage(h.db, 'groq', modelId, keyId, 'request', 0, now);
    addUsage(h.db, 'groq', modelId, keyId, 'request', 0, now);
    const res = await getRoutes(h);
    const route = findRoute(res.body, 'groq', modelId, keyId);
    expect(route.reason).toBe('cooldown');
  });
});
