/**
 * GET /v1/routes — read-only route-state endpoint (schema_version 1).
 *
 * Sibling of GET /v1/providers (same unified-key auth): one entry per enabled model × usable
 * key, saying whether the router would accept that route right now. The decision is made by the
 * router's OWN gate functions, called in the router's order (selectKeyForModel in
 * services/router.ts): cooldown, provider_daily_cap, provider_minute_cap, key_concurrency,
 * request_limit (rpm/rpd), token_limit (tpm/tpd), provider_token_cap.
 * `no_key` is a ninth, non-gate reason for a model with no usable key.
 * This release has no per-key monthly budget gate, so monthly_budget_cap is never reported; the monthly block is still computed from the requests table.
 * The first failing gate becomes `reason`; `until` is the epoch ms the route next becomes usable.
 *
 * PURE READ: this handler must never write. In particular isOnCooldown() deletes an expired
 * rate_limit_cooldowns row as a side effect, so it is only called when no persisted row exists
 * (an in-memory-only cooldown). Do not add calls to setCooldown, record*, acquireLease or
 * reserveMonthlyBudget here. __tests__/routes/route-state-monthly-pure.test.ts guards this.
 *
 * Monthly usage comes from the `requests` table for the current UTC calendar month, per
 * (platform, model_id); the published budget is the model's free-text label parsed by parseBudget.
 */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { extractApiToken, timingSafeStringEqual } from './proxy.js';
import type { Db } from '../db/types.js';
import {
  canMakeRequest,
  canUseTokens,
  isOnCooldown,
  canUseProvider,
  canUseProviderMinute,
  canUseProviderTokens,
  canUseKeyConcurrency,
} from '../services/ratelimit.js';

import { parseBudget } from '../lib/budget.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { customEndpointKeyIds } from '../services/custom-endpoint.js';

// ─── helpers ───────────────────────────────────────────────────────────────────

function nextUtcMidnightMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function windowReset(oldest: number | undefined | null, windowMs: number): number | null {
  if (oldest == null) return null;
  return oldest + windowMs;
}

function parseEstimatedTokens(val: unknown): number {
  if (typeof val === 'string' && /^\d+$/.test(val)) {
    const n = parseInt(val, 10);
    if (n >= 0) return n;
  }
  return 1;
}

// ─── types ─────────────────────────────────────────────────────────────────────

export interface RouteStateRoute {
  platform: string;
  model_id: string;
  model_db_id: number;
  display_name: string;
  key_id: number | null;
  key_label: string | null;
  key_ref: string | null;
  available_now: boolean;
  reason: string | null;
  until: number | null;
  cooldown_source: string | null;
  daily: {
    requests_limit: number | null;
    requests_used: number;
    tokens_limit: number | null;
    tokens_used: number;
    resets_at: number | null;
  };
  minute: {
    requests_limit: number | null;
    requests_used: number;
    tokens_limit: number | null;
    tokens_used: number;
    resets_at: number | null;
  };
  monthly: {
    month: string;
    published_budget_text: string;
    published_budget_tokens: number | null;
    budget_keys: number;
    used_tokens_this_month: number;
    used_requests_this_month: number;
    usable_this_month: boolean | null;
    resets_at: number;
  };
}

export interface RouteStateResponse {
  schema_version: 1;
  generated_at: string;
  generated_at_ms: number;
  estimated_tokens: number;
  counts: {
    routes: number;
    available: number;
    unavailable: number;
  };
  routes: RouteStateRoute[];
}

// ─── buildRouteState ───────────────────────────────────────────────────────────

