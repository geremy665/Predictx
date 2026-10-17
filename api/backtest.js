// api/backtest.js — le labo de backtest d'Alphie
// Moteur : teste une stratégie décrite en JSON sur des années d'historique (plateformes crypto ou Yahoo), avec frais,
// la valide sur une période « hors échantillon » pour détecter la sur-optimisation, et la compare au hasard.
// Site : POST { password, action: "lire" } → historique des backtests.

const KEY = "alphie:backtests";
let _core = null;
const core = () => _core || (_core = require("./chat.js")._core);

// ---------- Données ----------
const CRYPTO_Y = { BTC: "BTC-USD", BITCOIN: "BTC-USD", ETH: "ETH-USD", ETHEREUM: "ETH-USD", SOL: "SOL-USD", SOLANA: "SOL-USD", XRP: "XRP-USD", RIPPLE: "XRP-USD", DOGE: "DOGE-USD", ADA: "ADA-USD", AVAX: "AVAX-USD", LINK: "LINK-USD", BNB: "BNB-USD", LTC: "LTC-USD", DOT: "DOT-USD" };
const UNITES = { "1m": ["1m", "7d"], "5m": ["5m", "60d"], "15m": ["15m", "60d"], "1h": ["60m", "730d"], "4h": ["60m", "730d"], "1j": ["1d", "10y"], "1s": ["1wk", "15y"] };

async function symbole(actif) {
  const a = String(actif || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (CRYPTO_Y[a]) return CRYPTO_Y[a];
  const y = await core().resolveYahoo(actif);
  if (y) return y;
  if (/^[A-Z0-9]{2,8}$/.test(a)) return a + "-USD";
  throw new Error("actif introuvable : " + actif);
}

// ---------- Cryptos : données gratuites des plateformes, sur plusieurs années ----------
// Yahoo ne donne que 60 jours en 15 min et 2 ans en 1 h. Les plateformes donnent des années, sans clé.
// Ordre d'essai : Binance (données publiques), Binance, Binance US (serveurs américains), Coinbase. Sinon : Yahoo.
const EX = {   // unité : [intervalle Binance, durée d'une bougie en ms, jours visés Binance, granularité Coinbase (s), jours visés Coinbase, regroupement]
  "1m": ["1m", 60e3, 30, 60, 7, 1],
  "5m": ["5m", 300e3, 180, 300, 60, 1],
  "15m": ["15m", 900e3, 730, 900, 365, 1],
  "1h": ["1h", 3600e3, 1825, 3600, 1095, 1],
  "4h": ["4h", 14400e3, 2190, 3600, 1095, 4],
};

function baseCrypto(sym) {
  const m = /^([A-Z0-9]{2,10})-USD$/.exec(sym || "");
  return m ? m[1] : null;
}

// Télécharge des fenêtres de temps en parallèle, de la plus récente à la plus ancienne.
// Si une fenêtre échoue deux fois, on garde la partie récente déjà complète (historique continu).
async function paginer(fenetres, parallele, f, budgetMs) {
  const t0 = Date.now(), res = new Array(fenetres.length);
  let fin = fenetres.length;
  if (!fin) return [];
  res[0] = await f(fenetres[0], true);   // sonde : une seule fenêtre d'abord, pour abandonner vite une source bloquée
  for (let k = 1; k < fenetres.length && k < fin; k += parallele) {
    if (k > 0 && Date.now() - t0 > budgetMs) { fin = k; break; }
    const lot = fenetres.slice(k, k + parallele);
    const out = await Promise.all(lot.map(async (w) => {
      try { return await f(w); } catch (e) {
        await new Promise((r) => setTimeout(r, 700));
        try { return await f(w); } catch (e2) { return e2; }
      }
    }));
    for (let x = 0; x < out.length; x++) {
      if (out[x] instanceof Error) {
        fin = Math.min(fin, k + x); break;
      }
      res[k + x] = out[x];
    }
  }
  const vu = new Set(), c = [];
  for (let k = 0; k < fin; k++) for (const b of res[k] || []) if (!vu.has(b.t) && [b.o, b.h, b.l, b.c].every(Number.isFinite)) { vu.add(b.t); c.push(b); }
  return c.sort((a, b) => a.t - b.t);
}

function fenetres(depuis, fin, pas) {
  const w = [];
  for (let b = fin; b > depuis; b -= pas) w.push([Math.max(depuis, b - pas), b - 1]);
  return w;   // de la plus récente à la plus ancienne
}

async function klinesBinance(host, base, unite) {
  const [iv, ms, jours] = EX[unite], fin = Date.now(), depuis = fin - jours * 86400e3;
  return paginer(fenetres(depuis, fin, 1000 * ms), 10, async ([a, b], sonde) => {
    const d = await core().fetchJSON(`${host}/api/v3/klines?symbol=${base}USDT&interval=${iv}&startTime=${a}&endTime=${b}&limit=1000`, sonde ? 6000 : 9000);
    if (!Array.isArray(d)) throw new Error("réponse inattendue");
    return d.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  }, 22000);
}

async function candlesCoinbase(base, unite) {
  const [, , , gran, jours, grp] = EX[unite], fin = Date.now(), depuis = fin - jours * 86400e3;
  const c = await paginer(fenetres(depuis, fin, 300 * gran * 1000), 4, async ([a, b], sonde) => {
    const d = await core().fetchJSON(`https://api.exchange.coinbase.com/products/${base}-USD/candles?granularity=${gran}&start=${new Date(a).toISOString()}&end=${new Date(b).toISOString()}`, sonde ? 6000 : 9000);
    if (!Array.isArray(d)) throw new Error("réponse inattendue");
    return d.map((k) => ({ t: k[0] * 1000, l: +k[1], h: +k[2], o: +k[3], c: +k[4], v: +k[5] }));
  }, 22000);
  return grp > 1 ? regrouperUTC(c, grp * gran * 1000) : c;
}

// Regroupe des bougies sur des créneaux UTC fixes (ex. 4 h : 0 h, 4 h, 8 h…)
function regrouperUTC(c, pas) {
  const out = [];
  for (const b of c) {
    const t = Math.floor(b.t / pas) * pas, d = out[out.length - 1];
    if (d && d.t === t) { d.h = Math.max(d.h, b.h); d.l = Math.min(d.l, b.l); d.c = b.c; d.v += b.v; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

const SOURCES_CRYPTO = [
  ["Binance", (b, u) => klinesBinance("https://data-api.binance.vision", b, u)],
  ["Binance", (b, u) => klinesBinance("https://api.binance.com", b, u)],
  ["Binance US", (b, u) => klinesBinance("https://api.binance.us", b, u)],
  ["Coinbase", (b, u) => candlesCoinbase(b, u)],
];

async function bougiesPlateformes(base, unite) {
  const erreurs = [], t0 = Date.now();
  for (const [nom, f] of SOURCES_CRYPTO) {
    if (Date.now() - t0 > 30000) { erreurs.push("délai dépassé"); break; }
    try {
      const c = await f(base, unite);
      if (c.length >= 300) return { meta: { shortName: base + "/USD" }, c, source: nom, detail: nom + " : " + c.length + " bougies" };
      erreurs.push(nom + " : " + c.length + " bougies");
    } catch (e) { erreurs.push(nom + " : " + e.message); }
  }
  throw new Error(erreurs.join(" ; "));
}

// ---------- Forex, or, indices : historique Dukascopy (banque suisse), gratuit et sans inscription ----------
// Fichiers mensuels de bougies 1 h, compressés en LZMA (« .bi5 ») : on les décompresse ici, sans dépendance.
// Décodeur écrit d'après la spécification de référence LZMA (LzmaSpec, Igor Pavlov).
function lzmaDecode(src) {
  if (src.length < 13) throw new Error("fichier LZMA trop court");
  let d = src[0];
  if (d >= 225) throw new Error("en-tête LZMA invalide");
  const lc = d % 9; d = (d / 9) | 0; const lp = d % 5, pb = (d / 5) | 0;
  let dictSize = 0; for (let k = 0; k < 4; k++) dictSize += src[1 + k] * 2 ** (8 * k);
  if (dictSize < 4096) dictSize = 4096;
  let taille = 0, connue = false;
  for (let k = 0; k < 8; k++) if (src[5 + k] !== 0xff) connue = true;
  if (connue) for (let k = 0; k < 8; k++) taille += src[5 + k] * 2 ** (8 * k);
  let ip = 13;
  const lire = () => { if (ip >= src.length) throw new Error("données LZMA tronquées"); return src[ip++]; };
  // décodeur d'intervalle
  if (lire() !== 0) throw new Error("flux LZMA invalide");
  let range = 0xffffffff, code = 0;
  for (let k = 0; k < 4; k++) code = ((code << 8) | lire()) >>> 0;
  if (code === range) throw new Error("flux LZMA invalide");
  const normaliser = () => { if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | lire()) >>> 0; } };
  const bit = (p, k) => {
    const v = p[k], borne = (range >>> 11) * v;
    if (code < borne) { p[k] = v + ((2048 - v) >>> 5); range = borne; normaliser(); return 0; }
    p[k] = v - (v >>> 5); code = (code - borne) >>> 0; range = (range - borne) >>> 0; normaliser(); return 1;
  };
  const directs = (n) => { let r = 0; for (; n > 0; n--) { range = range >>> 1; code = (code - range) >>> 0; const t = 0 - (code >>> 31); code = (code + (range & t)) >>> 0; r = ((r << 1) + (t + 1)) >>> 0; normaliser(); } return r; };
  const arbre = (p, base, n) => { let m = 1; for (let k = 0; k < n; k++) m = (m << 1) + bit(p, base + m); return m - (1 << n); };
  const arbreInverse = (p, base, n) => { let m = 1, s = 0; for (let k = 0; k < n; k++) { const b = bit(p, base + m); m = (m << 1) + b; s |= b << k; } return s; };
  const P = (n) => new Uint16Array(n).fill(1024);
  const lit = P(0x300 << (lc + lp)), estMatch = P(192), estRep = P(12), estRepG0 = P(12), estRepG1 = P(12), estRepG2 = P(12), estRep0Long = P(192);
  const posSlot = P(4 << 6), posDec = P(115), align = P(16);
  const longueur = () => ({ choix: P(2), bas: P(16 << 3), milieu: P(16 << 3), haut: P(256) });
  const lenDec = longueur(), repLenDec = longueur();
  const lireLong = (L, ps) => { if (bit(L.choix, 0) === 0) return arbre(L.bas, ps << 3, 3); if (bit(L.choix, 1) === 0) return 8 + arbre(L.milieu, ps << 3, 3); return 16 + arbre(L.haut, 0, 8); };
  // fenêtre de sortie (fichiers petits : on garde tout en mémoire)
  let out = new Uint8Array(connue ? taille : 1 << 16), pos = 0;
  const mettre = (b) => { if (pos >= out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; } out[pos++] = b; };
  let etat = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  const pbMasque = (1 << pb) - 1, lpMasque = (1 << lp) - 1;
  for (;;) {
    if (connue && pos >= taille) break;
    if (!connue && ip >= src.length && code === 0) break;
    const ps = pos & pbMasque;
    if (bit(estMatch, (etat << 4) + ps) === 0) {
      const prec = pos > 0 ? out[pos - 1] : 0, base = 0x300 * (((pos & lpMasque) << lc) + (prec >>> (8 - lc)));
      let s = 1;
      if (etat >= 7) {
        let mb = out[pos - rep0 - 1];
        do { const m = (mb >>> 7) & 1; mb <<= 1; const b = bit(lit, base + ((1 + m) << 8) + s); s = (s << 1) | b; if (m !== b) break; } while (s < 0x100);
      }
      while (s < 0x100) s = (s << 1) | bit(lit, base + s);
      mettre(s - 0x100);
      etat = etat < 4 ? 0 : etat < 10 ? etat - 3 : etat - 6;
      continue;
    }
    let len;
    if (bit(estRep, etat) !== 0) {
      if (pos === 0) throw new Error("flux LZMA invalide");
      if (bit(estRepG0, etat) === 0) {
        if (bit(estRep0Long, (etat << 4) + ps) === 0) { etat = etat < 7 ? 9 : 11; mettre(out[pos - rep0 - 1]); continue; }
      } else {
        let dist;
        if (bit(estRepG1, etat) === 0) dist = rep1;
        else { if (bit(estRepG2, etat) === 0) dist = rep2; else { dist = rep3; rep3 = rep2; } rep2 = rep1; }
        rep1 = rep0; rep0 = dist;
      }
      len = lireLong(repLenDec, ps); etat = etat < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = lireLong(lenDec, ps); etat = etat < 7 ? 7 : 10;
      const ls = len > 3 ? 3 : len, slot = arbre(posSlot, ls << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const nb = (slot >>> 1) - 1;
        let dist = ((2 | (slot & 1)) << nb) >>> 0;
        if (slot < 14) dist = (dist + arbreInverse(posDec, dist - slot, nb)) >>> 0;
        else dist = (dist + ((directs(nb - 4) << 4) >>> 0) + arbreInverse(align, 0, 4)) >>> 0;
        rep0 = dist;
      }
      if (rep0 === 0xffffffff) break;   // marqueur de fin
      if (rep0 >= pos) throw new Error("distance LZMA invalide");
    }
    len += 2;
    if (connue && pos + len > taille) throw new Error("données LZMA trop longues");
    for (let k = 0; k < len; k++) mettre(out[pos - rep0 - 1]);
  }
  return out.subarray(0, pos);
}

// Nom Dukascopy à partir du symbole Yahoo du Labo
const DK_NOMS = { "GC=F": "XAUUSD", "SI=F": "XAGUSD", "^NDX": "USATECHIDXUSD", "^GSPC": "USA500IDXUSD", "^DJI": "USA30IDXUSD", "^GDAXI": "DEUIDXEUR", "^FCHI": "FRAIDXEUR", "CL=F": "LIGHTCMDUSD", "BZ=F": "BRENTCMDUSD", "HG=F": "COPPERCMDUSD", "^N225": "JPNIDXJPY" };
function nomDukascopy(sym) {
  if (DK_NOMS[sym]) return DK_NOMS[sym];
  const m = /^([A-Z]{6})=X$/.exec(sym || "");
  return m ? m[1] : null;
}
// Facteur de prix par défaut (vérifié ensuite par rapport au prix Yahoo)
const facteurDefaut = (nom) => (/JPY/.test(nom) || /^X(AU|AG)/.test(nom) || /IDX|CMD/.test(nom) ? 1000 : 100000);

// Bougies d'un fichier : 24 octets chacune (temps en s depuis le début du mois, ouverture, clôture, bas, haut, volume)
function lireBougies(bytes, debutMs) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), n = Math.floor(bytes.byteLength / 24), out = [];
  for (let k = 0; k < n; k++) {
    const o = k * 24;
    out.push({ t: debutMs + v.getInt32(o) * 1000, a: v.getInt32(o + 4), b: v.getInt32(o + 8), c: v.getInt32(o + 12), d: v.getInt32(o + 16), v: v.getFloat32(o + 20) });
  }
  return out;
}
// Ordre des prix : on vérifie l'ordre documenté (ouverture, clôture, bas, haut) ; sinon (ouverture, haut, bas, clôture)
function ordonner(brut) {
  const okA = brut.filter((x) => x.c <= Math.min(x.a, x.b) && x.d >= Math.max(x.a, x.b)).length;
  const okB = brut.filter((x) => x.c <= Math.min(x.a, x.d) && x.b >= Math.max(x.a, x.d)).length;
  return okA >= okB ? brut.map((x) => ({ t: x.t, o: x.a, c: x.b, l: x.c, h: x.d, v: x.v })) : brut.map((x) => ({ t: x.t, o: x.a, h: x.b, l: x.c, c: x.d, v: x.v }));
}

// Dukascopy refuse les serveurs de Vercel (vérifié le 06/10/2026 : le téléphone de Geremy télécharge, Vercel n'obtient rien).
// Si DUKASCOPY_RELAIS est réglé dans Vercel, les fichiers passent par le relais Cloudflare d'Alphie, protégé par la clé cron.
function duka(chemin) {
  const relais = (process.env.DUKASCOPY_RELAIS || "").trim().replace(/\/+$/, "");
  return relais ? relais + chemin + "?k=" + encodeURIComponent((process.env.CRON_SECRET || "").trim()) : "https://datafeed.dukascopy.com" + chemin;
}
const routeDuka = () => ((process.env.DUKASCOPY_RELAIS || "").trim() ? "relais Cloudflare" : "direct");
// message d'erreur avec sa vraie cause (« fetch failed » seul ne dit rien)
const msgErr = (e) => e.message + (e.cause && (e.cause.code || e.cause.message) ? " : " + (e.cause.code || e.cause.message) : "");

async function telecharger(url, ms) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms || 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (r.status === 404) return null;   // mois sans données (futur, ou trop ancien)
    if (!r.ok) { const t = (await r.text().catch(() => "")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60); throw new Error("HTTP " + r.status + (t ? " (" + t + ")" : "")); }
    return new Uint8Array(await r.arrayBuffer());
  } finally { clearTimeout(to); }
}

// Ordre de remplissage : d'abord les marchés qu'Alphie trade en direct (dont la livre-dollar), puis ceux du rejeu (DAX, S&P 500, argent),
// puis ceux qui ne servent qu'aux tests du Labo ; dans chaque groupe, la réserve la plus proche d'être complète ; les complètes en dernier.
// Avant le 16/10, seul « le plus proche d'être complet » comptait : quand Dukascopy n'accepte que quelques mois par jour,
// la livre-dollar (la moins avancée) n'avait jamais son tour (0/121 après plusieurs jours).
const RESERVE_DIRECT = ["XAUUSD", "USATECHIDXUSD", "EURUSD", "GBPUSD"];
const prioriteReserve = (nom) => (RESERVE_DIRECT.includes(nom) ? 0 : Object.values(DK_REJEU).includes(nom) ? 1 : 2);
const ordreReserve = (liste, manques) => liste.map((n, k) => ({ n, m: manques[k] }))
  .sort((a, b) => (a.m === 0) - (b.m === 0) || prioriteReserve(a.n) - prioriteReserve(b.n) || a.m - b.m || (a.n < b.n ? -1 : 1)).map((x) => x.n);
// ===== Réserve cTrader : les prix de FTMO, pour les marchés que Dukascopy ne livre pas =====
// Depuis que le pont FTMO est relié (17/10), Alphie peut demander l'historique des prix au courtier lui-même : bougies d'une heure,
// mois par mois, gardées dans Redis (un champ par mois, compressé). Dukascopy reste la source tant que sa réserve est complète ;
// cTrader prend le relais pour les marchés où elle ne l'est pas (livre-dollar, DAX, S&P 500, argent…), avec les vrais prix de FTMO.
const zlib = require("zlib");
const CLE_CT = (nom) => "alphie:ct:" + nom;
const CT_SOURCES = { pont: null };   // remplaçable dans les tests
const pontLib = () => { if (CT_SOURCES.pont) return CT_SOURCES.pont; try { return require("../lib/ctrader.js"); } catch (e) { return null; } };
const MOIS_CT = () => moisDK(12);   // 12 ans : les 10 ans du rejeu, plus l'échauffement des moyennes
const finDuMois = (m) => Date.UTC(m[0], m[1] + 1, 1) - 1;
const PRIX_CT = 100000;   // l'Open API donne les prix en 1/100 000
const encCT = (rows) => (rows && rows.length ? zlib.deflateSync(Buffer.from(JSON.stringify(rows))).toString("base64") : "-");
const decCT = (v) => (v && v !== "-" ? JSON.parse(zlib.inflateSync(Buffer.from(v, "base64")).toString()) : []);
async function metaCT(nom) { try { const r = await core().redis(["HGET", CLE_CT(nom), "_meta"]); return r ? JSON.parse(r) : {}; } catch (e) { return {}; } }
const avantHistoireCT = (meta, m) => !!(meta.fin_histoire && meta.debut && finDuMois(m) < meta.debut);
// Complète la réserve cTrader des marchés où Dukascopy manque, jusqu'à l'heure « finAvant ». Du mois le plus récent au plus ancien ;
// quand 3 mois d'affilée reviennent vides avant les premières bougies, on a atteint le début de l'historique de FTMO.
async function remplirCT(finAvant) {
  const P = pontLib(); if (!P || !P.historiqueH1) return { info: "pont FTMO absent" };
  const liste = instrumentsCampagne(), manques = await Promise.all(liste.map((n) => manquantsReserve(n).catch(() => 0)));
  const cibles = ordreReserve(liste, manques).filter((n) => manques[liste.indexOf(n)] > RESERVE_MANQUE_MAX);
  if (!cibles.length) return { info: "réserve Dukascopy complète" };
  const mois = MOIS_CT(), now = Date.now(), demandes = [], metas = {};
  for (const nom of cibles) {
    const meta = (metas[nom] = await metaCT(nom));
    if (meta.introuvable && now - (meta.maj || 0) < 7 * J_MS) continue;
    let present = new Set(); try { present = new Set((await core().redis(["HKEYS", CLE_CT(nom)])) || []); } catch (e) {}
    const aFaire = mois.filter((m) => {
      const ch = nomMoisDK(m);
      if (m[2] > now || avantHistoireCT(meta, m)) return false;
      if (!present.has(ch)) return true;
      return finDuMois(m) > now - 2 * J_MS && now - ((meta.recents || {})[ch] || 0) > 6 * 3600000;   // mois en cours : rafraîchi toutes les 6 heures
    });
    if (aFaire.length) demandes.push({ nom, mois: aFaire.map((m) => [m[2], finDuMois(m), nomMoisDK(m)]) });
  }
  if (!demandes.length) return { info: "réserve cTrader à jour" };
  let res; try { res = await P.historiqueH1(core().redis, demandes, finAvant); } catch (e) { return { erreur: e.message }; }
  const bilan = {};
  for (const d of demandes) {
    const r = res[d.nom]; if (!r) continue;
    const meta = metas[d.nom]; meta.maj = now;
    if (r.introuvable) { meta.introuvable = true; await core().redis(["HSET", CLE_CT(d.nom), "_meta", JSON.stringify(meta)]).catch(() => {}); bilan[d.nom] = "absent chez FTMO"; continue; }
    delete meta.introuvable; meta.symbole = r.symbole; meta.recents = meta.recents || {};
    let n = 0;
    for (const [de, a, cle] of d.mois) {
      if (!(cle in r.mois)) break;
      const rows = r.mois[cle];
      await core().redis(["HSET", CLE_CT(d.nom), cle, encCT(rows)]).catch(() => {});
      n++;
      if (a > now - 2 * J_MS) meta.recents[cle] = now;
      if (rows.length) { meta.debut = Math.min(meta.debut || Infinity, de); meta.vides = 0; }
      else if (meta.debut && de < meta.debut) { meta.vides = (meta.vides || 0) + 1; if (meta.vides >= 3) meta.fin_histoire = true; }
    }
    for (const k of Object.keys(meta.recents)) if (now - meta.recents[k] > 40 * J_MS) delete meta.recents[k];
    await core().redis(["HSET", CLE_CT(d.nom), "_meta", JSON.stringify(meta)]).catch(() => {});
    bilan[d.nom] = (meta.symbole || "") + " : " + n + " mois reçus" + (r.erreur ? " (arrêt : " + r.erreur + ")" : "") + (meta.fin_histoire ? ", historique FTMO complet depuis " + new Date(meta.debut).toISOString().slice(0, 7) : "");
  }
  return bilan;
}
// Bougies d'une heure de la réserve cTrader entre « de » et « a » (marché en attente si plus de 2 mois manquent)
async function lireCT(nom, de, a) {
  const meta = await metaCT(nom);
  if (meta.introuvable) { const e = new Error("marché absent chez FTMO"); e.attente = true; throw e; }
  const mois = [];
  for (let d = new Date(Date.UTC(new Date(de).getUTCFullYear(), new Date(de).getUTCMonth(), 1)); d.getTime() <= a; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) mois.push([d.getUTCFullYear(), d.getUTCMonth(), d.getTime()]);
  const champs = mois.map(nomMoisDK), vals = {};
  for (let i = 0; i < champs.length; i += 20) { const part = champs.slice(i, i + 20), v = (await core().redis(["HMGET", CLE_CT(nom)].concat(part))) || []; part.forEach((ch, k) => { vals[ch] = v[k] == null ? null : v[k]; }); }
  const manquants = mois.filter((m, k) => vals[champs[k]] == null && !avantHistoireCT(meta, m) && Date.now() - m[2] >= RECENT_MS);
  if (manquants.length > 2) { const e = new Error("prix FTMO (cTrader) : " + manquants.length + " mois pas encore récupérés"); e.attente = true; throw e; }
  const c = [], vu = new Set();
  for (const ch of champs) for (const r of decCT(vals[ch])) { const t = r[0] * 60000; if (t < de || t > a || vu.has(t) || !(r[2] >= r[3])) continue; vu.add(t); c.push({ t, o: r[1] / PRIX_CT, h: r[2] / PRIX_CT, l: r[3] / PRIX_CT, c: r[4] / PRIX_CT, v: r[5] }); }
  return c.sort((x, y) => x.t - y.t);
}
// La réserve cTrader couvre-t-elle les 10 ans (ou tout l'historique de FTMO s'il est plus court) ?
async function ctPret(nom) {
  const meta = await metaCT(nom); if (meta.introuvable || !meta.debut) return false;
  let present = new Set(); try { present = new Set((await core().redis(["HKEYS", CLE_CT(nom)])) || []); } catch (e) { return false; }
  return moisDK(10).every((m) => present.has(nomMoisDK(m)) || avantHistoireCT(meta, m) || Date.now() - m[2] < RECENT_MS);
}
// ===== Réserve Dukascopy dans Redis =====
// Un mois publié par Dukascopy ne change plus jamais : on ne le télécharge qu'UNE fois, puis il reste en réserve.
// Dukascopy limite les demandes (« HTTP 503 ») : on télécharge doucement, un mois à la fois, et au premier refus on pose
// le frein (voir plus bas). Ce qui manque est complété aux passages suivants (lien « remplir », appelé par cron-job.org).
const CLE_DK = (nom) => "alphie:dk:" + nom;
// Frein : quand Dukascopy refuse (HTTP 503), plus AUCUNE demande pendant un moment, pour tout Alphie (remplissage et tests du Labo).
// Le 11/10/2026, une tâche chaque minute qui redemandait sans arrêt l'a fait refuser tout le temps pendant 12 h.
// Pause de 5 min si des mois venaient d'arriver (simple limite de débit), sinon 10, 20, 40, 80 puis 120 min au plus.
const KEY_FREIN = "alphie:dk:frein";
async function lireFrein() { try { const r = await core().redis(["GET", KEY_FREIN]); return r ? JSON.parse(r) : {}; } catch (e) { return {}; } }
const pauseSuivante = (f, deja) => (deja ? 5 : Math.min(120, Math.max(10, (f.depuis ? f.pause_min || 5 : 5) * 2)));
async function poserFrein(deja, raison) {
  const f = await lireFrein(), now = Date.now(), p = pauseSuivante(f, deja);
  const nf = { jusqua: now + p * 60000, pause_min: p, depuis: (!deja && f.depuis) || now, refus: (deja ? 0 : f.refus || 0) + 1, raison: String(raison || "").slice(0, 140), dernier_ok: deja ? now : f.dernier_ok || null };
  await core().redis(["SET", KEY_FREIN, JSON.stringify(nf)]).catch(() => {});
  return nf;
}
async function noterReussite(f) {   // des mois sont arrivés sans refus : la série de refus est finie
  if (!f.depuis && f.dernier_ok && Date.now() - f.dernier_ok < 60000) return;
  await core().redis(["SET", KEY_FREIN, JSON.stringify({ dernier_ok: Date.now() })]).catch(() => {});
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const nomMoisDK = ([y, m]) => y + "-" + String(m + 1).padStart(2, "0");
const RECENT_MS = 62 * 86400000;   // mois en cours ou à peine fini : peut-être pas encore publié, on ne le note jamais « vide »
function moisDK(annees) {
  const maintenant = new Date(), mois = [];
  for (let k = 0; k < annees * 12 + 1; k++) { const d = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - k, 1)); mois.push([d.getUTCFullYear(), d.getUTCMonth(), d.getTime()]); }
  return mois;   // du plus récent au plus ancien
}
async function lireReserve(nom, champs) {
  const out = {}, lots = [];
  for (let i = 0; i < champs.length; i += 20) lots.push(champs.slice(i, i + 20));
  await Promise.all(lots.map(async (part) => {
    const vals = await core().redis(["HMGET", CLE_DK(nom)].concat(part));
    part.forEach((ch, k) => { const v = vals && vals[k]; if (v != null) out[ch] = v === "-" ? null : new Uint8Array(Buffer.from(v, "base64")); });
  }));
  return out;
}
// Complète la réserve d'un instrument jusqu'à l'heure « finAvant ». Renvoie ce qui était déjà là et ce qui a été obtenu.
async function preparerReserve(nom, annees, finAvant, D) {
  const mois = moisDK(annees), champs = mois.map(nomMoisDK);
  let present = new Set();
  try { present = new Set((await core().redis(["HKEYS", CLE_DK(nom)])) || []); } catch (e) { D.reserve_erreur = e.message; }
  const url = ([y, m]) => duka(`/datafeed/${nom}/${y}/${String(m).padStart(2, "0")}/BID_candles_hour_1.bi5`);
  let aFaire = mois.filter((m, k) => !present.has(champs[k]));
  const obtenus = {}, frein = await lireFrein();
  if (frein.jusqua > Date.now() && aFaire.length) { D.frein = frein; aFaire = []; }   // Dukascopy refusait il y a peu : on ne le dérange pas
  // Le mois en cours et le précédent ne sont parfois pas encore publiés : Dukascopy les fait attendre jusqu'au délai maximal.
  // On ne les retente qu'une fois toutes les 6 heures, sinon ils mangeaient la moitié de chaque passage (et ils ne servent pas aux tests :
  // les 12 derniers mois sont au coffre-fort).
  const recents = aFaire.filter((m) => Date.now() - m[2] < RECENT_MS), sauter = new Set();
  for (const m of recents) {
    const ok = await core().redis(["SET", "alphie:dk:essai:" + nom + ":" + nomMoisDK(m), "1", "EX", "21600", "NX"]).catch(() => "OK");
    if (ok !== "OK") sauter.add(nomMoisDK(m));
  }
  aFaire = aFaire.filter((m) => !sauter.has(nomMoisDK(m)));
  Object.assign(D, { route: routeDuka(), mois_demandes: mois.length, mois_deja_en_reserve: mois.length - aFaire.length, mois_telecharges: 0, mois_sans_fichier: 0, refus_dukascopy: 0, premiere_erreur: null });
  let freins = 0, erreurs = 0, i = 0;
  // un mois à la fois, un peu espacés ; au premier refus on s'arrête et on pose le frein.
  // On ne lance jamais un téléchargement qui pourrait finir après l'heure limite (chacun peut durer jusqu'à 9 s).
  while (i < aFaire.length && Date.now() + 9000 <= finAvant && freins < 1 && erreurs < 4) {
    const lot = aFaire.slice(i, i + 1); i += lot.length;
    const res = await Promise.all(lot.map(async (m) => { try { return { m, b: await telecharger(url(m), 9000) }; } catch (e) { return { m, e: new Error(msgErr(e)) }; } }));
    let freine = false;
    for (const x of res) {
      const ch = nomMoisDK(x.m);
      if (x.e) {
        if (!D.premiere_erreur) D.premiere_erreur = ch + " : " + x.e.message;
        if (/HTTP (503|429)/.test(x.e.message)) { freine = true; D.refus_dukascopy++; } else erreurs++;
        continue;
      }
      obtenus[ch] = x.b;
      if (x.b == null) { D.mois_sans_fichier++; if (Date.now() - x.m[2] > RECENT_MS) await core().redis(["HSET", CLE_DK(nom), ch, "-"]).catch(() => {}); }
      else { D.mois_telecharges++; await core().redis(["HSET", CLE_DK(nom), ch, Buffer.from(x.b).toString("base64")]).catch(() => {}); }
    }
    if (freine) { freins++; D.frein = await poserFrein(D.mois_telecharges > 0, D.premiere_erreur); break; }
    if (i < aFaire.length && Date.now() + 9000 + 800 <= finAvant) await pause(800);
  }
  D.arret_freinage = freins >= 1 || !!(D.frein && D.frein.jusqua > Date.now());
  if (!freins && D.mois_telecharges > 0) await noterReussite(frein);
  D.mois_manquants = champs.filter((ch, k) => !present.has(ch) && !(ch in obtenus) && Date.now() - mois[k][2] >= RECENT_MS).length;   // les mois pas encore publiés ne comptent pas
  D.complet = D.mois_manquants === 0;
  return { mois, champs, present, obtenus };
}

