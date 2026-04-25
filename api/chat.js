// EDGE - Chat IA Proxy - Anthropic Claude
// ANTHROPIC_API_KEY dans Vercel env vars

const RATE_LIMIT = new Map();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Methode non autorisee" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = 20;
  if (!RATE_LIMIT.has(ip)) RATE_LIMIT.set(ip, []);
  const hits = RATE_LIMIT.get(ip).filter(t => now - t < windowMs);
  if (hits.length >= max) return res.status(429).json({ error: "Limite 20 req/h atteinte." });
  hits.push(now);
  RATE_LIMIT.set(ip, hits);

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante" });

  try {
    const body = req.body || {};
    const messages = body.messages || [];
    const system = body.system || "Tu es EDGE Scanner, un assistant expert en analyse de paris sportifs. Tu analyses avec precision mathematique et conseilles sur les value bets de facon responsable. Reponds en francais.";

    // Si pas de messages mais un prompt direct
    const finalMessages = messages.length > 0 ? messages : 
      body.prompt ? [{role: "user", content: body.prompt}] : [];

    if (!finalMessages.length) {
      return res.status(400).json({ error: "Au moins un message est requis" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1024,
        system,
        messages: finalMessages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    // Retourner aussi data.text pour compatibilité
    const text = data.content?.[0]?.text || "";
    return res.status(200).json({ ...data, text });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
