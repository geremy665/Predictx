// EDGE Scanner — api/chat.js
// Analyse IA via Anthropic Claude
// Variable Vercel: ANTHROPIC_API_KEY

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST requis" });

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY manquante dans Vercel" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "JSON invalide" }); }
  }

  const { messages, match, analysis } = body || {};
  if (!messages?.length) return res.status(400).json({ error: "messages requis" });

  // Construire le système prompt
  let systemPrompt = `Tu es EDGE, un expert en analyse de paris sportifs et en modélisation statistique du football.

Tu utilises les modèles Dixon-Coles, l'inférence bayésienne et les simulations Monte Carlo pour analyser les matchs.
Tu parles toujours en français. Tu es précis, factuel et tu donnes des conseils concrets.
Tu mentions toujours la responsabilité (18+, limites de mise).

Tes analyses incluent:
- Évaluation de la valeur des cotes (edge mathématique)
- Probabilités calculées vs cotes implicites
- Facteurs contextuels (forme, domicile/extérieur, blessures si connues)
- Recommandation de mise Kelly si applicable
- Niveau de confiance sur 100`;

  if (match) {
    systemPrompt += `\n\nMATCH EN COURS D'ANALYSE:
- ${match.home || match.h} vs ${match.away || match.a}
- Ligue: ${match.leagueName || match.c || ""}
- Cotes: 1=${match.o1 || "?"} / N=${match.on || "?"} / 2=${match.o2 || "?"}`;
    if (match.isLive) systemPrompt += `\n- MATCH EN DIRECT - Score: ${match.goalsH ?? "?"}-${match.goalsA ?? "?"}`;
  }

  if (analysis) {
    systemPrompt += `\n\nANALYSE ALGORITHMIQUE:
- Probabilités: Dom=${Math.round((analysis.pH||0)*100)}% / Nul=${Math.round((analysis.pN||0)*100)}% / Ext=${Math.round((analysis.pA||0)*100)}%
- Edge: ${analysis.edg ? ((analysis.edg||0)*100).toFixed(1)+"%" : "N/A"}
- Confiance: ${analysis.conf || 0}%
- Signal: ${analysis.label || ""}`;
  }

  try {
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
        system: systemPrompt,
        messages: messages.slice(-10) // max 10 messages d'historique
      }),
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic error:", response.status, errText);
      return res.status(response.status).json({ error: `API Anthropic: ${response.status}`, detail: errText.substring(0, 200) });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    return res.status(200).json({
      success: true,
      message: text,
      model: data.model,
      usage: data.usage
    });

  } catch (err) {
    console.error("chat.js error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
