// ═══════════════════════════════════════════════════════════════
// EDGE — api/machine.js
// La machine : lancée automatiquement par Vercel toutes les 30 minutes
// (voir vercel.json). À chaque passage :
//   1. lit les cotes Winamax, Betclic, Unibet, PMU, NetBet + Pinnacle ;
//   2. applique la règle v2 et ENREGISTRE les paris avant le match ;
//   3. suit la cote jusqu'au coup d'envoi (clôture) ;
//   4. règle les paris avec le score réel, même plusieurs jours après.
// Tout est gardé dans la base : la Preuve ne dépend plus d'aucun téléphone.
// ═══════════════════════════════════════════════════════════════
const store = require("./_lib/store");
const odds = require("./_lib/oddsapi");
const R = require("./_lib/regle");

const CLE_SIGNAUX = "edge:v2:signaux";
const CLE_ETAT = "edge:etat";
const CLE_SNAP = "edge:fr:snap";
const CLE_CAL = "edge:fr:cal";
const H = 3600000;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function parPaquets(liste, fn, taille) {
  const out = [];
  for (let i = 0; i < liste.length; i += taille) {
    const r = await Promise.all(liste.slice(i, i + taille).map(x => fn(x).catch(e => ({ __err: e }))));
    out.push(...r);
  }
  return out;
}

