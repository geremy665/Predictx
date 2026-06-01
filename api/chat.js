// EDGE — api/chat.js v2
// Analyse IA via Claude Sonnet

const RATE_LIMIT = new Map();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST requis" });

  /* Rate limit: 20 requêtes/heure par IP */
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  const now = Date.now();
  const hits = (RATE_LIMIT.get(ip) || []).filter(t => now - t < 3600000);
  if (hits.length >= 20) return res.status(429).json({ error: "Limite atteinte — réessaie dans 1h" });
  hits.push(now);
  RATE_LIMIT.set(ip, hits);

  try {
    /* Parser le body */
    let body = req.body || {};
    if (!body.messages) {
      let raw = "";
      await new Promise((resolve, reject) => {
        req.on("data", c => raw += c);
        req.on("end", resolve);
        req.on("error", reject);
      });
      try { body = JSON.parse(raw); } catch(e) {}
    }

    const messages = body.messages || [];
    if (!messages.length) return res.status(400).json({ error: "Messages requis" });

    const system = body.system ||
      "Tu es EDGE, expert en analyse de paris sportifs. " +
      "Tu analyses les matchs avec rigueur : probabilités, value bets, gestion du risque. " +
      "Sois direct, humain, sans jargon technique. " +
      "Donne toujours un avis clair et une recommandation concrète. " +
      "18+ — tu rappelles toujours de parier responsablement.";

    const maxTokens = Math.min(body.max_tokens || 1200, 2000);

    /* Appel Claude */
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: system,
        messages: messages.slice(-6)
      })
    });

    if (!response.ok) {
      const err = await response.text();
      /* Fallback Mistral si Claude indispo */
      const MISTRAL_KEY = process.env.MISTRAL_API_KEY || "";
      if (MISTRAL_KEY) {
        const mr = await fetch("https://api.mistral.ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MISTRAL_KEY}` },
          body: JSON.stringify({ model: "mistral-small-latest", max_tokens: maxTokens, messages })
        });
        if (mr.ok) {
          const md = await mr.json();
          return res.status(200).json({ text: md.choices?.[0]?.message?.content || "" });
        }
      }
      return res.status(502).json({ error: "IA temporairement indisponible" });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    return res.status(200).json({ text });

  } catch(e) {
    console.error("chat.js error:", e.message);
    return res.status(500).json({ error: "Erreur serveur: " + e.message });
  }
};
