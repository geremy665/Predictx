// EDGE - API Football PRO - endpoint /odds direct
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
  {id:197,name:"Super League GR",f:"GR"},
  {id:2,name:"Champions League",f:"UCL"},
  {id:3,name:"Europa League",f:"UEL"},
  {id:848,name:"Conference League",f:"UEL"},
  {id:253,name:"MLS",f:"USA"},
  {id:71,name:"Brasileirao",f:"BRA"},
  {id:128,name:"Primera Division",f:"ARG"}
];

const season = new Date().getFullYear();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=300,stale-while-revalidate=600");
  if(req.method==="OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if(!KEY) return res.status(500).json({error:"FOOTBALL_API_KEY manquante",matches:[]});

  const h = {"x-apisports-key":KEY,"Accept":"application/json"};
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const in2days = new Date(now.getTime()+48*3600000).toISOString().split("T")[0];

  try {
    // STEP 1: fixtures du jour et demain
    const [fixToday, fixTomorrow] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?date=${today}`,{headers:h,signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json():null).catch(()=>null),
      fetch(`https://v3.football.api-sports.io/fixtures?date=${in2days}`,{headers:h,signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json():null).catch(()=>null)
    ]);

    const lgIds = new Set(LEAGUES.map(l=>l.id));
    const lgMap = {};
    LEAGUES.forEach(l=>{lgMap[l.id]=l;});

    const fixtureMap = {};
    const allFixtures = [
      ...((fixToday&&fixToday.response)||[]),
      ...((fixTomorrow&&fixTomorrow.response)||[])
    ];

    allFixtures.forEach(fix=>{
      const lgId = fix.league?.id;
      if(!lgIds.has(lgId)) return;
      const fId = fix.fixture?.id;
      if(!fId) return;
      fixtureMap[fId] = fix;
    });

    const fixtureIds = Object.keys(fixtureMap);
    if(!fixtureIds.length) {
      return res.status(200).json({matches:[],count:0,updated:now.toISOString(),source:"API-Football PRO"});
    }

    // STEP 2: fetch cotes pour ces fixtures (par batch de 20)
    const oddsMap = {};
    const idBatches = [];
    for(let i=0;i<fixtureIds.length;i+=20) idBatches.push(fixtureIds.slice(i,i+20));

    for(const batch of idBatches.slice(0,3)) {
      const oddsResults = await Promise.all(
        batch.map(fId=>
          fetch(`https://v3.football.api-sports.io/odds?fixture=${fId}&bookmaker=6&bet=1`,{headers:h,signal:AbortSignal.timeout(5000)})
          .then(r=>r.ok?r.json():null)
          .catch(()=>null)
        )
      );
      oddsResults.forEach((data,i)=>{
        if(!data||!data.response||!data.response.length) return;
        oddsMap[batch[i]] = data.response[0];
      });
    }

    // STEP 3: construire les matchs
    const matches = [];
    fixtureIds.forEach(fId=>{
      const fix = fixtureMap[fId];
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

      const status = fix.fixture?.status?.short||"NS";
      const isLive = ["1H","2H","HT","ET","BT","P"].includes(status);

      // Extraire cotes
      let o1=0,on=0,o2=0;
      const bkArr = [];
      const oddsData = oddsMap[fId];
      if(oddsData) {
        (oddsData.bookmakers||[]).forEach(bk=>{
          const bet = (bk.bets||[]).find(b=>b.id===1||b.name==="Match Winner");
          if(!bet) return;
          const hv=bet.values?.find(v=>v.value==="Home")?.odd;
          const dv=bet.values?.find(v=>v.value==="Draw")?.odd;
          const av=bet.values?.find(v=>v.value==="Away")?.odd;
          if(!hv) return;
          const ho=parseFloat(hv),do_=parseFloat(dv||0),ao=parseFloat(av||0);
          if(ho>o1)o1=ho;
          if(do_>on)on=do_;
          if(ao>o2)o2=ao;
          bkArr.push({n:bk.bookmaker?.name||"Bk",o1:ho,on:do_,o2:ao});
        });
      }

      // Fallback cotes si vide
      if(!o1) { o1=2.20; on=3.30; o2=3.20; }

      matches.push({
        id:parseInt(fId),
        league:"api_"+lgId,
        leagueName:lg.name,
        f:lg.f,
        home,away,time,
        homeId:fix.teams?.home?.id,
        awayId:fix.teams?.away?.id,
        leagueId:lgId,
        o1:+o1.toFixed(2),
        on:+on.toFixed(2),
        o2:+o2.toFixed(2),
        bk:bkArr.slice(0,6),
        isLive,
        liveScore:isLive?{home:fix.goals?.home??null,away:fix.goals?.away??null,elapsed:fix.fixture?.status?.elapsed??null}:null,
        status,
        venue:fix.fixture?.venue?.name||null
      });
    });

    matches.sort((a,b)=>new Date(a.time)-new Date(b.time));

    return res.status(200).json({
      matches,
      count:matches.length,
      updated:now.toISOString(),
      source:"API-Football PRO"
    });

  } catch(e) {
    return res.status(500).json({error:e.message,matches:[]});
  }
};
