// ═══════════════════════════════════════════════════════════════
// EDGE — api/analyze.js v3
// Analyse complète d'un match via Mistral
// ═══════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();

  // Clé UNIQUEMENT depuis variables d'environnement Vercel
  const MKEY = process.env.MISTRAL_API_KEY;
  if (!MKEY) return res.status(500).json({error:"MISTRAL_API_KEY manquante dans les variables d'environnement"});

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

  // Construction du prompt avec données réelles uniquement
  const lines=[];
  lines.push(`=== MATCH ===`);
  lines.push(`${d.home||d.h} vs ${d.away||d.a} | ${d.leagueName||d.league||d.c||"?"}`);
  lines.push(`Cotes marché: DOM ${d.o1||"?"}x | NUL ${d.on||d.oN||"?"}x | EXT ${d.o2||"?"}x`);
  if(d.bk&&d.bk.length>0){
    lines.push(`Bookmakers couverts: ${d.bk.length} (${d.bk.map(b=>b.n).slice(0,4).join(", ")})`);
  }
  lines.push("");

  if(r){
    const hasData = r.dataQ >= 2;
    lines.push(`=== MOTEUR EDGE ===`);
    lines.push(`Qualité données: ${["Faible","Moyenne","Bonne","Excellente"][Math.min((r.dataQ||1)-1,3)]}`);
    lines.push(`Probas calculées: DOM ${((r.pH||0)*100).toFixed(1)}% | NUL ${((r.pN||0)*100).toFixed(1)}% | EXT ${((r.pA||0)*100).toFixed(1)}%`);
    lines.push(`Buts attendus: DOM λ=${(+(r.lH||0)).toFixed(2)} | EXT λ=${(+(r.lA||0)).toFixed(2)}`);
    lines.push(`Signal: ${r.label||r.bR||"?"} @ ${r.bO||"?"}x | Edge: ${((r.edg||0)*100).toFixed(1)}% | Confiance: ${r.conf||0}/100`);
    if(r.mcH!=null) lines.push(`Monte Carlo 800 sim: DOM ${((r.mcH||0)*100).toFixed(0)}% NUL ${((r.mcN||0)*100).toFixed(0)}% EXT ${((r.mcA||0)*100).toFixed(0)}%`);
    if(r.sc2&&r.sc2.length) lines.push(`Scores probables: ${r.sc2.slice(0,4).map(s=>`${s.h}-${s.a}(${(s.p*100).toFixed(1)}%)`).join(" ")}`);
    if(!hasData) lines.push(`⚠️ Données insuffisantes — analyse basée sur cotes uniquement`);
    lines.push("");
  }

  lines.push(`=== STATS ===`);
  const hxg = d.hxg||d.hXG;
  const axg = d.axg||d.aXG;
  if(hxg) lines.push(`xG dom=${hxg} xGA dom=${d.hxga||d.hXGA||"?"} | xG ext=${axg} xGA ext=${d.axga||d.aXGA||"?"}`);
  lines.push(`Forme dom=${d.hf||"?"}pts/15 | Forme ext=${d.af||"?"}pts/15`);
  if(d.hcs||d.acs) lines.push(`Clean sheets dom=${d.hcs||"?"}% | ext=${d.acs||"?"}%`);
  if(d.hRank&&d.aRank) lines.push(`Classement: DOM #${d.hRank} | EXT #${d.aRank}`);
  lines.push("");

  // Contexte uniquement si données réelles
  const ctx=[];
  if(d.keyPlayerOut>0) ctx.push(`Absents clés DOM: ${d.keyPlayerOut}`);
  if(d.keyPlayerOutA>0) ctx.push(`Absents clés EXT: ${d.keyPlayerOutA}`);
  if(d.matchsLast7H>=2) ctx.push(`Fatigue DOM: ${d.matchsLast7H} matchs/7j`);
  if(d.matchsLast7A>=2) ctx.push(`Fatigue EXT: ${d.matchsLast7A} matchs/7j`);
  if(d.derby) ctx.push("Derby — variance élevée");
  if(d.stakeLevel===0) ctx.push("Match sans enjeu");
  if(d.stakeLevel===3) ctx.push("Match décisif");
  if(r&&r.ctx&&r.ctx.length) ctx.push(...r.ctx.slice(0,3));
  if(ctx.length){ lines.push(`=== CONTEXTE ===\n${ctx.join(" | ")}\n`); }

  if(d.h2h&&d.h2h.length){
    const h2h=d.h2h.slice(0,6);
    const hW=h2h.filter(g=>g.winner==="home").length;
    const aW=h2h.filter(g=>g.winner==="away").length;
    const draws=h2h.length-hW-aW;
    lines.push(`=== H2H (${h2h.length} matchs) ===`);
    lines.push(`DOM ${hW}V ${draws}N ${aW}D`);
    lines.push(`Derniers résultats: ${h2h.slice(0,4).map(g=>`${g.homeGoals||0}-${g.awayGoals||0}`).join(" ")}\n`);
  }

  if(d.injuries){
    const hInj=(d.injuries.homeInj||[]).slice(0,4).map(i=>i.player).join(", ");
    const aInj=(d.injuries.awayInj||[]).slice(0,4).map(i=>i.player).join(", ");
    if(hInj||aInj){
      lines.push(`=== BLESSÉS ===`);
      if(hInj) lines.push(`DOM: ${hInj}`);
      if(aInj) lines.push(`EXT: ${aInj}`);
      lines.push("");
    }
  }

  lines.push(`=== MISSION ===`);
  lines.push(`Analyse ce match en te basant UNIQUEMENT sur les données ci-dessus.`);
  lines.push(`Si les données sont insuffisantes, dis-le clairement plutôt qu'inventer.`);
  lines.push(`Structure ta réponse EXACTEMENT ainsi:`);
  lines.push(`VERDICT: [pari recommandé ou "Pas de signal clair"] @ [cote]x | Mise: [X]% bankroll`);
  lines.push(`FORCES DOM: [points basés sur stats réelles]`);
  lines.push(`FORCES EXT: [points basés sur stats réelles]`);
  lines.push(`RISQUES: [facteurs d'incertitude]`);
  lines.push(`SCÉNARIO: [déroulement probable]`);
  lines.push(`ALTERNATIVES: [autres marchés si disponibles]`);
  lines.push(`250 mots max. Direct, factuel, zéro invention.`);

  const prompt = lines.join("\n");

  try {
    const resp = await fetch("https://api.mistral.ai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${MKEY}`},
      body:JSON.stringify({
        model:"mistral-small-latest",
        max_tokens:800,
        temperature:0.15,
        messages:[
          {role:"user", content:"Tu es EDGE, un outil d'analyse de paris sportifs. Tu analyses uniquement ce que les données te montrent. Tu ne fais jamais de prédictions sans données suffisantes. Compris?"},
          {role:"assistant", content:"Compris. J'analyse uniquement les données fournies. Si elles sont insuffisantes, je le signale clairement."},
          {role:"user", content:prompt}
        ]
      }),
      signal:(()=>{const c=new AbortController();setTimeout(()=>c.abort(),28000);return c.signal;})()
    });

    if(!resp.ok){
      const err=await resp.text();
      return res.status(502).json({error:`Mistral indisponible (${resp.status})`});
    }

    const data=await resp.json();
    const text=data.choices?.[0]?.message?.content||"";
    if(!text) return res.status(500).json({error:"Réponse vide"});

    return res.status(200).json({
      text: text.replace(/```[a-z]*/g,"").replace(/```/g,"").trim(),
      model:"mistral-small-latest",
      tokens: data.usage?.total_tokens||0
    });

  } catch(e){
    return res.status(500).json({error: e.name==="AbortError"?"Timeout (28s)":e.message});
  }
};
