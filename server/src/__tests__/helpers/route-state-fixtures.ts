import type { Express } from 'express';
import type { Db } from '../../db/types.js';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

export interface Harness { app: Express; unifiedKey: string; db: Db }

export function startHarness(): Harness {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const app = createApp();
  const unifiedKey = getUnifiedApiKey();
  const db = getDb();
  return { app, unifiedKey, db };
}

export async function getRoutes(h: Harness, query = '', headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const defaultHeaders = { Authorization: 'Bearer ' + h.unifiedKey };
  const requestHeaders = headers === undefined ? defaultHeaders : headers;

  return new Promise((resolve, reject) => {
    const server = h.app.listen(0, '127.0.0.1', async () => {
      const port = (server.address() as any).port;
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/v1/routes' + query, { headers: requestHeaders });
        const body = await response.json().catch(() => null);
        server.close();
        resolve({ status: response.status, body });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

export function insertKey(db: Db, platform: string, label = 'test-key', opts?: { scopeJson?: string | null; status?: string }): number {
  const { encrypted, iv, authTag } = encrypt('test-secret-abc');
  const status = opts?.status ?? 'healthy';
  const scopeJson = opts?.scopeJson ?? null;
  const result = db.prepare(
    'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  ).run(platform, label, encrypted, iv, authTag, status, scopeJson);
  return Number(result.lastInsertRowid);
}

export function insertModel(db: Db, platform: string, modelId: string, limits?: { rpm?: number | null; rpd?: number | null; tpm?: number | null; tpd?: number | null; budget?: string; enabled?: 0 | 1 }): number {
  const result = db.prepare(
    'INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled) VALUES (?, ?, ?, 500, 500, ?, ?, ?, ?, ?, ?)'
  ).run(
    platform,
    modelId,
    modelId,
    limits?.rpm ?? null,
    limits?.rpd ?? null,
    limits?.tpm ?? null,
    limits?.tpd ?? null,
    limits?.budget ?? '',
    limits?.enabled ?? 1
  );
  return Number(result.lastInsertRowid);
}

export function findRoute(body: any, platform: string, modelId: string, keyId?: number): any {
  if (!body?.routes || !Array.isArray(body.routes)) return undefined;
  return body.routes.find((r: any) =>
    r.platform === platform &&
    r.model_id === modelId &&
    (keyId === undefined || r.key_id === keyId)
  );
}

export function addUsage(db: Db, platform: string, modelId: string, keyId: number, kind: 'request' | 'tokens', tokens: number, atMs: number): void {
  db.prepare(
    'INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(platform, modelId, keyId, kind, kind === 'request' ? 0 : tokens, atMs);
}

export function addCooldown(db: Db, platform: string, modelId: string, keyId: number, expiresAtMs: number, source: 'heuristic' | 'authoritative' | 'credit' | 'tier'): void {
  db.prepare(
    'INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms, source, set_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(platform, modelId, keyId, expiresAtMs, source, Date.now());
}

export function addRequest(db: Db, platform: string, modelId: string, keyId: number, status: string, inTok: number, outTok: number, createdAt?: string): void {
  if (createdAt) {
    db.prepare(
      'INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(platform, modelId, keyId, status, inTok, outTok, createdAt);
  } else {
    db.prepare(
      'INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(platform, modelId, keyId, status, inTok, outTok);
  }
}

export function nextMonthStartMs(now = Date.now()): number {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return Date.UTC(year, month + 1, 1);
}

export function dumpAllTables(db: Db): Record<string, unknown[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  const result: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const rows = db.prepare('SELECT * FROM "' + name + '"').all();
    result[name] = rows;
  }
  return result;
}
