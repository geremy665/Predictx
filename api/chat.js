// EDGE Scanner — api/chat.js
// Analyse IA via Mistral AI

const RATE_LIMIT = new Map();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST requis" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || "unknown";
  const now = Date.now();
  const hits = (RATE_LIMIT.get(ip) || []).filter(t => now - t < 3600000);
  if (hits.length >= 30) return res.status(429).json({ error: "Limite atteinte" });
  hits.push(now);
  RATE_LIMIT.set(ip, hits);

  // Clé depuis variable d'env OU fallback
  const KEY = process.env.MISTRAL_API_KEY || process.env.MISTRAL || "";
  if (!KEY) return res.status(500).json({ error: "MISTRAL_API_KEY manquante" });

  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const messages = body.messages?.length > 0
      ? body.messages
      : body.prompt
        ? [{ role: "user", content: body.prompt }]
        : [];

    if (!messages.length) return res.status(400).json({ error: "Messages requis" });

    const system = body.system ||
      "Tu es EDGE Scanner, expert en analyse de paris sportifs. " +
      "Tu utilises Dixon-Coles, Bayesien, Monte Carlo. " +
      "Reponds en francais, de facon precise. Rappelle de parier responsablement (18+).";

    const fullMessages = [
      { role: "user", content: system + "\n\nCompris ?" },
      { role: "assistant", content: "Compris. EDGE Scanner pret." },
      ...messages.slice(-8)
    ];

    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${KEY}`
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        max_tokens: 1024,
        temperature: 0.3,
        messages: fullMessages
      }),
      signal: AbortSignal.timeout(30000)
    });

    const rawText = await response.text();
    if (!rawText?.trim()) return res.status(500).json({ error: "Reponse vide" });

    let data;
    try { data = JSON.parse(rawText); }
    catch(e) { return res.status(500).json({ error: "JSON invalide: " + rawText.substring(0,100) }); }

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || data.error || "Erreur Mistral " + response.status
      });
    }

    const text = data.choices?.[0]?.message?.content || "";
    if (!text) return res.status(500).json({ error: "Reponse vide de Mistral" });

    return res.status(200).json({
      success: true,
      text,
      content: [{ type: "text", text }],
      model: data.model || "mistral-small-latest"
    });

  } catch(e) {
    return res.status(500).json({ error: e.message || "Erreur inconnue" });
  }
};
