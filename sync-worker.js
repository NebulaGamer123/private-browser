// Shared search-history backend for private-browser (Cloudflare Worker + D1).
// Free-tier friendly. See the setup steps below.
//
// SETUP (Cloudflare dashboard):
//   1. Storage & Databases > D1 > Create database (any name, e.g. "private-browser").
//   2. Workers & Pages > Create > Create Worker > Deploy, then "Edit code" and
//      paste this whole file in, then Deploy.
//   3. Worker > Settings > Bindings > Add > D1 database:
//        Variable name:  DB          (must be exactly DB)
//        Database:       the one from step 1
//   4. Worker > Settings > Variables and Secrets > Add:
//        Type: Secret, Name: API_KEY, Value: any long random string you make up
//   5. In the browser (each device): Settings > Cloud sync for searches > on,
//      Sync API URL = your worker URL (https://<name>.<you>.workers.dev),
//      Sync API Key = the same API_KEY value.
//
// The table is created automatically on the first request.
//
// API (all requests need the header  Authorization: Bearer <API_KEY>):
//   POST   /sync            body { searches: [{ id, query, url, timestamp, deviceId, deviceName }] }
//   GET    /sync?limit=N    -> { searches: [...] }   newest first, N up to 1000
//   DELETE /sync?id=ID      delete one search
//   DELETE /sync?all=1      delete everything

let schemaReady = null;

function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .batch([
        db.prepare(
          'CREATE TABLE IF NOT EXISTS searches (' +
            'id TEXT PRIMARY KEY, ' +
            'query TEXT NOT NULL, ' +
            'url TEXT, ' +
            'timestamp TEXT NOT NULL, ' +
            'device_id TEXT NOT NULL, ' +
            'device_name TEXT)'
        ),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_searches_timestamp ON searches (timestamp)')
      ])
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Constant-time string comparison so the key can't be guessed byte by byte.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (!env.API_KEY) return json({ error: 'API_KEY secret is not set on the worker' }, 500);
    if (!env.DB) return json({ error: 'D1 binding named DB is missing' }, 500);

    const auth = request.headers.get('Authorization') || '';
    if (!safeEqual(auth, `Bearer ${env.API_KEY}`)) return json({ error: 'Unauthorized' }, 401);

    const url = new URL(request.url);
    if (url.pathname.replace(/\/+$/, '') !== '/sync') return json({ error: 'Not found' }, 404);

    try {
      await ensureSchema(env.DB);

      if (request.method === 'POST') {
        const body = await request.json();
        const incoming = Array.isArray(body && body.searches) ? body.searches.slice(0, 200) : [];
        const valid = incoming.filter(
          (s) =>
            s &&
            typeof s.id === 'string' &&
            typeof s.query === 'string' &&
            typeof s.timestamp === 'string' &&
            typeof s.deviceId === 'string'
        );
        if (valid.length === 0) return json({ ok: true, stored: 0 });

        const insert = env.DB.prepare(
          'INSERT OR IGNORE INTO searches (id, query, url, timestamp, device_id, device_name) ' +
            'VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        );
        await env.DB.batch(
          valid.map((s) =>
            insert.bind(
              s.id.slice(0, 80),
              s.query.slice(0, 500),
              String(s.url || '').slice(0, 1000),
              s.timestamp.slice(0, 40),
              s.deviceId.slice(0, 80),
              String(s.deviceName || '').slice(0, 80)
            )
          )
        );
        return json({ ok: true, stored: valid.length });
      }

      if (request.method === 'GET') {
        const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 500));
        const { results } = await env.DB.prepare(
          'SELECT id, query, url, timestamp, device_id AS deviceId, device_name AS deviceName ' +
            'FROM searches ORDER BY timestamp DESC LIMIT ?1'
        )
          .bind(limit)
          .all();
        return json({ searches: results });
      }

      if (request.method === 'DELETE') {
        if (url.searchParams.get('all') === '1') {
          await env.DB.prepare('DELETE FROM searches').run();
          return json({ ok: true });
        }
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'Missing id' }, 400);
        await env.DB.prepare('DELETE FROM searches WHERE id = ?1').bind(id).run();
        return json({ ok: true });
      }

      return json({ error: 'Method not allowed' }, 405);
    } catch (err) {
      return json({ error: err.message || 'Server error' }, 500);
    }
  }
};