export function buildRouteState(
  db: Db,
  now: number,
  estimatedTokens: number
): RouteStateResponse {
  const DAY_MS = 86400000;
  const MINUTE_MS = 60000;

  // ── models ──────────────────────────────────────────────────────────────
  const modelsRows = db.prepare(
    'SELECT id, platform, model_id, display_name, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, key_id FROM models WHERE enabled = 1 ORDER BY intelligence_rank ASC, id ASC'
  ).all() as any[];

  // ── keys ────────────────────────────────────────────────────────────────
  const keysRows = db.prepare(
    'SELECT id, platform, label, model_scope_json FROM api_keys WHERE enabled = 1 AND status IN (\'healthy\', \'unknown\') ORDER BY id ASC'
  ).all() as any[];

  const keysByPlatform = new Map<string, { id: number; label: string; scope: Set<string> | null }[]>();
  const keysCountByPlatform = new Map<string, number>();
  for (const k of keysRows) {
    const platform = k.platform;
    if (!keysByPlatform.has(platform)) {
      keysByPlatform.set(platform, []);
    }
    keysCountByPlatform.set(platform, (keysCountByPlatform.get(platform) ?? 0) + 1);
    keysByPlatform.get(platform)!.push({
      id: k.id,
      label: k.label,
      scope: parseModelScope(k.model_scope_json),
    });
  }

  // ── usage windows (day + minute) ────────────────────────────────────────
  const dayCutoff = now - DAY_MS;
  const minuteCutoff = now - MINUTE_MS;

  const dayUsageRows = db.prepare(
    'SELECT platform, model_id, key_id, SUM(CASE WHEN kind = \'request\' THEN 1 ELSE 0 END) AS req, COALESCE(SUM(CASE WHEN kind = \'tokens\' THEN tokens ELSE 0 END), 0) AS tok, MIN(created_at_ms) AS oldest FROM rate_limit_usage WHERE created_at_ms > ? GROUP BY platform, model_id, key_id'
  ).all(dayCutoff) as any[];

  const minuteUsageRows = db.prepare(
    'SELECT platform, model_id, key_id, SUM(CASE WHEN kind = \'request\' THEN 1 ELSE 0 END) AS req, COALESCE(SUM(CASE WHEN kind = \'tokens\' THEN tokens ELSE 0 END), 0) AS tok, MIN(created_at_ms) AS oldest FROM rate_limit_usage WHERE created_at_ms > ? GROUP BY platform, model_id, key_id'
  ).all(minuteCutoff) as any[];

  const dayUsageMap = new Map<string, { req: number; tok: number; oldest: number | null }>();
  for (const r of dayUsageRows) {
    const key = `${r.platform}\u0000${r.model_id}\u0000${r.key_id}`;
    dayUsageMap.set(key, {
      req: Number(r.req) || 0,
      tok: Number(r.tok) || 0,
      oldest: r.oldest != null ? Number(r.oldest) : null,
    });
  }

  const minuteUsageMap = new Map<string, { req: number; tok: number; oldest: number | null }>();
  for (const r of minuteUsageRows) {
    const key = `${r.platform}\u0000${r.model_id}\u0000${r.key_id}`;
    minuteUsageMap.set(key, {
      req: Number(r.req) || 0,
      tok: Number(r.tok) || 0,
      oldest: r.oldest != null ? Number(r.oldest) : null,
    });
  }

  // ── monthly usage (requests table) ──────────────────────────────────────
  const nowDate = new Date(now);
  const monthStr = `${nowDate.getUTCFullYear()}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthStartStr = `${monthStr}-01 00:00:00`;

  const monthlyRows = db.prepare(
    'SELECT platform, model_id, COUNT(*) AS n, COALESCE(SUM(input_tokens + output_tokens), 0) AS tok FROM requests WHERE status = \'success\' AND created_at >= ? GROUP BY platform, model_id'
  ).all(monthStartStr) as any[];

  const monthlyUsageMap = new Map<string, { n: number; tok: number }>();
  for (const r of monthlyRows) {
    const key = `${r.platform}\u0000${r.model_id}`;
    monthlyUsageMap.set(key, { n: Number(r.n) || 0, tok: Number(r.tok) || 0 });
  }

  // ── cooldown statement (prepared once) ──────────────────────────────────
  const cooldownStmt = db.prepare(
    'SELECT expires_at_ms, source FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND key_id = ?'
  );

  // ── custom-endpoint cache ───────────────────────────────────────────────
  const customEndpointCache = new Map<number, Set<number>>();

  // ── build routes ────────────────────────────────────────────────────────
  const routes: RouteStateRoute[] = [];
  let availableCount = 0;

  for (const model of modelsRows) {
    const platform = model.platform;
    const modelId = model.model_id;
    const modelDbId = model.id;
    const displayName = model.display_name;
    const limits = {
      rpm: model.rpm_limit ?? null,
      rpd: model.rpd_limit ?? null,
      tpm: model.tpm_limit ?? null,
      tpd: model.tpd_limit ?? null,
    };

    // candidate keys for this model
    const platformKeys = keysByPlatform.get(platform) ?? [];
    let candidateKeys = platformKeys.filter(k => scopeAllows(k.scope, modelId));

    if (platform === 'custom' && model.key_id != null) {
      if (!customEndpointCache.has(model.key_id)) {
        customEndpointCache.set(model.key_id, customEndpointKeyIds(db, model.key_id));
      }
      const allowedSet = customEndpointCache.get(model.key_id)!;
      candidateKeys = candidateKeys.filter(k => allowedSet.has(k.id));
    }

    // monthly data (same for all keys of this model)
    const monthlyKey = `${platform}\u0000${modelId}`;
    const monthlyUsage = monthlyUsageMap.get(monthlyKey) ?? { n: 0, tok: 0 };
    const budgetKeys = Math.max(1, keysCountByPlatform.get(platform) ?? 1);
    const budgetText = model.monthly_token_budget != null ? String(model.monthly_token_budget) : '';
    const parsedBudget = parseBudget(budgetText);
    const publishedBudgetTokens = parsedBudget > 0 ? parsedBudget * budgetKeys : null;
    const usedTokensThisMonth = monthlyUsage.tok;
    const usedRequestsThisMonth = monthlyUsage.n;
    const usableThisMonth =
      publishedBudgetTokens != null ? usedTokensThisMonth < publishedBudgetTokens : null;
    const monthResetAt = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1);

    // no_key route
    if (candidateKeys.length === 0) {
      routes.push({
        platform,
        model_id: modelId,
        model_db_id: modelDbId,
        display_name: displayName,
        key_id: null,
        key_label: null,
        key_ref: null,
        available_now: false,
        reason: 'no_key',
        until: null,
        cooldown_source: null,
        daily: {
          requests_limit: limits.rpd,
          requests_used: 0,
          tokens_limit: limits.tpd,
          tokens_used: 0,
          resets_at: null,
        },
        minute: {
          requests_limit: limits.rpm,
          requests_used: 0,
          tokens_limit: limits.tpm,
          tokens_used: 0,
          resets_at: null,
        },
        monthly: {
          month: monthStr,
          published_budget_text: budgetText,
          published_budget_tokens: publishedBudgetTokens,
          budget_keys: budgetKeys,
          used_tokens_this_month: usedTokensThisMonth,
          used_requests_this_month: usedRequestsThisMonth,
          usable_this_month: usableThisMonth,
          resets_at: monthResetAt,
        },
      });
      continue;
    }

    // evaluate each candidate key
    for (const key of candidateKeys) {
      const keyId = key.id;
      const keyLabel = key.label;
      const keyRef = createHash('sha256')
        .update(`${platform}:${keyId}`)
        .digest('hex')
        .slice(0, 12);

      // daily / minute usage for this route
      const dayKey = `${platform}\u0000${modelId}\u0000${keyId}`;
      const dayUsage = dayUsageMap.get(dayKey) ?? { req: 0, tok: 0, oldest: null };
      const dayReq = dayUsage.req;
      const dayTok = dayUsage.tok;
      const dayReset = windowReset(dayUsage.oldest, DAY_MS);

      const minuteKey = `${platform}\u0000${modelId}\u0000${keyId}`;
      const minuteUsage = minuteUsageMap.get(minuteKey) ?? { req: 0, tok: 0, oldest: null };
      const minuteReq = minuteUsage.req;
      const minuteTok = minuteUsage.tok;
      const minuteReset = windowReset(minuteUsage.oldest, MINUTE_MS);

      // gate evaluation
      let available_now = true;
      let reason: string | null = null;
      let until: number | null = null;
      let cooldown_source: string | null = null;

      // 1. cooldown
      const cooldownRow = cooldownStmt.get(platform, modelId, keyId) as any;
      let onCooldown = false;
      let cooldownExpires: number | null = null;
      let cooldownSource: string | null = null;

      if (cooldownRow) {
        if (cooldownRow.expires_at_ms > now) {
          onCooldown = true;
          cooldownExpires = cooldownRow.expires_at_ms;
          cooldownSource = cooldownRow.source;
        }
        // expired row → not on cooldown, do NOT call isOnCooldown
      } else if (isOnCooldown(platform, modelId, keyId)) {
        onCooldown = true; // in-memory only
      }

      if (onCooldown) {
        available_now = false;
        reason = 'cooldown';
        until = cooldownExpires;
        cooldown_source = cooldownSource;
      }

      // 2. provider_daily_cap
      if (available_now && !canUseProvider(platform, keyId, now)) {
        available_now = false;
        reason = 'provider_daily_cap';
        until = nextUtcMidnightMs(now);
      }

      // 3. provider_minute_cap
      if (available_now && !canUseProviderMinute(platform, keyId, now)) {
        available_now = false;
        reason = 'provider_minute_cap';
        until = now + MINUTE_MS;
      }

      // 4. key_concurrency
      if (available_now && !canUseKeyConcurrency(platform, keyId, now)) {
        available_now = false;
        reason = 'key_concurrency';
        until = null;
      }

      // 5. request_limit
      if (available_now && !canMakeRequest(platform, modelId, keyId, limits)) {
        available_now = false;
        reason = 'request_limit';
        const resets: number[] = [];
        if (limits.rpm !== null && minuteReq >= limits.rpm && minuteReset != null) {
          resets.push(minuteReset);
        }
        if (limits.rpd !== null && dayReq >= limits.rpd && dayReset != null) {
          resets.push(dayReset);
        }
        until = resets.length > 0 ? Math.max(...resets) : null;
      }

      // 6. token_limit
      if (available_now && !canUseTokens(platform, modelId, keyId, estimatedTokens, limits)) {
        available_now = false;
        reason = 'token_limit';
        const resets: number[] = [];
        if (limits.tpm !== null && minuteTok + estimatedTokens > limits.tpm && minuteReset != null) {
          resets.push(minuteReset);
        }
        if (limits.tpd !== null && dayTok + estimatedTokens > limits.tpd && dayReset != null) {
          resets.push(dayReset);
        }
        until = resets.length > 0 ? Math.max(...resets) : null;
      }

      // 7. provider_token_cap
      if (available_now && !canUseProviderTokens(platform, keyId, modelId, estimatedTokens)) {
        available_now = false;
        reason = 'provider_token_cap';
        until = nextUtcMidnightMs(now);
      }

      routes.push({
        platform,
        model_id: modelId,
        model_db_id: modelDbId,
        display_name: displayName,
        key_id: keyId,
        key_label: keyLabel,
        key_ref: keyRef,
        available_now,
        reason,
        until,
        cooldown_source,
        daily: {
          requests_limit: limits.rpd,
          requests_used: dayReq,
          tokens_limit: limits.tpd,
          tokens_used: dayTok,
          resets_at: dayReset,
        },
        minute: {
          requests_limit: limits.rpm,
          requests_used: minuteReq,
          tokens_limit: limits.tpm,
          tokens_used: minuteTok,
          resets_at: minuteReset,
        },
        monthly: {
          month: monthStr,
          published_budget_text: budgetText,
          published_budget_tokens: publishedBudgetTokens,
          budget_keys: budgetKeys,
          used_tokens_this_month: usedTokensThisMonth,
          used_requests_this_month: usedRequestsThisMonth,
          usable_this_month: usableThisMonth,
          resets_at: monthResetAt,
        },
      });

      if (available_now) availableCount++;
    }
  }

  return {
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    generated_at_ms: now,
    estimated_tokens: estimatedTokens,
    counts: {
      routes: routes.length,
      available: availableCount,
      unavailable: routes.length - availableCount,
    },
    routes,
  };
}

// ─── router ────────────────────────────────────────────────────────────────────

export const routeStateRouter = Router();

routeStateRouter.get('/routes', (req: Request, res: Response) => {
  try {
    const token = extractApiToken(req);
    if (!token || !timingSafeStringEqual(token, getUnifiedApiKey())) {
      res.status(401).json({
        error: { message: 'Invalid API key', type: 'authentication_error' },
      });
      return;
    }

    const estimatedTokens = parseEstimatedTokens(req.query.estimated_tokens);
    res.set('Cache-Control', 'no-store');
    res.json(buildRouteState(getDb(), Date.now(), estimatedTokens));
  } catch {
    res.status(500).json({
      error: { message: 'route state unavailable', type: 'server_error' },
    });
  }
});
