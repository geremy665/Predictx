// ═══════════════════════════════════════════════════════════════
// EDGE — api/machine.js
// La machine : lancée automatiquement par Vercel toutes les 30 minutes
// (voir vercel.json). À chaque passage :
//   1. (facultatif) rafraîchit les vraies cotes .fr via The Odds API ;
//   2. charge les matchs et les cotes d'API-Football (le même scan que l'appli) ;
//   3. applique la règle v2 et ENREGISTRE les paris avant le match ;
//   4. suit la cote jusqu'au coup d'envoi (clôture) ;
//   5. règle les paris avec le score réel.
// Tout est gardé dans la base : la Preuve ne dépend plus d'aucun téléphone.
// ═══════════════════════════════════════════════════════════════
const store = require("./_lib/store");
const odds = require("./_lib/oddsapi");
const R = require("./_lib/regle");
const scan = require("./scan.js");

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
// Lance le scan de l'appli sans passer par Internet
function lancerScan(query) {
  return new Promise(resolve => {
    const res = {
      setHeader() {}, status() { return this; },
      json(j) { resolve(j); }, end() { resolve(null); },
    };
    Promise.resolve(scan({ method: "GET", query, headers: {} }, res)).catch(() => resolve(null));
  });
}
function regler(s, gh, ga) {
  const res = gh > ga ? "1" : gh < ga ? "2" : "N";
  s.status = res === s.pick ? "won" : "lost";
  s.gh = gh; s.ga = ga; s.regleLe = Date.now();
  if (s.pClo > 0) s.clv = Math.round((s.cote * s.pClo - 1) * 10000) / 100;   // en %
}

