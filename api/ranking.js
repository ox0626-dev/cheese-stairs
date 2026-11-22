const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const { isIP } = require('node:net');

const origin = 'https://ox0626-dev.github.io';
const prefix = 'cheese-stairs:';
const ttl = 7 * 24 * 60 * 60;
const secretCandidate = randomBytes(32).toString('hex');

const loadSecret = `
  redis.call('SET', KEYS[1], ARGV[1], 'NX')
  return redis.call('GET', KEYS[1])
`;

const beginRun = `
  local owner = redis.call('HGET', KEYS[2], ARGV[1])
  if owner == ARGV[3] then
    if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
      return 'nickname_taken'
    end
  else
    if owner then return 'nickname_taken' end
    if redis.call('HLEN', KEYS[1]) >= 2 then return 'nickname_limit' end
    redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
    redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
    redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
  end
  redis.call('SET', KEYS[4], ARGV[1] .. ':' .. ARGV[4], 'EX', ARGV[5])
  return 'ok'
`;

const finishRun = `
  local run = redis.call('GET', KEYS[1])
  if not run then return 'run_expired' end
  if run == 'submitted' then return 'ok' end
  local split = string.find(run, ':', 1, true)
  local started = tonumber(string.sub(run, split + 1))
  local score = tonumber(ARGV[1])
  if score > math.floor((tonumber(ARGV[2]) - started) / 100) + 2 then
    return 'invalid_score'
  end
  local nickname = string.sub(run, 1, split - 1)
  redis.call('ZADD', KEYS[2], 'GT', score, nickname)
  redis.call('SET', KEYS[1], 'submitted', 'EX', ARGV[3])
  return 'ok'
`;

const topScores = `
  local scores = redis.call('ZREVRANGE', KEYS[1], 0, 19, 'WITHSCORES')
  local entries = {}
  for index = 1, #scores, 2 do
    local name = redis.call('HGET', KEYS[2], scores[index])
    if name then
      table.insert(entries, {name, tonumber(scores[index + 1])})
    end
  end
  return entries
`;

async function redis(...command) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Ranking database is unavailable');
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Ranking database request failed');
  return data.result;
}

let secret;
async function networkKey(req) {
  const ip = req.headers['x-vercel-forwarded-for'];
  if (typeof ip !== 'string' || !isIP(ip)) return null;
  secret ||= await redis('EVAL', loadSecret, 1, prefix + 'secret', secretCandidate);
  const normalized = isIP(ip) === 6 ? new URL('http://[' + ip + ']').hostname : ip;
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

async function ranking() {
  const entries = await redis('EVAL', topScores, 2, prefix + 'scores', prefix + 'names');
  return entries.map(([nickname, score]) => ({ nickname, score }));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.headers.origin && req.headers.origin !== origin) {
    return res.status(403).json({ error: 'invalid_origin' });
  }

  try {
    if (req.method === 'GET' && req.query.view === 'top') {
      return res.json({ ranking: await ranking() });
    }
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    const network = await networkKey(req);
    if (!network) return res.status(400).json({ error: 'network_unavailable' });
    const profiles = prefix + 'profiles:' + network;
    const runKey = (id) => prefix + 'runs:' + network + ':' + id;

    if (req.method === 'GET') {
      const nicknames = await redis('HVALS', profiles);
      return res.json({ nicknames });
    }

    const body = req.body;
    if (body?.action === 'start') {
      const nickname = typeof body.nickname === 'string'
        ? body.nickname.normalize('NFKC').trim().replace(/ +/g, ' ')
        : '';
      if (!/^[\p{L}\p{N} _-]{1,16}$/u.test(nickname) || !/[\p{L}\p{N}]/u.test(nickname)) {
        return res.status(400).json({ error: 'invalid_nickname' });
      }
      const id = randomUUID();
      const result = await redis('EVAL', beginRun, 4,
        profiles, prefix + 'owners', prefix + 'names', runKey(id),
        nickname.toLowerCase(), nickname, network, String(Date.now()), String(ttl));
      if (result !== 'ok') return res.status(409).json({ error: result });
      const nicknames = await redis('HVALS', profiles);
      return res.json({ id, nicknames });
    }

    if (body?.action === 'finish') {
      if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id) ||
          !Number.isInteger(body.score) || body.score < 0 || body.score > 100000) {
        return res.status(400).json({ error: 'invalid_score' });
      }
      const result = await redis('EVAL', finishRun, 2,
        runKey(body.id), prefix + 'scores', String(body.score), String(Date.now()), String(ttl));
      if (result !== 'ok') return res.status(409).json({ error: result });
      return res.json({ ranking: await ranking() });
    }

    return res.status(400).json({ error: 'invalid_action' });
  } catch {
    return res.status(503).json({ error: 'ranking_unavailable' });
  }
};
