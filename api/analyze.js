// ═══════════════════════════════════════════════════════════════
// EDGE — api/analyze.js v4 — Analyse ultra-complète
// ═══════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();

  const MKEY = process.env.MISTRAL_API_KEY;
  const CKEY = process.env.ANTHROPIC_API_KEY;
  if (!MKEY && !CKEY) return res.status(500).json({error:"Clés IA manquantes"});

  let body={};
  try {
    if(req.body&&typeof req.body==="object"){body=req.body;}
    else{
      let raw="";
      await new Promise((r2,rj)=>{req.on("data",c=>{raw+=c.toString();});req.on("end",r2);req.on("error",rj);});
      if(raw) body=JSON.parse(raw);
    }
  } catch(e){ return res.status(400).json({error:"Body JSON invalide"}); }

  const d = body.match || body;
  const r = body.result || body.calc;
  if (!d.home && !d.h) return res.status(400).json({error:"Données match manquantes"});

  const home = d.home||d.h||"?";
  const away = d.away||d.a||"?";
  const league = d.leagueName||d.league||d.c||"?";
  const o1 = d.o1||0, oN = d.on||d.oN||0, o2 = d.o2||0;
  const hasOdds = o1>1.05 && oN>1.05 && o2>1.05;

  // ── CONSTRUCTION DU PROMPT ULTRA-DÉTAILLÉ ─────────────────
  const L = []; // lines

  L.push("Tu es EDGE, le meilleur analyste de paris sportifs.");
  L.push("Tu as accès à toutes les données ci-dessous. Utilise-les toutes.");
  L.push("Ton analyse doit être complète, précise, et actionnable.");
  L.push("");

  // MATCH
  L.push("════ MATCH ════");
  L.push(`${home} vs ${away}`);
  L.push(`Compétition: ${league}`);
  if(d.time) L.push(`Heure: ${new Date(d.time).toLocaleString("fr-FR",{weekday:"long",day:"2-digit",month:"long",hour:"2-digit",minute:"2-digit"})}`);
  L.push("");

  // COTES ET PROBABILITÉS MARCHÉ
  if(hasOdds){
    const mg = 1/o1+1/oN+1/o2;
    const pH_mkt = ((1/o1)/mg*100).toFixed(1);
    const pN_mkt = ((1/oN)/mg*100).toFixed(1);
    const pA_mkt = ((1/o2)/mg*100).toFixed(1);
    const margin = (mg-1)*100;
    L.push("════ COTES MARCHÉ ════");
    L.push(`DOM victoire: ${o1}x → proba implicite ${pH_mkt}%`);
    L.push(`Match nul:    ${oN}x → proba implicite ${pN_mkt}%`);
    L.push(`EXT victoire: ${o2}x → proba implicite ${pA_mkt}%`);
    L.push(`Marge bookmaker: ${margin.toFixed(1)}% | ${d.hasSharp?"Pinnacle disponible ✓":"Cotes moyennes marché"}`);
    if(d.pinnacle){
      const p=d.pinnacle;
      L.push(`Pinnacle (référence sharp): DOM ${p.o1}x | NUL ${p.on}x | EXT ${p.o2}x`);
    }
    if(d.valueBks&&d.valueBks.length>0){
      L.push(`Value vs référence: ${d.valueBks.slice(0,3).map(b=>`${b.n} DOM+${(b.edgeH*100).toFixed(1)}% NUL+${(b.edgeN*100).toFixed(1)}% EXT+${(b.edgeA*100).toFixed(1)}%`).join(" | ")}`);
    }
    L.push("");
  }

  // MOTEUR EDGE
  if(r){
    L.push("════ MOTEUR EDGE (Dixon-Coles + Monte Carlo + Bayésien) ════");
    L.push(`Qualité données: ${["⚠️ Faible","📊 Moyenne","📈 Bonne","✅ Excellente"][Math.min((r.dataQ||1)-1,3)]} (niveau ${r.dataQ||1}/4)`);
    L.push("");
    L.push(`Probabilités calculées:`);
    L.push(`  DOM: ${((r.pH||0)*100).toFixed(1)}% | NUL: ${((r.pN||0)*100).toFixed(1)}% | EXT: ${((r.pA||0)*100).toFixed(1)}%`);
    if(r.mcH!=null){
      L.push(`Monte Carlo 800 simulations:`);
      L.push(`  DOM: ${((r.mcH||0)*100).toFixed(0)}% | NUL: ${((r.mcN||0)*100).toFixed(0)}% | EXT: ${((r.mcA||0)*100).toFixed(0)}%`);
    }
    L.push(`Buts attendus: ${home} λ=${(+(r.lH||0)).toFixed(2)} buts | ${away} λ=${(+(r.lA||0)).toFixed(2)} buts`);
    L.push("");
    L.push(`Signal principal: ${r.label||r.bR||"?"} @ ${r.bO||"?"}x`);
    L.push(`Edge: ${((r.edg||0)*100).toFixed(1)}% | Confiance: ${r.conf||0}/100${r.hasPinnacle&&r.edgVsPinnacle?` | Edge vs Pinnacle: ${((r.edgVsPinnacle||0)*100).toFixed(1)}%`:""}`);
    L.push(`Kelly fractionnel: ${((r.kel||0)*100).toFixed(1)}% du bankroll`);

    if(r.sc2&&r.sc2.length){
      const top = r.sc2.slice(0,5);
      L.push(`\nScores les plus probables:`);
      top.forEach(s=>L.push(`  ${s.h}-${s.a}: ${(s.p*100).toFixed(1)}%`));
    }

    // Marchés alternatifs
    if(r.altMarkets&&r.altMarkets.length>0){
      L.push(`\nMarchés alternatifs détectés (basés sur 885 matchs réels):`);
      r.altMarkets.forEach(m=>{
        L.push(`  → ${m.n} @ ${m.o}x | Proba: ${(m.p*100).toFixed(0)}% | EV: +${(m.ev*100).toFixed(1)}% | Réussite historique: ${m.conf}%`);
      });
    }

    // Probabilités marchés buts
    if(r.pOver25||r.pBttsY){
      L.push(`\nProbabilités marchés buts:`);
      if(r.pOver25) L.push(`  Plus 2.5 buts: ${((r.pOver25||0)*100).toFixed(0)}% | Moins 2.5: ${((r.pUnder25||0)*100).toFixed(0)}%`);
      if(r.pOver35) L.push(`  Plus 3.5 buts: ${((r.pOver35||0)*100).toFixed(0)}%`);
      if(r.pBttsY)  L.push(`  Les 2 marquent: ${((r.pBttsY||0)*100).toFixed(0)}% | Les 2 ne marquent pas: ${((r.pBttsN||0)*100).toFixed(0)}%`);
      if(r.pUnder15) L.push(`  Moins 1.5 buts: ${((r.pUnder15||0)*100).toFixed(0)}%`);
    }
    L.push("");
  }

  // STATISTIQUES COMPLÈTES
  L.push("════ STATISTIQUES ════");
  const hxg=d.hxg||d.hXG, axg=d.axg||d.aXG;
  const hxga=d.hxga||d.hXGA, axga=d.axga||d.aXGA;
  const hg=d.hg||d.hG, ag=d.ag||d.aG;
  const hf=d.hf||d.hF, af=d.af||d.aF;
  const hcs=d.hcs, acs=d.acs;

  L.push(`${home}:`);
  if(hxg) L.push(`  xG moyen: ${hxg} buts/match | xGA (buts concédés): ${hxga||"?"}`);
  if(hg)  L.push(`  Buts marqués/match: ${typeof hg==="number"?hg.toFixed(2):hg}`);
  if(hf!=null) L.push(`  Forme récente: ${hf}/15 pts`);
  if(hcs!=null) L.push(`  Clean sheets: ${hcs}%`);
  if(d.hRank) L.push(`  Classement: #${d.hRank}`);
  if(d.hWinRate) L.push(`  Taux victoire: ${(d.hWinRate*100).toFixed(0)}%`);

  L.push(`\n${away}:`);
  if(axg) L.push(`  xG moyen: ${axg} buts/match | xGA: ${axga||"?"}`);
  if(ag)  L.push(`  Buts marqués/match: ${typeof ag==="number"?ag.toFixed(2):ag}`);
  if(af!=null) L.push(`  Forme récente: ${af}/15 pts`);
  if(acs!=null) L.push(`  Clean sheets: ${acs}%`);
  if(d.aRank) L.push(`  Classement: #${d.aRank}`);
  L.push("");

  // CONTEXTE MATCH
  const ctx=[];
  if(d.keyPlayerOut>0)   ctx.push(`Absents importants DOM: ${d.keyPlayerOut}/10`);
  if(d.keyPlayerOutA>0)  ctx.push(`Absents importants EXT: ${d.keyPlayerOutA}/10`);
  if(d.rotationH>0)      ctx.push(`Rotation DOM: ${d.rotationH===2?"massive":"légère"}`);
  if(d.rotationA>0)      ctx.push(`Rotation EXT: ${d.rotationA===2?"massive":"légère"}`);
  if(d.matchsLast7H>=2)  ctx.push(`Fatigue DOM: ${d.matchsLast7H} matchs en 7 jours`);
  if(d.matchsLast7A>=2)  ctx.push(`Fatigue EXT: ${d.matchsLast7A} matchs en 7 jours`);
  if(d.derby)            ctx.push("Derby — variance élevée, résultat imprévisible");
  if(d.stakeLevel===0)   ctx.push("Match sans enjeu — risque de relâchement");
  if(d.stakeLevel===3)   ctx.push("Match décisif — pression maximale des deux côtés");
  if(d.motivH<0)         ctx.push(`Moral DOM bas`);
  if(d.motivA<0)         ctx.push(`Moral EXT bas`);
  if(d.tactH)            ctx.push(`Tactique DOM: ${d.tactH}`);
  if(d.tactA)            ctx.push(`Tactique EXT: ${d.tactA}`);
  if(r&&r.ctx&&r.ctx.length) ctx.push(...r.ctx.slice(0,3));

  if(ctx.length){
    L.push("════ CONTEXTE ════");
    ctx.forEach(c=>L.push(`• ${c}`));
    L.push("");
  }

  // H2H
  // ── CORRECTIF ──
  // enrich.js produit des entrées { gh, ga, date }. Ce bloc lisait
  // homeGoals/awayGoals/winner, qui n'existent PAS : `g.homeGoals||0`
  // donnait 0 et aucun vainqueur n'était trouvé, donc tout était compté
  // comme nul. L'IA recevait "6 confrontations, 6 nuls 0-0" sur des
  // matchs réels et bâtissait une analyse tactique entière là-dessus.
  // On lit désormais les vrais champs, et le vainqueur est déduit du score.
  const butsH = g => {
    const v = (g.homeGoals !== undefined && g.homeGoals !== null) ? g.homeGoals
            : (g.gh !== undefined && g.gh !== null) ? g.gh
            : (g.goalsH !== undefined && g.goalsH !== null) ? g.goalsH : null;
    return (typeof v === "number" && isFinite(v)) ? v : null;
  };
  const butsA = g => {
    const v = (g.awayGoals !== undefined && g.awayGoals !== null) ? g.awayGoals
            : (g.ga !== undefined && g.ga !== null) ? g.ga
            : (g.goalsA !== undefined && g.goalsA !== null) ? g.goalsA : null;
    return (typeof v === "number" && isFinite(v)) ? v : null;
  };

  // On ne garde que les confrontations dont le score est réellement connu :
  // mieux vaut ne rien dire que d'inventer des 0-0.
  const h2hOk = (d.h2h || []).filter(g => butsH(g) !== null && butsA(g) !== null).slice(0, 6);

  if(h2hOk.length){
    const hW = h2hOk.filter(g => butsH(g) > butsA(g)).length;
    const aW = h2hOk.filter(g => butsA(g) > butsH(g)).length;
    const draws = h2hOk.length - hW - aW;
    const avgGH=(h2hOk.reduce((s,g)=>s+butsH(g),0)/h2hOk.length).toFixed(1);
    const avgGA=(h2hOk.reduce((s,g)=>s+butsA(g),0)/h2hOk.length).toFixed(1);
    const avgTot=(h2hOk.reduce((s,g)=>s+butsH(g)+butsA(g),0)/h2hOk.length).toFixed(1);
    L.push("════ HISTORIQUE H2H ════");
    L.push(`${h2hOk.length} confrontations directes:`);
    L.push(`  DOM ${hW}V | ${draws}N | ${aW}D EXT`);
    L.push(`  Buts moyens: ${home} ${avgGH} | ${away} ${avgGA} | Total: ${avgTot}/match`);
    L.push(`  Résultats récents: ${h2hOk.slice(0,5).map(g=>`${butsH(g)}-${butsA(g)}`).join(" | ")}`);
    if(d.h2hStats){
      const s=d.h2hStats;
      L.push(`  Équipe dominante H2H: ${s.hWins>s.aWins?home:s.aWins>s.hWins?away:"Équilibré"}`);
    }
    L.push("");
  } else if (d.h2h && d.h2h.length) {
    // Des confrontations existent mais sans score exploitable :
    // on le dit explicitement pour que l'IA n'invente rien.
    L.push("════ HISTORIQUE H2H ════");
    L.push("Scores des confrontations directes indisponibles.");
    L.push("N'invente aucun résultat et n'en tire aucune conclusion tactique.");
    L.push("");
  }

  // BLESSÉS
  if(d.injuries){
    const hInj=(d.injuries.homeInj||[]).slice(0,6);
    const aInj=(d.injuries.awayInj||[]).slice(0,6);
    if(hInj.length||aInj.length){
      L.push("════ BLESSÉS / SUSPENDUS ════");
      if(hInj.length) L.push(`${home}: ${hInj.map(i=>`${i.player}${i.type?" ("+i.type+")":""}`).join(", ")}`);
      if(aInj.length) L.push(`${away}: ${aInj.map(i=>`${i.player}${i.type?" ("+i.type+")":""}`).join(", ")}`);
      L.push("");
    }
  }

  // PRÉDICTIONS API (si disponibles)
  if(d.apiPredH||d.apiPredN){
    L.push("════ PRÉDICTIONS API-FOOTBALL ════");
    if(d.apiPredH) L.push(`DOM: ${(d.apiPredH*100).toFixed(0)}% | NUL: ${(d.apiPredN*100).toFixed(0)}% | EXT: ${(d.apiPredA*100).toFixed(0)}%`);
    L.push("");
  }

  // MISSION — STRUCTURE IMPOSÉE
  L.push("════ TA MISSION ════");
  L.push(`Analyse complète de ${home} vs ${away}.`);
  L.push("Utilise TOUTES les données ci-dessus. Ne répète pas les chiffres bruts — interprète-les.");
  L.push("Si une donnée manque, signale-le brièvement et passe à ce que tu sais.");
  L.push("");
  L.push("Réponds EXACTEMENT dans ce format:");
  L.push("");
  L.push("⚡ VERDICT");
  L.push("[Pari principal recommandé ou 'Pas de signal clair' si données insuffisantes]");
  L.push("Cote: [X]x | Mise: [Y]% du bankroll | Confiance: [Z]/100");
  L.push("");
  L.push("📊 ANALYSE");
  L.push("[3-4 phrases sur les forces/faiblesses des deux équipes basées sur xG, forme, H2H]");
  L.push("");
  L.push("⚠️ RISQUES");
  L.push("[Blessures, fatigue, enjeu, derby, variance — ce qui peut faire foirer le pari]");
  L.push("");
  L.push("🎯 MARCHÉS ALTERNATIFS");
  L.push("[2-3 marchés avec probabilité et cote estimée — Over/Under, BTTS, Double Chance]");
  L.push("");
  L.push("📈 SCÉNARIO PROBABLE");
  L.push("[Comment le match va se dérouler, score probable]");
  L.push("");
  L.push("350 mots maximum. Sois direct. Sois précis. Sois honnête sur les incertitudes.");
  L.push("18+ — rappelle toujours de parier responsablement à la fin.");

  const prompt = L.join("\n");

  // Essayer Claude en premier (meilleure analyse)
  if(CKEY){
    try{
      const resp = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-api-key":CKEY,
          "anthropic-version":"2023-06-01"
        },
        body:JSON.stringify({
          model:"claude-sonnet-4-6",
          max_tokens:1500,
          system:"Tu es EDGE, le meilleur analyste de paris sportifs. Tu analyses avec rigueur et honnêteté. Tu ne promets jamais de gains garantis mais tu identifies les opportunités réelles basées sur les données. Tu rappelles toujours de parier responsablement.",
          messages:[{role:"user",content:prompt}]
        })
      });
      if(resp.ok){
        const data=await resp.json();
        const text=data.content?.[0]?.text||"";
        if(text) return res.status(200).json({text,model:"claude-sonnet-4-6",tokens:data.usage?.output_tokens||0});
      }
    }catch(e){}
  }

  // Fallback Mistral
  if(MKEY){
    try{
      const resp = await fetch("https://api.mistral.ai/v1/chat/completions",{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${MKEY}`},
        body:JSON.stringify({
          model:"mistral-small-latest",
          max_tokens:1500,
          temperature:0.10,
          messages:[
            {role:"user",content:"Tu es EDGE, analyste de paris sportifs. Tu analyses avec rigueur et honnêteté, sans jamais promettre de gains garantis. Compris?"},
            {role:"assistant",content:"Compris. J'analyse avec rigueur en me basant uniquement sur les données. Honnêteté totale sur les incertitudes."},
            {role:"user",content:prompt}
          ]
        }),
        signal:(()=>{const c=new AbortController();setTimeout(()=>c.abort(),28000);return c.signal;})()
      });
      if(resp.ok){
        const data=await resp.json();
        const text=data.choices?.[0]?.message?.content||"";
        if(text) return res.status(200).json({
          text:text.replace(/```[a-z]*/g,"").replace(/```/g,"").trim(),
          model:"mistral-small-latest",
          tokens:data.usage?.total_tokens||0
        });
      }
    }catch(e){
      return res.status(500).json({error:e.name==="AbortError"?"Timeout (28s)":e.message});
    }
  }

  return res.status(502).json({error:"IA temporairement indisponible"});
};
