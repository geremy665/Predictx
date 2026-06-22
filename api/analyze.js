// ═══════════════════════════════════════════════════════════════
// EDGE — api/analyze.js v4
// Analyse ultra-précise avec buteurs, combos, scénario complet
// ═══════════════════════════════════════════════════════════════

// Base joueurs clés par équipe/sélection
const PLAYERS_DB = {
  "France":["Kylian Mbappé","Antoine Griezmann","Ousmane Dembélé","Marcus Thuram","Adrien Rabiot","Aurélien Tchouaméni","William Saliba","Mike Maignan","Randal Kolo Muani","Michael Olise","Christopher Nkunku"],
  "Espagne":["Rodri","Pedri","Gavi","Lamine Yamal","Nico Williams","Álvaro Morata","David Raya","Dani Carvajal","Aymeric Laporte","Mikel Merino","Ferran Torres"],
  "Allemagne":["Florian Wirtz","Jamal Musiala","Kai Havertz","Leroy Sané","Thomas Müller","Manuel Neuer","Joshua Kimmich","Antonio Rüdiger","Niklas Füllkrug","Deniz Undav","Chris Führich"],
  "Angleterre":["Jude Bellingham","Harry Kane","Phil Foden","Bukayo Saka","Cole Palmer","Jordan Pickford","Declan Rice","Trent Alexander-Arnold","Luke Shaw","Marcus Rashford","Ollie Watkins"],
  "Portugal":["Cristiano Ronaldo","Bruno Fernandes","Bernardo Silva","Rafael Leão","Gonçalo Ramos","Diogo Costa","João Cancelo","Rúben Dias","Vitinha","Pedro Neto","Diogo Jota"],
  "Brésil":["Vinicius Jr","Rodrygo","Richarlison","Casemiro","Alisson","Marquinhos","Endrick","Lucas Paquetá","Gabriel Martinelli","Raphinha","Éder Militão"],
  "Argentine":["Lionel Messi","Lautaro Martínez","Julián Álvarez","Rodrigo De Paul","Emiliano Martínez","Cristian Romero","Alexis Mac Allister","Enzo Fernández","Paulo Dybala","Nahuel Molina","Lisandro Martínez"],
  "PSG":["Kylian Mbappé","Ousmane Dembélé","Gonçalo Ramos","Achraf Hakimi","Marquinhos","Gianluigi Donnarumma","Vitinha","Warren Zaïre-Emery","Bradley Barcola","Marco Asensio","Lucas Hernández"],
  "Real Madrid":["Vinícius Jr","Rodrygo","Jude Bellingham","Federico Valverde","Luka Modric","Thibaut Courtois","Dani Carvajal","Éder Militão","Aurélien Tchouaméni","Eduardo Camavinga","Brahim Díaz"],
  "Barcelona":["Robert Lewandowski","Pedri","Lamine Yamal","Raphinha","Gavi","Marc-André ter Stegen","Ronald Araújo","Jules Koundé","Frenkie de Jong","Fermín López","Ansu Fati"],
  "Bayern Munich":["Harry Kane","Leroy Sané","Jamal Musiala","Thomas Müller","Manuel Neuer","Joshua Kimmich","Leon Goretzka","Kingsley Coman","Mathys Tel","Serge Gnabry","Konrad Laimer"],
  "Manchester City":["Erling Haaland","Kevin De Bruyne","Phil Foden","Bernardo Silva","Ederson","Kyle Walker","Rúben Dias","Rodri","Jeremy Doku","Jack Grealish","Mateo Kovačić"],
  "Liverpool":["Mohamed Salah","Darwin Núñez","Luis Díaz","Trent Alexander-Arnold","Virgil van Dijk","Alisson","Andrew Robertson","Dominik Szoboszlai","Cody Gakpo","Diogo Jota","Curtis Jones"],
  "Arsenal":["Bukayo Saka","Martin Ødegaard","Leandro Trossard","Kai Havertz","Gabriel Jesus","David Raya","Ben White","William Saliba","Gabriel Magalhães","Thomas Partey","Declan Rice"],
  "Chelsea":["Cole Palmer","Nicolas Jackson","Christopher Nkunku","Reece James","Enzo Fernández","Robert Sánchez","Moisés Caicedo","Romeo Lavia","Noni Madueke","Raheem Sterling","Axel Disasi"],
  "Atletico Madrid":["Antoine Griezmann","Álvaro Morata","Memphis Depay","Rodrigo De Paul","Jan Oblak","Nahuel Molina","José María Giménez","Koke","Marcos Llorente","Saúl","Reinildo"],
  "Juventus":["Dušan Vlahović","Federico Chiesa","Adrien Rabiot","Manuel Locatelli","Bremer","Wojciech Szczęsny","Andrea Cambiaso","Weston McKennie","Filip Kostić","Kenan Yıldız","Gleison Bremer"],
  "Inter Milan":["Lautaro Martínez","Marcus Thuram","Nicolò Barella","Hakan Çalhanoğlu","Yann Sommer","Alessandro Bastoni","Denzel Dumfries","Stefan de Vrij","Davide Frattesi","Carlos Augusto","Alexis Sánchez"],
  "AC Milan":["Rafael Leão","Olivier Giroud","Christian Pulisic","Tijjani Reijnders","Mike Maignan","Theo Hernández","Fikayo Tomori","Ruben Loftus-Cheek","Samuel Chukwueze","Davide Calabria","Noah Okafor"],
  "Borussia Dortmund":["Niclas Füllkrug","Donyell Malen","Julian Brandt","Marcel Sabitzer","Gregor Kobel","Mats Hummels","Nico Schlotterbeck","Karim Adeyemi","Salih Özcan","Giovanni Reyna","Jamie Gittens"],
  "Maroc":["Hakim Ziyech","Youssef En-Nesyri","Achraf Hakimi","Sofyan Amrabat","Romain Saïss","Yassine Bounou","Noussair Mazraoui","Azzedine Ounahi","Bilal El Khannouss","Abde Ezzalzouli","Selim Amallah"],
  "Sénégal":["Sadio Mané","Ismaïla Sarr","Édouard Mendy","Kalidou Koulibaly","Cheikhou Kouyaté","Idrissa Gana Gueye","Famara Diédhiou","Boulaye Dia","Pape Matar Sarr","Lamine Camara","Nampalys Mendy"],
};