// Bougies 1 h sur « annees » années : la réserve d'abord, puis un petit complément téléchargé si le temps le permet
async function bougies1h(nom, annees, prixRef, diag, budgetMs) {
  const D = diag || {}, t0 = Date.now();
  const { mois, champs, present, obtenus } = await preparerReserve(nom, annees, t0 + (budgetMs || 12000), D);
  let donnees = {};
  try { donnees = await lireReserve(nom, champs.filter((ch) => present.has(ch))); } catch (e) { D.reserve_erreur = D.reserve_erreur || e.message; }
  Object.assign(donnees, obtenus);
  Object.assign(D, { mois_utilises: 0, mois_sautes: [], erreurs_decodage: 0 });
  // un mois isolé qui manque encore est sauté ; on ne s'arrête qu'au-delà de 3 trous, ou à 2 trous d'affilée
  const trou = (k, motif) => { D.mois_sautes.push(champs[k]); if (!D.premiere_erreur) D.premiere_erreur = champs[k] + " : " + motif; return D.mois_sautes.length > 3 || (k > 0 && D.mois_sautes.includes(champs[k - 1])); };
  const brut = [];
  for (let k = 0; k < mois.length; k++) {
    const ch = champs[k];
    if (!(ch in donnees)) { if (Date.now() - mois[k][2] < RECENT_MS) continue; if (trou(k, "pas encore en réserve")) break; continue; }
    if (donnees[ch] == null || !donnees[ch].length) continue;   // pas de fichier : mois pas encore publié, ou avant le début de l'historique
    try { const b = lireBougies(lzmaDecode(donnees[ch]), mois[k][2]); for (const x of b) brut.push(x); D.mois_utilises++; }
    catch (e) { D.erreurs_decodage++; core().redis(["HDEL", CLE_DK(nom), ch]).catch(() => {}); if (trou(k, "fichier abîmé (" + e.message + "), retéléchargé au prochain passage")) break; }
  }
  if (!brut.length) throw new Error(!D.mois_telecharges && !D.mois_deja_en_reserve ? "Dukascopy injoignable (" + (D.premiere_erreur || "aucune réponse") + ")" : "Dukascopy : aucune donnée exploitable" + (D.premiere_erreur ? " (" + D.premiere_erreur + ")" : ""));
  let c = ordonner(brut).filter((x) => x.v > 0 && x.h >= x.l);   // on retire les heures sans cotation (week-ends, jours fériés)
  // facteur de prix : celui par défaut, corrigé si le prix Yahoo récent dit autre chose
  let f = facteurDefaut(nom);
  if (prixRef > 0) { const tri = c.slice(-200).map((x) => x.c).sort((a, b) => a - b), med = tri[Math.floor(tri.length / 2)]; if (med > 0) f = 10 ** Math.round(Math.log10(med / prixRef)); }
  D.facteur_prix = f;
  const vu = new Set();
  c = c.filter((x) => !vu.has(x.t) && vu.add(x.t)).sort((a, b) => a.t - b.t).map((x) => ({ t: x.t, o: x.o / f, h: x.h / f, l: x.l / f, c: x.c / f, v: x.v }));
  D.duree_s = Math.round((Date.now() - t0) / 100) / 10;
  if (c.length) { D.de = new Date(c[0].t).toISOString().slice(0, 10); D.a = new Date(c[c.length - 1].t).toISOString().slice(0, 10); D.bougies = c.length; }
  return c;
}

async function bougies(sym, unite) {
  const base = baseCrypto(sym);
  let echecPlateformes = null;
  if (base && EX[unite]) {
    try { return await bougiesPlateformes(base, unite); } catch (e) { echecPlateformes = e.message; }
  }
  // Forex, or, argent, indices, pétrole en 1 h ou 4 h : 10 ans de Dukascopy au lieu de 2 ans de Yahoo
  const dk = !base && (unite === "1h" || unite === "4h") ? nomDukascopy(sym) : null;
  if (dk) {
    let manque = 0; try { manque = await manquantsReserve(dk); } catch (e) {}
    if (manque > RESERVE_MANQUE_MAX && (await ctPret(dk).catch(() => false))) {
      try {
        let c = await lireCT(dk, Date.now() - 10 * 365.25 * J_MS, Date.now());
        if (unite === "4h") c = regrouperUTC(c, 4 * 3600000);
        if (c.length >= 300) return { meta: { shortName: dk }, c, source: "cTrader (FTMO)", detail: "prix FTMO (cTrader) : " + new Date(c[0].t).toISOString().slice(0, 10) + " → " + new Date(c[c.length - 1].t).toISOString().slice(0, 10) + ", à la place de Dukascopy (" + manque + " mois manquants)" };
      } catch (e) { echecPlateformes = "cTrader : " + e.message; }
    }
    const D = {};
    try {
      let ref = null;
      try { const y = await core().yahooChart(sym, "1d", "3mo"); const cl = y.candles.map((x) => x.c).filter((x) => x > 0).sort((a, b) => a - b); ref = cl[Math.floor(cl.length / 2)] || null; } catch (e) {}
      let c = await bougies1h(dk, 10, ref, D);
      if (unite === "4h") c = regrouperUTC(c, 4 * 3600000);
      const detail = "Dukascopy : " + D.mois_utilises + " mois de données (" + D.de + " → " + D.a + ")" + (D.complet ? "" : ", réserve en cours de remplissage (" + D.mois_manquants + " mois manquants)") + (D.mois_sautes.length ? ", " + D.mois_sautes.length + " mois sauté(s), premier incident : " + D.premiere_erreur : "");
      if (c.length >= 300) return { meta: { shortName: dk }, c, source: "Dukascopy", detail };
      echecPlateformes = detail;
    } catch (e) { echecPlateformes = e.message; }
  }
  const u = UNITES[unite] || UNITES["1j"];
  const { meta, candles } = await core().yahooChart(sym, u[0], u[1]);
  const source = "Yahoo" + (echecPlateformes ? (dk ? " (Dukascopy indisponible)" : " (plateformes crypto indisponibles)") : "");
  const detail = echecPlateformes ? "Yahoo, à la place de " + (dk ? "Dukascopy" : "Binance") + " : " + echecPlateformes : "Yahoo";
  if (unite !== "4h") return { meta, c: candles, source, detail };
  const out = [];
  for (let i = 0; i < candles.length; i += 4) {
    const g = candles.slice(i, i + 4);
    out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[g.length - 1].c, v: g.reduce((s, x) => s + x.v, 0) });
  }
  return { meta, c: out, source, detail };
}

function fraisDefaut(sym) {
  if (/-USD$/.test(sym)) return 0.06;           // crypto : frais + spread par côté, en %
  if (/=X$/.test(sym)) return 0.008;            // forex
  if (/^\^|=F$/.test(sym)) return 0.02;         // indices, futures
  return 0.05;                                  // actions
}

// Frais de financement d'une position gardée la nuit (CFD), en % par nuit. Comptés seulement si la stratégie le demande (vague 2).
function fraisNuitDefaut(sym) {
  if (/-USD$/.test(sym)) return 0.03;
  if (/=X$/.test(sym)) return 0.004;
  if (sym === "GC=F" || sym === "SI=F") return 0.015;
  return 0.02;                                  // indices, actions
}

// ---------- Indicateurs (calculés une fois) ----------
function makeATR(c, p) {
  const o = new Array(c.length).fill(null); let a = null;
  for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); a = a == null ? tr : (a * (p - 1) + tr) / p; o[i] = a; }
  return o;
}

function makeInd(c) {
  const cache = {};
  const close = c.map((x) => x.c);
  const get = (k, f) => cache[k] || (cache[k] = f());
  return {
    _cache: get,
    ema: (p) => get("ema" + p, () => { const k = 2 / (p + 1), o = new Array(c.length).fill(null); let e = null; for (let i = 0; i < c.length; i++) { if (i === p - 1) e = close.slice(0, p).reduce((s, x) => s + x, 0) / p; else if (i >= p) e = close[i] * k + e * (1 - k); o[i] = e; } return o; }),
    rsi: (p) => get("rsi" + p, () => { const o = new Array(c.length).fill(null); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = close[i] - close[i - 1]; if (i <= p) { if (d > 0) g += d; else l -= d; if (i === p) { g /= p; l /= p; o[i] = l ? 100 - 100 / (1 + g / l) : 100; } } else { g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; o[i] = l ? 100 - 100 / (1 + g / l) : 100; } } return o; }),
    atr: (p) => get("atr" + p, () => { const o = new Array(c.length).fill(null); let a = null; for (let i = 1; i < c.length; i++) { const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); if (i === p) a = tr; else if (i > p) a = (a * (p - 1) + tr) / p; else a = a == null ? tr : a + (tr - a) / i; o[i] = a; } return o; }),
    volMoy: (p) => get("vm" + p, () => { const o = new Array(c.length).fill(null); let s = 0; for (let i = 0; i < c.length; i++) { s += c[i].v; if (i >= p) s -= c[i - p].v; if (i >= p - 1) o[i] = s / p; } return o; }),
    // ADX de Wilder : force de la tendance (sous 20 : pas de tendance, au-dessus de 25 : tendance nette)
    adx: (p) => get("adx" + p, () => {
      const n = c.length, o = new Array(n).fill(null);
      let tr = 0, pdm = 0, mdm = 0, adx = null, dxs = [];
      for (let i = 1; i < n; i++) {
        const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
        const t = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
        const pd = up > dn && up > 0 ? up : 0, md = dn > up && dn > 0 ? dn : 0;
        if (i <= p) { tr += t; pdm += pd; mdm += md; } else { tr = tr - tr / p + t; pdm = pdm - pdm / p + pd; mdm = mdm - mdm / p + md; }
        if (i < p) continue;
        const pdi = tr ? (100 * pdm) / tr : 0, mdi = tr ? (100 * mdm) / tr : 0, dx = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
        if (adx == null) { dxs.push(dx); if (dxs.length === p) adx = dxs.reduce((a, b) => a + b, 0) / p; }
        else adx = (adx * (p - 1) + dx) / p;
        o[i] = adx;
      }
      return o;
    }),
    hautMax: (p) => get("hm" + p, () => c.map((_, i) => i < p ? null : Math.max(...c.slice(i - p, i).map((x) => x.h)))),
    basMin: (p) => get("bm" + p, () => c.map((_, i) => i < p ? null : Math.min(...c.slice(i - p, i).map((x) => x.l)))),
    // Structure ICT/SMC : swings confirmés (2 bougies de chaque côté), BOS, CHoCH, order blocks, displacement
    struct: () => get("struct", () => {
      const n = c.length, K = 2, atr = makeATR(c, 14);
      const o = { bosU: [], bosD: [], chochU: [], chochD: [], obU: [], obD: [], dispU: [], dispD: [] };
      let sh = null, shp = null, sl = null, slp = null, zoneU = null, zoneD = null;
      for (let i = 0; i < n; i++) {
        const j = i - K; // un swing en j est confirmé à la bougie i
        if (j >= K) {
          let isH = true, isL = true;
          for (let k = j - K; k <= j + K; k++) { if (k === j) continue; if (c[k].h >= c[j].h) isH = false; if (c[k].l <= c[j].l) isL = false; }
          if (isH) { shp = sh; sh = c[j].h; }
          if (isL) { slp = sl; sl = c[j].l; }
        }
        const up = sh != null && c[i].c > sh && i > 0 && c[i - 1].c <= sh;
        const dn = sl != null && c[i].c < sl && i > 0 && c[i - 1].c >= sl;
        const bear = sh != null && shp != null && sl != null && slp != null && sh < shp && sl < slp;
        const bull = sh != null && shp != null && sl != null && slp != null && sh > shp && sl > slp;
        o.bosU[i] = up; o.bosD[i] = dn; o.chochU[i] = up && bear; o.chochD[i] = dn && bull;
        const body = Math.abs(c[i].c - c[i].o), a = atr[i] || 0;
        o.dispU[i] = i >= 2 && c[i].c > c[i].o && body > 1.5 * a && c[i].l > c[i - 2].h;
        o.dispD[i] = i >= 2 && c[i].c < c[i].o && body > 1.5 * a && c[i].h < c[i - 2].l;
        // Order blocks : dernière bougie opposée avant une cassure de structure, valide au premier retour
        o.obU[i] = false; o.obD[i] = false;
        if (zoneU && i > zoneU.k) { if (c[i].c < zoneU.l) zoneU = null; else if (c[i].l <= zoneU.h) { o.obU[i] = c[i].c > zoneU.l; zoneU = null; } }
        if (zoneD && i > zoneD.k) { if (c[i].c > zoneD.h) zoneD = null; else if (c[i].h >= zoneD.l) { o.obD[i] = c[i].c < zoneD.h; zoneD = null; } }
        if (up) for (let k = i - 1; k >= Math.max(0, i - 12); k--) if (c[k].c < c[k].o) { zoneU = { h: c[k].h, l: c[k].l, k: i }; break; }
        if (dn) for (let k = i - 1; k >= Math.max(0, i - 12); k--) if (c[k].c > c[k].o) { zoneD = { h: c[k].h, l: c[k].l, k: i }; break; }
      }
      return o;
    }),
  };
}

