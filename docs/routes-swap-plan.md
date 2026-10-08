# Swap plan: homelab free-model aggregator to a build with `GET /v1/routes`

Prepared 2026-10-08. Nothing in this document has been executed against the live container.
Everything below that says "rehearsed" ran on a COPY of the live database with the network disabled.

## 1. What is running now

| Item | Value |
|---|---|
| Host / compose dir | `homelab`, `~/freellmapi` (project `freellmapi`) |
| Container | `freellmapi-freellmapi-1` |
| Image | `ghcr.io/tashfeenahmed/freellmapi@sha256:d162b053b634eb7ce2dbed693e350c89b8e423168d06b2686b790f64a998fbfe` |
| Build | v0.8.4, upstream revision `6c4233b6847623328cdb8652d68e4d70d81f16e6`, built 2026-08-20 |
| Data volume | `freellmapi_freellmapi-data` mounted at `/app/server/data` |
| Env | `~/freellmapi/.env` (env_file) plus `NODE_ENV`, `PORT`, `PROXY_RATE_LIMIT_RPM=0`, `NODE_OPTIONS=--require /app/patches/auth-reject-log.cjs` |
| Bind mounts | `~/freellmapi/patches/index.js` over `/app/server/dist/providers/index.js` (keyless zen patch), `~/homelab-config/freellmapi/auth-reject-log.cjs` |
| Port | `${HOST_BIND}:${PORT}:3001` (live: `100.98.251.123:3001`) |

## 2. Which image to swap in

Two images were built and rehearsed. Use A.

| | A. `freellmapi-routes:633a356` (recommended) | B. `freellmapi-routes:cf6b850` |
|---|---|---|
| Branch | `fm/routes-api-v084` (6c4233b plus the endpoint) | `fm/routes-api` (upstream main dbac4f3 plus the endpoint) |
| Image ID | `sha256:3acc5b7818352378806a6a5aed57937364be7cd00f305b6e76cc0be606cf9dc5` | `sha256:61c7abd3be43c2403366620b8490890e9580b99e3d09ee697d4609559017b967` |
| Migrations vs running build | none | 15 new plus an edit to the baseline (list in section 7) |
| Gates reported | 7 router gates plus `no_key` | 8 router gates plus `no_key` (adds the per-key monthly budget cap) |
| Rehearsed on a copy of the live DB | chain tables unchanged | **chain tables change** (see below) |
| Local patches (zen keyless mount, auth-reject log) | keep working, unchanged | zen mount must be dropped (it pins a v0.8.4 compiled file) |
| Known blocker | none | v0.13.4 sent the Kilo placeholder key as a bearer and every Kilo call returned 401 on 2026-10-05 (README in `~/homelab-config/freellmapi`). Needs the Kilo key row set to `no-key` first, which is a database write |

Rehearsal of B on a copy of the live database: enabled models 527 to 579, `fallback_config` rows 530 to 582
(enabled 240 to 292), `profile_models` 2120 to 2328, and `enable_mcp` set to 1. A first boot of B therefore
changes the curated chain. Rehearsal of A: model, `fallback_config`, `profile_models` and `api_keys` hashes
identical to the original, and the only table whose row count changed is `rate_limit_cooldowns` (142 to 84,
expired rows removed at boot, which every restart does).

Rehearsal result for A (`GET /v1/routes` on the copy): HTTP 200 in 96 ms, 555 routes, 419 available, 136 unavailable
(48 cooldown, 88 no_key). The response contained no key material (checked by searching it for the unified key).

## 3. Preflight (changes nothing)

```bash
ssh homelab
cd ~/freellmapi
NEW=freellmapi-routes:633a356
docker image inspect "$NEW" --format '{{.Id}}'          # expect sha256:3acc5b78...cf9dc5
docker image inspect ghcr.io/tashfeenahmed/freellmapi@sha256:d162b053b634eb7ce2dbed693e350c89b8e423168d06b2686b790f64a998fbfe --format '{{.Id}}'   # old image still present
docker compose ps                                         # freellmapi-freellmapi-1 healthy
df -h /var/lib/docker | tail -1                           # needs about 1 GB free
```

