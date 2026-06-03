// Upstream model scanner: lists each provider's live models, diffs vs catalog.
// Writes { upstream: { generatedAt, providers:[{platform, newModels[], goneModels[], note}] } }
// merged into server/data/model-status.json. Run after probe (daily cron).
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const ROOT = '/opt/freellmapi';
const DB = `${ROOT}/server/data/freeapi.db`;
const OUT = `${ROOT}/server/data/model-status.json`;

// Load ENCRYPTION_KEY into env BEFORE importing crypto (crypto.js captures it at module load).
for (const line of readFileSync(`${ROOT}/.env`, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const { decrypt, initEncryptionKey } = await import('../server/dist/lib/crypto.js');

const db = new Database(DB, { readonly: true });
initEncryptionKey(db); // uses process.env.ENCRYPTION_KEY (set above); no DB write when env present

function firstKey(platform) {
  const row = db.prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform=? AND enabled=1 ORDER BY id LIMIT 1"
  ).get(platform);
  if (!row) return null;
  try { return decrypt(row.encrypted_key, row.iv, row.auth_tag); } catch { return null; }
}
function catalogIds(platform) {
  return new Set(
    db.prepare("SELECT model_id FROM models WHERE platform=? AND enabled=1").all(platform)
      .map((r) => r.model_id)
  );
}

async function listUpstream(platform, key) {
  const t = 15000;
  const ac = () => { const c = new AbortController(); setTimeout(() => c.abort(), t); return c.signal; };
  try {
    if (platform === 'google') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { signal: ac() });
      if (!r.ok) return { err: `HTTP ${r.status}` };
      const j = await r.json();
      return { ids: (j.models || []).map((m) => (m.name || '').replace(/^models\//, '')) };
    }
    const base = {
      groq: 'https://api.groq.com/openai/v1/models',
      cerebras: 'https://api.cerebras.ai/v1/models',
      mistral: 'https://api.mistral.ai/v1/models',
      openrouter: 'https://openrouter.ai/api/v1/models',
      sambanova: 'https://api.sambanova.ai/v1/models',
      cohere: 'https://api.cohere.com/v1/models',
    }[platform];
    if (!base) return { err: 'no upstream list endpoint' };
    const r = await fetch(base, { headers: { Authorization: `Bearer ${key}` }, signal: ac() });
    if (!r.ok) return { err: `HTTP ${r.status}` };
    const j = await r.json();
    const arr = j.data || j.models || [];
    return { ids: arr.map((m) => m.id || m.name).filter(Boolean) };
  } catch (e) {
    return { err: String(e).slice(0, 80) };
  }
}

const PLATFORMS = ['groq', 'cerebras', 'mistral', 'openrouter', 'sambanova', 'cohere', 'google'];
const providers = [];
for (const p of PLATFORMS) {
  const key = firstKey(p);
  if (!key) { providers.push({ platform: p, note: 'no key', newModels: [], goneModels: [] }); continue; }
  const up = await listUpstream(p, key);
  if (up.err) { providers.push({ platform: p, note: up.err, newModels: [], goneModels: [] }); continue; }
  const cat = catalogIds(p);
  const live = new Set(up.ids);
  const newModels = [...live].filter((id) => !cat.has(id)).slice(0, 100);
  const goneModels = [...cat].filter((id) => !live.has(id));
  providers.push({ platform: p, note: '', upstreamCount: live.size, catalogCount: cat.size, newModels, goneModels });
}

let base = { generatedAt: null, ok: 0, fail: 0, total: 0, results: [] };
if (existsSync(OUT)) { try { base = JSON.parse(readFileSync(OUT, 'utf8')); } catch {} }
base.upstream = { generatedAt: new Date().toISOString(), providers };
writeFileSync(OUT, JSON.stringify(base, null, 1));
console.log('upstream-scan done:',
  providers.map((p) => `${p.platform}:+${p.newModels.length}/-${p.goneModels.length}`).join(' '));
