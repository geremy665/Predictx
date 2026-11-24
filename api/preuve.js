// ═══════════════════════════════════════════════════════════════
// EDGE — api/preuve.js
// La Preuve officielle, lue par l'appli : les paris enregistrés par le
// serveur avant chaque match, et leur résultat. Même chose pour tout le
// monde, quel que soit le téléphone.
// ═══════════════════════════════════════════════════════════════
const store = require("./_lib/store");
const odds = require("./_lib/oddsapi");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  const base = store.actif(), cle = odds.actif();
  const out = { actif: false, base, cleOdds: cle, signaux: [], etat: null };
  if (!base) return res.status(200).json(out);
  try {
    const [table, etat] = await Promise.all([store.lireTable("edge:v2:signaux"), store.getJSON("edge:etat")]);
    out.signaux = Object.values(table || {}).filter(s => s && s.id && s.cote > 1)
      .sort((a, b) => new Date(b.ko) - new Date(a.ko));
    out.etat = etat ? { dernierScan: etat.dernierScan || null, credits: etat.credits || null,
      dernier: etat.dernier || null, erreurs: etat.erreurs || [] } : null;
    // Active dès que la machine a tourné au moins une fois
    out.actif = !!(etat && etat.dernierScan);
  } catch (e) {
    out.erreur = "base_injoignable";
  }
  return res.status(200).json(out);
};