function getPlayers(teamName) {
  if (!teamName) return [];
  if (PLAYERS_DB[teamName]) return PLAYERS_DB[teamName];
  for (const k of Object.keys(PLAYERS_DB)) {
    if (teamName.toLowerCase().includes(k.toLowerCase()) ||
        k.toLowerCase().includes(teamName.toLowerCase().split(" ")[0])) {
      return PLAYERS_DB[k];
    }
  }
  return [];
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();

  const MKEY = process.env.MISTRAL_API_KEY;
  if (!MKEY) return res.status(500).json({error:"MISTRAL_API_KEY manquante"});

  let body={};
  try {
    if(req.body&&typeof req.body==="object") body=req.body;
    else {
      let raw="";
      await new Promise((r2,rj)=>{req.on("data",c=>{raw+=c.toString();});req.on("end",r2);req.on("error",rj);});
      if(raw) body=JSON.parse(raw);
    }
  } catch(e){ return res.status(400).json({error:"Body JSON invalide"}); }

  const d = body.match || body;
  const r = body.result || body.calc;

  if (!d.home && !d.h) return res.status(400).json({error:"Données match manquantes"});

  const home = d.home || d.h || "DOM";
  const away = d.away || d.a || "EXT";
  const league = d.leagueName || d.league || d.c || "Football";
  const o1 = parseFloat(d.o1) || 0;
  const oN = parseFloat(d.on || d.oN) || 0;
  const o2 = parseFloat(d.o2) || 0;
  const hasOdds = o1 > 1.05 && oN > 1.05 && o2 > 1.05;

  // Joueurs connus
  const hPlayers = getPlayers(home);
  const aPlayers = getPlayers(away);
  const hScorer = hPlayers[0] || "";
  const hAssist = hPlayers[1] || "";
  const aScorer = aPlayers[0] || "";
  const aAssist = aPlayers[1] || "";

  // Probabilités moteur
  const pH = r ? ((r.pH||0)*100).toFixed(1) : "?";
  const pN = r ? ((r.pN||0)*100).toFixed(1) : "?";
  const pA = r ? ((r.pA||0)*100).toFixed(1) : "?";
  const lH = r ? (+(r.lH||0)).toFixed(2) : "?";
  const lA = r ? (+(r.lA||0)).toFixed(2) : "?";
  const conf = r ? (r.conf||0) : 0;
  const signal = r ? (r.bR||"?") : "?";
  const edgPct = r ? ((r.edg||0)*100).toFixed(1) : "0";
  const pOver25 = r ? ((r.pOver25||0)*100).toFixed(0) : "?";
  const pBtts = r ? ((r.pBttsY||0)*100).toFixed(0) : "?";
  const sc2 = r && r.sc2 ? r.sc2.slice(0,4).map(s=>`${s.h}-${s.a}(${(s.p*100).toFixed(0)}%)`).join(" | ") : "";
  const dataQ = r ? (r.dataQ||1) : 1;

  // Favori déterminé
  const pHnum = r ? (r.pH||0) : 0;
  const pAnum = r ? (r.pA||0) : 0;
  const favTeam = pHnum > pAnum ? home : away;
  const favOdd = pHnum > pAnum ? o1 : o2;
  const favScorer = pHnum > pAnum ? hScorer : aScorer;
  const favAssist = pHnum > pAnum ? hAssist : aAssist;
  const lSum = r ? ((r.lH||1.35)+(r.lA||1.10)) : 2.45;

  // Estimation cotes combos
  const oO15 = d.over15 || (lSum > 2.0 ? 1.30 : 1.50);
  const oO25 = d.over25 || (lSum > 2.5 ? 1.80 : 2.10);
  const oBtts = d.bttsY || 1.85;
  const oDC   = pHnum > pAnum ? (d.dc1x || parseFloat((1/(1/o1+1/oN)*0.95).toFixed(2))) : (d.dcx2 || parseFloat((1/(1/o2+1/oN)*0.95).toFixed(2)));

  // Cote combo sécurisé: favori + O1.5
  const comboSecOdd = hasOdds && favOdd > 1 ? (favOdd * oO15).toFixed(2) : "?";
  // Cote combo fun: favori + scorer buteur + assist décisif (~estimation)
  const comboFunOdd = hasOdds && favOdd > 1 ? (favOdd * 2.40 * 2.80).toFixed(2) : "?";
  // DC + O2.5
  const comboDcOdd = hasOdds && oDC > 1 ? (oDC * oO25).toFixed(2) : "?";

  // Forme H2H
  let h2hStr = "";
  if (d.h2h && d.h2h.length) {
    const h2h = d.h2h.slice(0,5);
    const hW = h2h.filter(g=>g.winner==="home"||g.hG>g.aG).length;
    const aW = h2h.filter(g=>g.winner==="away"||g.aG>g.hG).length;
    const dr = h2h.length - hW - aW;
    h2hStr = `H2H ${h2h.length} matchs: ${home} ${hW}V ${dr}N ${aW}D | Scores: ${h2h.slice(0,4).map(g=>`${g.hG||g.homeGoals||0}-${g.aG||g.awayGoals||0}`).join(" ")}`;
  }

  // ─── PROMPT ULTRA-CALIBRÉ ─────────────────────────────────
  const prompt = `Tu es l'analyste principal de EDGE, l'outil de pronostics sportifs le plus précis du marché.

═══ DONNÉES DU MATCH ═══
${home} vs ${away} | ${league}
${hasOdds ? `Cotes: 1=${o1}x | N=${oN}x | 2=${o2}x` : "Pas de cotes disponibles"}

═══ MOTEUR EDGE (Dixon-Coles + Monte Carlo 800 sim) ═══
Probabilités: ${home} ${pH}% | Nul ${pN}% | ${away} ${pA}%
Buts attendus (λ): ${home} ${lH} | ${away} ${lA}
Plus de 2.5 buts: ${pOver25}% | Les 2 marquent: ${pBtts}%
${sc2 ? `Scores les plus probables: ${sc2}` : ""}
Signal moteur: ${signal} | Edge: ${edgPct}% | Confiance: ${conf}/100
Qualité données: ${dataQ}/4

${h2hStr ? `═══ H2H ═══\n${h2hStr}\n` : ""}
${d.hf ? `═══ FORME ═══\n${home}: ${d.hf}/15 pts | ${away}: ${d.af||"?"}/15 pts\n` : ""}
${d.hRank ? `Classement: ${home} #${d.hRank} | ${away} #${d.aRank||"?"}\n` : ""}
${hScorer ? `Joueurs clés ${home}: ${hPlayers.slice(0,5).join(", ")}` : ""}
${aScorer ? `Joueurs clés ${away}: ${aPlayers.slice(0,5).join(", ")}` : ""}

═══ COTES MARCHÉS ═══
Double Chance favori: ${oDC}x | Over 1.5: ${oO15}x | Over 2.5: ${oO25}x | BTTS: ${oBtts}x
Combo sécurisé (${favTeam} + O1.5): ~${comboSecOdd}x
Combo fun (${favTeam} + ${favScorer} buteur + ${favAssist} décisif): ~${comboFunOdd}x
DC favori + O2.5: ~${comboDcOdd}x

═══ TA MISSION ═══
Génère une analyse COMPLÈTE et PRÉCISE. Sois direct comme un expert qui parle à un ami.
Même si la cote est faible (ex: 1.20x), propose quand même le pari — l'utilisateur veut un pronostic clair.
Base-toi sur les probabilités du moteur ET ta connaissance des équipes.

STRUCTURE OBLIGATOIRE (respecte exactement ces emojis et titres):

🏆 VERDICT
[1-2 phrases percutantes sur qui va gagner et pourquoi. Ex: "La France devrait s'imposer nettement face à l'Irak, les statistiques sont sans appel."]

🎯 PARI PRINCIPAL
[Pari exact] @ [cote]x
[1 phrase justification]

⚡ COMBO SÉCURISÉ
[Ex: France gagne + Plus 1.5 buts] @ ~${comboSecOdd}x
[1 phrase pourquoi c'est sûr]

🎰 PARI FUN
[Ex: ${favTeam} gagne + ${favScorer} buteur + ${favAssist} décisif] @ ~${comboFunOdd}x
[1 phrase d'ambiance]

📊 ANALYSE RAPIDE
- ${home}: [force principale en 1 ligne]
- ${away}: [force/faiblesse en 1 ligne]
- Scénario: [comment le match va se dérouler en 1-2 phrases]

⚠️ RISQUE PRINCIPAL
[1 phrase sur le principal danger]

🔁 ALTERNATIVE
[1 autre marché intéressant avec sa cote]

RÈGLES ABSOLUES:
- Maximum 220 mots
- Toujours proposer un pari même si cote basse
- Nommer les joueurs quand pertinent (${favScorer}, ${hAssist}, etc.)
- Jamais dire "données insuffisantes" — analyse toujours
- Ton: expert confiant, direct, humain`;

  try {
    const resp = await fetch("https://api.mistral.ai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${MKEY}`},
      body:JSON.stringify({
        model:"mistral-small-latest",
        max_tokens:900,
        temperature:0.20,
        messages:[
          {
            role:"system",
            content:"Tu es l'analyste expert de EDGE. Tu donnes toujours des pronostics précis, clairs et actionnables. Tu nommes les joueurs clés. Tu proposes toujours un pari même sur les gros favoris. Ton style: expert confiant, direct, humain. Jamais de formules vagues. Toujours le format demandé avec les emojis."
          },
          {role:"user", content:prompt}
        ]
      }),
      signal:(()=>{const c=new AbortController();setTimeout(()=>c.abort(),28000);return c.signal;})()
    });

    if(!resp.ok){
      const err=await resp.text();
      return res.status(502).json({error:`Mistral indisponible (${resp.status}): ${err.slice(0,100)}`});
    }

    const data=await resp.json();
    const text=data.choices?.[0]?.message?.content||"";
    if(!text) return res.status(500).json({error:"Réponse vide"});

    return res.status(200).json({
      text: text.replace(/```[a-z]*/g,"").replace(/```/g,"").trim(),
      model:"mistral-small-latest",
      tokens: data.usage?.total_tokens||0,
      home, away,
      favTeam,
      favScorer,
      combos: {
        secure: { label:`${favTeam} gagne + Plus 1.5 buts`, odd: comboSecOdd },
        fun: { label:`${favTeam} + ${favScorer} buteur + ${favAssist} décisif`, odd: comboFunOdd },
        dc: { label:`Double Chance favori + Plus 2.5 buts`, odd: comboDcOdd }
      }
    });

  } catch(e){
    return res.status(500).json({
      error: e.name==="AbortError"?"Timeout (28s)":e.message
    });
  }
};