// ---------- Conditions disponibles (le « vocabulaire » des stratégies) ----------
function heureParis(t) { return Math.floor(paris(t).min / 60); }   // rapide : pas de conversion de fuseau coûteuse à chaque bougie
function jourParis(t) { return Math.floor((t + decalageParis(t) * 3600000) / 86400000); }   // numéro du jour, heure de Paris
// Paris : UTC+2 du dernier dimanche de mars (1 h UTC) au dernier dimanche d'octobre (1 h UTC), sinon UTC+1
const _dst = {};
function decalageParis(t) {
  const y = new Date(t).getUTCFullYear();
  if (!_dst[y]) { const dim = (m) => { const x = new Date(Date.UTC(y, m + 1, 0, 1)); x.setUTCDate(x.getUTCDate() - x.getUTCDay()); return x.getTime(); }; _dst[y] = [dim(2), dim(9)]; }
  return t >= _dst[y][0] && t < _dst[y][1] ? 2 : 1;
}
function paris(t) {
  const d = new Date(t + decalageParis(t) * 3600000);
  return { an: d.getUTCFullYear(), mois: d.getUTCMonth(), jour: d.getUTCDate(), js: d.getUTCDay() || 7, min: d.getUTCHours() * 60 + d.getUTCMinutes(), finMois: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(), cle: d.getUTCFullYear() * 400 + d.getUTCMonth() * 32 + d.getUTCDate() };
}
const hm = (x) => { const m = /^(\d{1,2})(?::|h)?(\d{2})?$/.exec(String(x || "").trim()); return m ? +m[1] * 60 + (+m[2] || 0) : null; };
// Plus haut / plus bas des « minutes » premières minutes d'une session, jour par jour (heure de Paris)
function rangeOuverture(c, I, heure, minutes) {
  return I._cache("or" + heure + "_" + minutes, () => {
    const debut = hm(heure), fin = debut + minutes, hi = new Array(c.length).fill(null), lo = new Array(c.length).fill(null), finT = new Array(c.length).fill(null);
    let cle = null, h = -Infinity, l = Infinity, complet = false;
    for (let i = 0; i < c.length; i++) {
      const P = paris(c[i].t);
      if (P.cle !== cle) { cle = P.cle; h = -Infinity; l = Infinity; complet = false; }
      if (P.min >= debut && P.min < fin) { h = Math.max(h, c[i].h); l = Math.min(l, c[i].l); }
      else if (P.min >= fin && h > -Infinity) complet = true;
      if (complet) { hi[i] = h; lo[i] = l; finT[i] = P.min - fin; }
    }
    return { hi, lo, apres: finT };
  });
}
// FVG encore ouvert le plus récent : haussier = bas de la bougie k au-dessus du haut de k-2 (trou laissé par une poussée).
// Invalide si une clôture l'a traversé ; « premier retour » : aucune mèche n'y est revenue avant la bougie i.
function fvgOuvert(c, i, fenetre, sens) {
  for (let k = i - 1; k >= Math.max(2, i - fenetre); k--) {
    const bas = sens > 0 ? c[k - 2].h : c[k].h, haut = sens > 0 ? c[k].l : c[k - 2].l;
    if (!(haut > bas)) continue;
    let ok = true;
    for (let m = k + 1; m < i; m++) {
      if (sens > 0 ? c[m].c < bas || c[m].l <= haut : c[m].c > haut || c[m].h >= bas) { ok = false; break; }
    }
    return ok ? { bas, haut, k } : null;   // seul le FVG le plus récent compte
  }
  return null;
}
// Divergence : extrême des « fenetre » dernières bougies comparé à l'extrême précédent (dans les « retour » bougies d'avant)
function divergenceRSI(c, I, i, p, sens) {
  const r = I.rsi(p.periode || 14), f = p.fenetre ?? 6, n = p.retour ?? 48;
  if (i - f - n < 1) return false;
  const pire = (a, b) => (sens > 0 ? c[a].l < c[b].l : c[a].h > c[b].h);
  let k = i; for (let x = i - f; x <= i; x++) if (pire(x, k)) k = x;
  let m = k - 3; for (let x = k - n; x <= k - 3; x++) if (pire(x, m)) m = x;
  if (r[k] == null || r[m] == null || !pire(k, m)) return false;
  return sens > 0 ? r[k] > r[m] : r[k] < r[m];
}
// Série journalière d'un AUTRE marché (indice du dollar, VIX), lue bougie par bougie sans jamais regarder le futur :
// à chaque bougie, on ne connaît que les clôtures des jours précédents (jour UTC strictement antérieur à l'ouverture de la bougie).
// Rien n'est lu si la dernière clôture connue a plus de 5 jours (trou dans les données) : la condition est alors fausse.
function serieExterne(c, I, p) {
  const sym = String(p.symbole || ""), n = p.periode || 50;
  return I._cache("ext" + sym + "_" + n, () => {
    const E = (I.ext || {})[sym];
    if (!E || !E.length) throw new Error("série externe absente : " + sym + " (elle se télécharge au lancement du test)");
    const k = 2 / (n + 1), ema = new Array(E.length).fill(null); let e = null;
    for (let x = 0; x < E.length; x++) { if (x === n - 1) e = E.slice(0, n).reduce((s, y) => s + y.c, 0) / n; else if (x >= n) e = E[x].c * k + e * (1 - k); ema[x] = e; }
    const val = new Array(c.length).fill(null), moy = new Array(c.length).fill(null), jourE = E.map((y) => Math.floor(y.t / 86400000));
    let x = -1;
    for (let i = 0; i < c.length; i++) {
      const jour = Math.floor(c[i].t / 86400000);
      while (x + 1 < E.length && jourE[x + 1] < jour) x++;
      if (x >= 0 && ema[x] != null && jour - jourE[x] <= 5) { val[i] = E[x].c; moy[i] = ema[x]; }
    }
    return { val, moy };
  });
}
// Momentum multi-horizons (TSMOM, base de la stratégie partagée par Grok) : rendement sur 2, 4, 8 et 12 mois de bourse,
// chacun divisé par la volatilité attendue sur cet horizon (volatilité des 3 derniers mois), puis moyenne pondérée 0,20 / 0,25 / 0,30 / 0,25.
// Sur un marché sans tendance, le score tourne autour de 0. p.jour = bougies par jour de bourse (1 en journalier, 6 en 4 h, 22 en 1 h).
function tsmomSerie(c, I, p) {
  const bj = p.jour || 1;
  return I._cache("ts" + bj, () => {
    const n = c.length, o = new Array(n).fill(null), H = [[42, 0.2], [84, 0.25], [168, 0.3], [252, 0.25]].map(([d, w]) => [Math.round(d * bj), w]), V = Math.round(63 * bj);
    const s1 = new Float64Array(n + 1), s2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const r = i > 0 && c[i - 1].c > 0 && c[i].c > 0 ? Math.log(c[i].c / c[i - 1].c) : 0; s1[i + 1] = s1[i] + r; s2[i + 1] = s2[i] + r * r; }
    for (let i = Math.max(H[H.length - 1][0], V); i < n; i++) {
      const m = (s1[i + 1] - s1[i + 1 - V]) / V, sd = Math.sqrt(Math.max(0, (s2[i + 1] - s2[i + 1 - V]) / V - m * m));
      if (!(sd > 0)) continue;
      let sc = 0; for (const [h, w] of H) sc += (w * Math.log(c[i].c / c[i - h].c)) / (sd * Math.sqrt(h));
      o[i] = sc;
    }
    return o;
  });
}
// ---------- Vague 7 (17/10/2026) : la liquidité, la peur, et la dernière heure de New York ----------
// Plus haut et plus bas de la journée précédente (heure de Paris, dernière journée avec des cotations), et première bougie de la journée en cours
function niveauxVeille(c, I) {
  return I._cache("veille", () => {
    const n = c.length, pH = new Array(n).fill(null), pL = new Array(n).fill(null), d0 = new Array(n).fill(0);
    let cle = null, h = -Infinity, l = Infinity, ph = null, pl = null, debut = 0;
    for (let i = 0; i < n; i++) {
      const k = paris(c[i].t).cle;
      if (k !== cle) { if (cle != null) { ph = h; pl = l; } cle = k; h = -Infinity; l = Infinity; debut = i; }
      pH[i] = ph; pL[i] = pl; d0[i] = debut;
      h = Math.max(h, c[i].h); l = Math.min(l, c[i].l);
    }
    return { pH, pL, d0 };
  });
}
// Turtle Soup (Raschke et Connors, 1995) : nouveau plus bas des « periode » bougies alors que l'ancien plus bas date d'au moins « age_min »
// bougies, et clôture revenue au-dessus de cet ancien plus bas (l'inverse en haut). Les stops placés sous l'ancien plus bas ont été pris.
function soupeTortue(c, i, p, sens) {
  const n = p.periode || 20, age = p.age_min ?? 4; if (i < n + 1) return false;
  let k = i - n; for (let x = i - n; x < i; x++) if (sens > 0 ? c[x].l <= c[k].l : c[x].h >= c[k].h) k = x;   // à égalité, le plus récent
  if (i - k < age) return false;
  const niv = sens > 0 ? c[k].l : c[k].h;
  return sens > 0 ? c[i].l < niv && c[i].c > niv : c[i].h > niv && c[i].c < niv;
}
// Double bas (ou double haut) : le plus bas des « periode » bougies a été touché au moins « touches » fois séparées (à « tolerance_atr » ATR près),
// donc beaucoup de stops juste dessous ; la bougie passe dessous puis clôture au-dessus
function doubleExtreme(c, I, i, p, sens) {
  const n = p.periode || 48, tol = (p.tolerance_atr ?? 0.25) * (I.atr(14)[i] || 0), besoin = p.touches || 2;
  const niv = sens > 0 ? I.basMin(n)[i] : I.hautMax(n)[i];
  if (niv == null || !(tol > 0)) return false;
  if (!(sens > 0 ? c[i].l < niv && c[i].c > niv : c[i].h > niv && c[i].c < niv)) return false;
  let touches = 0, der = -99;
  for (let k = i - n; k < i; k++) if (sens > 0 ? c[k].l <= niv + tol : c[k].h >= niv - tol) { if (k - der > 2) touches++; der = k; }   // bougies voisines = une seule touche
  return touches >= besoin;
}
// Piège d'ouverture : le range de la nuit (par défaut 1 h à 8 h, heure de Paris) est dépassé par une mèche puis la bougie clôture dedans,
// sans qu'aucune bougie n'ait déjà clôturé dehors depuis la fin du range (sinon c'est une vraie cassure, pas un piège). sens -1 = piège en haut (vente).
function piegeOuverture(c, I, i, p, sens) {
  const R = rangeOuverture(c, I, p.heure || "01:00", p.minutes || 420), niv = sens > 0 ? R.lo[i] : R.hi[i];
  if (niv == null || R.apres[i] > (p.fenetre_minutes ?? 180)) return false;
  if (!(sens > 0 ? c[i].l < niv && c[i].c > niv : c[i].h > niv && c[i].c < niv)) return false;
  for (let k = i - 1; k >= 0 && R.apres[k] != null && R.apres[k] < R.apres[i]; k--) if (sens > 0 ? c[k].c < R.lo[k] : c[k].c > R.hi[k]) return false;
  return true;
}
// Momentum de la journée (Gao, Han, Li et Zhou, 2018) : variation entre la clôture de New York de la veille (bougie de 21 h, heure de Paris)
// et la clôture de la bougie de 15 h (16 h à Paris = 10 h à New York) du jour, connue à partir de 16 h
function debutSeanceUS(c, I, p) {
  const hs = p.heure_signal ?? 15, hv = p.veille ?? 21;
  return I._cache("dsus" + hs + "_" + hv, () => {
    const n = c.length, o = new Array(n).fill(null);
    let cle = null, refVeille = null, dernierV = null, auj = null;
    for (let i = 0; i < n; i++) {
      const P = paris(c[i].t), h = Math.floor(P.min / 60);
      if (P.cle !== cle) { cle = P.cle; refVeille = dernierV; auj = null; }
      if (h === hv) dernierV = c[i].c;
      if (h === hs) auj = c[i].c;
      if (auj != null && refVeille > 0) o[i] = auj / refVeille - 1;
    }
    return o;
  });
}
const COND = {
  tsmom_sur: (c, I, i, p) => { const s = tsmomSerie(c, I, p)[i]; return s != null && s > (p.seuil ?? 0.5); },
  tsmom_sous: (c, I, i, p) => { const s = tsmomSerie(c, I, p)[i]; return s != null && s < (p.seuil ?? -0.5); },
  prix_au_dessus_ema: (c, I, i, p) => { const e = I.ema(p.periode || 200)[i]; return e != null && c[i].c > e; },
  prix_sous_ema: (c, I, i, p) => { const e = I.ema(p.periode || 200)[i]; return e != null && c[i].c < e; },
  ema_au_dessus: (c, I, i, p) => I.ema(p.rapide || 20)[i] > I.ema(p.lente || 50)[i],
  ema_en_dessous: (c, I, i, p) => I.ema(p.rapide || 20)[i] < I.ema(p.lente || 50)[i],
  ema_croise_haut: (c, I, i, p) => { const a = I.ema(p.rapide || 20), b = I.ema(p.lente || 50); return a[i - 1] <= b[i - 1] && a[i] > b[i]; },
  ema_croise_bas: (c, I, i, p) => { const a = I.ema(p.rapide || 20), b = I.ema(p.lente || 50); return a[i - 1] >= b[i - 1] && a[i] < b[i]; },
  rsi_sous: (c, I, i, p) => I.rsi(p.periode || 14)[i] < (p.seuil ?? 30),
  rsi_sur: (c, I, i, p) => I.rsi(p.periode || 14)[i] > (p.seuil ?? 70),
  rsi_croise_haut: (c, I, i, p) => { const r = I.rsi(p.periode || 14); return r[i - 1] <= (p.seuil ?? 30) && r[i] > (p.seuil ?? 30); },
  rsi_croise_bas: (c, I, i, p) => { const r = I.rsi(p.periode || 14); return r[i - 1] >= (p.seuil ?? 70) && r[i] < (p.seuil ?? 70); },
  cassure_plus_haut: (c, I, i, p) => c[i].c > I.hautMax(p.periode || 20)[i],
  cassure_plus_bas: (c, I, i, p) => c[i].c < I.basMin(p.periode || 20)[i],
  rebond_ema: (c, I, i, p) => { const e = I.ema(p.periode || 20)[i]; return c[i].l <= e * (1 + (p.tolerance_pct || 0.3) / 100) && c[i].c > e && c[i].c > c[i].o; },
  rejet_ema: (c, I, i, p) => { const e = I.ema(p.periode || 20)[i]; return c[i].h >= e * (1 - (p.tolerance_pct || 0.3) / 100) && c[i].c < e && c[i].c < c[i].o; },
  englobante_haussiere: (c, I, i) => c[i - 1].c < c[i - 1].o && c[i].c > c[i].o && c[i].c >= c[i - 1].o && c[i].o <= c[i - 1].c,
  englobante_baissiere: (c, I, i) => c[i - 1].c > c[i - 1].o && c[i].c < c[i].o && c[i].c <= c[i - 1].o && c[i].o >= c[i - 1].c,
  volume_fort: (c, I, i, p) => { const m = I.volMoy(p.periode || 20)[i - 1]; return m > 0 && c[i].v > m * (p.mult || 1.5); },
  fvg_haussier: (c, I, i) => c[i].l > c[i - 2].h,
  fvg_baissier: (c, I, i) => c[i].h < c[i - 2].l,
  balayage_bas: (c, I, i, p) => { const b = I.basMin(p.periode || 20)[i]; return c[i].l < b && c[i].c > b; },   // chasse de liquidité sous un bas puis réintégration
  balayage_haut: (c, I, i, p) => { const h = I.hautMax(p.periode || 20)[i]; return c[i].h > h && c[i].c < h; },
  // --- Vague 7 : liquidité
  soupe_tortue_bas: (c, I, i, p) => soupeTortue(c, i, p, 1),
  soupe_tortue_haut: (c, I, i, p) => soupeTortue(c, i, p, -1),
  // le plus bas de la veille balayé puis repris, la première fois de la journée
  balayage_veille_bas: (c, I, i) => { const V = niveauxVeille(c, I), L = V.pL[i]; if (L == null || !(c[i].l < L && c[i].c > L)) return false; for (let k = V.d0[i]; k < i; k++) if (c[k].l < L) return false; return true; },
  balayage_veille_haut: (c, I, i) => { const V = niveauxVeille(c, I), H = V.pH[i]; if (H == null || !(c[i].h > H && c[i].c < H)) return false; for (let k = V.d0[i]; k < i; k++) if (c[k].h > H) return false; return true; },
  balayage_double_bas: (c, I, i, p) => doubleExtreme(c, I, i, p, 1),
  balayage_double_haut: (c, I, i, p) => doubleExtreme(c, I, i, p, -1),
  piege_ouverture_bas: (c, I, i, p) => piegeOuverture(c, I, i, p, 1),
  piege_ouverture_haut: (c, I, i, p) => piegeOuverture(c, I, i, p, -1),
  // --- Vague 7 : momentum de la journée américaine
  debut_seance_haussier: (c, I, i, p) => { const v = debutSeanceUS(c, I, p)[i]; return v != null && v > (p.seuil ?? 0); },
  debut_seance_baissier: (c, I, i, p) => { const v = debutSeanceUS(c, I, p)[i]; return v != null && v < -(p.seuil ?? 0); },
  heure_entre: (c, I, i, p) => { const h = heureParis(c[i].t); return h >= (p.debut ?? 0) && h < (p.fin ?? 24); },
  session_asie: (c, I, i) => { const h = heureParis(c[i].t); return h >= 1 && h < 8; },
  session_londres: (c, I, i) => { const h = heureParis(c[i].t); return h >= 8 && h < 12; },
  session_newyork: (c, I, i) => { const h = heureParis(c[i].t); return h >= 14 && h < 18; },
  bos_haussier: (c, I, i) => I.struct().bosU[i],
  bos_baissier: (c, I, i) => I.struct().bosD[i],
  choch_haussier: (c, I, i) => I.struct().chochU[i],
  choch_baissier: (c, I, i) => I.struct().chochD[i],
  order_block_haussier: (c, I, i) => I.struct().obU[i],
  order_block_baissier: (c, I, i) => I.struct().obD[i],
  displacement_haussier: (c, I, i) => I.struct().dispU[i],
  displacement_baissier: (c, I, i) => I.struct().dispD[i],
  discount: (c, I, i, p) => { const n = p.periode || 50, h = I.hautMax(n)[i], l = I.basMin(n)[i]; return h != null && c[i].c < l + (h - l) * (p.niveau ?? 0.5); },
  premium: (c, I, i, p) => { const n = p.periode || 50, h = I.hautMax(n)[i], l = I.basMin(n)[i]; return h != null && c[i].c > l + (h - l) * (p.niveau ?? 0.5); },
  atr_min_pct: (c, I, i, p) => (I.atr(14)[i] / c[i].c) * 100 >= (p.pct ?? 0.3),
  // --- Régime de marché
  adx_sous: (c, I, i, p) => { const a = I.adx(p.periode || 14)[i]; return a != null && a < (p.seuil ?? 20); },
  adx_sur: (c, I, i, p) => { const a = I.adx(p.periode || 14)[i]; return a != null && a > (p.seuil ?? 25); },
  // Range : pas de tendance (ADX bas), assez large pour couvrir les frais, haut ET bas touchés au moins « touches » fois
  marche_en_range: (c, I, i, p) => {
    const n = p.periode || 40, h = I.hautMax(n)[i], l = I.basMin(n)[i], a = I.adx(14)[i], at = I.atr(14)[i];
    if (h == null || a == null || !at || a >= (p.adx_max ?? 22)) return false;
    const larg = h - l; if (!(larg >= (p.largeur_min_atr ?? 3) * at)) return false;
    const zone = larg * (p.zone ?? 0.15), besoin = p.touches ?? 2;
    let th = 0, tb = 0, dH = false, dB = false;
    for (let k = i - n; k < i; k++) { const eh = c[k].h >= h - zone, eb = c[k].l <= l + zone; if (eh && !dH) th++; if (eb && !dB) tb++; dH = eh; dB = eb; }
    return th >= besoin && tb >= besoin;
  },
  bas_du_range: (c, I, i, p) => { const n = p.periode || 40, h = I.hautMax(n)[i], l = I.basMin(n)[i]; return h != null && c[i].c <= l + (h - l) * (p.niveau ?? 0.25); },
  haut_du_range: (c, I, i, p) => { const n = p.periode || 40, h = I.hautMax(n)[i], l = I.basMin(n)[i]; return h != null && c[i].c >= h - (h - l) * (p.niveau ?? 0.25); },
  // --- Momentum : le prix est plus haut (ou plus bas) qu'il y a N bougies
  momentum_haussier: (c, I, i, p) => { const n = p.periode || 63; return i >= n && c[i].c > c[i - n].c * (1 + (p.pct ?? 0) / 100); },
  momentum_baissier: (c, I, i, p) => { const n = p.periode || 63; return i >= n && c[i].c < c[i - n].c * (1 - (p.pct ?? 0) / 100); },
  // --- Retour à la moyenne
  bougies_baissieres_consecutives: (c, I, i, p) => { const n = p.nombre || 3; if (i < n) return false; for (let k = i - n + 1; k <= i; k++) if (!(c[k].c < c[k].o)) return false; return true; },
  bougies_haussieres_consecutives: (c, I, i, p) => { const n = p.nombre || 3; if (i < n) return false; for (let k = i - n + 1; k <= i; k++) if (!(c[k].c > c[k].o)) return false; return true; },
  ecart_ema_atr_sous: (c, I, i, p) => { const e = I.ema(p.periode || 20)[i], a = I.atr(14)[i]; return e != null && a > 0 && (c[i].c - e) / a < -(p.atr ?? 2); },
  ecart_ema_atr_sur: (c, I, i, p) => { const e = I.ema(p.periode || 20)[i], a = I.atr(14)[i]; return e != null && a > 0 && (c[i].c - e) / a > (p.atr ?? 2); },
  // --- Volatilité : bougie la plus étroite des N dernières (NR7), ou ATR court nettement sous l'ATR long
  compression: (c, I, i, p) => { const n = p.periode || 7; if (i < n) return false; const r = c[i].h - c[i].l; for (let k = i - n + 1; k < i; k++) if (c[k].h - c[k].l <= r) return false; return true; },
  atr_compression: (c, I, i, p) => { const a = I.atr(p.rapide || 14)[i], b = I.atr(p.lente || 100)[i]; return a != null && b > 0 && a / b < (p.seuil ?? 0.75); },
  // --- Calendrier (heure de Paris) : jours 1 = lundi … 7 = dimanche ; jour du mois négatif = depuis la fin (-1 = dernier jour)
  jour_semaine: (c, I, i, p) => (p.jours || [1, 2, 3, 4, 5]).includes(paris(c[i].t).js),
  jour_du_mois: (c, I, i, p) => {
    const P = paris(c[i].t), f = (x) => (x < 0 ? P.finMois + x + 1 : x), de = f(p.de ?? 1), a = f(p.a ?? 31);
    return de <= a ? P.jour >= de && P.jour <= a : P.jour >= de || P.jour <= a;
  },
  // --- Cassure du range d'ouverture : premier passage au-dessus (ou en dessous) des « minutes » premières minutes de la session
  cassure_ouverture_haut: (c, I, i, p) => { const R = rangeOuverture(c, I, p.heure || "15:30", p.minutes || 15); return i > 0 && R.hi[i] != null && R.apres[i] <= (p.fenetre_minutes ?? 180) && c[i].c > R.hi[i] && !(R.hi[i - 1] != null && c[i - 1].c > R.hi[i - 1]); },
  cassure_ouverture_bas: (c, I, i, p) => { const R = rangeOuverture(c, I, p.heure || "15:30", p.minutes || 15); return i > 0 && R.lo[i] != null && R.apres[i] <= (p.fenetre_minutes ?? 180) && c[i].c < R.lo[i] && !(R.lo[i - 1] != null && c[i - 1].c < R.lo[i - 1]); },
  // --- Vague 2 : liquidité, FVG, divergences, compression, force de clôture
  // Retour dans le dernier FVG encore ouvert (formé dans les « fenetre » bougies), premier retour seulement, avec rejet
  retour_fvg_haussier: (c, I, i, p) => { const z = fvgOuvert(c, i, p.fenetre || 12, 1); return !!z && c[i].l <= z.haut && c[i].c > z.bas && c[i].c > c[i].o; },
  retour_fvg_baissier: (c, I, i, p) => { const z = fvgOuvert(c, i, p.fenetre || 12, -1); return !!z && c[i].h >= z.bas && c[i].c < z.haut && c[i].c < c[i].o; },
  // Liquidité prise récemment : une mèche est passée sous le plus bas des « periode » bougies, et le prix est revenu au-dessus
  balayage_bas_recent: (c, I, i, p) => { const n = p.periode || 48, bm = I.basMin(n); for (let k = Math.max(1, i - (p.fenetre ?? 6)); k <= i; k++) if (bm[k] != null && c[k].l < bm[k] && c[i].c > bm[k]) return true; return false; },
  balayage_haut_recent: (c, I, i, p) => { const n = p.periode || 48, hx = I.hautMax(n); for (let k = Math.max(1, i - (p.fenetre ?? 6)); k <= i; k++) if (hx[k] != null && c[k].h > hx[k] && c[i].c < hx[k]) return true; return false; },
  // Divergence RSI : le prix fait un plus bas plus bas, le RSI un plus bas plus haut (et l'inverse en haut)
  divergence_rsi_haussiere: (c, I, i, p) => divergenceRSI(c, I, i, p, 1),
  divergence_rsi_baissiere: (c, I, i, p) => divergenceRSI(c, I, i, p, -1),
  // Compression puis explosion : la bougie précédente est la plus étroite des N dernières, et celle-ci clôture au-delà
  cassure_apres_compression_haut: (c, I, i, p) => i > 1 && COND.compression(c, I, i - 1, p) && c[i].c > c[i - 1].h,
  cassure_apres_compression_bas: (c, I, i, p) => i > 1 && COND.compression(c, I, i - 1, p) && c[i].c < c[i - 1].l,
  // Force de clôture (IBS) : 0 = clôture tout en bas de la bougie, 1 = tout en haut
  ibs_sous: (c, I, i, p) => c[i].h > c[i].l && (c[i].c - c[i].l) / (c[i].h - c[i].l) < (p.seuil ?? 0.2),
  ibs_sur: (c, I, i, p) => c[i].h > c[i].l && (c[i].c - c[i].l) / (c[i].h - c[i].l) > (p.seuil ?? 0.8),
  // --- Vague 4 : un autre marché comme filtre (clôture de la veille au-dessus ou en dessous de sa moyenne)
  // ex. { type: "externe_sous_ema", symbole: "DX-Y.NYB", periode: 50 } = le dollar est faible ; « ^VIX » sous sa moyenne = marché calme
  externe_sous_ema: (c, I, i, p) => { const s = serieExterne(c, I, p); return s.val[i] != null && s.val[i] < s.moy[i]; },
  externe_sur_ema: (c, I, i, p) => { const s = serieExterne(c, I, p); return s.val[i] != null && s.val[i] > s.moy[i]; },
  // --- Vague 7 : la peur qui s'emballe. Le marché externe (le VIX) au moins « ecart_pct » % au-dessus de sa moyenne, « jours » bougies de suite
  externe_ecart_sur: (c, I, i, p) => { const s = serieExterne(c, I, p), e = 1 + (p.ecart_pct ?? 5) / 100, n = p.jours || 1; if (i < n - 1) return false; for (let k = i - n + 1; k <= i; k++) if (!(s.val[k] != null && s.moy[k] != null && s.val[k] > s.moy[k] * e)) return false; return true; },
};
// Marchés externes autorisés comme filtre (séries journalières Yahoo, 10 ans)
const EXTERNES = { "DX-Y.NYB": "indice du dollar", "^VIX": "VIX (peur des marchés)" };
function symbolesExternes(strat) {
  const s = new Set();
  for (const l of [strat.entree_long, strat.entree_short, strat.sortie_long, strat.sortie_short]) for (const k of l || []) if (/^externe_/.test(k.type)) s.add(String(k.symbole || ""));
  return [...s];
}
// Télécharge une fois les séries externes dont la stratégie a besoin. Une erreur ici annule le test (il n'est pas compté).
async function externesDe(strat) {
  const out = {}, syms = symbolesExternes(strat || {});
  for (const sym of syms) if (!EXTERNES[sym]) throw new Error("marché externe inconnu : « " + sym + " ». Possibles : " + Object.keys(EXTERNES).join(", "));
  await Promise.all(syms.map(async (sym) => {
    let candles;
    try { candles = (await core().yahooChart(sym, "1d", "10y")).candles; } catch (e) { throw new Error(EXTERNES[sym] + " : " + e.message); }
    const c = (candles || []).filter((x) => x.c > 0).sort((a, b) => a.t - b.t);
    if (c.length < 500) throw new Error(EXTERNES[sym] + " : seulement " + c.length + " jours de données");
    out[sym] = c;
  }));
  return out;
}
const COND_LISTE = Object.keys(COND);

function verifie(conds, c, I, i) {
  for (const k of conds || []) {
    const f = COND[k.type];
    if (!f) throw new Error("condition inconnue : " + k.type + ". Possibles : " + COND_LISTE.join(", "));
    if (!f(c, I, i, k)) return false;
  }
  return true;
}

// ---------- Simulation ----------
function slippageDefaut(sym) {
  if (/-USD$/.test(sym)) return 0.03;
  if (/=X$/.test(sym)) return 0.004;
  if (/^\^|=F$/.test(sym)) return 0.01;
  return 0.02;
}

// Prépare ce qui sert à chaque trade (indicateurs, volatilité normale, règles de stop et d'objectif)
function preparer(c, strat, fraisPct, slipPct, nuitPct, ext) {
  const I = makeInd(c), atr = I.atr(14);
  I.ext = ext || null;   // séries journalières d'autres marchés (dollar, VIX) pour les conditions « externe_… »
  // volatilité « normale » de l'actif (médiane de l'ATR en %), pour gonfler le glissement quand ça s'agite
  const atrPct = atr.map((a, k) => (a && c[k].c ? a / c[k].c : null)).filter((x) => x != null).sort((a, b) => a - b);
  return {
    c, I, atr, fraisPct, slipPct: slipPct || 0,
    medAtr: atrPct.length ? atrPct[Math.floor(atrPct.length / 2)] : 0.01,
    coutMax: (strat.cout_max_pct_stop ?? 25) / 100,
    stopM: strat.stop || { type: "atr", mult: 1.5 }, objM: strat.objectif || { type: "R", val: 2 },
    maxBars: strat.duree_max_bougies || 50, start: Math.max(210, 30),
    // vague 6 : stop qui suit la tendance, à « suiveur_atr » ATR derrière le meilleur prix atteint (il ne recule jamais)
    suiveur: strat.stop && strat.stop.suiveur_atr > 0 ? +strat.stop.suiveur_atr : null,
    // vague 2 : entrée à la clôture de la bougie du signal, sortie à heure fixe (Paris), frais de nuit des CFD
    entreeCloture: strat.entree === "cloture", sortieH: strat.sortie_heure != null ? +strat.sortie_heure : null, nuitPct: strat.frais_nuit ? nuitPct || 0 : 0,
    hP: strat.sortie_heure != null ? c.map((b) => heureParis(b.t)) : null, jP: strat.sortie_heure != null ? c.map((b) => jourParis(b.t)) : null,   // calculés une fois : la comparaison au hasard rejoue des centaines de milliers de trades
    // vague 4 : sortie quand une condition devient vraie (ex. le RSI repasse 50), à l'ouverture de la bougie suivante
    sortieL: strat.sortie_long && strat.sortie_long.length ? strat.sortie_long : null, sortieS: strat.sortie_short && strat.sortie_short.length ? strat.sortie_short : null,
  };
}

// Exécute un trade décidé à la clôture de la bougie i (entrée à l'ouverture suivante).
// Renvoie null (impossible), "filtre" (frais trop lourds pour ce stop) ou { trade, j }.
function executer(X, i, dir) {
  const { c, atr, medAtr, fraisPct, slipPct, coutMax, stopM, objM, maxBars, sortieH } = X, a = atr[i];
  const vol = Math.min(3, Math.max(0.5, (a / c[i].c) / medAtr)), slip = (slipPct * vol) / 100;
  const e = (X.entreeCloture ? c[i].c : c[i + 1].o) * (1 + dir * slip); // entrée au marché : glissement défavorable
  let stop;
  if (stopM.type === "pct") stop = e * (1 - dir * stopM.val / 100);
  else if (stopM.type === "swing") { const n = stopM.periode || 10; stop = dir > 0 ? Math.min(...c.slice(i - n + 1, i + 1).map((x) => x.l)) - a * 0.1 : Math.max(...c.slice(i - n + 1, i + 1).map((x) => x.h)) + a * 0.1; }
  else if (stopM.type === "range") { const n = stopM.periode || 40, m = (stopM.marge_atr ?? 0.25) * a; stop = dir > 0 ? Math.min(X.I.basMin(n)[i], c[i].l) - m : Math.max(X.I.hautMax(n)[i], c[i].h) + m; }
  else stop = e - dir * a * (stopM.mult || 1.5);
  const risque = Math.abs(e - stop);
  if (!(risque > 0) || (dir > 0 ? stop >= e : stop <= e)) return null;
  // filtre de qualité : si frais + glissement mangent une trop grosse part du stop, on ne prend pas le trade
  if ((e * (2 * fraisPct / 100 + 2 * slip)) > risque * coutMax) return "filtre";
  let obj;
  if (objM.type === "range") {   // bord opposé (ou milieu) du range des N dernières bougies, avec une petite marge pour être rempli
    const n = objM.periode || 40, h = X.I.hautMax(n)[i], l = X.I.basMin(n)[i];
    if (h == null || l == null) return null;
    obj = objM.cible === "milieu" ? (h + l) / 2 : dir > 0 ? h - (objM.marge_atr ?? 0.1) * a : l + (objM.marge_atr ?? 0.1) * a;
    if (dir > 0 ? obj <= e : obj >= e) return null;
    if (Math.abs(obj - e) / risque < (objM.ratio_min ?? 1)) return null;   // gain trop petit par rapport au risque
  } else if (objM.type === "zone") {   // vague 7 : milieu ou bord opposé de la veille (« veille ») ou du range de la nuit (« asie »)
    const z = objM.zone === "asie" ? rangeOuverture(c, X.I, objM.heure || "01:00", objM.minutes || 420) : null, V = z ? null : niveauxVeille(c, X.I);
    const h = z ? z.hi[i] : V.pH[i], l = z ? z.lo[i] : V.pL[i];
    if (h == null || l == null) return null;
    obj = objM.cible === "milieu" ? (h + l) / 2 : dir > 0 ? h - (objM.marge_atr ?? 0.1) * a : l + (objM.marge_atr ?? 0.1) * a;
    if (dir > 0 ? obj <= e : obj >= e) return null;
    if (Math.abs(obj - e) / risque < (objM.ratio_min ?? 1)) return null;
  } else obj = objM.type === "atr" ? e + dir * a * (objM.mult || 3) : e + dir * risque * (objM.val || 2);
  let sortie = null, j = i + 1, raison = "", meilleur = e;
  const sortieC = dir > 0 ? X.sortieL : X.sortieS;
  for (; j < c.length && j <= i + maxBars; j++) {
    const b = c[j];
    // sortie à heure fixe : à l'ouverture de la première bougie qui atteint cette heure (le lendemain si on la dépasse déjà)
    if (sortieH != null && j > i + 1) { const h = X.hP[j], hp = X.hP[j - 1]; if (h >= sortieH && (hp < sortieH || X.jP[j] !== X.jP[j - 1])) { sortie = b.o * (1 - dir * slip); raison = "heure"; break; } }
    const touchStop = dir > 0 ? b.l <= stop : b.h >= stop, touchObj = dir > 0 ? b.h >= obj : b.l <= obj;
    // Limite connue (gardée pour que tous les tests de la campagne restent comparables) : après la première bougie, un écart de prix
    // à l'ouverture au-delà du stop sort encore au niveau du stop, un peu optimiste. À corriger un jour pour TOUS les tests d'un coup.
    if (touchStop) { const px = j === i + 1 && (dir > 0 ? b.o < stop : b.o > stop) ? b.o : stop; sortie = px * (1 - dir * slip); raison = "stop"; break; } // stop au marché : glissement ; prudence : stop avant objectif // stop au marché : glissement ; prudence : stop avant objectif
    if (touchObj) { sortie = obj; raison = "objectif"; break; }
    // condition de sortie vraie à la clôture de cette bougie : on sort au marché à l'ouverture de la suivante (glissement compté)
    if (sortieC && verifie(sortieC, c, X.I, j)) { if (j + 1 < c.length) { j++; sortie = c[j].o * (1 - dir * slip); } else sortie = c[j].c * (1 - dir * slip); raison = "condition"; break; }
    // stop suiveur : recalculé à la clôture de cette bougie, il ne servira qu'aux bougies suivantes (aucune information du futur)
    if (X.suiveur) { meilleur = dir > 0 ? Math.max(meilleur, b.h) : Math.min(meilleur, b.l); const ns = meilleur - dir * X.suiveur * (X.atr[j] || a); if (dir > 0 ? ns > stop : ns < stop) stop = ns; }
  }
  if (sortie == null) { j = Math.min(j, c.length - 1); sortie = c[j].c * (1 - dir * slip); raison = "temps"; }
  const nuits = X.nuitPct ? Math.max(0, Math.floor((c[j].t + (decalageParis(c[j].t) + 1) * 3600000) / 86400000) - Math.floor((c[i + 1].t + (decalageParis(c[i + 1].t) + 1) * 3600000) / 86400000)) : 0;   // passages de 23 h (Paris), l'heure où les CFD facturent la nuit
  const frais = (e + sortie) * fraisPct / 100 + e * nuits * X.nuitPct / 100;
  const R = (((sortie - e) * dir) - frais) / risque;
  return { trade: { t: c[i + 1].t, sortieT: c[j].t, sens: dir > 0 ? "long" : "short", entree: e, sortie, R, raison, bougies: j - i }, j };
}

function simuler(c, strat, fraisPct, slipPct, nuitPct, ext) {
  const X = preparer(c, strat, fraisPct, slipPct, nuitPct, ext), I = X.I, trades = [];
  let filtres = 0, i = X.start;
  while (i < c.length - 2) {
    const L = strat.entree_long && strat.entree_long.length && verifie(strat.entree_long, c, I, i);
    const S = !L && strat.entree_short && strat.entree_short.length && verifie(strat.entree_short, c, I, i);
    if (!L && !S) { i++; continue; }
    const r = executer(X, i, L ? 1 : -1);
    if (r === null) { i++; continue; }
    if (r === "filtre") { filtres++; i++; continue; }
    trades.push(r.trade);
    i = r.j + 1;
  }
  trades.filtres = filtres;
  trades.X = X;
  return trades;
}

// Face au hasard : on rejoue les MÊMES règles de sortie (stop, objectif, durée max), frais, glissement,
// et la même proportion de long/short, mais avec des moments d'entrée tirés au hasard.
// Si la stratégie ne fait pas mieux que ces tirages, son « avantage » vient de la tendance du marché, pas de ses règles.
function faceAuHasard(trades, seuil) {
  seuil = seuil || 0.9;
  const X = trades.X, K = trades.length;
  if (!X || K < 10) return null;
  const sens = trades.map((t) => (t.sens === "long" ? 1 : -1));
  const lo = X.start, hi = X.c.length - 3;
  if (hi - lo < 50) return null;
  let s = 1234567 + K * 7919; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  // plus le seuil est exigeant, plus il faut de tirages pour le mesurer finement
  const tirages = seuil > 0.98 ? Math.max(60, Math.min(400, Math.floor(1200000 / K))) : Math.max(60, Math.min(200, Math.floor(600000 / K)));
  const moy = [];
  for (let r = 0; r < tirages; r++) {
    let somme = 0, k = 0, essais = 0;
    while (k < K && essais < K * 20) {
      essais++;
      const res = executer(X, lo + Math.floor(rnd() * (hi - lo)), sens[Math.floor(rnd() * K)]);
      if (!res || res === "filtre") continue;
      somme += res.trade.R; k++;
    }
    if (k >= Math.min(K, 10)) moy.push(somme / k);
  }
  if (moy.length < 30) return null;
  const strat = trades.reduce((a, t) => a + t.R, 0) / K, tri = moy.slice().sort((a, b) => a - b);
  const q = (p) => tri[Math.min(tri.length - 1, Math.floor(tri.length * p))], r2 = (x) => Math.round(x * 100) / 100;
  const part = moy.filter((m) => m < strat).length / moy.length;
  return {
    tirages: moy.length, trades_par_tirage: K,
    esperance_strategie: r2(strat), esperance_hasard_mediane: r2(q(0.5)), hasard_p5: r2(q(0.05)), hasard_p95: r2(q(0.95)),
    part_des_tirages_battus: Math.round(part * 1000) / 1000, seuil, bat_le_hasard: part >= seuil,
    methode: "mêmes stops, objectifs, sorties, durée max, frais, glissement et proportion long/short ; seuls les moments d'entrée sont tirés au hasard",
  };
}

