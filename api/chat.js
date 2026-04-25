// EDGE - Chat IA Proxy - Anthropic Claude
// ANTHROPIC_API_KEY dans Vercel env vars

const RATE_LIMIT = new Map();

// Modèles par ordre de priorité - le premier disponible sera utilisé
const MODELS = [
  "claude-3-5-haiku-20241022",
  "claude-3-haiku-20240307",
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-2.1",
  "claude-instant-1.2"
];

async function tryModel(model, messages, system, key) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages
    })
  });

  if (response.status === 404) {
    // Modèle pas disponible - essayer le suivant
    return null;
  }

  const data = await response.json();
  if (data.error?.type === "not_found_error") return null;

  return { response, data };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Methode non autorisee" });

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

    // Accepter messages[] ou prompt string
    const messages = body.messages?.length > 0
      ? body.messages
      : body.prompt
        ? [{ role: "user", content: body.prompt }]
        : [];

    if (!messages.length) {
      return res.status(400).json({ error: "Au moins un message est requis" });
    }

    const system = body.system ||
      "Tu es EDGE Scanner, un assistant expert en analyse de paris sportifs. " +
      "Tu analyses avec precision mathematique et conseilles sur les value bets " +
      "de facon responsable. Reponds en francais.";

    // Essayer chaque modèle jusqu'à en trouver un qui fonctionne
    for (const model of MODELS) {
      try {
        const result = await tryModel(model, messages, system, KEY);
        if (!result) continue;

        const { response, data } = result;

        if (!response.ok) {
          const err = await response.text().catch(() => JSON.stringify(data));
          return res.status(response.status).json({ error: err });
        }

        const text = data.content?.[0]?.text || "";
        return res.status(200).json({ ...data, text, model_used: model });

      } catch (e) {
        continue;
      }
    }

    return res.status(500).json({ error: "Aucun modele Claude disponible sur ce compte." });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