// ── Cotes .fr (The Odds API), seulement si une clé est branchée ──
// Le rythme s'adapte aux crédits restants : la formule gratuite
// (500 crédits par mois) tient avec 3 relevés par jour sur les grands championnats.
// Formule gratuite : 3 relevés par jour aux meilleurs moments (heure de Paris)
//   10 h : les cotes du jour sont fraîches, avant les matchs de l'après-midi
//   16 h : avant les matchs de 18 h – 19 h
//   19 h : avant les matchs de 20 h 45 – 21 h
const CRENEAUX = [10, 16, 19];
function heureParis(ms) {
  const f = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const v = t => (f.find(x => x.type === t) || {}).value;
  return { h: parseInt(v("hour"), 10) % 24, jour: v("year") + "-" + v("month") + "-" + v("day") };
}
async function rafraichirFR(etat, now, erreurs, manuel) {
  if (!odds.actif()) return { fait: false, raison: "pas_de_cle" };
  const rest = etat.credits && isFinite(etat.credits.restants) ? etat.credits.restants : null;
  if (rest != null && rest < 40) return { fait: false, raison: "credits_epuises" };
  const petitBudget = rest == null || rest < 1500;
  let creneau = null;
  if (petitBudget && !manuel) {
    const p = heureParis(now);
    if (CRENEAUX.indexOf(p.h) < 0) return { fait: false, raison: "hors_creneau" };
    creneau = p.jour + "-" + p.h;
    if ((etat.frCreneaux || []).indexOf(creneau) >= 0) return { fait: false, raison: "creneau_fait" };
  } else {
    // Gros budget : toutes les 30 min (2 h sous 5 000 crédits). Bouton manuel : 6 h minimum en petit budget.
    const intervalle = petitBudget ? 6 * H : rest >= 5000 ? 0.5 * H : 2 * H;
    if (now - (etat.frDernier || 0) < intervalle - 5 * 60000) return { fait: false, raison: "pas_encore" };
  }
  if (creneau) etat.frCreneaux = (etat.frCreneaux || []).slice(-8).concat([creneau]);
  let cal = null;
  try { cal = await store.getJSON(CLE_CAL); } catch (e) {}
  if (!cal || !cal.sports || now - (cal.ts || 0) > 3 * H) {
    try {
      const sports = await odds.championnatsActifs();
      const r = await parPaquets(sports, s => odds.calendrier(s, iso(now), iso(now + 48 * H)).then(l => [s, l]), 5);
      cal = { ts: now, sports: {} };
      r.forEach(x => { if (x && !x.__err) cal.sports[x[0]] = x[1].map(e => e.ko); });
      await store.setJSON(CLE_CAL, cal);
    } catch (e) { erreurs.push("calendrier: " + e.message); return { fait: false, raison: "erreur" }; }
  }
  const fin = now + R.SDJ.horizonH * H;
  let ligues = Object.keys(cal.sports || {}).filter(s =>
    (cal.sports[s] || []).some(ko => { const t = new Date(ko).getTime(); return t > now && t <= fin; }));
  // Crédits inconnus (tout premier relevé) ou bas : seulement les grands championnats
  if (rest == null || rest < 1500) ligues = ligues.filter(s => odds.PRINCIPAUX.indexOf(s) >= 0);
  if (!ligues.length) { etat.frDernier = now; return { fait: false, raison: "aucun_match" }; }
  const evenements = [];
  const r = await parPaquets(ligues, s => odds.cotes(s, iso(now), iso(fin)), 4);
  r.forEach(x => { if (Array.isArray(x)) evenements.push(...x); else if (x && x.__err) erreurs.push(String(x.__err.message).slice(0, 120)); });
  try { await store.setJSON(CLE_SNAP, { ts: now, events: evenements }); } catch (e) { erreurs.push("snap: " + e.message); }
  etat.frDernier = now;
  const q = odds.quota();
  etat.credits = { restants: q.restants != null ? q.restants : rest, utilises: q.utilises };
  return { fait: true, ligues: ligues.length, matchs: evenements.length };
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

  const now = Date.now();
  const journal = [], erreurs = [];
  let etat = {}, signaux = {};
  try {
    etat = (await store.getJSON(CLE_ETAT)) || {};
    signaux = await store.lireTable(CLE_SIGNAUX);
  } catch (e) { return res.status(200).json({ ok: false, raison: "base_injoignable", detail: e.message }); }

  // Garde : jamais deux passages à moins de 10 minutes
  const ecart = now - (etat.dernierScan || 0);
  if (ecart < 10 * 60000) return res.status(200).json({ ok: true, ignore: "passage_recent", ilYa: Math.round(ecart / 60000) + " min" });
  etat.dernierScan = now;
  try { await store.setJSON(CLE_ETAT, etat); } catch (e) {}

  // ── 1. Cotes .fr (facultatif) ──
  const fr = await rafraichirFR(etat, now, erreurs, manuel);
  if (fr.fait) journal.push("cotes FR : " + fr.ligues + " championnat(s), " + fr.matchs + " match(s)");

  // ── 2. Matchs et cotes d'API-Football (+ cotes .fr de moins d'1 h) ──
  const data = await lancerScan({ nocache: "1", frmax: "60" });
  if (!data || !Array.isArray(data.matches)) {
    erreurs.push("scan: " + ((data && (data.error || data.apiError)) || "aucune réponse"));
    etat.erreurs = erreurs; try { await store.setJSON(CLE_ETAT, etat); } catch (e) {}
    return res.status(200).json({ ok: false, raison: "scan_vide", erreurs });
  }
  if (data.apiError) erreurs.push("API-Football: " + String(data.apiError).slice(0, 120));
  const matches = data.matches.filter(m => m && m.id != null);
  journal.push(matches.length + " match(s), dont " + matches.filter(m => m.oddsFR).length + " avec cotes .fr");

  const modifies = {};
  const enAttente = Object.values(signaux).filter(s => s && s.status === "pending");
  const parId = {};
  matches.forEach(m => { parId[String(m.id)] = m; });

  // ── 3. Suivi jusqu'au coup d'envoi (clôture) ──
  enAttente.forEach(s => {
    const m = parId[String(s.id)];
    if (!m || m.isLive || new Date(s.ko).getTime() <= now) return;
    const pm = R.probMarche(m), px = R.meilleurPrixFR(m, s.pick);
    if (pm) {
      const p = { "1": pm.p1, "N": pm.pn, "2": pm.p2 }[s.pick];
      s.pClo = Math.round(p * 10000) / 10000; s.srcClo = pm.src;
      s.minAct = R.coteMinRegle(p, R.multPrudence(pm.src));
    }
    if (px) { s.coteAct = px.cote; s.bookAct = px.book; }
    s.majAct = now;
    modifies[s.id] = s;
  });

  // ── 4. Nouveaux paris, enregistrés AVANT le match ──
  const fin = now + R.SDJ.horizonH * H;
  let analyses = 0, suspects = 0;
  const cands = [];
  matches.forEach(m => {
    if (!m.hasRealOdds || m.isLive) return;
    const t = new Date(m.time || m.t).getTime();
    if (!isFinite(t) || t < now + 10 * 60000 || t > fin) return;
    const r = R.candidat(m);
    if (!r.analyse) return;
    analyses++; suspects += r.suspects || 0;
    if (r.cand) cands.push(Object.assign({ m, t }, r.cand));
  });
  cands.sort((a, b) => b.ev - a.ev);

  // Diagnostic : à quel point les prix français approchent-ils le prix juste ?
  const avecFR = matches.filter(m => m.oddsFR && m.hasRealOdds && !m.isLive);
  if (avecFR.length) {
    let meilleur = null, positifs = 0, issues = 0;
    avecFR.forEach(m => {
      const t = new Date(m.time || m.t).getTime();
      if (!isFinite(t) || t < now + 10 * 60000 || t > fin) return;
      const pm = R.probMarche(m);
      if (!pm) return;
      [["1", pm.p1, "Victoire " + m.h], ["N", pm.pn, "Match nul"], ["2", pm.p2, "Victoire " + m.a]].forEach(x => {
        const px = R.meilleurPrixFR(m, x[0]);
        if (!px || px.cote < R.SDJ.coteMin || px.cote > R.SDJ.coteMax) return;
        issues++;
        const ev = x[1] * px.cote;
        if (ev > 1) positifs++;
        if (ev <= R.EV_SUSPECT && (!meilleur || ev > meilleur.ev)) meilleur = { ev: Math.round(ev * 10000) / 10000,
          seuil: Math.round(R.seuilEV(px.cote, R.multPrudence(pm.src)) * 10000) / 10000,
          label: x[2], h: m.h, a: m.a, cote: px.cote, book: px.book, src: pm.src };
      });
    });
    etat.diagFR = { ts: now, matchs: avecFR.length, issues, positifs, meilleur };
  }
  const tous = Object.values(signaux);
  const nouveaux = [];
  cands.forEach(c => {
    const id = String(c.m.id);
    if (signaux[id] || nouveaux.some(n => String(n.id) === id)) return;   // un seul pari par match, jamais modifié
    const jour = R.jourParis(c.t);
    const duJour = tous.concat(nouveaux).filter(s => s.jour === jour);
    if (duJour.length >= R.SDJ.maxTotal) return;
    if (duJour.filter(s => s.pick === c.k).length >= R.SDJ.maxParType) return;
    if (c.cote > R.SDJ.seuilOutsider && duJour.filter(s => s.cote > R.SDJ.seuilOutsider).length >= R.SDJ.maxOutsiders) return;
    const s = {
      id: c.m.id, lg: c.m.c || c.m.leagueName || "", h: c.m.h, a: c.m.a, ko: c.m.time || c.m.t, jour,
      pick: c.k, label: c.label, cote: c.cote, book: c.book, fr: !!c.m.oddsFR,
      prob: Math.round(c.prob * 10000) / 10000, src: c.src, mult: c.mult,
      ev: Math.round(c.ev * 10000) / 10000, coteMin: c.coteMin,
      pClo: Math.round(c.prob * 10000) / 10000, srcClo: c.src, coteAct: c.cote, bookAct: c.book, minAct: c.coteMin, majAct: now,
      ts: now, regle: "v2", status: "pending",
    };
    nouveaux.push(s);
    modifies[id] = s;
  });
  journal.push(analyses + " analysé(s), " + cands.length + " candidat(s), " + nouveaux.length + " nouveau(x) pari(s)");

  // ── 5. Règlement avec le score réel (matchs terminés hier et aujourd'hui) ──
  const fini = {};
  (data.finished || []).forEach(f => { if (f && f.id != null) fini[String(f.id)] = f; });
  let regles = 0;
  enAttente.forEach(s => {
    const f = fini[String(s.id)];
    if (f && f.gh != null && f.ga != null) { regler(s, f.gh, f.ga); modifies[s.id] = s; regles++; return; }
    // Introuvable 3 jours et demi après le coup d'envoi : reporté ou annulé → remboursé
    if (new Date(s.ko).getTime() < now - 3.5 * 24 * H) { s.status = "void"; s.motif = "match reporté ou annulé"; s.regleLe = now; modifies[s.id] = s; }
  });
  journal.push(regles + " pari(s) réglé(s)");

  // ── 6. Sauvegarde ──
  try { await store.ecrireTable(CLE_SIGNAUX, modifies); } catch (e) { erreurs.push("sauvegarde: " + e.message); }
  etat.dernier = { matchs: matches.length, avecFR: matches.filter(m => m.oddsFR).length, analyses,
    candidats: cands.length, nouveaux: nouveaux.length, regles, suspects, frFait: !!fr.fait };
  etat.erreurs = erreurs.slice(0, 6);
  try { await store.setJSON(CLE_ETAT, etat); } catch (e) {}

  return res.status(200).json({ ok: true, journal, erreurs, credits: etat.credits || null,
    nouveaux: nouveaux.map(s => s.h + " – " + s.a + " : " + s.label + " @ " + s.cote + " (" + s.book + ")") });
};