// Bootstrap : on retire au hasard (avec remise) des trades parmi ceux de la validation, 3000 fois.
// Si dans 90 % des tirages l'espérance reste positive, le résultat est peu probablement dû à la chance.
function bootstrap(trades) {
  const R = trades.map((t) => t.R); if (R.length < 10) return null;
  let s = 987654321; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const moy = [], n = R.length; let pos = 0;
  for (let b = 0; b < 3000; b++) { let sum = 0; for (let i = 0; i < n; i++) sum += R[Math.floor(rnd() * n)]; const m = sum / n; moy.push(m); if (m > 0) pos++; }
  moy.sort((a, b) => a - b); const r = (x) => Math.round(x * 100) / 100;
  return { tirages: 3000, trades: n, proba_esperance_positive: r(pos / 3000), esperance_p5: r(moy[Math.floor(3000 * 0.05)]), esperance_mediane: r(moy[1500]), esperance_p95: r(moy[Math.floor(3000 * 0.95)]) };
}

// Capital simulé : 10 000 $, risque fixe de 1 % du capital par trade (intérêts composés)
function capital(trades, depart, risquePct) {
  let eq = depart, pic = depart, dd = 0; const courbe = [];
  for (const t of trades) { eq *= 1 + (risquePct / 100) * t.R; pic = Math.max(pic, eq); dd = Math.min(dd, eq / pic - 1); courbe.push([t.t, Math.round(eq)]); }
  const ret = (eq / depart - 1) * 100, r = (x) => Math.round(x * 100) / 100;
  const g = trades.length ? Math.pow(eq / depart, 1 / trades.length) : 1;
  return { depart, final: Math.round(eq), rendement_pct: r(ret), drawdown_max_pct: r(dd * 100), ratio_rendement_dd: dd < 0 ? r(ret / Math.abs(dd * 100)) : null, trades_pour_doubler: g > 1 ? Math.ceil(Math.log(2) / Math.log(g)) : null, courbe };
}

// Walk-forward : la période est découpée en 5 fenêtres successives, on regarde si l'avantage tient dans chacune
function walkForward(trades, debut, fin, n) {
  const out = [], pas = (fin - debut) / n;
  for (let k = 0; k < n; k++) {
    const a = debut + k * pas, b = a + pas, tr = trades.filter((t) => t.t >= a && t.t < b), st = stats(tr);
    out.push({ debut: a, fin: b, trades: st.trades || 0, esperance_R: st.esperance_R ?? 0, profit_factor: st.profit_factor ?? 0 });
  }
  return out;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const gains = trades.filter((t) => t.R > 0), sumG = gains.reduce((s, t) => s + t.R, 0), sumP = Math.abs(trades.filter((t) => t.R <= 0).reduce((s, t) => s + t.R, 0));
  let eq = 0, pic = 0, dd = 0, serie = 0, pire = 0;
  for (const t of trades) { eq += t.R; pic = Math.max(pic, eq); dd = Math.min(dd, eq - pic); serie = t.R <= 0 ? serie + 1 : 0; pire = Math.max(pire, serie); }
  const r = (x) => Math.round(x * 100) / 100;
  return { trades: n, reussite_pct: r((gains.length / n) * 100), esperance_R: r((sumG - sumP) / n), total_R: r(sumG - sumP), profit_factor: sumP ? r(sumG / sumP) : 99, drawdown_max_R: r(dd), pertes_consecutives_max: pire, duree_moy_bougies: r(trades.reduce((s, t) => s + t.bougies, 0) / n) };
}

const pctTxt = (x) => (Math.round(x * 1000) / 10).toString().replace(".", ",") + " %";

function verdict(is, oos, extra) {
  const r = (x) => Math.round(x * 100) / 100, minOOS = extra.unite === "1j" || extra.unite === "1s" ? 40 : 25;
  const crit = [
    { nom: "Trades en validation", ok: (oos.trades || 0) >= minOOS, valeur: oos.trades || 0, seuil: "≥ " + minOOS },
    { nom: "Espérance en validation", ok: (oos.esperance_R ?? -9) > 0.15, valeur: (oos.esperance_R ?? 0) + " R", seuil: "> 0,15 R" },
    { nom: "Profit factor en validation", ok: (oos.profit_factor ?? 0) > 1.3, valeur: oos.profit_factor ?? 0, seuil: "> 1,3" },
    { nom: "Drawdown maximal", ok: (extra.global.drawdown_max_R ?? -99) > -15, valeur: (extra.global.drawdown_max_R ?? 0) + " R", seuil: "moins de 15 R" },
    { nom: "Années positives", ok: extra.anneesOk >= 0.7, valeur: Math.round(extra.anneesOk * 100) + " %", seuil: "≥ 70 %" },
    { nom: "Fenêtres walk-forward positives", ok: extra.wfOk >= 0.6, valeur: Math.round(extra.wfOk * 100) + " %", seuil: "≥ 60 %" },
  ];
  if (extra.boot) crit.push({ nom: "Confiance bootstrap (pas la chance)", ok: extra.boot.proba_esperance_positive >= 0.9, valeur: Math.round(extra.boot.proba_esperance_positive * 100) + " %", seuil: "≥ 90 %" });
  if (extra.hasard) crit.push({ nom: "Bat le hasard (seuil " + pctTxt(extra.hasard.seuil) + (extra.essai > 1 ? ", essai n° " + extra.essai : "") + ")", ok: extra.hasard.bat_le_hasard, valeur: pctTxt(extra.hasard.part_des_tirages_battus), seuil: "≥ " + pctTxt(extra.hasard.seuil) });
  if (extra.coffre && extra.coffre.ouvert) { const k = extra.coffre.stats || {}; crit.push({ nom: "Coffre-fort (période jamais vue)", ok: (k.trades || 0) >= 10 && (k.esperance_R ?? -9) > 0 && (k.profit_factor ?? 0) > 1.2, valeur: (k.trades || 0) + " trades, " + (k.esperance_R ?? 0) + " R", seuil: "≥ 10 trades, > 0 R, PF > 1,2" }); }
  const ko = crit.filter((x) => !x.ok).map((x) => x.nom.toLowerCase());
  const total = (is.trades || 0) + (oos.trades || 0);
  let note, texte;
  if (total < 30 || (oos.trades || 0) < 10) { note = "insuffisant"; texte = "Pas assez de trades pour conclure. Allonge la période, change d'unité de temps ou assouplis les conditions."; }
  else if (!ko.length) { note = "robuste"; texte = "Tous les critères sont validés, y compris sur la période jamais vue et dans le temps. À confirmer en démo avant tout argent réel."; }
  else if ((is.esperance_R ?? 0) > 0.1 && (oos.esperance_R ?? 0) <= 0) { note = "sur-optimisee"; texte = "Elle gagne sur l'historique d'étude mais perd sur la période de validation : signe classique de sur-optimisation."; }
  else if (extra.hasard && !extra.hasard.bat_le_hasard && (oos.esperance_R ?? 0) > 0 && (extra.global.esperance_R ?? 0) > 0) { note = "fragile"; texte = "Elle gagne, mais des entrées au hasard avec les mêmes règles font presque aussi bien (elle ne bat que " + Math.round(extra.hasard.part_des_tirages_battus * 100) + " % des tirages) : le gain vient surtout de la tendance du marché, pas de ses conditions d'entrée." + (ko.length > 1 ? " Autres critères non tenus : " + ko.filter((x) => x.indexOf("hasard") < 0).join(", ") + "." : ""); }
  else if ((oos.esperance_R ?? 0) > 0 && (extra.global.esperance_R ?? 0) > 0) { note = "fragile"; texte = "Positive, mais pas assez solide. Critères non tenus : " + ko.join(", ") + "."; }
  else { note = "perdante"; texte = "Pas d'avantage statistique après frais et glissement."; }
  return { note, texte, criteres: crit };
}

// ---------- Objectif prop firm de Geremy : au moins 2 % par mois, sans jamais mettre le compte en danger ----------
// Règles d'une prop firm : -5 % max sur une journée, -10 % max au total. On garde une marge : pire journée > -3 %, pire baisse < 6 %.
// On cherche le risque par trade le plus élevé qui respecte ces marges, puis on regarde le gain mensuel moyen à ce risque.
const PROP = { gain_mensuel_min: 2, pire_baisse_max: 6, pire_jour_max: 3, niveaux: [0.25, 0.5, 0.75, 1] };
function objectifPropFirm(trades, debut, fin) {
  const mois = Math.max(1, (fin - debut) / (30.44 * 86400000)), r2 = (x) => Math.round(x * 100) / 100;
  if (trades.length < 10) return null;
  const essais = PROP.niveaux.map((r) => {
    let eq = 0, pic = 0, dd = 0; const jours = {}, parMois = {};
    for (const t of trades) {
      const g = t.R * r; eq += g; pic = Math.max(pic, eq); dd = Math.min(dd, eq - pic);
      const d = new Date(t.sortieT || t.t).toISOString(); jours[d.slice(0, 10)] = (jours[d.slice(0, 10)] || 0) + g; parMois[d.slice(0, 7)] = (parMois[d.slice(0, 7)] || 0) + g;
    }
    const m = Object.values(parMois);
    return { risque_pct: r, gain_mensuel_pct: r2(eq / mois), pire_baisse_pct: r2(dd), pire_jour_pct: r2(Math.min(0, ...Object.values(jours))), mois_positifs_pct: m.length ? Math.round((m.filter((x) => x > 0).length / m.length) * 100) : 0 };
  });
  const surs = essais.filter((x) => x.pire_baisse_pct > -PROP.pire_baisse_max && x.pire_jour_pct > -PROP.pire_jour_max);
  const choix = surs.length ? surs[surs.length - 1] : null;
  const compatible = !!choix && choix.gain_mensuel_pct >= PROP.gain_mensuel_min;
  let texte;
  if (essais.every((x) => x.gain_mensuel_pct <= 0)) texte = "Perdante : aucun niveau de risque ne la rend rentable.";
  else if (!choix) texte = "Trop dangereuse pour une prop firm : même à 0,25 % de risque par trade, la pire baisse ou la pire journée dépasse les marges de sécurité.";
  else if (compatible) texte = "Compatible avec ton objectif : à " + String(choix.risque_pct).replace(".", ",") + " % de risque par trade, environ " + String(choix.gain_mensuel_pct).replace(".", ",") + " % par mois, pire baisse " + String(choix.pire_baisse_pct).replace(".", ",") + " %.";
  else texte = "Pas assez rentable pour ton objectif : au risque le plus élevé qui reste sûr (" + String(choix.risque_pct).replace(".", ",") + " %), elle ne fait qu'environ " + String(choix.gain_mensuel_pct).replace(".", ",") + " % par mois, pour 2 % visés.";
  return { objectif: "≥ 2 % par mois, pire baisse < 6 %, pire journée > -3 %", trades_par_mois: r2(trades.length / mois), risque_conseille_pct: choix ? choix.risque_pct : null, gain_mensuel_pct: choix ? choix.gain_mensuel_pct : null, pire_baisse_pct: choix ? choix.pire_baisse_pct : null, pire_jour_pct: choix ? choix.pire_jour_pct : null, mois_positifs_pct: choix ? choix.mois_positifs_pct : null, compatible, texte, niveaux: essais };
}

// ---------- Coffre-fort : la période la plus récente est cachée de tous les tests ----------
// 12 derniers mois si l'historique dépasse 3 ans, sinon les 20 % les plus récents. On ne l'ouvre qu'une fois, pour la finaliste.
function coupeCoffre(c) {
  const debut = c[0].t, fin = c[c.length - 1].t, duree = fin - debut;
  return fin - (duree >= 3 * 365 * 86400000 ? 365 * 86400000 : duree * 0.2);
}

// ---------- Registre de campagne : chaque essai compte, et la barre monte avec le nombre d'essais ----------
const KEY_CAMP = "alphie:campagne";
async function lireCampagne() {
  try { const r = await core().redis(["GET", KEY_CAMP]); if (r) return JSON.parse(r); } catch (e) {}
  return { debut: Date.now(), essais: [], coffres: [] };
}
async function ecrireCampagne(k) { try { await core().redis(["SET", KEY_CAMP, JSON.stringify(k)]); } catch (e) {} }
// Correction des tests multiples (Bonferroni) : 1 essai → 90 %, 10 essais → 99 %, 20 essais et plus → 99,5 %
const seuilHasard = (n) => Math.round(Math.min(0.995, 1 - 0.1 / Math.max(1, n)) * 1000) / 1000;

async function lancerUn(a, ctx) {
  const strat = a.strategie || {};
  const unite = UNITES[a.unite] ? a.unite : "1j";
  const sym = await symbole(a.actif);
  const { meta, c: cTout, source, detail } = await bougies(sym, unite);
  const cut = coupeCoffre(cTout), avant = cTout.filter((b) => b.t < cut);
  const c = ctx.ouvrir ? cTout : avant;   // coffre fermé : les bougies récentes ne sont même pas simulées
  if (avant.length < 300) throw new Error("pas assez d'historique hors coffre-fort (" + avant.length + " bougies)");
  const fraisPct = a.frais_pct != null ? +a.frais_pct : fraisDefaut(sym);
  const slipPct = a.slippage_pct != null ? +a.slippage_pct : slippageDefaut(sym);
  const trades = simuler(c, strat, fraisPct, slipPct, fraisNuitDefaut(sym), ctx.ext);
  const coupure = avant[Math.floor(avant.length * 0.7)].t;
  const horsCoffre = trades.filter((t) => t.t < cut);
  const is = stats(horsCoffre.filter((t) => t.t < coupure)), oos = stats(horsCoffre.filter((t) => t.t >= coupure)), tout = stats(trades);
  const coffre = { depuis: cut, ouvert: !!ctx.ouvrir, mois: Math.round((cTout[cTout.length - 1].t - cut) / (30.44 * 86400000)), stats: ctx.ouvrir ? stats(trades.filter((t) => t.t >= cut)) : null };
  let eq = 0; const courbe = trades.map((t) => [t.t, Math.round((eq += t.R) * 100) / 100]);
  const parAn = {}; trades.forEach((t) => { const y = new Date(t.t).getUTCFullYear(); parAn[y] = Math.round(((parAn[y] || 0) + t.R) * 100) / 100; });
  const annees = Object.keys(parAn).filter((y) => trades.filter((t) => new Date(t.t).getUTCFullYear() === +y).length >= 3);
  const anneesOk = annees.length ? annees.filter((y) => parAn[y] > 0).length / annees.length : 0;
  const debutUtile = c[Math.min(210, c.length - 1)].t, finSim = c[c.length - 1].t;
  const wf = walkForward(trades, debutUtile, finSim, 5);
  const wfActives = wf.filter((w) => w.trades >= 3), wfOk = wfActives.length ? wfActives.filter((w) => w.esperance_R > 0).length / wfActives.length : 0;
  const cap = capital(trades, 10000, 1);
  const boot = bootstrap(horsCoffre.filter((t) => t.t >= coupure));
  const hasard = faceAuHasard(trades, ctx.seuil);
  const prop = objectifPropFirm(trades, debutUtile, finSim);
  const v = verdict(is, oos, { unite, global: tout, anneesOk, wfOk, boot, hasard, essai: ctx.essai, coffre });
  const res = {
    id: "B" + Date.now().toString(36) + Math.floor(Math.random() * 1000), date: Date.now(), nom: strat.nom || "Stratégie", actif: meta.longName || meta.shortName || sym, symbole: sym, unite, source: source || "Yahoo", source_detail: detail || source || "Yahoo", annees_testees: Math.round(((c[c.length - 1].t - c[0].t) / (365.25 * 86400000)) * 10) / 10, bougies: c.length,
    periode: { debut: c[0].t, fin: finSim, coupure_validation: coupure }, coffre, essai: ctx.essai, hasard, prop, frais_pct_par_cote: fraisPct, glissement_pct_base: slipPct, trades_filtres_cout: trades.filtres || 0,
    bootstrap: boot, capital: Object.assign({}, cap, { courbe: cap.courbe.length > 150 ? cap.courbe.filter((_, i) => i % Math.ceil(cap.courbe.length / 150) === 0 || i === cap.courbe.length - 1) : cap.courbe }), walk_forward: wf,
    strategie: strat, global: tout, etude: is, validation: oos, par_annee: parAn, verdict: v,
    courbe: courbe.length > 150 ? courbe.filter((_, i) => i % Math.ceil(courbe.length / 150) === 0 || i === courbe.length - 1) : courbe,
    derniers_trades: trades.slice(-5).map((t) => ({ date: new Date(t.t).toISOString().slice(0, 10), sens: t.sens, R: Math.round(t.R * 100) / 100, sortie: t.raison })),
  };
  return res;
}

