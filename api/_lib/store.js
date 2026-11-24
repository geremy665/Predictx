// ═══════════════════════════════════════════════════════════════
// EDGE — api/_lib/store.js
// Mémoire permanente du serveur (Upstash Redis, via son API REST).
// Les variables sont créées automatiquement par Vercel quand on relie
// la base au projet : KV_REST_API_URL / KV_REST_API_TOKEN
// (ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// ═══════════════════════════════════════════════════════════════
const urlBase = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const jeton = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

function actif() { return !!(urlBase() && jeton()); }

async function cmd(args, delaiMs) {
  if (!actif()) throw new Error("base_absente");
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), delaiMs || 5000);
  try {
    const r = await fetch(urlBase(), {
      method: "POST",
      headers: { Authorization: "Bearer " + jeton(), "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: c.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error) throw new Error("redis: " + ((j && j.error) || r.status));
    return j.result;
  } finally { clearTimeout(t); }
}

async function getJSON(cle, delaiMs) {
  const v = await cmd(["GET", cle], delaiMs);
  if (v == null) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
async function setJSON(cle, val) { return cmd(["SET", cle, JSON.stringify(val)]); }

// Table clé → objet (un pari par champ)
async function lireTable(cle) {
  const plat = await cmd(["HGETALL", cle]);
  const out = {};
  if (Array.isArray(plat)) {
    for (let i = 0; i + 1 < plat.length; i += 2) {
      try { out[plat[i]] = JSON.parse(plat[i + 1]); } catch (e) {}
    }
  } else if (plat && typeof plat === "object") {
    Object.keys(plat).forEach(k => { try { out[k] = JSON.parse(plat[k]); } catch (e) {} });
  }
  return out;
}
async function ecrireTable(cle, objets) {
  const ids = Object.keys(objets || {});
  if (!ids.length) return 0;
  // Par paquets pour rester loin de la taille maximale d'une requête
  for (let i = 0; i < ids.length; i += 40) {
    const args = ["HSET", cle];
    ids.slice(i, i + 40).forEach(id => { args.push(id, JSON.stringify(objets[id])); });
    await cmd(args);
  }
  return ids.length;
}

module.exports = { actif, cmd, getJSON, setJSON, lireTable, ecrireTable };