## 4. Snapshot the data volume (container stopped, so the copy is consistent)

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
B=~/backups/freellmapi-routes-$TS
mkdir -p "$B"
VOL=$(docker volume inspect -f '{{.Mountpoint}}' freellmapi_freellmapi-data)
cp -p docker-compose.yml "$B/docker-compose.yml"
docker compose stop
sudo tar -C "$VOL" -czf "$B/volume.tgz" .
sudo cp -p "$VOL/freeapi.db" "$B/freeapi.db"
for e in -wal -shm; do sudo test -e "$VOL/freeapi.db$e" && sudo cp -p "$VOL/freeapi.db$e" "$B/freeapi.db$e"; done
sudo chown -R "$USER": "$B"
(cd "$B" && sha256sum volume.tgz freeapi.db docker-compose.yml > SHA256SUMS && sha256sum -c --quiet SHA256SUMS && echo snapshot ok)
echo "$B" > ~/backups/freellmapi-routes-latest.txt
```

Expected: `snapshot ok`. The stop starts the outage (callers get connection errors until section 5 finishes, about 20 seconds).

## 5. Start the new image with the same volume, env, ports and mounts

Only the `image:` line changes. Every `volumes`, `environment`, `env_file`, `ports` and `healthcheck` entry stays as it is.

```bash
cd ~/freellmapi
cp -p "$B/docker-compose.yml" docker-compose.yml.pre-routes-$TS
sed -i 's#^    image: .*#    image: freellmapi-routes:633a356   # routes endpoint on base 6c4233b, swapped '"$TS"'#' docker-compose.yml
docker compose config | grep -E 'image:|source:|published'
docker compose up -d --pull never
```

`--pull never` stops compose from trying to fetch a local-only tag from a registry.

## 6. Health probe (reads the unified key from its file, never prints it)

```bash
cd ~/freellmapi
HP=$(docker compose port freellmapi 3001)
for i in $(seq 1 30); do [ "$(docker inspect freellmapi-freellmapi-1 --format '{{.State.Health.Status}}')" = healthy ] && break; sleep 2; done
docker inspect freellmapi-freellmapi-1 --format 'health={{.State.Health.Status}} image={{.Image}}'   # image= sha256:3acc5b78...
curl -fsS "http://$HP/livez"
curl -fsS "http://$HP/readyz"
curl -fsS -H "Authorization: Bearer $(cat ~/freellmapi/.unified-key)" "http://$HP/v1/routes" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["schema_version"], d["counts"])'
curl -s -o /dev/null -w '%{http_code}\n' "http://$HP/v1/routes"     # expect 401 without a key
docker logs --since 2m freellmapi-freellmapi-1 2>&1 | grep -ci 'error'    # expect near 0
```

Expected: `healthy`, `/livez` and `/readyz` 200, `/v1/routes` prints `1 {'routes': ~555, ...}`, the keyless call prints 401.
Then send one real chat call through the usual path (for example the hive health check) and confirm it answers.

## 7. Rollback (exact)

The old image is still on the host, so rollback is a compose revert. Image A runs no migrations, so the database does not need restoring.

```bash
cd ~/freellmapi
TS=<the timestamp used in section 4>
cp -p docker-compose.yml docker-compose.yml.routes-$TS
cp -p docker-compose.yml.pre-routes-$TS docker-compose.yml
docker compose up -d --pull never
docker inspect freellmapi-freellmapi-1 --format '{{.Image}}'      # expect sha256:d162b053b634eb7ce2dbed693e350c89b8e423168d06b2686b790f64a998fbfe
```

Only if the database itself is suspect (it should not be for image A): with the container stopped, restore from the snapshot.

```bash
cd ~/freellmapi && docker compose stop
B=$(cat ~/backups/freellmapi-routes-latest.txt)
(cd "$B" && sha256sum -c --quiet SHA256SUMS)
VOL=$(docker volume inspect -f '{{.Mountpoint}}' freellmapi_freellmapi-data)
sudo rm -f "$VOL"/freeapi.db "$VOL"/freeapi.db-wal "$VOL"/freeapi.db-shm
sudo tar -C "$VOL" -xzf "$B/volume.tgz"
docker compose up -d --pull never
```

For image B the database restore is mandatory, because its migrations are forward-only. B's migrations between the running build and main:
`20260819_000001_custom_model_tombstones`, `20260823_000001_server_logs`, `20260823_000002_backups_table`, `20260823_000003_attempt_key_label`,
`20260823_000004_profile_auto_include`, `20260901_000001_idempotency_claims`, `20260901_000002_quota_observation_lookup`, `20260901_000003_request_caller`,
`20260902_000001_analytics_latency_percentile_index`, `20260903_000001_mcp_enabled_default`, `20260903_000002_response_cache`, `20260904_000001_key_monthly_budget`,
`20260913_000001_request_model_attribution`, `20260914_000001_key_monthly_usage`, `20260915_000001_quota_snapshot_freshness`, and an edit to `20260101_000000_legacy_baseline`.
The existing `~/homelab-config/freellmapi/rollback-v0.8.4.sh` is written for a different backup directory, so use the snapshot above instead.

## 8. Notes

- The swap restarts the process: in-memory state (escalation counters, leases, per-minute windows) resets, exactly as on any restart. The persisted cooldown table and usage ledger survive.
- The new image is local only (built on homelab, never pushed). Rebuild it from a branch commit with `git archive <sha> | ssh homelab 'tar -x -C <dir>'` then `docker build -t freellmapi-routes:<sha> --build-arg FREELLMAPI_COMMIT_SHA=<full sha> <dir>`.
- Image A reports the same `GET /v1/routes` contract as B (`schema_version` 1). It never returns `reason: monthly_budget_cap`, because v0.8.4 has no per-key monthly cap.
