// EDGE - Chat IA Proxy - Anthropic Claude
// ANTHROPIC_API_KEY dans Vercel env vars

const RATE_LIMIT = new Map();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Rate limit 20 req/h par IP
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

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
