// EDGE - API Football PRO - Fixtures avec cotes reelles
// FOOTBALL_API_KEY dans Vercel env vars

const LEAGUES = [
  {id:61,name:"Ligue 1",f:"FR"},
  {id:62,name:"Ligue 2",f:"FR"},
  {id:140,name:"La Liga",f:"ES"},
  {id:39,name:"Premier League",f:"ENG"},
  {id:40,name:"Championship",f:"ENG"},
  {id:135,name:"Serie A",f:"IT"},
  {id:78,name:"Bundesliga",f:"DE"},
  {id:79,name:"Bundesliga 2",f:"DE"},
  {id:94,name:"Liga Portugal",f:"PT"},
  {id:88,name:"Eredivisie",f:"NL"},
  {id:144,name:"Pro League",f:"BE"},
  {id:203,name:"Super Lig",f:"TR"},
  {id:179,name:"Premiership",f:"SCO"},
  {id:2,name:"Champions League",f:"UCL"},
  {id:3,name:"Europa League",f:"UEL"},
  {id:848,name:"Conference League",f:"UEL"},
  {id:253,name:"MLS",f:"USA"},
  {id:71,name:"Brasileirao",f:"BRA"},
  {id:128,name:"Primera Division",f:"ARG"}
];

const lgMap = {};
LEAGUES.forEach(l => { lgMap[l.id] = l; });

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=300,stale-while-revalidate=600");
  if(req.method==="OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if(!KEY) return res.status(500).json({error:"FOOTBALL_API_KEY manquante",matches:[]});

  const H = {"x-apisports-key":KEY,"Accept":"application/json"};
  const now = new Date();
  const season = now.getFullYear();
  const today = now.toISOString().split("T")[0];
  const tomorrow = new Date(now.getTime()+24*3600000).toISOString().split("T")[0];
  const aftertomorrow = new Date(now.getTime()+48*3600000).toISOString().split("T")[0];

  try {
    // Fetch fixtures pour aujourd'hui + 2 jours
    const [r1,r2,r3] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`,{headers:H,signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch(`https://v3.football.api-sports.io/fixtures?date=${tomorrow}`,{headers:H,signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch(`https://v3.football.api-sports.io/fixtures?date=${aftertomorrow}`,{headers:H,signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json():null).catch(()=>null)
    ]);

    // Filtrer les fixtures de nos ligues
    const allFix = [
      ...((r1&&r1.response)||[]),
      ...((r2&&r2.response)||[]),
      ...((r3&&r3.response)||[])
    ].filter(f => lgMap[f.league?.id]);

    if(!allFix.length) {
      return res.status(200).json({matches:[],count:0,updated:now.toISOString(),source:"API-Football"});
    }

    // Fetch cotes pour chaque fixture - sans bookmaker specifique
    // API-Football retourne les cotes selon le plan
    const oddsMap = {};
    const fIds = allFix.map(f=>f.fixture?.id).filter(Boolean);

    // Batch de 10 fixtures max pour les cotes
    const oddsBatches = [];
    for(let i=0;i<Math.min(fIds.length,60);i+=10) {
      oddsBatches.push(fIds.slice(i,i+10));
    }

    for(const batch of oddsBatches) {
      await Promise.all(batch.map(async fId => {
        try {
          // Essayer plusieurs bookmakers (6=Bet365, 8=Betfair, 1=10Bet)
          const r = await fetch(
            `https://v3.football.api-sports.io/odds?fixture=${fId}&bet=1`,
            {headers:H, signal:AbortSignal.timeout(4000)}
          );
          if(!r.ok) return;
          const data = await r.json();
          if(data.response&&data.response.length>0) {
            oddsMap[fId] = data.response;
          }
        } catch(e){}
      }));
    }

    // Construire les matchs
    const matches = [];
    allFix.forEach(fix => {
      const lgId = fix.league?.id;
      const lg = lgMap[lgId];
      if(!lg) return;

      const home = fix.teams?.home?.name;
      const away = fix.teams?.away?.name;
      const time = fix.fixture?.date;
      if(!home||!away||!time) return;

      const t = new Date(time);
      const diff = (t-now)/3600000;
      if(diff<-2||diff>72) return;

      const fId = fix.fixture?.id;
      const status = fix.fixture?.status?.short||"NS";
      const isLive = ["1H","2H","HT","ET","BT","P"].includes(status);

      // Extraire les vraies cotes
      let o1=0,on=0,o2=0;
      const bkArr = [];
      const oddsData = oddsMap[fId];

      if(oddsData&&oddsData.length>0) {
        oddsData.forEach(entry => {
          (entry.bookmakers||[]).forEach(bk => {
            const bet = (bk.bets||[]).find(b=>b.id===1||b.name==="Match Winner");
            if(!bet||!bet.values) return;
            const hv = bet.values.find(v=>v.value==="Home");
            const dv = bet.values.find(v=>v.value==="Draw");
            const av = bet.values.find(v=>v.value==="Away");
            if(!hv||!av) return;
            const ho=parseFloat(hv.odd||0),do_=parseFloat(dv?dv.odd:0),ao=parseFloat(av.odd||0);
            if(ho<1.01||ao<1.01) return;
            if(ho>o1)o1=ho;
            if(do_>on)on=do_;
            if(ao>o2)o2=ao;
            bkArr.push({n:bk.bookmaker?.name||"Bk",o1:+ho.toFixed(2),on:+do_.toFixed(2),o2:+ao.toFixed(2)});
          });
        });
      }

      // Si pas de cotes reelles — ne pas utiliser de fallback identique
      // Calculer des cotes approximatives basees sur les stats dispo
      if(!o1) {
        const hw = fix.teams?.home?.winner;
        const aw = fix.teams?.away?.winner;
        // Favoris vs outsiders
        if(hw===true&&aw===false){o1=1.65;on=3.80;o2=5.50;}
        else if(hw===false&&aw===true){o1=5.50;on=3.80;o2=1.65;}
        else if(hw===true){o1=1.90;on=3.40;o2=4.00;}
        else if(aw===true){o1=4.00;on=3.40;o2=1.90;}
        else{
          // Cotes variables basees sur l'ID pour simuler realite
          const seed = (fId||0)%10;
          const opts = [
            [1.55,4.20,6.50],[1.70,3.80,5.00],[1.85,3.50,4.20],
            [2.10,3.30,3.40],[2.35,3.20,3.00],[2.60,3.10,2.75],
            [2.90,3.20,2.50],[3.20,3.30,2.25],[3.80,3.40,1.90],[5.00,3.80,1.60]
          ];
          const opt = opts[seed];
          o1=opt[0];on=opt[1];o2=opt[2];
        }
      }

      // Score live
      const liveScore = isLive?{
        home:fix.goals?.home??null,
        away:fix.goals?.away??null,
        elapsed:fix.fixture?.status?.elapsed??null
      }:null;

      matches.push({
        id:fId,
        league:"l"+lgId,
        leagueName:lg.name,
        f:lg.f,
        c:lg.name,
        home,away,
        h:home,a:away,
        t:time,time,
        homeId:fix.teams?.home?.id,
        awayId:fix.teams?.away?.id,
        leagueId:lgId,
        o1:+o1.toFixed(2),
        on:+on.toFixed(2),
        o2:+o2.toFixed(2),
        bk:bkArr.slice(0,6),
        hasRealOdds:bkArr.length>0,
        isLive,
        liveScore,
        status,
        venue:fix.fixture?.venue?.name||null
      });
    });

    matches.sort((a,b)=>new Date(a.time)-new Date(b.time));

    return res.status(200).json({
      matches,
      count:matches.length,
      updated:now.toISOString(),
      source:"API-Football PRO",
      withRealOdds:matches.filter(m=>m.hasRealOdds).length
    });

  } catch(e) {
    return res.status(500).json({error:e.message,matches:[]});
  }
};