// ---------- Vague 1 de la campagne : 9 idées définies une fois pour toutes (aucune recopie, donc aucune erreur) ----------
// Les marchés sont choisis pour avoir le plus d'historique : Dukascopy (10 ans) pour l'or, l'EURUSD et le Nasdaq en 1 h et 4 h,
// Binance (5 à 6 ans) pour les cryptos, Yahoo (10 ans) en journalier.
const TENDANCE = ["GC=F", "EURUSD=X", "^NDX"], CRYPTOS = ["BTC", "ETH", "SOL"];
// Instruments Dukascopy dont la campagne a besoin (forex, or, indices en 1 h ou 4 h)
function instrumentsCampagne() {
  const s = new Set();
  for (const v of TOUS_LES_TESTS) if (v.unite === "1h" || v.unite === "4h") for (const sym of v.actifs) { if (baseCrypto(sym)) continue; const dk = nomDukascopy(sym); if (dk) s.add(dk); }
  for (const dk of Object.values(DK_REJEU)) s.add(dk);   // les marchés d'Alphie, pour le rejeu du témoin (dont la livre-dollar)
  return [...s];
}
const VAGUE_1 = [
  { id: "V1-1", famille: "Suivi de tendance", unite: "4h", actifs: TENDANCE, strategie: { nom: "Tortues : cassure des 55 bougies", entree_long: [{ type: "cassure_plus_haut", periode: 55 }], entree_short: [{ type: "cassure_plus_bas", periode: 55 }], stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 120 } },
  { id: "V1-2", famille: "Suivi de tendance", unite: "4h", actifs: TENDANCE, strategie: { nom: "Croisement EMA 50 / EMA 200", entree_long: [{ type: "ema_croise_haut", rapide: 50, lente: 200 }], entree_short: [{ type: "ema_croise_bas", rapide: 50, lente: 200 }], stop: { type: "atr", mult: 2.5 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 150 } },
  { id: "V1-3", famille: "Suivi de tendance", unite: "4h", actifs: TENDANCE, strategie: { nom: "Momentum 3 mois + repli", entree_long: [{ type: "momentum_haussier", periode: 378 }, { type: "prix_au_dessus_ema", periode: 200 }, { type: "rsi_croise_haut", periode: 14, seuil: 40 }], entree_short: [{ type: "momentum_baissier", periode: 378 }, { type: "prix_sous_ema", periode: 200 }, { type: "rsi_croise_bas", periode: 14, seuil: 60 }], stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 2.5 }, duree_max_bougies: 60 } },
  { id: "V1-4", famille: "Suivi de tendance", unite: "1h", actifs: ["BTC", "ETH", "GC=F"], strategie: { nom: "Repli en tendance : RSI repasse 40 au-dessus de l'EMA 200", entree_long: [{ type: "prix_au_dessus_ema", periode: 200 }, { type: "adx_sur", seuil: 20 }, { type: "rsi_croise_haut", periode: 14, seuil: 40 }], entree_short: [{ type: "prix_sous_ema", periode: 200 }, { type: "adx_sur", seuil: 20 }, { type: "rsi_croise_bas", periode: 14, seuil: 60 }], stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 48 } },
  { id: "V1-5", famille: "Retour à la moyenne", unite: "1j", actifs: ["^NDX", "^GSPC", "^GDAXI"], strategie: { nom: "RSI 2 de Connors (indices)", entree_long: [{ type: "prix_au_dessus_ema", periode: 200 }, { type: "rsi_sous", periode: 2, seuil: 10 }], stop: { type: "atr", mult: 2.5 }, objectif: { type: "R", val: 1 }, duree_max_bougies: 5 } },
  { id: "V1-6", famille: "Calendrier", unite: "1h", actifs: CRYPTOS, strategie: { nom: "Cryptos : continuation pendant la session de New York", entree_long: [{ type: "heure_entre", debut: 15, fin: 17 }, { type: "prix_au_dessus_ema", periode: 200 }, { type: "momentum_haussier", periode: 24 }], entree_short: [{ type: "heure_entre", debut: 15, fin: 17 }, { type: "prix_sous_ema", periode: 200 }, { type: "momentum_baissier", periode: 24 }], stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 12 } },
  { id: "V1-7", famille: "Setups d'Alphie", unite: "1h", actifs: ["GC=F", "EURUSD=X", "BTC"], strategie: { nom: "S1 : repli en zone OTE + order block, en tendance", entree_long: [{ type: "prix_au_dessus_ema", periode: 200 }, { type: "discount", periode: 50, niveau: 0.382 }, { type: "order_block_haussier" }], entree_short: [{ type: "prix_sous_ema", periode: 200 }, { type: "premium", periode: 50, niveau: 0.618 }, { type: "order_block_baissier" }], stop: { type: "swing", periode: 10 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 48 } },
  { id: "V1-8", famille: "Setups d'Alphie", unite: "1h", actifs: ["BTC", "ETH", "^NDX"], strategie: { nom: "S2 : changement de structure depuis un extrême", entree_long: [{ type: "choch_haussier" }, { type: "discount", periode: 48, niveau: 0.3 }], entree_short: [{ type: "choch_baissier" }, { type: "premium", periode: 48, niveau: 0.7 }], stop: { type: "swing", periode: 10 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 48 } },
  { id: "V1-9", famille: "Range", unite: "1h", actifs: ["GC=F", "EURUSD=X", "BTC"], strategie: { nom: "S4 : rebond au bord d'un range", entree_long: [{ type: "marche_en_range", periode: 40 }, { type: "balayage_bas", periode: 40 }], entree_short: [{ type: "marche_en_range", periode: 40 }, { type: "balayage_haut", periode: 40 }], stop: { type: "range", periode: 40, marge_atr: 0.25 }, objectif: { type: "range", periode: 40, cible: "oppose", ratio_min: 1.5 }, duree_max_bougies: 40 } },
];

// ---------- Vague 2 : la liquidité de Geremy, les heures des gros acteurs, et des effets étudiés mais peu joués ----------
// Tendance de fond lue « en grande unité » sans changer d'écran : EMA 800 en 1 h ≈ EMA 200 en 4 h. Liquidité = plus haut / plus bas des 48 dernières heures.
// Toutes comptent les frais de nuit des CFD (financement), ce que la vague 1 ne faisait pas : un peu plus sévère, donc plus réaliste.
// V2-7 et V2-8 jouent une plage horaire : le stop large (4 ATR) n'est qu'une sécurité, c'est l'heure de sortie qui compte.
const LIQ = { periode: 48, fenetre: 6 }, VERS_LIQ = { type: "range", periode: 48, cible: "oppose", ratio_min: 1.5, marge_atr: 0.1 }, INDICES = ["^NDX", "^GSPC", "^GDAXI"];
const VAGUE_2 = [
  { id: "V2-1", famille: "Liquidité (Geremy)", unite: "1h", actifs: TENDANCE, strategie: { nom: "Aller chercher la liquidité : repli sur FVG dans la tendance", entree_long: [{ type: "prix_au_dessus_ema", periode: 800 }, { type: "retour_fvg_haussier", fenetre: 12 }], entree_short: [{ type: "prix_sous_ema", periode: 800 }, { type: "retour_fvg_baissier", fenetre: 12 }], stop: { type: "swing", periode: 5 }, objectif: VERS_LIQ, duree_max_bougies: 48, frais_nuit: true } },
  { id: "V2-2", famille: "Liquidité (Geremy)", unite: "1h", actifs: TENDANCE, strategie: { nom: "Liquidité prise puis CHoCH : retournement", entree_long: [Object.assign({ type: "balayage_bas_recent" }, LIQ), { type: "choch_haussier" }], entree_short: [Object.assign({ type: "balayage_haut_recent" }, LIQ), { type: "choch_baissier" }], stop: { type: "swing", periode: 8 }, objectif: VERS_LIQ, duree_max_bougies: 48, frais_nuit: true } },
  { id: "V2-3", famille: "Liquidité (Geremy)", unite: "1h", actifs: TENDANCE, strategie: { nom: "Balayage + divergence RSI + FVG", entree_long: [Object.assign({ type: "balayage_bas_recent" }, LIQ), { type: "divergence_rsi_haussiere", periode: 14, fenetre: 6, retour: 48 }, { type: "fvg_haussier" }], entree_short: [Object.assign({ type: "balayage_haut_recent" }, LIQ), { type: "divergence_rsi_baissiere", periode: 14, fenetre: 6, retour: 48 }, { type: "fvg_baissier" }], stop: { type: "swing", periode: 8 }, objectif: VERS_LIQ, duree_max_bougies: 48, frais_nuit: true } },
  { id: "V2-4", famille: "Heures des gros acteurs", unite: "1h", actifs: TENDANCE, strategie: { nom: "Range asiatique cassé à l'ouverture de Londres", entree_long: [{ type: "cassure_ouverture_haut", heure: "01:00", minutes: 420, fenetre_minutes: 180 }], entree_short: [{ type: "cassure_ouverture_bas", heure: "01:00", minutes: 420, fenetre_minutes: 180 }], stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 12, frais_nuit: true } },
  { id: "V2-5", famille: "Suivi de tendance", unite: "1h", actifs: TENDANCE, strategie: { nom: "Tortues en 1 h : cassure des 55 bougies", entree_long: [{ type: "cassure_plus_haut", periode: 55 }], entree_short: [{ type: "cassure_plus_bas", periode: 55 }], stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 120, frais_nuit: true } },
  { id: "V2-6", famille: "Volatilité", unite: "1h", actifs: TENDANCE, strategie: { nom: "Compression puis explosion, dans la tendance", entree_long: [{ type: "prix_au_dessus_ema", periode: 800 }, { type: "cassure_apres_compression_haut", periode: 7 }], entree_short: [{ type: "prix_sous_ema", periode: 800 }, { type: "cassure_apres_compression_bas", periode: 7 }], stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 24, frais_nuit: true } },
  { id: "V2-7", famille: "Heures des gros acteurs", unite: "1h", actifs: ["^NDX"], strategie: { nom: "Nasdaq : acheter à la clôture, revendre le lendemain", entree_long: [{ type: "heure_entre", debut: 21, fin: 22 }, { type: "jour_semaine", jours: [1, 2, 3, 4] }], stop: { type: "atr", mult: 4 }, objectif: { type: "R", val: 20 }, sortie_heure: 15, duree_max_bougies: 30, frais_nuit: true } },
  { id: "V2-8", famille: "Heures des gros acteurs", unite: "1h", actifs: ["GC=F"], strategie: { nom: "Or : acheter la nuit asiatique, revendre à Londres", entree_long: [{ type: "heure_entre", debut: 0, fin: 1 }, { type: "jour_semaine", jours: [1, 2, 3, 4, 5] }], stop: { type: "atr", mult: 4 }, objectif: { type: "R", val: 20 }, sortie_heure: 9, duree_max_bougies: 12, frais_nuit: true } },
  { id: "V2-9", famille: "Calendrier", unite: "1j", actifs: INDICES, strategie: { nom: "Effet de fin de mois (indices)", entree_long: [{ type: "jour_du_mois", de: -3, a: -1 }], stop: { type: "atr", mult: 2.5 }, objectif: { type: "R", val: 20 }, duree_max_bougies: 4, frais_nuit: true } },
  { id: "V2-10", famille: "Retour à la moyenne", unite: "1j", actifs: INDICES, strategie: { nom: "Rebond après une clôture en bas de journée (IBS)", entree: "cloture", entree_long: [{ type: "ibs_sous", seuil: 0.2 }], stop: { type: "atr", mult: 2.5 }, objectif: { type: "R", val: 1 }, duree_max_bougies: 3, frais_nuit: true } },
];
// ---------- Vague 3 : la règle déjà prouvée (Tortues 4 h, robustes sur l'or) sur de NOUVEAUX marchés, famille par famille ----------
// Comme les vraies Tortues : chaque marché donne peu de signaux, c'est le nombre de marchés qui fait le nombre de trades.
// Une famille = un essai, confirmé sur ses 3 marchés. Les frais de nuit des CFD sont comptés (plus sévère que V1-1).
// Le Brent plutôt que le pétrole américain : son prix n'est jamais passé sous zéro (avril 2020).
const TORTUES_4H = (nom) => ({ nom, entree_long: [{ type: "cassure_plus_haut", periode: 55 }], entree_short: [{ type: "cassure_plus_bas", periode: 55 }], stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 120, frais_nuit: true });
const VAGUE_3 = [
  { id: "V3-1", famille: "Tortues sur nouveaux marchés", unite: "4h", actifs: ["BTC", "ETH", "SOL"], strategie: TORTUES_4H("Tortues 4 h sur les cryptos") },
  { id: "V3-2", famille: "Tortues sur nouveaux marchés", unite: "4h", actifs: ["SI=F", "HG=F", "BZ=F"], strategie: TORTUES_4H("Tortues 4 h sur les métaux et l'énergie") },
  { id: "V3-3", famille: "Tortues sur nouveaux marchés", unite: "4h", actifs: ["^GSPC", "^GDAXI", "^N225"], strategie: TORTUES_4H("Tortues 4 h sur les indices du monde") },
];
// ---------- Vague 4 : des stratégies connues, chacune avec 2 ou 3 indicateurs qui se confirment ----------
// Rangées par disponibilité des données : V4-1 à V4-3 sur des marchés déjà prêts, V4-4 et V4-5 attendent la réserve de l'argent et des indices.
// V4-3 : le seuil RSI 20 prévu donnait environ 1 trade par an et par marché en simulation (pas de quoi conclure) : seuil classique 30 / 70,
// décidé AVANT tout résultat. Le stop large (3 ATR) n'est qu'une sécurité, c'est le retour du RSI à 50 qui fait sortir.
// V4-4 et V4-5 lisent un autre marché : la clôture de la veille de l'indice du dollar ou du VIX par rapport à sa moyenne de 50 jours.
const SORTIE_TORTUES = { stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 120, frais_nuit: true };
const VAGUE_4 = [
  { id: "V4-1", famille: "Suivi de tendance", unite: "4h", actifs: TENDANCE, strategie: Object.assign({ nom: "Tortues + ADX + EMA 200 : la cassure dans une tendance confirmée", entree_long: [{ type: "cassure_plus_haut", periode: 55 }, { type: "adx_sur", periode: 14, seuil: 25 }, { type: "prix_au_dessus_ema", periode: 200 }], entree_short: [{ type: "cassure_plus_bas", periode: 55 }, { type: "adx_sur", periode: 14, seuil: 25 }, { type: "prix_sous_ema", periode: 200 }] }, SORTIE_TORTUES) },
  { id: "V4-2", famille: "Suivi de tendance", unite: "4h", actifs: TENDANCE, strategie: Object.assign({ nom: "Cassure des 20 jours + momentum 12 mois", entree_long: [{ type: "cassure_plus_haut", periode: 120 }, { type: "momentum_haussier", periode: 1512 }], entree_short: [{ type: "cassure_plus_bas", periode: 120 }, { type: "momentum_baissier", periode: 1512 }] }, SORTIE_TORTUES) },
  { id: "V4-3", famille: "Retour à la moyenne", unite: "1h", actifs: CRYPTOS, strategie: { nom: "RSI sous 30 en tendance, sortie quand le RSI repasse 50 (cryptos)", entree_long: [{ type: "rsi_sous", periode: 14, seuil: 30 }, { type: "prix_au_dessus_ema", periode: 200 }], entree_short: [{ type: "rsi_sur", periode: 14, seuil: 70 }, { type: "prix_sous_ema", periode: 200 }], sortie_long: [{ type: "rsi_sur", periode: 14, seuil: 50 }], sortie_short: [{ type: "rsi_sous", periode: 14, seuil: 50 }], stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 5 }, duree_max_bougies: 48, frais_nuit: true } },
  { id: "V4-4", famille: "Inter-marchés", unite: "4h", actifs: ["GC=F", "SI=F"], strategie: Object.assign({ nom: "Tortues + dollar : acheter les métaux quand le dollar faiblit", entree_long: [{ type: "cassure_plus_haut", periode: 55 }, { type: "externe_sous_ema", symbole: "DX-Y.NYB", periode: 50 }], entree_short: [{ type: "cassure_plus_bas", periode: 55 }, { type: "externe_sur_ema", symbole: "DX-Y.NYB", periode: 50 }] }, SORTIE_TORTUES) },
  { id: "V4-5", famille: "Inter-marchés", unite: "4h", actifs: INDICES, strategie: Object.assign({ nom: "Tortues + VIX : acheter les indices quand la peur retombe", entree_long: [{ type: "cassure_plus_haut", periode: 55 }, { type: "externe_sous_ema", symbole: "^VIX", periode: 50 }], entree_short: [{ type: "cassure_plus_bas", periode: 55 }, { type: "externe_sur_ema", symbole: "^VIX", periode: 50 }] }, SORTIE_TORTUES) },
];
// ---------- Vague 5 : 20 stratégies à 3 indicateurs, choisies dans les familles les plus étudiées (décidées le 16/10/2026, avant tout résultat) ----------
// Suivi de tendance et momentum multi-horizons : des décennies de résultats sur des marchés diversifiés. Retour à la moyenne : surtout sur les indices
// actions en journalier. Heures, calendrier et liquidité : plus fragiles, testés pour trancher. Aucune n'est « sûre » : c'est le test qui décide.
// V5-9 et V5-10 = la stratégie partagée par Grok, en version stricte et en version haute fréquence. Sa sortie est simplifiée (stop 1,5 ATR,
// objectif 2 R) : le moteur ne fait pas encore les sorties partielles ni le stop suiveur. On verra au moins si son ENTRÉE a un avantage.
// Mêmes données que les vagues d'avant : la réserve de 10 ans n'a rien de nouveau à télécharger.
const METAUX = ["GC=F", "SI=F", "HG=F"], FX2 = ["EURUSD=X", "GBPUSD=X"], US2 = ["^NDX", "^GSPC"];
const miroir = (L) => L.map((k) => { const x = Object.assign({}, k), inv = { momentum_haussier: "momentum_baissier", cassure_plus_haut: "cassure_plus_bas", prix_au_dessus_ema: "prix_sous_ema", ema_au_dessus: "ema_en_dessous", rebond_ema: "rejet_ema", rsi_croise_haut: "rsi_croise_bas", tsmom_sur: "tsmom_sous", balayage_bas_recent: "balayage_haut_recent", choch_haussier: "choch_baissier", cassure_ouverture_haut: "cassure_ouverture_bas", ecart_ema_atr_sous: "ecart_ema_atr_sur", rsi_sous: "rsi_sur", cassure_apres_compression_haut: "cassure_apres_compression_bas" };
  if (inv[x.type]) x.type = inv[x.type];
  if (x.type === "rsi_croise_bas" || x.type === "rsi_sur") x.seuil = 100 - (k.seuil ?? 30);
  if (x.type === "tsmom_sous") x.seuil = -(k.seuil ?? 0.5);
  return x; });
const deuxSens = (nom, L, reste) => Object.assign({ nom, entree_long: L, entree_short: miroir(L) }, reste);
const NUIT = { frais_nuit: true };
const VAGUE_5 = [
  // Suivi de tendance
  { id: "V5-1", famille: "Suivi de tendance", unite: "1j", actifs: TENDANCE, strategie: deuxSens("Momentum 12 mois + cassure 20 jours + ADX", [{ type: "momentum_haussier", periode: 252 }, { type: "cassure_plus_haut", periode: 20 }, { type: "adx_sur", periode: 14, seuil: 20 }], Object.assign({ stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 60 }, NUIT)) },
  { id: "V5-2", famille: "Suivi de tendance", unite: "1j", actifs: METAUX, strategie: deuxSens("Métaux : momentum 12 mois + cassure 20 jours + ADX", [{ type: "momentum_haussier", periode: 252 }, { type: "cassure_plus_haut", periode: 20 }, { type: "adx_sur", periode: 14, seuil: 20 }], Object.assign({ stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 60 }, NUIT)) },
  { id: "V5-3", famille: "Suivi de tendance", unite: "1j", actifs: CRYPTOS, strategie: deuxSens("Cryptos : momentum 3 mois + EMA 50 + cassure 20 jours", [{ type: "momentum_haussier", periode: 90 }, { type: "prix_au_dessus_ema", periode: 50 }, { type: "cassure_plus_haut", periode: 20 }], Object.assign({ stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 40 }, NUIT)) },
  { id: "V5-4", famille: "Suivi de tendance", unite: "4h", actifs: TENDANCE, strategie: deuxSens("EMA 20 au-dessus de l'EMA 50 + rebond sur l'EMA 20 + ADX 25", [{ type: "ema_au_dessus", rapide: 20, lente: 50 }, { type: "rebond_ema", periode: 20 }, { type: "adx_sur", periode: 14, seuil: 25 }], Object.assign({ stop: { type: "swing", periode: 10 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 30 }, NUIT)) },
  { id: "V5-5", famille: "Suivi de tendance", unite: "4h", actifs: TENDANCE, strategie: deuxSens("Volatilité comprimée puis cassure, dans la tendance", [{ type: "prix_au_dessus_ema", periode: 200 }, { type: "atr_compression", rapide: 14, lente: 100, seuil: 0.8 }, { type: "cassure_plus_haut", periode: 20 }], Object.assign({ stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 60 }, NUIT)) },
  { id: "V5-6", famille: "Suivi de tendance", unite: "4h", actifs: CRYPTOS, strategie: deuxSens("Cryptos : cassure 20 bougies + EMA 200 + volume fort", [{ type: "cassure_plus_haut", periode: 20 }, { type: "prix_au_dessus_ema", periode: 200 }, { type: "volume_fort", periode: 20, mult: 1.5 }], Object.assign({ stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 3 }, duree_max_bougies: 60 }, NUIT)) },
  { id: "V5-7", famille: "Suivi de tendance", unite: "4h", actifs: INDICES, strategie: deuxSens("Indices : repli en tendance (EMA 50/200, RSI repasse 40, ADX 20)", [{ type: "ema_au_dessus", rapide: 50, lente: 200 }, { type: "rsi_croise_haut", periode: 14, seuil: 40 }, { type: "adx_sur", periode: 14, seuil: 20 }], Object.assign({ stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 40 }, NUIT)) },
  // Momentum multi-horizons (TSMOM)
  { id: "V5-8", famille: "Momentum multi-horizons", unite: "1j", actifs: TENDANCE, strategie: Object.assign(deuxSens("TSMOM 2-4-8-12 mois + EMA 150 + ADX (journalier)", [{ type: "tsmom_sur", seuil: 0.5, jour: 1 }, { type: "prix_au_dessus_ema", periode: 150 }, { type: "adx_sur", periode: 14, seuil: 16 }], Object.assign({ stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 6 }, duree_max_bougies: 120 }, NUIT)), { sortie_long: [{ type: "tsmom_sous", seuil: 0.15, jour: 1 }], sortie_short: [{ type: "tsmom_sur", seuil: -0.15, jour: 1 }] }) },
  { id: "V5-9", famille: "Momentum multi-horizons", unite: "1h", actifs: TENDANCE, strategie: deuxSens("Stratégie de Grok, stricte : TSMOM ≥ 0,5 + EMA 150 jours + balayage de la veille", [{ type: "tsmom_sur", seuil: 0.5, jour: 22 }, { type: "prix_au_dessus_ema", periode: 3300 }, { type: "balayage_bas_recent", periode: 24, fenetre: 1 }], Object.assign({ stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 48 }, NUIT)) },
  { id: "V5-10", famille: "Momentum multi-horizons", unite: "1h", actifs: TENDANCE, strategie: deuxSens("Stratégie de Grok, haute fréquence : TSMOM ≥ 0,28 + ADX 16 + balayage des 12 bougies", [{ type: "tsmom_sur", seuil: 0.28, jour: 22 }, { type: "adx_sur", periode: 14, seuil: 16 }, { type: "balayage_bas_recent", periode: 12, fenetre: 1 }], Object.assign({ stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 48 }, NUIT)) },
  // Retour à la moyenne
  { id: "V5-11", famille: "Retour à la moyenne", unite: "1j", actifs: INDICES, strategie: Object.assign({ nom: "RSI 2 sous 10 + clôture basse (IBS) + EMA 200 (Connors)", entree: "cloture", entree_long: [{ type: "prix_au_dessus_ema", periode: 200 }, { type: "rsi_sous", periode: 2, seuil: 10 }, { type: "ibs_sous", seuil: 0.3 }], sortie_long: [{ type: "rsi_sur", periode: 2, seuil: 70 }], stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 10 }, duree_max_bougies: 7 }, NUIT) },
  { id: "V5-12", famille: "Retour à la moyenne", unite: "1j", actifs: INDICES, strategie: Object.assign({ nom: "3 jours de baisse + RSI 14 sous 45 + EMA 200", entree: "cloture", entree_long: [{ type: "bougies_baissieres_consecutives", nombre: 3 }, { type: "rsi_sous", periode: 14, seuil: 45 }, { type: "prix_au_dessus_ema", periode: 200 }], sortie_long: [{ type: "rsi_sur", periode: 2, seuil: 70 }], stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 10 }, duree_max_bougies: 7 }, NUIT) },
  { id: "V5-13", famille: "Retour à la moyenne", unite: "1j", actifs: INDICES, strategie: Object.assign({ nom: "Acheter la peur en tendance : 2 ATR sous l'EMA 20 + EMA 200 + VIX élevé", entree: "cloture", entree_long: [{ type: "ecart_ema_atr_sous", periode: 20, atr: 2 }, { type: "prix_au_dessus_ema", periode: 200 }, { type: "externe_sur_ema", symbole: "^VIX", periode: 50 }], sortie_long: [{ type: "rsi_sur", periode: 2, seuil: 70 }], stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 10 }, duree_max_bougies: 10 }, NUIT) },
  { id: "V5-14", famille: "Retour à la moyenne", unite: "1h", actifs: CRYPTOS, strategie: Object.assign(deuxSens("Cryptos : capitulation en tendance (RSI 25 + volume ×2 + EMA)", [{ type: "prix_au_dessus_ema", periode: 800 }, { type: "rsi_sous", periode: 14, seuil: 25 }, { type: "volume_fort", periode: 20, mult: 2 }], Object.assign({ stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 5 }, duree_max_bougies: 48 }, NUIT)), { sortie_long: [{ type: "rsi_sur", periode: 14, seuil: 50 }], sortie_short: [{ type: "rsi_sous", periode: 14, seuil: 50 }] }) },
  { id: "V5-15", famille: "Retour à la moyenne", unite: "4h", actifs: FX2, strategie: Object.assign(deuxSens("Forex : excès de 2 ATR + ADX sous 25 + RSI extrême", [{ type: "ecart_ema_atr_sous", periode: 20, atr: 2 }, { type: "adx_sous", periode: 14, seuil: 25 }, { type: "rsi_sous", periode: 14, seuil: 30 }], Object.assign({ stop: { type: "atr", mult: 2.5 }, objectif: { type: "R", val: 5 }, duree_max_bougies: 30 }, NUIT)), { sortie_long: [{ type: "rsi_sur", periode: 14, seuil: 50 }], sortie_short: [{ type: "rsi_sous", periode: 14, seuil: 50 }] }) },
  // Heures et calendrier
  { id: "V5-16", famille: "Heures et calendrier", unite: "1h", actifs: US2, strategie: Object.assign({ nom: "Nuit américaine : acheter à la clôture en tendance, VIX calme", entree_long: [{ type: "heure_entre", debut: 21, fin: 22 }, { type: "prix_au_dessus_ema", periode: 800 }, { type: "externe_sous_ema", symbole: "^VIX", periode: 50 }], stop: { type: "atr", mult: 4 }, objectif: { type: "R", val: 20 }, sortie_heure: 15, duree_max_bougies: 30 }, NUIT) },
  { id: "V5-17", famille: "Heures et calendrier", unite: "1j", actifs: INDICES, strategie: Object.assign({ nom: "Tournant du mois en tendance, VIX calme", entree_long: [{ type: "jour_du_mois", de: -2, a: -1 }, { type: "prix_au_dessus_ema", periode: 200 }, { type: "externe_sous_ema", symbole: "^VIX", periode: 50 }], stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 20 }, duree_max_bougies: 5 }, NUIT) },
  { id: "V5-18", famille: "Heures et calendrier", unite: "1h", actifs: TENDANCE, strategie: deuxSens("Range asiatique cassé à Londres, dans la tendance, ADX 20", [{ type: "cassure_ouverture_haut", heure: "01:00", minutes: 420, fenetre_minutes: 180 }, { type: "prix_au_dessus_ema", periode: 800 }, { type: "adx_sur", periode: 14, seuil: 20 }], Object.assign({ stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 12 }, NUIT)) },
  // Liquidité
  { id: "V5-19", famille: "Liquidité", unite: "1h", actifs: TENDANCE, strategie: deuxSens("Balayage du plus bas de la veille + CHoCH + tendance 4 h", [{ type: "balayage_bas_recent", periode: 24, fenetre: 6 }, { type: "choch_haussier" }, { type: "prix_au_dessus_ema", periode: 800 }], Object.assign({ stop: { type: "swing", periode: 8 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 48 }, NUIT)) },
  { id: "V5-20", famille: "Liquidité", unite: "1h", actifs: US2, strategie: deuxSens("Ouverture de New York : cassure de la première heure, en tendance, ADX 20", [{ type: "cassure_ouverture_haut", heure: "15:00", minutes: 60, fenetre_minutes: 120 }, { type: "prix_au_dessus_ema", periode: 800 }, { type: "adx_sur", periode: 14, seuil: 20 }], Object.assign({ stop: { type: "atr", mult: 1.5 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 8 }, NUIT)) },
];
// ---------- Vague 6 : les Tortues avec leurs vraies règles de sortie (décidées le 17/10/2026, avant tout résultat) ----------
// La force du suivi de tendance vient de quelques très gros trades, qui durent des semaines : l'objectif fixe à 3 R des vagues 1 à 4 les coupait.
// Les vraies Tortues sortaient quand le prix cassait l'extrême inverse des 20 dernières bougies. V6-3 essaie l'autre sortie classique :
// un stop qui suit la tendance à 3 ATR. L'objectif à 50 R et la durée maximale (600 bougies de 4 h, environ 5 mois) ne sont que des sécurités.
// V6-2 : les nouveaux marchés, aux prix de FTMO (cTrader) quand Dukascopy ne les a pas.
const TORTUE_BASE = { entree_long: [{ type: "cassure_plus_haut", periode: 55 }], entree_short: [{ type: "cassure_plus_bas", periode: 55 }], stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 50 }, duree_max_bougies: 600, frais_nuit: true };
const SORTIE_ORIGINE = { sortie_long: [{ type: "cassure_plus_bas", periode: 20 }], sortie_short: [{ type: "cassure_plus_haut", periode: 20 }] };
const NOUVEAUX = ["SI=F", "^GDAXI", "^GSPC", "GBPUSD=X"];
const VAGUE_6 = [
  { id: "V6-1", famille: "Tortues, vraies sorties", unite: "4h", actifs: TENDANCE, strategie: Object.assign({ nom: "Tortues 4 h, sortie d'origine (cassure inverse des 20 bougies)" }, TORTUE_BASE, SORTIE_ORIGINE) },
  { id: "V6-2", famille: "Tortues, vraies sorties", unite: "4h", actifs: NOUVEAUX, strategie: Object.assign({ nom: "Tortues 4 h, sortie d'origine, sur l'argent, le DAX, le S&P 500 et la livre" }, TORTUE_BASE, SORTIE_ORIGINE) },
  { id: "V6-3", famille: "Tortues, vraies sorties", unite: "4h", actifs: TENDANCE, strategie: Object.assign({ nom: "Tortues 4 h, stop qui suit la tendance à 3 ATR" }, TORTUE_BASE, { stop: { type: "atr", mult: 2, suiveur_atr: 3 } }) },
];
// ---------- Vague 7 : la liquidité (l'idée de Geremy), la peur, et la dernière heure de New York (décidées le 17/10/2026, avant tout résultat) ----------
// Le rejeu du témoin a montré que ses cassures échouaient 82 % du temps : beaucoup de cassures ne sont que des chasses aux stops.
// Cette vague joue ces chasses aux stops, avec des règles publiées, ou écrites ici avant de voir le moindre résultat :
// V7-1 et V7-2 : « Turtle Soup » (Raschke et Connors, Street Smarts, 1995), en journalier comme publiée, puis en 4 h. Entrée à la clôture
//   qui reprend l'ancien plus bas (la version publiée achète dès que le prix y revient dans la journée), stop sous la mèche, sortie rapide.
// V7-3 : le plus bas (ou le plus haut) de la veille balayé puis repris, objectif le milieu de la veille.
// V7-4 : une zone touchée au moins 2 fois (« double bas ») : plus de stops derrière, donc une zone plus importante ; objectif le milieu du range.
// V7-5 : le piège de l'ouverture de Londres : le range de la nuit (1 h à 8 h) dépassé puis repris entre 8 h et 12 h, objectif l'autre bord.
// V7-6 : V7-3 seulement dans le sens de la tendance de fond (EMA 800 en 1 h ≈ EMA 200 en 4 h).
// V7-7 : la peur. « VIX Stretch » (Connors et Alvarez, 2008) : le VIX au moins 5 % au-dessus de sa moyenne de 10 jours, 3 jours de suite,
//   indice au-dessus de sa moyenne de 200 jours ; sortie quand le RSI 2 repasse 65. Proche de V5-13, mais c'est l'emballement du VIX qui déclenche.
// V7-8 : le momentum de la journée (Gao, Han, Li et Zhou, 2018) : le sens entre la clôture de la veille et 10 h à New York donne le sens de
//   la dernière heure (21 h à 22 h, heure de Paris). Bougies d'1 h : le début de séance est pris jusqu'à 16 h (10 h à New York).
// Pas refaits : le tournant du mois (déjà testé en V2-9 et V5-17) et le retour à la moyenne sur indices (vagues 1, 2 et 5).
const SOUPE = { periode: 20, age_min: 4 }, MARCHES_SOUPE = ["GC=F", "EURUSD=X", "^NDX", "^GSPC"], LIQ4 = ["GC=F", "EURUSD=X", "GBPUSD=X", "^NDX"];
const VERS_VEILLE = { stop: { type: "swing", periode: 3 }, objectif: { type: "zone", zone: "veille", cible: "milieu", ratio_min: 1 }, duree_max_bougies: 24, frais_nuit: true };
const VAGUE_7 = [
  { id: "V7-1", famille: "Liquidité", unite: "1j", actifs: MARCHES_SOUPE, strategie: { nom: "Turtle Soup (Raschke) : faux nouveau plus bas des 20 jours, repris à la clôture", entree: "cloture", entree_long: [Object.assign({ type: "soupe_tortue_bas" }, SOUPE)], entree_short: [Object.assign({ type: "soupe_tortue_haut" }, SOUPE)], stop: { type: "swing", periode: 1 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 5, frais_nuit: true } },
  { id: "V7-2", famille: "Liquidité", unite: "4h", actifs: MARCHES_SOUPE, strategie: { nom: "Turtle Soup en 4 h : faux nouveau plus bas des 20 bougies, repris", entree: "cloture", entree_long: [Object.assign({ type: "soupe_tortue_bas" }, SOUPE)], entree_short: [Object.assign({ type: "soupe_tortue_haut" }, SOUPE)], stop: { type: "swing", periode: 1 }, objectif: { type: "R", val: 2 }, duree_max_bougies: 30, frais_nuit: true } },
  { id: "V7-3", famille: "Liquidité", unite: "1h", actifs: LIQ4, strategie: Object.assign({ nom: "Plus bas (ou plus haut) de la veille balayé puis repris, objectif le milieu de la veille", entree_long: [{ type: "balayage_veille_bas" }], entree_short: [{ type: "balayage_veille_haut" }] }, VERS_VEILLE) },
  { id: "V7-4", famille: "Liquidité", unite: "1h", actifs: LIQ4, strategie: { nom: "Double bas (ou double haut) balayé puis repris : une zone touchée 2 fois", entree_long: [{ type: "balayage_double_bas", periode: 48, touches: 2, tolerance_atr: 0.25 }], entree_short: [{ type: "balayage_double_haut", periode: 48, touches: 2, tolerance_atr: 0.25 }], stop: { type: "swing", periode: 3 }, objectif: { type: "range", periode: 48, cible: "milieu", ratio_min: 1 }, duree_max_bougies: 24, frais_nuit: true } },
  { id: "V7-5", famille: "Liquidité", unite: "1h", actifs: ["EURUSD=X", "GBPUSD=X", "GC=F"], strategie: { nom: "Piège de l'ouverture de Londres : le range de la nuit cassé puis repris", entree_long: [{ type: "piege_ouverture_bas", heure: "01:00", minutes: 420, fenetre_minutes: 180 }], entree_short: [{ type: "piege_ouverture_haut", heure: "01:00", minutes: 420, fenetre_minutes: 180 }], stop: { type: "swing", periode: 3 }, objectif: { type: "zone", zone: "asie", cible: "oppose", ratio_min: 1 }, duree_max_bougies: 12, frais_nuit: true } },
  { id: "V7-6", famille: "Liquidité", unite: "1h", actifs: LIQ4, strategie: Object.assign({ nom: "Plus bas de la veille balayé, seulement dans le sens de la tendance de fond", entree_long: [{ type: "balayage_veille_bas" }, { type: "prix_au_dessus_ema", periode: 800 }], entree_short: [{ type: "balayage_veille_haut" }, { type: "prix_sous_ema", periode: 800 }] }, VERS_VEILLE) },
  { id: "V7-7", famille: "Sentiment (la peur)", unite: "1j", actifs: INDICES, strategie: { nom: "VIX Stretch (Connors) : acheter les indices quand la peur s'emballe, en tendance", entree: "cloture", entree_long: [{ type: "prix_au_dessus_ema", periode: 200 }, { type: "externe_ecart_sur", symbole: "^VIX", periode: 10, ecart_pct: 5, jours: 3 }], sortie_long: [{ type: "rsi_sur", periode: 2, seuil: 65 }], stop: { type: "atr", mult: 3 }, objectif: { type: "R", val: 10 }, duree_max_bougies: 10, frais_nuit: true } },
  { id: "V7-8", famille: "Momentum de la journée", unite: "1h", actifs: US2, strategie: { nom: "Dernière heure de New York dans le sens du début de séance (Gao et al.)", entree_long: [{ type: "heure_entre", debut: 20, fin: 21 }, { type: "debut_seance_haussier" }], entree_short: [{ type: "heure_entre", debut: 20, fin: 21 }, { type: "debut_seance_baissier" }], stop: { type: "atr", mult: 2 }, objectif: { type: "R", val: 20 }, sortie_heure: 22, duree_max_bougies: 3, frais_nuit: true } },
];
// ---------- Vague 8 : les Tortues de V1-1 sur de nouveaux marchés (décidée le 17/10/2026, avant tout résultat) ----------
// But (Geremy, 17/10) : environ 1 trade par jour avec une stratégie qui gagne. Les Tortues font environ 2,5 trades par mois et par marché :
// il faut donc un panier d'environ 8 marchés validés. Mêmes règles que la vague 3 (frais de nuit comptés). Chaque marché doit battre
// le hasard tout seul pour entrer dans le panier. Prix de FTMO (cTrader) : Dukascopy n'a pas ces marchés en réserve.
const VAGUE_8 = [
  { id: "V8-1", famille: "Tortues sur nouveaux marchés", unite: "4h", actifs: ["^DJI", "^FCHI"], strategie: TORTUES_4H("Tortues 4 h sur le Dow Jones et le CAC 40") },
  { id: "V8-2", famille: "Tortues sur nouveaux marchés", unite: "4h", actifs: ["GBPUSD=X", "USDJPY=X", "AUDUSD=X", "USDCAD=X"], strategie: TORTUES_4H("Tortues 4 h sur le forex : livre, yen, dollar australien, dollar canadien") },
];
const VAGUES = [{ num: 1, tests: VAGUE_1 }, { num: 2, tests: VAGUE_2 }, { num: 3, tests: VAGUE_3 }, { num: 4, tests: VAGUE_4 }, { num: 5, tests: VAGUE_5 }, { num: 6, tests: VAGUE_6 }, { num: 7, tests: VAGUE_7 }, { num: 8, tests: VAGUE_8 }];
const TOUS_LES_TESTS = VAGUE_1.concat(VAGUE_2, VAGUE_3, VAGUE_4, VAGUE_5, VAGUE_6, VAGUE_7, VAGUE_8);
// Les Tortues de V1-1 (cassure des 55 bougies de 4 h, stop 2 ATR, objectif 3 R) : V1-1 et ses copies sur d'autres marchés
const FAMILLE_TORTUES = ["V1-1", "V3-1", "V3-2", "V3-3", "V8-1", "V8-2"];

// ---------- Données prêtes ? ----------
// Forex, or, argent, indices et pétrole en 1 h / 4 h viennent de la réserve Dukascopy (10 ans) : un test n'est lancé que si elle est
// complète (au plus 2 mois anciens manquants : le test saute un mois isolé ; les 2 derniers mois ne comptent pas, ils sont au coffre-fort).
// Sinon il tournerait sur moins d'années et le résultat serait moins sûr. Les cryptos, le journalier et le dollar / VIX se téléchargent pendant le test.
const RESERVE_MANQUE_MAX = 2;
async function manquantsReserve(nom) {
  const mois = moisDK(10), champs = mois.map(nomMoisDK);
  const present = new Set((await core().redis(["HKEYS", CLE_DK(nom)])) || []);
  return champs.filter((ch, k) => !present.has(ch) && Date.now() - mois[k][2] >= RECENT_MS).length;
}
async function disponibilites(tests) {
  const cache = {}, out = {};
  const lire = (dk) => cache[dk] || (cache[dk] = manquantsReserve(dk).catch(() => 0).then(async (n) => (n > RESERVE_MANQUE_MAX && (await ctPret(dk).catch(() => false)) ? 0 : n)));   // Redis muet : on ne bloque pas ; couvert par cTrader : prêt
  await Promise.all(tests.map(async (v) => {
    const manque = [];
    if (v.unite === "1h" || v.unite === "4h") for (const sym of v.actifs) {
      if (baseCrypto(sym)) continue;
      const dk = nomDukascopy(sym); if (!dk) continue;
      const n = await lire(dk);
      if (n > RESERVE_MANQUE_MAX) manque.push({ symbole: sym, mois_manquants: n });
    }
    out[v.id] = manque;
  }));
  return out;
}

// Un essai = une idée testée, sur 1 à 4 marchés de la même famille (la confirmation multi-marchés compte comme un seul essai)
async function lancer(a) {
  const t0 = Date.now();
  const camp = await lireCampagne();
  if (a.preset) {
    const v = TOUS_LES_TESTS.find((x) => x.id === String(a.preset).toUpperCase());
    if (!v) throw new Error("test inconnu : " + a.preset + ". Possibles : " + TOUS_LES_TESTS.map((x) => x.id).join(", "));
    if (!a.ouvrir_coffre && camp.essais.some((e) => e.preset === v.id)) throw new Error(v.id + " a déjà été testé dans cette campagne : le relancer gaspillerait un essai et fausserait la correction des tests multiples");
    if (!a.ouvrir_coffre) {
      const manque = (await disponibilites([v]))[v.id];
      if (manque.length) throw new Error(v.id + " pas encore lancé (NON compté) : la réserve de 10 ans n'est pas complète pour " + manque.map((m) => m.symbole + " (" + m.mois_manquants + " mois manquants)").join(", ") + ". La tâche « Alphie données » la remplit : lance un autre test prêt en attendant.");
    }
    a = Object.assign({}, a, { actifs: v.actifs, unite: v.unite, strategie: v.strategie, preset: v.id });
  }
  const ouvrir = a.ouvrir_coffre === true;
  const essai = ouvrir ? Math.max(1, camp.essais.length) : camp.essais.length + 1;   // l'examen du coffre-fort n'est pas un nouvel essai
  const seuil = seuilHasard(essai);
  const actifs = [...new Set((Array.isArray(a.actifs) && a.actifs.length ? a.actifs : [a.actif]).filter(Boolean).map(String))].slice(0, 4);
  if (!actifs.length) throw new Error("aucun actif indiqué");
  // séries d'autres marchés (dollar, VIX) téléchargées une seule fois : si elles manquent, le test est annulé avant d'être compté
  let ext;
  try { ext = await externesDe(a.strategie || {}); }
  catch (e) { throw new Error((a.preset && !ouvrir ? "Test " + a.preset + " annulé et NON compté dans la campagne : " : "") + "données externes indisponibles (" + e.message + "). Réessaie dans quelques minutes."); }
  // les marchés tournent en parallèle : les téléchargements se chevauchent au lieu de s'additionner
  const resultats = [], erreurs = [];
  const sorties = await Promise.all(actifs.map((actif) => lancerUn(Object.assign({}, a, { actif }), { seuil, essai, ouvrir, ext }).then((r) => r, (e) => new Error(actif + " : " + e.message))));
  sorties.forEach((x) => { if (x instanceof Error) erreurs.push(x.message); else resultats.push(x); });
  if (!resultats.length) throw new Error(erreurs.join(" ; "));
  let multi = null;
  if (actifs.length > 1) {
    const confirmes = resultats.filter((r) => (r.global.esperance_R || 0) > 0 && r.hasard && r.hasard.bat_le_hasard).map((r) => r.symbole);
    const besoin = Math.max(2, Math.ceil((resultats.length * 2) / 3));
    multi = { marches: resultats.map((r) => r.symbole), confirmes, besoin, ok: confirmes.length >= besoin, erreurs };
    resultats.forEach((r) => { r.multi = multi; });
  }
  if (a.preset && !ouvrir) {
    const courts = resultats.filter((r) => r.annees_testees < 3.5);
    if (courts.length || erreurs.length) {
      throw new Error("Test " + a.preset + " annulé et NON compté dans la campagne : " +
        (courts.length ? courts.map((r) => r.symbole + " n'a que " + String(r.annees_testees).replace(".", ",") + " an(s) de données (" + r.source_detail + ")").join(" ; ") : "") +
        (erreurs.length ? (courts.length ? " ; " : "") + "marché(s) sans données : " + erreurs.join(" ; ") : "") +
        ". Il faut au moins 3,5 ans pour un test sérieux.");
    }
  }
  const ligne = {
    essai, date: Date.now(), nom: resultats[0].nom, unite: resultats[0].unite, seuil, coffre: ouvrir, preset: a.preset || null,
    marches: resultats.map((r) => ({ symbole: r.symbole, verdict: r.verdict.note, esperance_R: r.global.esperance_R ?? null, trades: r.global.trades || 0, hasard: r.hasard ? r.hasard.part_des_tirages_battus : null, bat_le_hasard: !!(r.hasard && r.hasard.bat_le_hasard), prop: !!(r.prop && r.prop.compatible), gain_mensuel_pct: r.prop ? r.prop.gain_mensuel_pct : null, coffre_R: r.coffre.stats ? r.coffre.stats.esperance_R ?? null : null })),
    multi: multi ? multi.confirmes.length + "/" + multi.marches.length : null,
  };
  if (ouvrir) camp.coffres = (camp.coffres || []).concat([ligne]).slice(-20);
  else camp.essais = camp.essais.concat([ligne]).slice(-100);
  await ecrireCampagne(camp);
  for (const r of resultats.slice().reverse()) { try { await core().redis(["LPUSH", KEY, JSON.stringify(r)]); } catch (e) {} }
  try { await core().redis(["LTRIM", KEY, "0", "49"]); } catch (e) {}
  const r0 = resultats[0];
  if (resultats.length > 1) r0.autres_marches = resultats.slice(1);
  r0.duree_s = Math.round((Date.now() - t0) / 1000);
  return r0;
}

async function campagne(action) {
  if (action === "nouvelle") { const k = { debut: Date.now(), essais: [], coffres: [] }; await ecrireCampagne(k); return k; }
  const k = await lireCampagne();
  const fait = (v) => k.essais.some((x) => x.preset === v.id), aFaire = TOUS_LES_TESTS.filter((v) => !fait(v));
  const dispo = await disponibilites(aFaire);
  const fiche = (v) => {
    const e = k.essais.find((x) => x.preset === v.id), m = dispo[v.id];
    return { id: v.id, famille: v.famille, nom: v.strategie.nom, unite: v.unite, marches: v.actifs, fait: !!e, pret: e ? undefined : !m.length, attente: m && m.length ? m : undefined, detail: e ? e.marches : undefined, essai: e ? e.essai : undefined, multi: e ? e.multi : undefined,
      resultat: e ? e.marches.map((x) => x.symbole + " " + (x.bat_le_hasard && (x.esperance_R || 0) > 0 ? "✓" : "✕")).join(", ") + (e.multi ? " (confirmée " + e.multi + ")" : "") : null };
  };
  k.vague_1 = VAGUE_1.map(fiche);
  // Tous les tests seront faits, dans l'ordre des vagues ; seul un test dont les données ne sont pas encore prêtes laisse passer le suivant.
  // Aucun tri sur les résultats : l'ordre ne dépend que de la disponibilité des données.
  const prochain = aFaire.find((v) => !dispo[v.id].length) || null;
  k.prochain = prochain ? fiche(prochain) : null;
  k.prets = aFaire.filter((v) => !dispo[v.id].length).map((v) => v.id);   // pour « lancer toute la série » depuis le site, dans l'ordre
  k.vague_5 = VAGUE_5.map(fiche);
  k.vague_7 = VAGUE_7.map(fiche);
  k.vague_8 = VAGUE_8.map(fiche);
  k.attente = aFaire.filter((v) => dispo[v.id].length).map(fiche);
  k.vagues = VAGUES.map((w) => ({ num: w.num, faits: w.tests.filter(fait).length, total: w.tests.length }));
  const vg = (prochain && VAGUES.find((w) => w.tests.includes(prochain))) || VAGUES.find((w) => w.tests.some((v) => !fait(v))) || VAGUES[VAGUES.length - 1];
  k.vague_en_cours = { num: vg.num, tests: vg.tests.map(fiche) };
  return k;
}

// ---------- Simulateur de challenge : la phase d'examen et le compte financé, jugés séparément ----------
// On rejoue le challenge en le démarrant chaque semaine de l'historique (hors coffre-fort), avec les vrais trades dans leur ordre réel,
// sur un ou plusieurs marchés à la fois (leurs trades se chevauchent, comme en vrai). Le risque est un % fixe du capital de départ,
// comme dans les règles des prop firms. Limite : les pertes latentes ne sont pas comptées, la règle des -5 % par jour est un peu optimiste.
const CHALLENGE = {
  nom: "FTMO 2 étapes", phases: [10, 5], perte_jour: 5, perte_totale: 10, jours_min: 4,
  risques_examen: [0.5, 1, 1.5, 2, 3], risques_finance: [0.25, 0.5, 0.75, 1], horizon_mois: 12,
};
const JOUR_MS = 86400000, MOIS_MS = 30.44 * JOUR_MS;
const mediane = (l) => { if (!l.length) return null; const t = l.slice().sort((a, b) => a - b), k = Math.floor(t.length / 2); return t.length % 2 ? t[k] : (t[k - 1] + t[k]) / 2; };
// Mise adaptée au challenge (demandée par Geremy le 17/10/2026, règles fixées avant tout résultat) :
// A = mise divisée par deux tant que le compte de la phase est à −5 % ou pire ; B = mise divisée par deux dès 70 % de l'objectif de la phase.
const REGLES_MISE = [
  { cle: "fixe", nom: "Mise fixe" },
  { cle: "A", nom: "A · moitié dans le creux (−5 % ou pire)" },
  { cle: "B", nom: "B · moitié près du but (dès 70 % de l'objectif)" },
  { cle: "AB", nom: "A + B" },
];
function facteurMise(regle, eq, cible) {
  let f = 1;
  if ((regle === "A" || regle === "AB") && eq <= -5) f = 0.5;
  if ((regle === "B" || regle === "AB") && eq >= 0.7 * cible) f = 0.5;
  return f;
}
// Une phase d'examen démarrée en s, au risque r (% par trade) : réussie (et en combien de temps), échouée, ou trop lente (plus de 12 mois).
// Avec une règle de mise, la taille de chaque trade est décidée à son ouverture, avec les seuls trades déjà fermés (jamais le futur).
function unExamen(T, s, r, P, regle) {
  const lim = s + P.horizon_mois * MOIS_MS, adapte = regle && regle !== "fixe", hist = [];
  let phase = 0, eq = 0, jourC = null, pj = 0, jours = new Set(), G = 0, G0 = 0, debutPhase = s;
  for (const t of T) {
    if (t.t < s) continue;
    if (t.sortieT > lim) break;
    let f = 1;
    if (adapte) {
      let k = hist.length - 1; while (k >= 0 && hist[k][0] > t.t) k--;
      f = facteurMise(regle, t.t >= debutPhase && k >= 0 ? hist[k][1] - G0 : 0, P.phases[phase]);
    }
    const g = t.R * r * f, d = jourParis(t.sortieT);
    if (d !== jourC) { jourC = d; pj = 0; }
    pj += g; eq += g; jours.add(jourParis(t.t));
    if (adapte) { G += g; hist.push([t.sortieT, G]); }
    if (pj <= -P.perte_jour || eq <= -P.perte_totale) return { issue: "echec", duree: t.sortieT - s, phase };
    if (eq >= P.phases[phase] && jours.size >= P.jours_min) {
      phase++;
      if (phase === P.phases.length) return { issue: "reussi", duree: t.sortieT - s };
      eq = 0; pj = 0; jours = new Set();   // la vérification repart d'un compte neuf
      G0 = G; debutPhase = t.sortieT;
    }
  }
  return { issue: "lent", phase };
}
// Un compte financé démarré en s, au risque r : gain sur 12 mois, ou compte perdu (et quand)
function unFinance(T, s, r, P) {
  const lim = s + P.horizon_mois * MOIS_MS, mois = new Array(P.horizon_mois).fill(0);
  let eq = 0, jourC = null, pj = 0;
  for (const t of T) {
    if (t.t < s) continue;
    if (t.sortieT > lim) break;
    const g = t.R * r, d = jourParis(t.sortieT);
    if (d !== jourC) { jourC = d; pj = 0; }
    pj += g; eq += g; mois[Math.min(P.horizon_mois - 1, Math.floor((t.sortieT - s) / MOIS_MS))] += g;
    if (pj <= -P.perte_jour || eq <= -P.perte_totale) return { perdu: true, apres_mois: Math.ceil((t.sortieT - s) / MOIS_MS), total: eq };
  }
  return { perdu: false, total: eq, mois };
}
function simulerChallenge(trades, debut, fin, P) {
  P = P || CHALLENGE;
  const T = trades.filter((t) => t.sortieT && Number.isFinite(t.R)).slice().sort((a, b) => a.sortieT - b.sortieT);   // dans l'ordre où les gains et pertes tombent
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10), pc = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const departs = [];
  for (let s = debut; s + P.horizon_mois * MOIS_MS <= fin; s += 7 * JOUR_MS) departs.push(s);
  if (departs.length < 20 || T.length < 20) return null;
  const examen = P.risques_examen.map((r) => {
    const res = departs.map((s) => unExamen(T, s, r, P)), ok = res.filter((x) => x.issue === "reussi"), j = ok.map((x) => x.duree / JOUR_MS);
    return { risque_pct: r, reussite_pct: pc(ok.length, res.length), echec_pct: pc(res.filter((x) => x.issue === "echec").length, res.length), trop_lent_pct: pc(res.filter((x) => x.issue === "lent").length, res.length),
      jours_median: r1(mediane(j)), en_2_semaines_pct: pc(j.filter((x) => x <= 14).length, res.length), en_1_mois_pct: pc(j.filter((x) => x <= 31).length, res.length), en_3_mois_pct: pc(j.filter((x) => x <= 92).length, res.length) };
  });
  const finance = P.risques_finance.map((r) => {
    const res = departs.map((s) => unFinance(T, s, r, P)), vivants = res.filter((x) => !x.perdu), m = [].concat(...vivants.map((x) => x.mois));
    return { risque_pct: r, compte_perdu_pct: pc(res.length - vivants.length, res.length), gain_mensuel_median_pct: Math.round(mediane(res.map((x) => x.total / P.horizon_mois)) * 100) / 100,
      gain_annuel_median_pct: r1(mediane(res.map((x) => x.total))), mois_positifs_pct: pc(m.filter((x) => x > 0).length, m.length) };
  });
  const meilleur = examen.slice().sort((a, b) => b.reussite_pct - a.reussite_pct || (a.jours_median || 1e9) - (b.jours_median || 1e9))[0];
  const sur = finance.filter((x) => x.compte_perdu_pct <= 5).pop();
  // chaque règle de mise, à son meilleur dosage
  const regles = REGLES_MISE.map((R) => {
    const par = P.risques_examen.map((r) => { const res = departs.map((s) => unExamen(T, s, r, P, R.cle)), ok = res.filter((x) => x.issue === "reussi");
      return { risque_pct: r, reussite_pct: pc(ok.length, res.length), echec_pct: pc(res.filter((x) => x.issue === "echec").length, res.length), jours_median: r1(mediane(ok.map((x) => x.duree / JOUR_MS))) }; });
    const m = par.slice().sort((a, b) => b.reussite_pct - a.reussite_pct || (a.jours_median || 1e9) - (b.jours_median || 1e9))[0];
    return Object.assign({ cle: R.cle, nom: R.nom }, m, { par_risque: par.map((x) => [x.risque_pct, x.reussite_pct]) });
  });
  const f = (x) => String(x).replace(".", ",");
  const mois = (j) => (j == null ? "?" : j < 45 ? f(Math.round(j)) + " jours" : f(Math.round(j / 30.44 * 10) / 10) + " mois");
  const lecture = [
    meilleur.reussite_pct > 0 ? "Examen : le meilleur dosage est " + f(meilleur.risque_pct) + " % par trade, avec " + f(meilleur.reussite_pct) + " % de réussite en " + mois(meilleur.jours_median) + " (médiane). Réussi en moins de 2 semaines : " + f(meilleur.en_2_semaines_pct) + " % des cas." : "Examen : aucun niveau de risque ne passe le challenge en moins de 12 mois.",
    sur ? "Compte financé : au plus " + f(sur.risque_pct) + " % par trade pour garder le risque de perdre le compte sous 5 % sur un an ; gain médian " + f(sur.gain_mensuel_median_pct) + " % par mois." : "Compte financé : même à 0,25 % par trade, le risque de perdre le compte dépasse 5 % sur un an.",
  ].join(" ");
  return { regles: P, departs: departs.length, trades: T.length, trades_par_mois: r1(T.length / Math.max(1, (fin - debut) / MOIS_MS)), examen, finance, mises: regles, lecture };
}

