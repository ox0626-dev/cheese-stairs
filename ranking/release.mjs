import { writeFileSync } from 'node:fs';

const sql = `
CREATE TABLE profiles (
  nickname_key text PRIMARY KEY,
  nickname text NOT NULL,
  device_id uuid NOT NULL,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 2),
  best integer CHECK (best BETWEEN 0 AND 100000),
  achieved timestamptz,
  UNIQUE (device_id, slot)
);
CREATE INDEX profiles_best ON profiles (best DESC, achieved, nickname_key) WHERE best IS NOT NULL;
CREATE TABLE runs (
  id uuid PRIMARY KEY, nickname_key text NOT NULL REFERENCES profiles(nickname_key),
  started timestamptz NOT NULL DEFAULT now(), submitted boolean NOT NULL DEFAULT false
);
CREATE INDEX runs_started ON runs (started);
`;

async function ranking(request) {
  const nicknameLimit = 3;
  const { adminDb } = await import('@run402/functions');
  const origin = 'https://ox0626-dev.github.io';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
  const send = (data, status = 200) => Response.json(data, { status, headers });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.headers.has('Origin') && request.headers.get('Origin') !== origin) {
    return send({ error: 'invalid_origin' }, 403);
  }
  const route = new URL(request.url);
  const db = adminDb();
  const top = async () => (await db.sql(`
    SELECT nickname, best AS score FROM profiles WHERE best IS NOT NULL
    ORDER BY best DESC, achieved, nickname_key LIMIT 20
  `)).rows;
  const names = async (device) => (await db.sql(
    'SELECT nickname FROM profiles WHERE device_id = $1::uuid ORDER BY slot', [device]
  )).rows.map(row => row.nickname);

  try {
    if (request.method === 'GET' && route.searchParams.get('view') === 'top') {
      return send({ ranking: await top() });
    }
    let data = {};
    if (request.method === 'POST') {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 1024) return send({ error: 'invalid_action' }, 413);
      try { data = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return send({ error: 'invalid_action' }, 400); }
    }
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const device = data?.device || route.searchParams.get('device');
    if (typeof device !== 'string' || !uuid.test(device)) return send({ error: 'network_unavailable' }, 400);
    if (request.method === 'GET') return send({ nicknames: await names(device), nicknameLimit });
    if (request.method !== 'POST') return send({ error: 'invalid_method' }, 405);
    if (data.action === 'start') {
      const name = typeof data.nickname === 'string'
        ? data.nickname.normalize('NFKC').trim().replace(/ +/g, ' ') : '';
      if (!/^[\p{L}\p{N} _-]{1,16}$/u.test(name) || !/[\p{L}\p{N}]/u.test(name)) {
        return send({ error: 'invalid_nickname' }, 400);
      }
      const key = name.toLowerCase();
      const id = crypto.randomUUID();
      for (let attempt = 0; attempt < nicknameLimit; attempt++) {
        const claim = await db.sql(`
          INSERT INTO profiles (nickname_key, nickname, device_id, slot)
          SELECT $1, $2, $3::uuid, candidate.slot
          FROM generate_series(1, $4::integer) AS candidate(slot)
          WHERE NOT EXISTS (
            SELECT 1 FROM profiles WHERE device_id = $3::uuid AND profiles.slot = candidate.slot
          )
          ORDER BY candidate.slot LIMIT 1 ON CONFLICT DO NOTHING RETURNING nickname_key
        `, [key, name, device, nicknameLimit]);
        if (claim.rows.length) break;
      }
      const created = await db.sql(`
        INSERT INTO runs (id, nickname_key)
        SELECT $1::uuid, nickname_key FROM profiles WHERE nickname_key = $2 AND device_id = $3::uuid
        RETURNING id
      `, [id, key, device]);
      if (!created.rows.length) {
        const taken = await db.sql('SELECT 1 FROM profiles WHERE nickname_key = $1', [key]);
        return send({ error: taken.rows.length ? 'nickname_taken' : 'nickname_limit' }, 409);
      }
      return send({ id, nicknames: await names(device) });
    }
    if (data.action === 'finish') {
      if (typeof data.id !== 'string' || !uuid.test(data.id) || !Number.isInteger(data.score) ||
          data.score < 0 || data.score > 100000) return send({ error: 'invalid_score' }, 400);
      const result = await db.sql(`
        WITH claimed AS (
          UPDATE runs SET submitted = true
          FROM profiles WHERE id = $1::uuid AND profiles.nickname_key = runs.nickname_key
            AND profiles.device_id = $2::uuid AND NOT submitted
            AND started >= now() - interval '7 days'
            AND (EXTRACT(epoch FROM now() - started) * 10 + 2) >= $3::integer
          RETURNING runs.nickname_key
        ), updated AS (
          UPDATE profiles SET best = $3::integer, achieved = now()
          FROM claimed WHERE profiles.nickname_key = claimed.nickname_key
            AND (best IS NULL OR best < $3::integer)
          RETURNING best
        ) SELECT (SELECT count(*) FROM claimed)::integer AS accepted
      `, [data.id, device, data.score]);
      if (!result.rows[0]?.accepted) {
        const before = await db.sql(`SELECT submitted FROM runs JOIN profiles USING (nickname_key)
          WHERE id = $1::uuid AND device_id = $2::uuid AND started >= now() - interval '7 days'`, [data.id, device]);
        if (!before.rows[0]?.submitted) return send({ error: before.rows.length ? 'invalid_score' : 'run_expired' }, 409);
      }
      return send({ ranking: await top() });
    }
    return send({ error: 'invalid_action' }, 400);
  } catch {
    return send({ error: 'ranking_unavailable' }, 503);
  }
}

writeFileSync('run402.json', JSON.stringify({
  database: { migrations: [
    { id: '001_ranking', sql },
    { id: '002_three_nickname_slots', sql: `
      ALTER TABLE profiles
        DROP CONSTRAINT profiles_slot_check,
        ADD CONSTRAINT profiles_slot_check CHECK (slot BETWEEN 1 AND 3);
    ` }
  ] },
  functions: { replace: { ranking: {
    runtime: 'node22',
    source: 'export default ' + ranking.toString(),
    config: { timeout_seconds: 10, memory_mb: 128 }
  } } },
  site: { replace: { 'index.html': { data: '<meta http-equiv="refresh" content="0;url=https://ox0626-dev.github.io/cheese-stairs/">' } } },
  routes: { replace: [{ pattern: '/api/ranking', methods: ['GET', 'POST', 'OPTIONS'],
    target: { type: 'function', name: 'ranking' } }] },
  verify: { http: [{ id: 'ranking', path: '/api/ranking?view=top', expect: { status: 200 } }] }
}, null, 2));
