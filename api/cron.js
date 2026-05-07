// ═══════════════════════════════════════════════════════════════
// EDGE — api/cron.js
// Endpoint déclenché par Vercel Cron Jobs
// Pré-calcule les analyses du jour et les met en cache
// Config dans vercel.json: { "crons": [{"path":"/api/cron","schedule":"0 8 * * *"}] }
// ═══════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  // Sécurité: seulement depuis Vercel Cron
  const auth = req.headers["authorization"];
  const CRON_SECRET = process.env.CRON_SECRET || "edge_cron_2025";
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({error:"Non autorisé"});
  }

  const log = [];
  const t0 = Date.now();
  log.push(`[${new Date().toISOString()}] EDGE Cron démarré`);

  try {
    const FKEY = process.env.FOOTBALL_API_KEY || "b0e8adc0dfcca1cc964daa5bfe9a56c1";
    const MKEY = process.env.MISTRAL_API_KEY  || "lvoeRXlFieBv5hpfh3TlZ12FZiFvIF8w";

    // 1. Déclencher le scan complet
    const scanUrl = `${process.env.VERCEL_URL || "https://predictx-pi.vercel.app"}/api/scan?mode=full&ai=1`;
    log.push(`Scan: ${scanUrl}`);

    const scanResp = await fetch(scanUrl, {
      headers: {"x-edge-cron": CRON_SECRET},
      signal: (() => { const c=new AbortController(); setTimeout(()=>c.abort(),25000); return c.signal; })()
    });
    const scanData = await scanResp.json();
    log.push(`Scan terminé: ${scanData.count||0} matchs, ${scanData.live||0} live`);

    // 2. Stats
    const duration = ((Date.now()-t0)/1000).toFixed(1);
    log.push(`Durée totale: ${duration}s`);
    log.push("✓ Cron terminé avec succès");

    return res.status(200).json({
      success: true,
      log,
      matchesScanned: scanData.count||0,
      liveMatches: scanData.live||0,
      duration: `${duration}s`,
      nextRun: "08:00 tomorrow"
    });

  } catch(e) {
    log.push(`ERREUR: ${e.message}`);
    return res.status(500).json({success:false, log, error:e.message});
  }
};