// La référence « sans avantage » : les mêmes trades, aux mêmes moments, avec leur moyenne retirée (gain moyen nul).
// Ce qu'elle réussit, c'est la part de chance ; seul l'écart avec la vraie ligne vient de la stratégie.
function ajouterSansAvantage(sim, trades, debut, fin) {
  const T = trades.filter((t) => t.sortieT && Number.isFinite(t.R)); if (!T.length) return sim;
  const moy = T.reduce((z, t) => z + t.R, 0) / T.length, S0 = simulerChallenge(T.map((t) => Object.assign({}, t, { R: t.R - moy })), debut, fin);
  if (!S0) return sim;
  sim.examen.forEach((x) => { const y = S0.examen.find((z) => z.risque_pct === x.risque_pct); if (y) x.sans_avantage = { reussite_pct: y.reussite_pct, echec_pct: y.echec_pct }; });
  sim.finance.forEach((x) => { const y = S0.finance.find((z) => z.risque_pct === x.risque_pct); if (y) x.sans_avantage = { compte_perdu_pct: y.compte_perdu_pct, gain_mensuel_median_pct: y.gain_mensuel_median_pct }; });
  (sim.mises || []).forEach((x) => { const y = (S0.mises || []).find((z) => z.cle === x.cle), v = y && y.par_risque.find((z) => z[0] === x.risque_pct); if (v) x.sans_avantage_pct = v[1]; });
  const m = sim.examen.slice().sort((a, b) => b.reussite_pct - a.reussite_pct || (a.jours_median || 1e9) - (b.jours_median || 1e9))[0], f = (x) => String(x).replace(".", ",");
  if (m && m.sans_avantage) {
    const ecart = Math.round((m.reussite_pct - m.sans_avantage.reussite_pct) * 10) / 10;
    sim.avantage = { risque_pct: m.risque_pct, reussite_pct: m.reussite_pct, hasard_pct: m.sans_avantage.reussite_pct, ecart_points: ecart };
    sim.lecture += " Sans avantage (les mêmes trades, moyenne retirée), ce dosage réussirait " + f(m.sans_avantage.reussite_pct) + " % : " +
      (ecart >= 10 ? "la stratégie apporte " + f(ecart) + " points de réussite de plus que la chance." : ecart > 0 ? "à peine " + f(ecart) + " points de plus que la chance : l'avantage est mince." : "pas mieux que la chance.");
  }
  return sim;
}
// Les trades d'une stratégie sur un marché, hors coffre-fort (le coffre reste fermé : la simulation n'est pas un nouvel essai)
async function tradesHorsCoffre(actif, unite, strat, ext) {
  const sym = await symbole(actif);
  const { c: cTout, source } = await bougies(sym, unite);
  const cut = coupeCoffre(cTout), c = cTout.filter((b) => b.t < cut);
  const ans = c.length ? (c[c.length - 1].t - c[0].t) / (365.25 * JOUR_MS) : 0;
  if (c.length < 300 || ans < 3.5) throw new Error(sym + " n'a que " + String(Math.round(ans * 10) / 10).replace(".", ",") + " an(s) de données (" + source + ")");
  const tr = simuler(c, Object.assign({}, strat, { frais_nuit: true }), fraisDefaut(sym), slippageDefaut(sym), fraisNuitDefaut(sym), ext);   // frais de nuit toujours comptés : une prop firm les facture
  return { sym, source, debut: c[Math.min(210, c.length - 1)].t, fin: c[c.length - 1].t, trades: tr.map((t) => ({ t: t.t, sortieT: t.sortieT, R: t.R, sym })) };
}
// Simule le challenge pour un test déjà fait, sur les marchés où il a été validé (ou ceux demandés), réunis en un seul panier
const KEY_CHALL = "alphie:challenges";
// Le panier : tous les marchés validés (✓ : gagne après frais ET bat le hasard, et pas « sur-optimisé ») de plusieurs tests, sur un seul compte.
// « tortues » = la famille des Tortues de V1-1 ; « tout » = tous les tests. Au plus 12 marchés (temps de calcul d'une minute).
const PANIERS = { tortues: { nom: "Panier des Tortues", detail: "toutes les Tortues validées, sur un seul compte" }, tout: { nom: "Panier complet", detail: "tout ce qui bat le hasard, sur un seul compte" } };
function compositionPanier(camp, type) {
  const L = [];
  for (const e of camp.essais || []) {
    const v = e.preset && TOUS_LES_TESTS.find((x) => x.id === e.preset); if (!v) continue;
    if (type === "tortues" && !FAMILLE_TORTUES.includes(v.id)) continue;
    for (const m of e.marches || []) if (m.bat_le_hasard && (m.esperance_R || 0) > 0 && m.verdict !== "sur-optimisee") L.push({ v, sym: m.symbole });
  }
  return L.slice(0, 12);
}
async function challengePanier(type) {
  if (!PANIERS[type]) throw new Error("panier inconnu : " + type);
  const camp = await lireCampagne(), L = compositionPanier(camp, type);
  if (!L.length) throw new Error("aucun marché validé pour ce panier");
  const ext = {};
  for (const x of L) { try { Object.assign(ext, await externesDe(x.v.strategie)); } catch (err) { throw new Error("données externes indisponibles (" + err.message + "). Réessaie dans quelques minutes."); } }
  const sorties = await Promise.all(L.map((x) => tradesHorsCoffre(x.sym, x.v.unite, x.v.strategie, ext).then((r) => Object.assign(r, { test: x.v.id }), (err) => new Error(x.v.id + " " + x.sym + " : " + err.message))));
  const erreurs = sorties.filter((x) => x instanceof Error).map((x) => x.message), ok = sorties.filter((x) => !(x instanceof Error));
  if (!ok.length) throw new Error(erreurs.join(" ; "));
  const debut = Math.max(...ok.map((x) => x.debut)), fin = Math.min(...ok.map((x) => x.fin));   // la période commune à tous les marchés
  const tous = [].concat(...ok.map((x) => x.trades)), sim = simulerChallenge(tous, debut, fin);
  if (!sim) throw new Error("pas assez de trades ou d'historique commun pour simuler un challenge");
  ajouterSansAvantage(sim, tous, debut, fin);
  const parTest = {}; ok.forEach((x) => { (parTest[x.test] = parTest[x.test] || []).push(x.sym); });
  const out = Object.assign({ id: "C" + Date.now().toString(36), date: Date.now(), preset: PANIERS[type].nom, panier: type, nom: PANIERS[type].detail, unite: "4h", marches: ok.map((x) => x.sym), composition: Object.keys(parTest).map((k) => ({ test: k, marches: parTest[k] })), erreurs, periode: { debut, fin } }, sim);
  try { await core().redis(["LPUSH", KEY_CHALL, JSON.stringify(out)]); await core().redis(["LTRIM", KEY_CHALL, "0", "9"]); } catch (err) {}
  return out;
}
async function challengePreset(a) {
  if (a.panier) return challengePanier(String(a.panier));
  const v = TOUS_LES_TESTS.find((x) => x.id === String(a.preset || "").toUpperCase());
  if (!v) throw new Error("test inconnu : " + a.preset);
  const camp = await lireCampagne(), e = camp.essais.find((x) => x.preset === v.id);
  if (!e) throw new Error(v.id + " n'a pas encore été testé : lance-le d'abord dans la campagne");
  const valides = e.marches.filter((m) => m.bat_le_hasard && (m.esperance_R || 0) > 0).map((m) => m.symbole);
  const marches = (Array.isArray(a.marches) && a.marches.length ? a.marches : valides).slice(0, 6);
  if (!marches.length) throw new Error(v.id + " n'a été validé sur aucun marché : rien à simuler");
  let ext;
  try { ext = await externesDe(v.strategie); } catch (err) { throw new Error("données externes indisponibles (" + err.message + "). Réessaie dans quelques minutes."); }
  const sorties = await Promise.all(marches.map((m) => tradesHorsCoffre(m, v.unite, v.strategie, ext).catch((err) => err)));
  const erreurs = sorties.filter((x) => x instanceof Error).map((x) => x.message), ok = sorties.filter((x) => !(x instanceof Error));
  if (!ok.length) throw new Error(erreurs.join(" ; "));
  const debut = Math.min(...ok.map((x) => x.debut)), fin = Math.min(...ok.map((x) => x.fin));
  const tous = [].concat(...ok.map((x) => x.trades)), sim = simulerChallenge(tous, debut, fin);
  if (!sim) throw new Error("pas assez de trades ou d'historique pour simuler un challenge");
  ajouterSansAvantage(sim, tous, debut, fin);
  const out = Object.assign({ id: "C" + Date.now().toString(36), date: Date.now(), preset: v.id, nom: v.strategie.nom, unite: v.unite, marches: ok.map((x) => x.sym), erreurs, periode: { debut, fin } }, sim);
  try { await core().redis(["LPUSH", KEY_CHALL, JSON.stringify(out)]); await core().redis(["LTRIM", KEY_CHALL, "0", "9"]); } catch (err) {}
  return out;
}
async function challengesSimules() {
  try { const raw = await core().redis(["LRANGE", KEY_CHALL, "0", "9"]); return (raw || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
}

async function historique() {
  const raw = await core().redis(["LRANGE", KEY, "0", "49"]);
  return (raw || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
}

// ===================== Rejeu du témoin sur 10 ans (demandé par Geremy le 12/10) =====================
// Le témoin (la stratégie d'Alphie appliquée par le code seul) rejoué sur l'historique en bougies d'1 heure, aux heures des sessions,
// avec les mêmes règles qu'en direct : setups PRÊTS du scanner, 2 R minimum, horaires de la stratégie, jamais contre le 4 h,
// un seul trade ou ordre par marché, ordres annulés quand le setup n'est plus prêt (ou au bout de 8 h), point mort à +1 R,
// protection des gains dès mi-chemin, rien d'ouvert le week-end hors crypto, frais et glissement de la démo.
// Limites honnêtes : le balayage S2 et les confluences 15 min demandent des bougies de 15 minutes, absentes de l'historique :
// seuls le repli S1 et la cassure S3 sont rejoués. Dans une bougie d'1 heure qui touche le stop et l'objectif, on compte le stop.
// À chaque décision, la photo du marché est prise comme en direct (le VIX, le dollar et les taux sont ceux de la veille ;
// le levier et l'agressivité crypto n'existent pas dans l'historique). La règle de stop de Geremy est rejouée sur chaque trade.
const REJEU = { version: "2026-10-13-c", actifs: ["OR", "US100", "EURUSD", "GBPUSD", "BTC", "ETH", "GER40", "US500", "ARGENT"], annees: 10, controle_annees: 3, duree_max_h: 15 * 24, morceau_jours: 200, conf_R_min: 1.5,
  // DAX, S&P 500 et argent : testés dans le rejeu seulement (Alphie ne les trade pas en direct), pour voir si la stratégie y marche mieux
  rejeu_seulement: ["GER40", "US500", "ARGENT"],
  frais_pct: { ARGENT: 0.04 },   // l'écart de prix de l'argent est plus large que celui de l'or : frais estimés plus haut (par sens, en %)
  horaires_comme: { US500: "US100" } };   // le S&P 500 suit les heures du Nasdaq (ouverture de New York)
const KR = { etat: "alphie:rejeu:etat", trades: (a) => "alphie:rejeu:t:" + a, resume: "alphie:rejeu:resume", ctx: "alphie:rejeu:ctx" };
const DK_REJEU = { OR: "XAUUSD", US100: "USATECHIDXUSD", EURUSD: "EURUSD", GBPUSD: "GBPUSD", GER40: "DEUIDXEUR", US500: "USA500IDXUSD", ARGENT: "XAGUSD" };
const PRIX_TYPE = { OR: 2000, US100: 12000, EURUSD: 1.1, GBPUSD: 1.3, GER40: 15000, US500: 4000, ARGENT: 22 };
const PH_CHAMPS = ["seance", "vix", "vix_var", "volume_rel", "volatilite", "chop", "range_conso", "cible_reste", "obstacles", "obstacle1_R", "cout_R", "dollar_pct", "taux_pb", "jour_sens", "semaine_sens", "repli_age", "profondeur", "stop_atr", "impulsion_atr", "rsi_sens"];
const SEANCES_R = ["Asie", "Londres", "Londres + New York", "New York", "Soir", "Week-end"];
const H_MS = 3600000, J_MS = 86400000;
const demoR = () => require("./demo.js")._rejeu;

// ----- Données : 1 h sur une période, depuis la réserve (or, Nasdaq, forex) ou Binance (crypto) -----
async function rejeuBougiesDK(actif, de, a) {
  const nom = DK_REJEU[actif], mois = [];
  for (let d = new Date(Date.UTC(new Date(de).getUTCFullYear(), new Date(de).getUTCMonth(), 1)); d.getTime() <= a; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) mois.push([d.getUTCFullYear(), d.getUTCMonth(), d.getTime()]);
  const champs = mois.map(nomMoisDK), donnees = await lireReserve(nom, champs), brut = [];
  // la réserve garde 10 ans : les mois plus anciens (l'échauffement des moyennes au tout début du rejeu) n'y seront jamais.
  // Ce n'est pas un manque à attendre : le rejeu démarre avec ce qui existe (avant ce correctif, le premier morceau attendait pour toujours).
  const fenetre = new Set(moisDK(10).map(nomMoisDK));
  const manquants = mois.filter((m, k) => !(champs[k] in donnees) && fenetre.has(champs[k]) && Date.now() - m[2] >= RECENT_MS).map((m) => nomMoisDK(m));
  if (manquants.length > 2) { const e = new Error(manquants.length + " mois pas encore en réserve"); e.attente = true; throw e; }
  mois.forEach((m, k) => { const v = donnees[champs[k]]; if (!v || !v.length) return; for (const x of lireBougies(lzmaDecode(v), m[2])) brut.push(x); });
  let c = ordonner(brut).filter((x) => x.v > 0 && x.h >= x.l && x.t >= de && x.t <= a);
  if (!c.length) return [];
  const tri = c.map((x) => x.c).sort((p, q) => p - q), med = tri[Math.floor(tri.length / 2)], f = 10 ** Math.round(Math.log10(med / PRIX_TYPE[actif]));
  const vu = new Set();
  return c.filter((x) => !vu.has(x.t) && vu.add(x.t)).sort((p, q) => p.t - q.t).map((x) => ({ t: x.t, o: x.o / f, h: x.h / f, l: x.l / f, c: x.c / f, v: x.v }));
}
// Binance n'a ses premières bougies BTC/USDT et ETH/USDT que le 17 août 2017. Avant, il n'y a rien à charger : ce n'est pas une panne,
// le rejeu passe simplement à la suite (avant ce correctif, le premier morceau d'octobre 2016 tombait en « attente » pour toujours).
const DEBUT_BINANCE = Date.UTC(2017, 7, 17);
async function rejeuBougiesCrypto(actif, de, a) {
  if (a < DEBUT_BINANCE) return [];
  de = Math.max(de, DEBUT_BINANCE - J_MS);
  let derniere = "aucune réponse";
  for (const host of ["https://data-api.binance.vision", "https://api.binance.com", "https://api.binance.us"]) {
    try {
      const c = await paginer(fenetres(de, a, 1000 * H_MS), 8, async ([x, y], sonde) => {
        const d = await core().fetchJSON(`${host}/api/v3/klines?symbol=${actif}USDT&interval=1h&startTime=${x}&endTime=${y}&limit=1000`, sonde ? 6000 : 9000);
        if (!Array.isArray(d)) throw new Error("réponse inattendue");
        return d.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      }, 15000);
      if (c.length >= 100 || (c.length && c[c.length - 1].t > a - 3 * J_MS)) return c.filter((x) => x.t >= de && x.t <= a && x.h >= x.l);
      derniere = host + " : " + c.length + " bougies";
    } catch (e) { derniere = host + " : " + e.message; }
  }
  throw new Error("historique crypto indisponible (" + derniere + ")");
}
// Une seule source par marché, choisie au départ : Dukascopy si sa réserve est complète, sinon les prix de FTMO (cTrader).
// Tant que le rejeu de ce marché n'a reçu aucune bougie, le choix peut encore changer (Dukascopy complété entre-temps).
async function rejeuBougiesReserve(actif, de, a, st) {
  const nom = DK_REJEU[actif], s = st || {};
  const dkComplet = async () => { let n = 99; try { n = await manquantsReserve(nom); } catch (e) {} return n <= RESERVE_MANQUE_MAX; };
  if (!s.source || (!s.demarre && s.source === "ctrader" && (await dkComplet()))) s.source = (await dkComplet()) ? "dukascopy" : "ctrader";
  let c;
  if (s.source === "ctrader") {
    try { c = await lireCT(nom, de, a); }
    catch (e) { if (e.attente) e.message = "Dukascopy incomplet, " + e.message; throw e; }
  } else c = await rejeuBougiesDK(actif, de, a);
  if (c.length) s.demarre = true;
  return c;
}
const REJEU_SOURCES = { bougies: (actif, de, a, st) => (DK_REJEU[actif] ? rejeuBougiesReserve(actif, de, a, st) : rejeuBougiesCrypto(actif, de, a)) };   // remplaçable dans les tests

// VIX, dollar et taux à 10 ans en journalier (gardés 2 jours dans Redis : 3 appels Yahoo au lieu de 3 par morceau)
async function rejeuContexte() {
  try { const r = await core().redis(["GET", KR.ctx]); if (r) { const x = JSON.parse(r); if (x && Date.now() - x.t < 2 * J_MS) return x; } } catch (e) {}
  const y = async (sym) => { try { return ((await core().yahooChart(sym, "1d", "10y")).candles || []).filter((b) => b && Number.isFinite(b.c) && b.c > 0).map((b) => [b.t, b.c]); } catch (e) { return []; } };
  const [vix, dxy, tnx] = await Promise.all([y("^VIX"), y("DX-Y.NYB"), y("^TNX")]);
  const x = { t: Date.now(), vix, dxy, tnx };
  if (vix.length || dxy.length || tnx.length) await core().redis(["SET", KR.ctx, JSON.stringify(x), "EX", String(2 * 86400)]).catch(() => {});
  return x;
}
// la dernière journée entièrement passée avant l'instant t, et celle d'avant (jamais d'information du futur)
function veille(serie, t) {
  let lo = 0, hi = serie.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (serie[m][0] + J_MS <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 1 ? [serie[k][1], serie[k - 1][1]] : null;
}
function marcheA(ctx, t) {
  const out = {}, v = veille(ctx.vix || [], t), d = veille(ctx.dxy || [], t), x = veille(ctx.tnx || [], t), n = (z) => (z > 20 ? z / 10 : z), r2 = (z) => Math.round(z * 100) / 100;
  if (v) out.vix = { niveau: r2(v[0]), var_pct: r2((v[0] / v[1] - 1) * 100) };
  if (d) out.dollar = { var24h_pct: r2((d[0] / d[1] - 1) * 100) };
  if (x) out.taux10 = { var24h_pb: Math.round((n(x[0]) - n(x[1])) * 100) };
  return out;
}

// ----- Les sessions d'Alphie (heure de Paris), ramenées à l'heure pleine dont la bougie vient de se fermer -----
function sessionA(fin, D) {
  const j = D.jourSemaineParis(fin), we = j === 0 || j === 6, h = Math.round(D.scHeureParis(fin) * 60) / 60;
  const liste = (we ? D.CONFIG.sessions_weekend : D.CONFIG.sessions_semaine).map((x) => x.split(":").map(Number));
  const s = liste.find(([hh]) => hh === h);
  return s ? { t: fin + s[1] * 60000, weekend: we } : null;
}

// ----- Une bougie appliquée à un trade : le vrai suivi (point mort à +1 R, protection des gains) et la règle de Geremy -----
function rejeuBougie(p, b, D, premiere) {
  const long = p.sens === "long", R0 = Math.abs(p.entree - p.stopInitial) || 1, g = p.g, dir = long ? 1 : -1;
  const enR = (px) => ((px - p.entree) * dir) / R0, bas = long ? b.l : b.h, haut = long ? b.h : b.l;
  const sortie = (v, prix, issue) => { v.etat = "clos"; v.fin = b.t + H_MS; v.sortie = prix; v.issue = issue; v.R = Math.round((((prix - p.entree) * dir - (p.entree + prix) * p.fr) / R0) * 100) / 100; };
  const pm = long ? p.entree * (1 + 2 * p.fr) : p.entree * (1 - 2 * p.fr);
  for (const v of [p.reel, p.geremy]) {
    if (v.etat === "clos") continue;
    const reel = v === p.reel;
    // 1) le stop, fixé avec les bougies précédentes (par prudence, vérifié avant l'objectif)
    if (long ? b.l <= v.stop : b.h >= v.stop) {
      const px = long ? Math.min(b.o, v.stop) : Math.max(b.o, v.stop);
      if (reel) p.mae = Math.min(p.mae, enR(px));
      sortie(v, px * (1 - dir * g), v.stop === p.stopInitial ? "stop" : "stop remonté"); continue;
    }
    if (reel) p.mae = Math.min(p.mae, enR(bas));
    if (premiere === "limite") continue;   // ordre servi dans cette bougie : on ignore son meilleur prix (on ne sait pas s'il est venu avant ou après)
    // 2) l'objectif (traversé, comme en direct)
    if (long ? b.h > p.objectif * (1 + D.TRAVERSEE) : b.l < p.objectif * (1 - D.TRAVERSEE)) { if (reel) p.mfe = Math.max(p.mfe, enR(p.objectif)); sortie(v, p.objectif, "objectif"); continue; }
    if (reel) p.mfe = Math.max(p.mfe, enR(haut));
    // 3) le stop pour les bougies suivantes
    v.meilleur = long ? Math.max(v.meilleur, b.h) : Math.min(v.meilleur, b.l);
    const gain = (v.meilleur - p.entree) * dir;
    let s = v.stop;
    if (reel) {
      if (gain >= R0) s = long ? Math.max(s, pm) : Math.min(s, pm);   // point mort à +1 R
      if (gain >= D.PROTECTION.depart * Math.abs(p.objectif - p.entree)) {   // protection des gains dès mi-chemin de l'objectif
        let q = p.entree + dir * D.PROTECTION.garder * gain;
        if (p.atr > 0) q = long ? Math.max(q, v.meilleur - D.PROTECTION.atr * p.atr) : Math.min(q, v.meilleur + D.PROTECTION.atr * p.atr);
        q = long ? Math.max(q, pm) : Math.min(q, pm); s = long ? Math.max(s, q) : Math.min(s, q);
      }
    } else if (gain >= 0.5 * R0) {   // règle de Geremy : point mort dès +0,5 R, puis 0,9 R de marge derrière le meilleur prix
      const q = long ? Math.max(v.meilleur - 0.9 * R0, pm) : Math.min(v.meilleur + 0.9 * R0, pm); s = long ? Math.max(s, q) : Math.min(s, q);
    }
    v.stop = s;
  }
}
function fermerA(p, prix, issue, t) {
  const long = p.sens === "long", R0 = Math.abs(p.entree - p.stopInitial) || 1, dir = long ? 1 : -1;
  for (const v of [p.reel, p.geremy]) if (v.etat !== "clos") { v.etat = "clos"; v.fin = t || null; v.sortie = prix; v.issue = issue; v.R = Math.round((((prix - p.entree) * dir - (p.entree + prix) * p.fr) / R0) * 100) / 100; }
}
const compactPhoto = (ph) => PH_CHAMPS.map((k) => (ph && ph[k] != null ? (k === "seance" ? SEANCES_R.indexOf(ph[k]) : ph[k]) : null));
const tradeCompact = (p) => [Math.round(p.decision / 60000), p.setup === "S3_CASSURE" ? 3 : p.setup === "S1_CONF" ? 11 : 1, p.sens === "long" ? 1 : -1, p.reel.R, p.geremy.R, Math.round(p.mfe * 100) / 100, Math.round(p.mae * 100) / 100, compactPhoto(p.photo), Math.round((p.reel.fin || p.decision) / 60000)];   // dernier : heure de sortie (pour simuler un challenge jour par jour)

// ----- Un morceau de rejeu pour un marché : de « depuis » jusqu'à « jusqua » au plus, tant que le temps le permet -----
async function rejeuMorceau(actif, st, finAvant, ctx, opts) {
  const D = demoR(), crypto = D.CONFIG.cryptos.includes(actif), inst = D.instrument(actif), g = D.glissement(inst), fr = (REJEU.frais_pct[actif] != null ? REJEU.frais_pct[actif] : D.fraisPctInst(inst)) / 100;
  const debut = st.curseur, fin = Math.min(st.fin, debut + REJEU.morceau_jours * J_MS);
  const c1 = await (opts && opts.bougies ? opts.bougies(actif, debut - 420 * J_MS, fin) : REJEU_SOURCES.bougies(actif, debut - 420 * J_MS, fin, st));   // 420 jours avant : les moyennes du 4 h, du jour (200) et de la semaine (30) démarrent comme en direct
  const c4 = D.scRegrouper4h(c1), cd = regrouperUTC(c1, J_MS), trades = [];
  let i4 = 0, id = 0, k0 = c1.findIndex((x) => x.t >= debut);
  if (k0 < 0) { st.curseur = fin; return { trades, decisions: 0 }; }
  let decisions = 0, k = k0;
  for (; k < c1.length; k++) {
    if (Date.now() > finAvant) break;
    const b = c1[k], finB = b.t + H_MS;
    // 1) ordres en attente : week-end, expiration, puis exécution dans cette bougie
    const vendredi = !crypto && D.jourSemaineParis(b.t) === 5, hP = D.scHeureParis(b.t);
    for (const o of st.ordres.slice()) {
      if ((vendredi && hP >= 19) || b.t >= o.expire) { st.ordres = st.ordres.filter((x) => x !== o); continue; }
      const long = o.sens === "long";
      let px = null;
      if (o.type === "marché") px = b.o * (1 + (long ? 1 : -1) * g);
      else if (o.type === "limite") { const tr = o.entree * D.TRAVERSEE; if (long ? b.l < o.entree - tr : b.h > o.entree + tr) px = o.entree; }
      else if (long ? b.h >= o.entree : b.l <= o.entree) px = o.entree * (1 + (long ? 1 : -1) * g);
      if (px == null) continue;
      st.ordres = st.ordres.filter((x) => x !== o);
      const p = { actif, setup: o.setup, sens: o.sens, decision: o.decision, entree: px, stopInitial: o.stop, objectif: o.objectif, atr: o.atr, g, fr, photo: o.photo, ouvert: b.t, mfe: 0, mae: 0,
        reel: { etat: "ouvert", stop: o.stop, meilleur: px }, geremy: { etat: "ouvert", stop: o.stop, meilleur: px } };
      // objectif ou stop déjà dépassés à l'ouverture (écart de prix) : le trade n'a pas de sens, on l'oublie
      if (long ? !(o.stop < px && o.objectif > px) : !(o.stop > px && o.objectif < px)) continue;
      st.positions.push(p);
      rejeuBougie(p, b, D, o.type === "marché" ? "marché" : "limite");
    }
    // 1 bis) l'entrée confirmée du repli (carnet à part, sans effet sur le témoin) : on attend qu'une bougie d'1 heure clôture
    // au-dessus de la précédente (au-dessous pour une vente), puis on entre à l'ouverture de la suivante, même stop et même objectif
    for (const q of st.conf.slice()) {
      const long = q.sens === "long";
      if (q.etat === "à ouvrir") {
        st.conf = st.conf.filter((z) => z !== q);
        const px = b.o * (1 + (long ? 1 : -1) * g);
        if (long ? !(q.stop < px && q.objectif > px) : !(q.stop > px && q.objectif < px)) continue;
        const pc = { actif, setup: "S1_CONF", sens: q.sens, decision: q.decision, entree: px, stopInitial: q.stop, objectif: q.objectif, atr: q.atr, g, fr, photo: q.photo, ouvert: b.t, mfe: 0, mae: 0,
          reel: { etat: "ouvert", stop: q.stop, meilleur: px }, geremy: { etat: "ouvert", stop: q.stop, meilleur: px } };
        st.posConf.push(pc); rejeuBougie(pc, b, D, "marché"); continue;
      }
      if ((vendredi && hP >= 19) || b.t >= q.expire || (long ? b.l <= q.stop : b.h >= q.stop)) { st.conf = st.conf.filter((z) => z !== q); continue; }
      const prev = c1[k - 1];
      if (prev && (long ? b.c > prev.h && b.c < q.objectif : b.c < prev.l && b.c > q.objectif) && Math.abs(q.objectif - b.c) / Math.abs(b.c - q.stop) >= REJEU.conf_R_min) q.etat = "à ouvrir";
    }
    for (const p of st.posConf.slice()) {
      if (p.ouvert !== b.t) rejeuBougie(p, b, D, null);
      if (!crypto && vendredi && hP >= 21 && (p.reel.etat !== "clos" || p.geremy.etat !== "clos")) fermerA(p, b.o, "fermé avant le week-end", b.t);
      if (b.t - p.ouvert >= REJEU.duree_max_h * H_MS) fermerA(p, b.c, "durée maximale", b.t + H_MS);
      if (p.reel.etat === "clos" && p.geremy.etat === "clos") { st.posConf = st.posConf.filter((x) => x !== p); trades.push(tradeCompact(p)); }
    }
    // 2) trades ouverts (ceux de la bougie d'avant et plus anciens)
    for (const p of st.positions.slice()) {
      if (p.ouvert !== b.t) rejeuBougie(p, b, D, null);
      if (!crypto && vendredi && hP >= 21 && (p.reel.etat !== "clos" || p.geremy.etat !== "clos")) fermerA(p, b.o, "fermé avant le week-end", b.t);
      if (b.t - p.ouvert >= REJEU.duree_max_h * H_MS) fermerA(p, b.c, "durée maximale", b.t + H_MS);
      if (p.reel.etat === "clos" && p.geremy.etat === "clos") { st.positions = st.positions.filter((x) => x !== p); trades.push(tradeCompact(p)); if (opts && opts.detail) opts.detail.push(detailRejeu(p)); }
    }
    // 3) décision du témoin si une session tombe à la fermeture de cette bougie
    const s = sessionA(finB, D);
    if (!s) continue;
    const nuit = D.scHeureParis(s.t) < D.CONFIG.heure_debut || D.scHeureParis(s.t) >= D.CONFIG.heure_fin;
    const libre = !st.positions.some((p) => p.reel.etat !== "clos") && !st.ordres.length;
    const chercher = libre && (crypto || (!s.weekend && !nuit && D.scHoraireOk(REJEU.horaires_comme[actif] || actif, s.t)));
    if (!chercher && !st.ordres.length) continue;
    if (!crypto && s.weekend) continue;
    while (i4 < c4.length && c4[i4].t + 4 * H_MS <= finB) i4++;
    while (id < cd.length && cd[id].t + J_MS <= finB) id++;
    const w1 = c1.slice(Math.max(0, k - 1199), k + 1), w4 = c4.slice(Math.max(0, i4 - 700), i4), wd = cd.slice(Math.max(0, id - 520), id);   // 2 ans de journalier, comme en direct
    // la bougie de 4 h en cours, faite des heures déjà fermées (comme en direct, jamais avec les heures à venir)
    const deb4 = Math.floor(finB / (4 * H_MS)) * 4 * H_MS, cours = c1.slice(Math.max(0, k - 4), k + 1).filter((x) => x.t >= deb4);
    if (cours.length) w4.push({ t: deb4, o: cours[0].o, h: Math.max(...cours.map((x) => x.h)), l: Math.min(...cours.map((x) => x.l)), c: cours[cours.length - 1].c, v: cours.reduce((z, x) => z + (x.v || 0), 0) });
    if (w1.length < 300 || w4.length < 210) continue;
    decisions++;
    let r; try { r = D.scAnalyser(actif, { c15: [{ t: s.t - 60000, o: b.c, h: b.c, l: b.c, c: b.c, v: 0 }], c1: w1, c4: w4, cd: wd, volume: true }, s.t); } catch (e) { continue; }
    if (!r || r.erreur) continue;
    // le témoin annule un ordre dont le setup n'est plus prêt
    for (const o of st.ordres.slice()) { const x = (r.setups || []).find((y) => y.setup === o.setup && y.sens === o.sens); if (!x || x.statut !== "prêt") st.ordres = st.ordres.filter((z) => z !== o); }
    if (!chercher || st.ordres.length) continue;
    const cand = (r.setups || []).filter((x) => (x.setup === "S1_REPLI" || x.setup === "S3_CASSURE") && x.statut === "prêt" && x.plan && x.sens && !x.contre4h)
      .sort((x, y) => ((y.plan.confluences || []).length - (x.plan.confluences || []).length) || (y.plan.R - x.plan.R));
    const x = cand[0]; if (!x) continue;
    const long = x.sens === "long", e = x.plan.entree, st0 = x.plan.stop, ob = x.plan.objectif;
    if (long ? !(st0 < e && ob > e) : !(st0 > e && ob < e)) continue;
    if (Math.abs(ob - e) / Math.abs(e - st0) < 2 - 1e-9) continue;
    const type = x.plan.type === "marché" ? "marché" : long ? (e < r.prix ? "limite" : "stop") : (e > r.prix ? "limite" : "stop");
    const photo = D.photoDe({ t: s.t, par: { [actif]: r }, marche: marcheA(ctx, s.t) }, actif, x.sens, { entree: e, stop: st0, objectif: ob, setup: x.setup }, s.t);
    st.ordres.push({ setup: x.setup, sens: x.sens, type, entree: e, stop: st0, objectif: ob, atr: r.atr1h, decision: s.t, expire: s.t + D.CONFIG.ordre_expiration_h * H_MS, photo });
    // la même décision, version « entrée confirmée » (seulement pour le repli, et un seul à la fois sur ce marché)
    if (x.setup === "S1_REPLI" && !st.conf.length && !st.posConf.some((p) => p.reel.etat !== "clos")) st.conf.push({ sens: x.sens, stop: st0, objectif: ob, atr: r.atr1h, decision: s.t, expire: s.t + D.CONFIG.ordre_expiration_h * H_MS, photo, etat: "attente" });
  }
  st.curseur = k < c1.length ? c1[k].t : fin;
  return { trades, decisions };
}

const detailRejeu = (p) => ({ actif: p.actif, setup: p.setup, sens: p.sens, decision: p.decision, ouvert: p.ouvert, entree: p.entree, stop: p.stopInitial, objectif: p.objectif, R: p.reel.etat === "clos" ? p.reel.R : null, issue: p.reel.etat === "clos" ? p.reel.issue : "en cours" });

// ===== Le rejeu colle-t-il à la réalité ? (demandé par Geremy le 17/10/2026) =====
// On rejoue les dernières semaines avec le moteur du rejeu, mais sur les MÊMES prix que le témoin en direct (Yahoo en 1 h pour l'or, le Nasdaq
// et le forex ; Binance pour les cryptos, très proche de Kraken), puis on met côte à côte ses trades et ceux que le témoin a vraiment pris.
// Écarts attendus et connus : en direct, le témoin voit aussi les bougies de 15 minutes, et ses garde-fous (budget du jour, corrélations,
// fermeture du marché) peuvent refuser un trade ; le rejeu traite chaque marché seul, en bougies d'1 heure.
const COMPARE = { jours: 21, chauffe_jours: 75, ecart_h: 3, cle: "alphie:rejeu:compare", compte: "alphie:demo:compte:temoin" };
async function bougiesDirect(actif, de, a) {
  const D = demoR(), inst = D.instrument(actif), de2 = Math.max(de, a - (COMPARE.jours + COMPARE.chauffe_jours) * J_MS);
  if (inst.src === "kraken") return rejeuBougiesCrypto(actif, de2, a);
  const { candles } = await core().yahooChart(inst.sym, "60m", "6mo");
  return (candles || []).filter((x) => x && Number.isFinite(x.c) && x.c > 0 && x.h >= x.l && x.t >= de2 && x.t + H_MS <= a).map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v || 0 })).sort((x, y) => x.t - y.t);
}
const COMPARE_SOURCES = { bougies: bougiesDirect };   // remplaçable dans les tests
// Associe chaque trade du témoin à un trade du rejeu : même marché, même sens, ouvert à « ecart_h » heures près (sinon dans les 24 h : décalé)
function associerTrades(TT, TR, ecartH) {
  const libres = TR.slice(), lignes = [];
  const prendre = (t, maxH) => {
    let best = null, d = Infinity;
    for (const r of libres) { if (r.actif !== t.actif || r.sens !== t.sens) continue; const x = Math.abs(r.ouvert - t.ouverture); if (x <= maxH * H_MS && x < d) { d = x; best = r; } }
    if (best) libres.splice(libres.indexOf(best), 1);
    return best;
  };
  for (const t of TT) { const r = prendre(t, ecartH); if (r) lignes.push({ etat: "retrouvé", t, r }); }
  for (const t of TT) { if (lignes.some((l) => l.t === t)) continue; const r = prendre(t, 24); lignes.push(r ? { etat: "décalé", t, r } : { etat: "témoin seul", t, r: null }); }
  for (const r of libres) lignes.push({ etat: "rejeu seul", t: null, r });
  return lignes.sort((x, y) => (x.t ? x.t.ouverture : x.r.ouvert) - (y.t ? y.t.ouverture : y.r.ouvert));
}
async function comparerTemoin(finAvant) {
  const D = demoR(), now = Date.now(), fin = now - H_MS, debut = now - COMPARE.jours * J_MS;
  let compte = null; try { const r = await core().redis(["GET", COMPARE.compte]); compte = r ? JSON.parse(r) : null; } catch (e) {}
  if (!compte) throw new Error("compte témoin introuvable");
  const serie = compte.serie && compte.serie.depuis ? new Date(compte.serie.depuis).getTime() : null;
  const setupDe = (x) => (/S3/.test(String(x || "")) ? "S3" : /S1/.test(String(x || "")) ? "S1" : String(x || "?").split("_")[0]);
  const TT = [].concat(compte.historique || [], compte.positions || []).filter((t) => t && t.ouverture && D.CONFIG.univers.includes(t.actif))
    .map((t) => ({ actif: t.actif, sens: t.sens, setup: setupDe(t.code_setup || t.setup), ouverture: new Date(t.ouverture).getTime(), entree: t.entree, stop: t.stopInitial != null ? t.stopInitial : t.stop, objectif: t.objectif, R: t.resultat_R != null ? t.resultat_R : null, issue: t.fermeture ? t.raison_sortie || "fermé" : "en cours" }))
    .filter((t) => t.ouverture >= debut && t.ouverture <= now).sort((a, b) => a.ouverture - b.ouverture);
  const ctx = await rejeuContexte(), marches = {}, TR = [];
  await Promise.all(D.CONFIG.univers.map(async (a) => {
    const st = { curseur: debut, fin, ordres: [], positions: [], conf: [], posConf: [] }, detail = [];
    try {
      await rejeuMorceau(a, st, finAvant, ctx, { bougies: COMPARE_SOURCES.bougies, detail });
      for (const p of st.positions) if (p.reel.etat !== "clos") detail.push(detailRejeu(p));   // encore ouverts à la fin
      detail.filter((x) => x.ouvert >= debut).forEach((x) => TR.push(x));
      marches[a] = { trades: detail.length, jusqua: st.curseur };
    } catch (e) { marches[a] = { erreur: e.message.slice(0, 120) }; }
  }));
  const lignes = associerTrades(TT, TR, COMPARE.ecart_h), n = (e) => lignes.filter((l) => l.etat === e).length;
  const paires = lignes.filter((l) => l.t && l.r && l.t.R != null && l.r.R != null), r2 = (x) => Math.round(x * 100) / 100;
  const somme = (L) => r2(L.reduce((z, x) => z + x, 0));
  const res = { t: now, debut, fin, serie_depuis: serie, jours: COMPARE.jours, ecart_h: COMPARE.ecart_h, marches,
    temoin: TT.length, rejeu: TR.length, retrouves: n("retrouvé"), decales: n("décalé"), temoin_seul: n("témoin seul"), rejeu_seul: n("rejeu seul"),
    R_temoin: somme(TT.filter((t) => t.R != null).map((t) => t.R)), R_rejeu: somme(TR.filter((t) => t.R != null).map((t) => t.R)),
    paires: paires.length, R_paires_temoin: somme(paires.map((l) => l.t.R)), R_paires_rejeu: somme(paires.map((l) => l.r.R)),
    lignes: lignes.slice(-60).map((l) => ({ etat: l.etat, actif: (l.t || l.r).actif, sens: (l.t || l.r).sens, setup: l.t ? l.t.setup : setupDe(l.r.setup),
      t_temoin: l.t ? l.t.ouverture : null, t_rejeu: l.r ? l.r.ouvert : null, entree_temoin: l.t ? l.t.entree : null, entree_rejeu: l.r ? +(+l.r.entree).toPrecision(6) : null,
      R_temoin: l.t ? l.t.R : null, R_rejeu: l.r ? l.r.R : null, issue_temoin: l.t ? l.t.issue : null, issue_rejeu: l.r ? l.r.issue : null, avant_serie: !!(serie && (l.t ? l.t.ouverture : l.r.ouvert) < serie) })) };
  const vus = res.retrouves + res.decales, f = (x) => String(x).replace(".", ",");
  if (res.temoin < 5) res.verdict = { note: "trop tôt", texte: "Le témoin n'a pris que " + res.temoin + " trade" + (res.temoin > 1 ? "s" : "") + " sur la période : trop peu pour juger. À refaire dans quelques jours." };
  else {
    const part = vus / res.temoin;
    res.verdict = part >= 0.7 ? { note: "fidèle", texte: "Le rejeu retrouve " + vus + " trades du témoin sur " + res.temoin + " : il reproduit bien ce que fait le témoin en direct. Ses résultats sur 10 ans sont crédibles." }
      : part >= 0.4 ? { note: "en partie", texte: "Le rejeu ne retrouve que " + vus + " trades du témoin sur " + res.temoin + " : il lui ressemble, sans le copier. Ses chiffres sur 10 ans sont une approximation." }
      : { note: "écart", texte: "Le rejeu ne retrouve que " + vus + " trades du témoin sur " + res.temoin + " : il s'écarte trop du direct. À corriger avant de faire confiance à ses chiffres sur 10 ans." };
    if (res.paires >= 3) res.verdict.texte += " Sur les " + res.paires + " trades finis des deux côtés : " + f(res.R_paires_temoin) + " R pour le témoin, " + f(res.R_paires_rejeu) + " R pour le rejeu.";
  }
  await core().redis(["SET", COMPARE.cle, JSON.stringify(res)]).catch(() => {});
  return res;
}

// ----- Un passage : avance le marché en cours, dans le temps donné -----
function nouvelEtatRejeu() {
  const fin = Date.now() - 2 * J_MS, debut = fin - REJEU.annees * 365.25 * J_MS, actifs = {};
  for (const a of REJEU.actifs) actifs[a] = { statut: "à faire", curseur: debut, fin, trades: 0, decisions: 0 };
  return { version: REJEU.version, lance: Date.now(), debut, fin, actifs };
}
async function lireEtatRejeu() { try { const r = await core().redis(["GET", KR.etat]); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
async function rejeuEtape(finAvant) {
  let E = await lireEtatRejeu();
  if (!E || E.version !== REJEU.version) { E = nouvelEtatRejeu(); for (const a of REJEU.actifs) await core().redis(["DEL", KR.trades(a)]).catch(() => {}); await core().redis(["DEL", KR.resume]).catch(() => {}); }
  const verrou = await core().redis(["SET", KR.etat + ":verrou", "1", "EX", "70", "NX"]).catch(() => "OK");
  if (verrou !== "OK") return { info: "rejeu déjà en cours" };
  const fait = [];
  try {
    const ctx = await rejeuContexte();
    while (Date.now() + 6000 < finAvant) {
      const a = REJEU.actifs.find((x) => E.actifs[x].statut === "à faire" || E.actifs[x].statut === "en cours")
        || REJEU.actifs.find((x) => E.actifs[x].statut === "en attente" && Date.now() - (E.actifs[x].essai || 0) > 30 * 60000);
      if (!a) break;
      const st = E.actifs[a];
      st.ordres = st.ordres || []; st.positions = st.positions || []; st.conf = st.conf || []; st.posConf = st.posConf || [];
      try {
        const r = await rejeuMorceau(a, st, finAvant - 1500, ctx);
        st.statut = st.curseur >= st.fin ? "fini" : "en cours"; st.decisions += r.decisions; st.trades += r.trades.length; delete st.erreur;
        if (r.trades.length) {
          let L = []; try { L = JSON.parse((await core().redis(["GET", KR.trades(a)])) || "[]"); } catch (e) {}
          await core().redis(["SET", KR.trades(a), JSON.stringify(L.concat(r.trades))]);
        }
        if (st.statut === "fini") { delete st.ordres; delete st.positions; delete st.conf; delete st.posConf; }
        fait.push(a + " : " + r.trades.length + " trades, jusqu'au " + new Date(st.curseur).toISOString().slice(0, 10));
      } catch (e) {
        st.essai = Date.now(); st.erreur = e.message.slice(0, 160); st.statut = e.attente || /indisponible/.test(e.message) ? "en attente" : "en cours";
        st.echecs = (st.echecs || 0) + 1; if (st.echecs >= 5 && st.statut !== "en attente") st.statut = "en attente";
        fait.push(a + " : " + st.erreur);
        if (st.statut !== "en attente") break;   // panne passagère : on réessaiera au prochain passage ; un marché en attente laisse passer les autres
      }
      await core().redis(["SET", KR.etat, JSON.stringify(E)]).catch(() => {});
    }
    await core().redis(["SET", KR.etat, JSON.stringify(E)]).catch(() => {});
    if (fait.length || !(await core().redis(["GET", KR.resume]).catch(() => null))) await calculerResumeRejeu(E);
  } finally { await core().redis(["DEL", KR.etat + ":verrou"]).catch(() => {}); }
  return { fait };
}

// ----- Analyse : par setup, par marché, règle de Geremy, placement du stop, conditions de marché (découverte et contrôle) -----
function statsR(R) {
  const n = R.length, s = R.reduce((z, x) => z + x, 0), r2 = (z) => Math.round(z * 100) / 100;
  return { n, R_moyen: n ? r2(s / n) : null, R_total: r2(s), gagnants_pct: n ? Math.round((R.filter((x) => x > 0.05).length / n) * 100) : 0,
    faibles_pct: n ? Math.round((R.filter((x) => x >= -0.3 && x <= 0.8).length / n) * 100) : 0 };   // trades « faibles » : finis entre −0,3 R et +0,8 R
}
// Combinaisons annoncées AVANT de voir les résultats (13/10/2026) : une hypothèse posée à l'avance vaut plus qu'une trouvée en fouillant.
// Fouiller toutes les combinaisons ferait forcément briller quelque chose par hasard : on n'en teste que trois, sur les replis.
const COMBOS_REJEU = [
  { cle: "grok", nom: "Repli stabilisé + fond de zone + impulsion forte", detail: "au moins 2 bougies depuis le bas du repli, entrée à plus de 74 % de la zone, impulsion 1 h d'au moins 4 ATR",
    champs: ["repli_age", "profondeur", "impulsion_atr"], f: (p) => p.repli_age >= 2 && p.profondeur > 0.74 && p.impulsion_atr >= 4 },
  { cle: "grok_sans_zone", nom: "Repli stabilisé + impulsion forte", detail: "la même sans la place dans la zone (le témoin entre presque toujours au milieu)",
    champs: ["repli_age", "impulsion_atr"], f: (p) => p.repli_age >= 2 && p.impulsion_atr >= 4 },
  { cle: "geremy", nom: "Semaine et jour avec le trade + repli stabilisé", detail: "le dézoom de Geremy, plus un repli qui a fini de baisser",
    champs: ["jour_sens", "semaine_sens", "repli_age"], f: (p) => p.jour_sens > 0 && p.semaine_sens > 0 && p.repli_age >= 2 },
];
// Un groupe contre le reste : « vraiment » meilleur ou moins bon sur la découverte (seuil donné), puis confirmé ou non sur le contrôle
function verdictGroupe(D, dansD, horsD, dansC, horsC, seuil) {
  const out = {}, a = D.moyEc(dansD), b = D.moyEc(horsD);
  if (!(a.n >= 20 && b.n >= 20)) return out;
  const z = (a.m - b.m) / (Math.sqrt(a.ec ** 2 / a.n + b.ec ** 2 / b.n) || 1);
  if (!(D.pValeur(z) < seuil)) return out;
  out.signal = z > 0 ? "vraiment meilleur" : "vraiment moins bon";
  const c = D.moyEc(dansC), e = D.moyEc(horsC);
  if (c.n >= 10 && e.n >= 10) { const z2 = (c.m - e.m) / (Math.sqrt(c.ec ** 2 / c.n + e.ec ** 2 / e.n) || 1); out.controle_verdict = Math.sign(z2) === Math.sign(z) && D.pValeur(z2) / 2 < 0.1 ? "confirmé" : "pas confirmé"; }
  else out.controle_verdict = "pas assez de trades pour confirmer";
  return out;
}
// Ce que donnerait un challenge FTMO 2 étapes, démarré chaque semaine des années de contrôle (jamais utilisées pour choisir les filtres)
function challengeRejeu(nom, L, coupure, fin) {
  const T = L.filter((t) => t.t >= coupure && t.sortieT).map((t) => ({ t: t.t, sortieT: t.sortieT, R: t.R }));
  const S = simulerChallenge(T, coupure, fin);
  if (!S) return { nom, trades: T.length, pas_assez: true };
  const meilleur = S.examen.slice().sort((a, b) => b.reussite_pct - a.reussite_pct || (a.jours_median || 1e9) - (b.jours_median || 1e9))[0], a1 = S.examen.find((x) => x.risque_pct === 1);
  // la référence : les mêmes trades, aux mêmes moments, mais sans avantage (on retire la moyenne). Ce qu'elle réussit, c'est la part de chance.
  const moy = T.reduce((z, t) => z + t.R, 0) / T.length, S0 = simulerChallenge(T.map((t) => Object.assign({}, t, { R: t.R - moy })), coupure, fin);
  const hasard = (r) => { const x = S0 && S0.examen.find((y) => y.risque_pct === r); return x ? { reussite_pct: x.reussite_pct, echec_pct: x.echec_pct } : null; };
  const resume = (x) => ({ risque_pct: x.risque_pct, reussite_pct: x.reussite_pct, echec_pct: x.echec_pct, trop_lent_pct: x.trop_lent_pct, jours_median: x.jours_median, sans_avantage: hasard(x.risque_pct) });
  return { nom, trades: T.length, par_mois: S.trades_par_mois, departs: S.departs, a1pct: a1 ? resume(a1) : null, meilleur: resume(meilleur) };
}
function analyseRejeu(Tout, coupure, fin) {
  const D = demoR(), r2 = (z) => Math.round(z * 100) / 100;
  const T = Tout.filter((t) => t.setup !== "S1c"), C = Tout.filter((t) => t.setup === "S1c");   // le témoin d'un côté, l'entrée confirmée de l'autre
  const per = (L) => ({ decouverte: statsR(L.filter((t) => t.t < coupure).map((t) => t.R)), controle: statsR(L.filter((t) => t.t >= coupure).map((t) => t.R)) });
  const setups = { tous: T, S1: T.filter((t) => t.setup === "S1"), S3: T.filter((t) => t.setup === "S3") };
  const par_setup = {}; for (const [k, L] of Object.entries(setups)) par_setup[k] = per(L);
  const par_actif = {}; for (const a of REJEU.actifs) { const L = T.filter((t) => t.actif === a); if (L.length) par_actif[a] = per(L); }
  // la règle de Geremy contre le suivi actuel, sur les mêmes trades
  const geremy = {}; for (const [k, L] of Object.entries(setups)) { const reel = statsR(L.map((t) => t.R)), ger = statsR(L.map((t) => t.Rg)); geremy[k] = { reel, geremy: ger, ecart_R: r2(ger.R_total - reel.R_total), mieux: L.filter((t) => t.Rg > t.R + 0.05).length, moins: L.filter((t) => t.Rg < t.R - 0.05).length }; }
  // placement du stop : à risque égal, un trade allé plus loin contre nous que le nouveau stop perd 1 R, les autres valent R / k
  const stops = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map((k) => { let tot = 0; for (const t of T) tot += k < 1 && t.mae <= -k ? -1 - (t.ph.cout_R || 0) / k : t.R / k; return { k, total_R: r2(tot) }; });
  const actuel = stops[stops.length - 1].total_R; stops.forEach((x) => (x.ecart_R = r2(x.total_R - actuel)));
  const G = T.filter((t) => t.R > 0.05).map((t) => Math.max(0, -t.mae)).sort((a, b) => a - b), q = (p) => (G.length ? r2(G[Math.min(G.length - 1, Math.floor(p * G.length))]) : null);
  // conditions de marché, sur chaque groupe de setups : signal sur la découverte (seuil corrigé), confirmé ou non sur le contrôle
  const dimsR = D.DIMS_CONDITIONS.filter((d) => d.cle !== "foule" && d.cle !== "agressivite");
  const conditions = {};
  for (const [k, L] of Object.entries(setups)) {
    const dims = []; let tests = 0;
    for (const d of dimsR) {
      const g = {};
      L.forEach((t) => { const nom = d.f(t.ph, t); if (nom) (g[nom] = g[nom] || []).push(t); });
      const groupes = d.ordre.filter((nom) => g[nom]).map((nom) => { const dec = g[nom].filter((t) => t.t < coupure).map((t) => t.R), con = g[nom].filter((t) => t.t >= coupure).map((t) => t.R); return { nom, decouverte: statsR(dec), controle: statsR(con), _d: dec, _c: con }; });
      tests += groupes.filter((x) => x._d.length).length; dims.push({ cle: d.cle, nom: d.nom, groupes });
    }
    const seuil = 0.05 / Math.max(1, tests);
    for (const dm of dims) {
      for (const gr of dm.groupes) {
        const autresD = dm.groupes.filter((x) => x !== gr).reduce((l, x) => l.concat(x._d), []), autresC = dm.groupes.filter((x) => x !== gr).reduce((l, x) => l.concat(x._c), []);
        const a = D.moyEc(gr._d), b = D.moyEc(autresD);
        if (a.n >= 20 && b.n >= 20) {
          const z = (a.m - b.m) / (Math.sqrt(a.ec ** 2 / a.n + b.ec ** 2 / b.n) || 1);
          if (D.pValeur(z) < seuil) {
            gr.signal = z > 0 ? "vraiment meilleur" : "vraiment moins bon";
            const c = D.moyEc(gr._c), e = D.moyEc(autresC);
            if (c.n >= 10 && e.n >= 10) { const z2 = (c.m - e.m) / (Math.sqrt(c.ec ** 2 / c.n + e.ec ** 2 / e.n) || 1); gr.controle_verdict = Math.sign(z2) === Math.sign(z) && D.pValeur(z2) / 2 < 0.1 ? "confirmé" : "pas confirmé"; }
            else gr.controle_verdict = "pas assez de trades pour confirmer";
          }
        }
      }
      dm.groupes.forEach((gr) => { delete gr._d; delete gr._c; });
    }
    conditions[k] = { seuil_p: seuil, dims };
  }
  // repli : entrer tout de suite (le témoin) ou attendre une bougie de confirmation, sur les mêmes décisions
  const confirmation = { immediat: per(setups.S1), confirme: per(C), R_min: REJEU.conf_R_min };
  // les combinaisons annoncées à l'avance, sur les replis : dedans contre dehors (seuil corrigé pour 3 essais)
  const combos = COMBOS_REJEU.map((cb) => {
    const L = setups.S1.filter((t) => cb.champs.every((k) => t.ph[k] != null)), dans = L.filter((t) => cb.f(t.ph)), hors = L.filter((t) => !cb.f(t.ph));
    const Rs = (X, avant) => X.filter((t) => (avant ? t.t < coupure : t.t >= coupure)).map((t) => t.R);
    return Object.assign({ cle: cb.cle, nom: cb.nom, detail: cb.detail, dedans: per(dans), dehors: per(hors) }, verdictGroupe(D, Rs(dans, true), Rs(hors, true), Rs(dans, false), Rs(hors, false), 0.05 / COMBOS_REJEU.length));
  });
  // sur un challenge : la stratégie telle quelle, puis avec les filtres
  fin = fin || Math.max(0, ...T.map((t) => t.sortieT || t.t));
  const challenge = [challengeRejeu("Témoin tel quel (repli + cassure)", T, coupure, fin), challengeRejeu("Repli seul", setups.S1, coupure, fin)];
  for (const cb of COMBOS_REJEU) challenge.push(challengeRejeu("Repli : " + cb.nom.toLowerCase(), setups.S1.filter((t) => cb.champs.every((k) => t.ph[k] != null) && cb.f(t.ph)), coupure, fin));
  const confirmes = (sig) => { const G = []; for (const d of conditions.tous.dims) for (const g of d.groupes) if (g.signal === sig && g.controle_verdict === "confirmé") G.push({ d: dimsR.find((x) => x.cle === d.cle), nom: g.nom }); return G; };
  const bons = confirmes("vraiment meilleur"), mauvais = confirmes("vraiment moins bon"), dansG = (t, G) => G.some((x) => x.d.f(t.ph, t) === x.nom);
  if (mauvais.length) challenge.push(Object.assign(challengeRejeu("Sans les conditions confirmées moins bonnes", T.filter((t) => !dansG(t, mauvais)), coupure, fin), { flatteur: true, filtres: mauvais.map((x) => x.d.nom + " : " + x.nom) }));
  if (bons.length) challenge.push(Object.assign(challengeRejeu("Seulement les conditions confirmées meilleures", T.filter((t) => dansG(t, bons)), coupure, fin), { flatteur: true, filtres: bons.map((x) => x.d.nom + " : " + x.nom) }));
  return { trades: T.length, coupure, par_setup, par_actif, geremy, confirmation, combos, challenge, stop: { gagnants: G.length, contre_gagnants: { mediane: q(0.5), p75: q(0.75), p90: q(0.9) }, lignes: stops }, conditions };
}
async function calculerResumeRejeu(E) {
  const T = [];
  for (const a of REJEU.actifs) {
    let L = []; try { L = JSON.parse((await core().redis(["GET", KR.trades(a)])) || "[]"); } catch (e) {}
    for (const x of L) { const ph = {}; PH_CHAMPS.forEach((k, i) => { const v = x[7][i]; if (v != null) ph[k] = k === "seance" ? SEANCES_R[v] : v; }); T.push({ actif: a, t: x[0] * 60000, sortieT: x[8] != null ? x[8] * 60000 : null, setup: x[1] === 3 ? "S3" : x[1] === 11 ? "S1c" : "S1", sens: x[2] === 1 ? "long" : "short", R: x[3], Rg: x[4], mfe: x[5], mae: x[6], ph }); }
  }
  const coupure = E.fin - REJEU.controle_annees * 365.25 * J_MS;
  const res = Object.assign({ t: Date.now(), version: E.version }, analyseRejeu(T, coupure, E.fin));
  await core().redis(["SET", KR.resume, JSON.stringify(res)]).catch(() => {});
  return res;
}
async function rejeuVue() {
  const E = await lireEtatRejeu(); let R = null;
  try { const r = await core().redis(["GET", KR.resume]); R = r ? JSON.parse(r) : null; } catch (e) {}
  let comp = null; try { const r = await core().redis(["GET", COMPARE.cle]); comp = r ? JSON.parse(r) : null; } catch (e) {}
  if (!E) return { statut: "pas encore lancé", actifs: {}, resume: null, comparaison: comp };
  const actifs = {};
  for (const a of REJEU.actifs) { const s = E.actifs[a] || {}; actifs[a] = { statut: s.statut, avance_pct: Math.max(0, Math.min(100, Math.round(((s.curseur - E.debut) / (E.fin - E.debut)) * 100))), jusqua: s.curseur, trades: s.trades || 0, decisions: s.decisions || 0, erreur: s.erreur || null, source: s.source || null }; }
  const fini = REJEU.actifs.every((a) => actifs[a].statut === "fini");
  return { statut: fini ? "fini" : "en cours", version: E.version, debut: E.debut, fin: E.fin, controle_annees: REJEU.controle_annees, actifs, resume: R && R.version === E.version ? R : null, comparaison: comp };
}

module.exports = async (req, res) => {
  try {
    // Remplissage de la réserve Dukascopy pour tous les instruments de la campagne (cron-job.org « Alphie données », toutes les 5 à 15 minutes)
    if (req.method === "GET" && req.query && req.query.remplir) {
      if (req.query.key !== process.env.CRON_SECRET) return res.status(401).json({ error: "clé invalide" });
      try { core().heartbeat("donnees"); } catch (e) {}   // la page d'état sait ainsi que la tâche « Alphie données » tourne
      const f0 = await lireFrein(), hm = (t) => new Date(t).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
      if (f0.jusqua > Date.now()) { const t0 = Date.now(); let ct = null, rejeu = null;
        try { ct = await remplirCT(t0 + 9000); } catch (e) { ct = { erreur: e.message }; }
        try { rejeu = await rejeuEtape(t0 + 20000); } catch (e) { rejeu = { erreur: e.message }; }
        return res.status(200).json({ ct, rejeu, route: routeDuka(), en_pause: true, message: "Dukascopy refusait : Alphie le laisse tranquille jusqu'à " + hm(f0.jusqua) + ", puis réessaie toute seule.", reprise: hm(f0.jusqua), refus_de_suite: f0.refus, depuis: f0.depuis ? hm(f0.depuis) : null, raison: f0.raison, dernier_mois_recu: f0.dernier_ok ? hm(f0.dernier_ok) : null }); }
      const fin = Date.now() + 22000, instruments = {};
      let ct = null; try { ct = await remplirCT(Date.now() + 8000); } catch (e) { ct = { erreur: e.message }; }   // les prix FTMO d'abord : Dukascopy freine souvent   // réponse en 22 s au plus : sous les 30 s de cron-job.org, même au démarrage à froid
      let freine = false;
      // Ordre de passage : d'abord la réserve la plus proche d'être complète (chaque réserve terminée débloque un test plus vite),
      // les réserves déjà complètes en dernier (elles ne font que rafraîchir les mois récents).
      // Avant, l'ordre tournait avec la minute : avec une tâche toutes les 15 minutes, seuls 3 marchés sur 9 passaient en premier,
      // et quand Dukascopy freine dès le premier, les 6 autres n'avançaient jamais.
      const liste = instrumentsCampagne(), manques = await Promise.all(liste.map((n) => manquantsReserve(n).catch(() => 0)));
      const ordre = ordreReserve(liste, manques);
      for (const nom of ordre) {
        if (freine || Date.now() + 9000 > fin) { instruments[nom] = { a_suivre: freine ? "après la pause (Dukascopy freine)" : "au prochain passage" }; continue; }
        const D = {};
        try { await preparerReserve(nom, 10, fin, D); freine = D.arret_freinage; instruments[nom] = { prets: (D.mois_demandes - D.mois_manquants) + " / " + D.mois_demandes, telecharges_maintenant: D.mois_telecharges, refus_dukascopy: D.refus_dukascopy, complet: D.complet, premiere_erreur: D.premiere_erreur || undefined }; }
        catch (e) { instruments[nom] = { erreur: e.message }; }
      }
      const tout = Object.values(instruments).every((x) => x.complet), f1 = await lireFrein();
      let rejeu = null; if (fin - Date.now() > 8000) { try { rejeu = await rejeuEtape(fin); } catch (e) { rejeu = { erreur: e.message }; } }
      return res.status(200).json({ ct, rejeu, route: routeDuka(), tout_est_pret: tout, mois_recus: Object.values(instruments).reduce((a, x) => a + (x.telecharges_maintenant || 0), 0), frein: f1.jusqua > Date.now() ? "Dukascopy a refusé : prochain essai à " + hm(f1.jusqua) : "aucun", instruments });
    }
    if (req.method === "GET" && req.query && req.query.diag) {
      if (req.query.key !== process.env.CRON_SECRET) return res.status(401).json({ error: "clé invalide" });
      const nom = String(req.query.nom || "XAUUSD").toUpperCase(), now = new Date(), d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const chemin = `/datafeed/${nom}/${d.getUTCFullYear()}/${String(d.getUTCMonth()).padStart(2, "0")}/BID_candles_hour_1.bi5`, u = duka(chemin);
      const brut = {};
      try { const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } }); const b = new Uint8Array(await r.arrayBuffer()); Object.assign(brut, { statut_http: r.status, type: r.headers.get("content-type"), octets: b.length, debut_hex: Buffer.from(b.slice(0, 16)).toString("hex") }); try { const x = lzmaDecode(b); brut.decompression = "OK, " + Math.floor(x.length / 24) + " bougies"; } catch (e) { brut.decompression = "ÉCHEC : " + e.message; } }
      catch (e) { brut.erreur = msgErr(e); }
      const D = {}; let complet;
      try { const c = await bougies1h(nom, +(req.query.annees || 10), null, D, 22000); complet = { bougies: c.length, dernier_prix: c.length ? Math.round(c[c.length - 1].c * 1e5) / 1e5 : null }; } catch (e) { complet = { erreur: e.message }; }
      return res.status(200).json({ instrument: nom, mois_dernier_brut: Object.assign({ route: routeDuka(), fichier: chemin }, brut), historique: Object.assign(complet, D) });
    }
    const body = req.body || {}, pass = (process.env.APP_PASSWORD || "").trim();
    if (req.method !== "POST" || !pass || body.password !== pass) return res.status(401).json({ error: "Mot de passe incorrect." });
    if (body.action === "lancer") return res.status(200).json({ resultat: await lancer(body) });
    if (body.action === "challenge") return res.status(200).json({ challenge: await challengePreset(body) });
    if (body.action === "comparer_temoin") return res.status(200).json({ comparaison: await comparerTemoin(Date.now() + 45000) });
    if (body.action === "rejeu") { const etape = await rejeuEtape(Date.now() + 45000); return res.status(200).json({ etape, rejeu: await rejeuVue() }); }
    return res.status(200).json({ backtests: await historique(), campagne: await campagne("lire"), challenges: await challengesSimules(), rejeu: await rejeuVue().catch(() => null) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
module.exports.lancer = lancer;
module.exports.config = { maxDuration: 60 };   // un test sur 3 marchés et 10 ans peut dépasser la limite par défaut
module.exports.COND_LISTE = COND_LISTE;
module.exports._historique = historique;
module.exports.campagne = campagne;
module.exports._test = { VAGUE_8, FAMILLE_TORTUES, REGLES_MISE, facteurMise, compositionPanier, challengePanier, PANIERS, VAGUE_7, niveauxVeille, debutSeanceUS, ajouterSansAvantage, comparerTemoin, associerTrades, COMPARE, COMPARE_SOURCES, detailRejeu, bougiesDirect, CT_SOURCES, CLE_CT, remplirCT, lireCT, ctPret, metaCT, encCT, decCT, rejeuBougiesReserve, ordreReserve, DEBUT_BINANCE, statsR, COMBOS_REJEU, verdictGroupe, challengeRejeu, PH_CHAMPS, REJEU_SOURCES, REJEU, KR, DK_REJEU, rejeuBougie, rejeuMorceau, rejeuEtape, rejeuVue, analyseRejeu, calculerResumeRejeu, sessionA, marcheA, veille, rejeuBougiesDK, rejeuBougiesCrypto, instrumentsCampagne, nouvelEtatRejeu, lireFrein, poserFrein, noterReussite, pauseSuivante, KEY_FREIN, VAGUE_4, VAGUE_5, VAGUE_6, tsmomSerie, TOUS_LES_TESTS, serieExterne, externesDe, symbolesExternes, EXTERNES, disponibilites, manquantsReserve, moisDK, nomMoisDK, RECENT_MS, campagne, lancer, tradesHorsCoffre, preparerReserve, bougies1h, instrumentsCampagne, CLE_DK, VAGUE_1, VAGUE_2, VAGUE_3, VAGUES, simulerChallenge, unExamen, unFinance, challengePreset, CHALLENGE, fraisNuitDefaut, jourParis, heureParis, fvgOuvert, divergenceRSI, lzmaDecode, nomDukascopy, bougies1h, paris, decalageParis, COND, simuler, stats, verdict, makeInd, capital, walkForward, bootstrap, faceAuHasard, executer, preparer, paginer, fenetres, regrouperUTC, bougies, baseCrypto, objectifPropFirm, coupeCoffre, seuilHasard, lancerUn };