function regler(s, gh, ga) {
  const res = gh > ga ? "1" : gh < ga ? "2" : "N";
  s.status = res === s.pick ? "won" : "lost";
  s.gh = gh; s.ga = ga; s.regleLe = Date.now();
  if (s.pClo > 0) s.clv = Math.round((s.cote * s.pClo - 1) * 10000) / 100;   // en %
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers["authorization"] || "";
  const ua = req.headers["user-agent"] || "";
  const estCron = secret ? auth === "Bearer " + secret : /vercel-cron/i.test(ua);
  const manuel = !!(req.query && req.query.manuel === "1");
  if (!estCron && !manuel) return res.status(401).json({ ok: false, raison: "non_autorise" });

  if (!store.actif()) return res.status(200).json({ ok: false, raison: "base_absente" });
  if (!odds.actif()) return res.status(200).json({ ok: false, raison: "cle_odds_absente" });

  const now = Date.now();
  const journal = [];
  let etat = {};
  try { etat = (await store.getJSON(CLE_ETAT)) || {}; } catch (e) { return res.status(200).json({ ok: false, raison: "base_injoignable", detail: e.message }); }

  // Garde anti-gaspillage : jamais deux passages rapprochés (crédits)
  const ecart = now - (etat.dernierScan || 0);
  if (ecart < 10 * 60000) {
    return res.status(200).json({ ok: true, ignore: "passage_recent", ilYa: Math.round(ecart / 60000) + " min" });
  }
  const restants = etat.credits && isFinite(etat.credits.restants) ? etat.credits.restants : null;
  const economie = restants != null && restants < 1500;          // un passage sur deux
  if (economie && !manuel && new Date().getUTCMinutes() >= 30) {
    return res.status(200).json({ ok: true, ignore: "economie_credits", restants });
  }
  const panne = restants != null && restants < 150;               // garder de quoi régler

  const erreurs = [];
  let signaux = {};
  try { signaux = await store.lireTable(CLE_SIGNAUX); } catch (e) { return res.status(200).json({ ok: false, raison: "base_injoignable", detail: e.message }); }
  const modifies = {};
  const liste = Object.values(signaux);
  const enAttente = liste.filter(s => s && s.status === "pending");

  // ── 1. Calendrier (gratuit, gardé 3 h) ──
  let cal = null;
  try { cal = await store.getJSON(CLE_CAL); } catch (e) {}
  if (!cal || !cal.sports || now - (cal.ts || 0) > 3 * H) {
    try {
      const sports = await odds.championnatsActifs();
      const r = await parPaquets(sports, s => odds.calendrier(s, iso(now), iso(now + 48 * H)).then(l => [s, l]), 5);
      cal = { ts: now, sports: {} };
      r.forEach(x => { if (x && !x.__err) cal.sports[x[0]] = x[1].map(e => e.ko); else if (x && x.__err) erreurs.push(String(x.__err.message).slice(0, 120)); });
      await store.setJSON(CLE_CAL, cal);
    } catch (e) { erreurs.push("calendrier: " + e.message); cal = cal || { ts: 0, sports: {} }; }
  }

  // ── 2. Cotes des championnats qui jouent dans les 24 h ──
  const fin = now + R.SDJ.horizonH * H;
  const aScanner = Object.keys(cal.sports || {}).filter(s =>
    (cal.sports[s] || []).some(ko => { const t = new Date(ko).getTime(); return t > now && t <= fin; }));
  enAttente.forEach(s => { if (new Date(s.ko).getTime() > now && aScanner.indexOf(s.sport) < 0) aScanner.push(s.sport); });

  let evenements = [];
  if (!panne && aScanner.length) {
    const r = await parPaquets(aScanner, s => odds.cotes(s, iso(now), iso(fin)), 4);
    r.forEach(x => { if (Array.isArray(x)) evenements.push(...x); else if (x && x.__err) erreurs.push(String(x.__err.message).slice(0, 120)); });
    try { await store.setJSON(CLE_SNAP, { ts: now, events: evenements }); } catch (e) { erreurs.push("snap: " + e.message); }
  }
  journal.push(aScanner.length + " championnat(s), " + evenements.length + " match(s) cotés");

  // ── 3. Suivi des paris en attente jusqu'au coup d'envoi (clôture) ──
  const parId = {};
  evenements.forEach(e => { parId[e.id] = e; });
  enAttente.forEach(s => {
    const e = parId[s.id];
    if (!e || new Date(s.ko).getTime() <= now) return;
    const pm = R.probMarche(e);
    const fr = R.meilleurPrixFR(e, s.pick);
    if (pm) {
      const p = { "1": pm.p1, "N": pm.pn, "2": pm.p2 }[s.pick];
      s.pClo = Math.round(p * 10000) / 10000;
      s.srcClo = pm.src;
      s.minAct = R.coteMinRegle(p, R.multPrudence(pm.src));
    }
    if (fr) { s.coteAct = fr.cote; s.bookAct = fr.book; }
    s.majAct = now;
    modifies[s.id] = s;
  });

  // ── 4. La sélection du jour : nouveaux paris, enregistrés AVANT le match ──
  let analyses = 0, suspects = 0;
  const cands = [];
  evenements.forEach(e => {
    const t = new Date(e.ko).getTime();
    if (!isFinite(t) || t < now + 10 * 60000 || t > fin) return;
    const r = R.candidat(e);
    if (!r.analyse) return;
    analyses++; suspects += r.suspects || 0;
    if (r.cand) cands.push(Object.assign({ e, t }, r.cand));
  });
  cands.sort((a, b) => b.ev - a.ev);
  const tous = Object.values(Object.assign({}, signaux, modifies));
  const nouveaux = [];
  cands.forEach(c => {
    if (signaux[c.e.id] || nouveaux.some(n => n.id === c.e.id)) return;   // un seul pari par match, jamais modifié
    const jour = R.jourParis(c.t);
    const duJour = tous.concat(nouveaux).filter(s => s.jour === jour);
    if (duJour.length >= R.SDJ.maxTotal) return;
    if (duJour.filter(s => s.pick === c.k).length >= R.SDJ.maxParType) return;
    if (c.cote > R.SDJ.seuilOutsider && duJour.filter(s => s.cote > R.SDJ.seuilOutsider).length >= R.SDJ.maxOutsiders) return;
    const s = {
      id: c.e.id, sport: c.e.sport, lg: c.e.lg, h: c.e.h, a: c.e.a, ko: c.e.ko, jour,
      pick: c.k, label: c.label, cote: c.cote, book: c.book,
      prob: Math.round(c.prob * 10000) / 10000, src: c.src, mult: c.mult,
      ev: Math.round(c.ev * 10000) / 10000, coteMin: c.coteMin,
      pClo: Math.round(c.prob * 10000) / 10000, srcClo: c.src, coteAct: c.cote, bookAct: c.book, minAct: c.coteMin, majAct: now,
      ts: now, regle: "v2", status: "pending",
    };
    nouveaux.push(s);
    modifies[s.id] = s;
  });
  journal.push(analyses + " analysé(s), " + cands.length + " candidat(s), " + nouveaux.length + " nouveau(x) pari(s)");

  // ── 5. Règlement avec le score réel ──
  const aRegler = enAttente.filter(s => new Date(s.ko).getTime() < now - 2.25 * H);
  const sportsRegl = [...new Set(aRegler.map(s => s.sport))];
  etat.regle = etat.regle || {};
  let regles = 0;
  for (const sp of sportsRegl) {
    if (now - (etat.regle[sp] || 0) < 3 * H && !manuel) continue;       // 2 crédits : pas trop souvent
    try {
      const sc = await odds.scores(sp);
      const parIdSc = {}; sc.forEach(x => { parIdSc[x.id] = x; });
      aRegler.filter(s => s.sport === sp).forEach(s => {
        const x = parIdSc[s.id];
        if (x && x.termine && x.gh != null && x.ga != null) { regler(s, x.gh, x.ga); modifies[s.id] = s; regles++; }
      });
      etat.regle[sp] = now;
    } catch (e) { erreurs.push("scores " + sp + ": " + e.message); }
  }
  // Match introuvable 3 jours et demi après : reporté ou annulé → remboursé
  enAttente.forEach(s => {
    if (s.status === "pending" && new Date(s.ko).getTime() < now - 3.5 * 24 * H) {
      s.status = "void"; s.motif = "match reporté ou annulé"; s.regleLe = now; modifies[s.id] = s;
    }
  });
  journal.push(regles + " pari(s) réglé(s)");

  // ── 6. Sauvegarde ──
  try { await store.ecrireTable(CLE_SIGNAUX, modifies); } catch (e) { erreurs.push("sauvegarde: " + e.message); }
  const q = odds.quota();
  etat.dernierScan = now;
  etat.credits = { restants: q.restants != null ? q.restants : restants, utilises: q.utilises };
  etat.dernier = { championnats: aScanner.length, matchs: evenements.length, analyses, candidats: cands.length,
    nouveaux: nouveaux.length, regles, suspects, economie: !!economie, panne: !!panne };
  etat.erreurs = erreurs.slice(0, 6);
  try { await store.setJSON(CLE_ETAT, etat); } catch (e) {}

  return res.status(200).json({ ok: true, journal, erreurs, credits: etat.credits,
    nouveaux: nouveaux.map(s => s.h + " – " + s.a + " : " + s.label + " @ " + s.cote + " (" + s.book + ")") });
};
