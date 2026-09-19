// api/generate-description.js
// POST /api/generate-description
// Body: { resume: string, bien: { ville, surface, pieces, dpe, equipements } }
// Header: Authorization: Bearer <access_token Supabase de l'utilisateur connecté>
//
// Génère une description d'annonce à partir d'un résumé sommaire donné par
// le vendeur + des caractéristiques déjà connues du bien. Le texte proposé
// reste éditable côté front — rien n'est publié automatiquement.
//
// Utilise Groq (https://console.groq.com), qui héberge des modèles open-source
// (Llama 3.3, Mixtral, Gemma) avec une clé API gratuite — adapté à un POC sans
// budget. Nécessite la variable d'environnement GROQ_API_KEY sur Vercel.

async function verifySupabaseUser(token) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: process.env.SUPABASE_ANON_KEY,
    },
  });
  return res.ok;
}

function buildPrompt(resume, bien) {
  const details = [];
  if (bien?.ville) details.push(`Ville : ${bien.ville}`);
  if (bien?.surface) details.push(`Surface habitable : ${bien.surface} m²`);
  if (bien?.pieces) details.push(`Nombre de pièces : ${bien.pieces}`);
  if (bien?.dpe) details.push(`DPE : ${bien.dpe}`);
  if (bien?.equipements?.length) details.push(`Équipements : ${bien.equipements.join(', ')}`);

  return `Tu rédiges une description d'annonce immobilière en français, pour un particulier qui vend sa maison sans agence.

Résumé donné par le vendeur : "${resume}"

Caractéristiques connues du bien :
${details.length ? details.join('\n') : 'Aucune autre caractéristique renseignée.'}

Consignes :
- Ton chaleureux mais factuel, sans emphase commerciale excessive ni superlatifs vides ("magnifique", "exceptionnel").
- 4 à 6 phrases, structurées en un seul paragraphe.
- Ne jamais inventer de caractéristique qui n'est pas donnée ci-dessus (pas de nombre de chambres, pas d'équipement non mentionné).
- Termine si pertinent par une phrase sur l'emplacement ou l'ambiance du quartier, sans localisation précise inventée au-delà de la ville donnée.
- Réponds uniquement avec le texte de la description, sans titre ni guillemets.`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token || !(await verifySupabaseUser(token))) {
      res.status(401).json({ error: 'Non authentifié.' });
      return;
    }

    if (!process.env.GROQ_API_KEY) {
      res.status(500).json({ error: "Clé API IA manquante côté serveur (GROQ_API_KEY)." });
      return;
    }

    const { resume, bien } = req.body || {};
    if (!resume || resume.trim().length < 10) {
      res.status(400).json({ error: 'Merci de décrire le bien en au moins quelques mots.' });
      return;
    }

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPrompt(resume.trim(), bien || {}) }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      res.status(502).json({ error: `Erreur Groq (${aiRes.status}) : ${errText.slice(0, 300)}` });
      return;
    }

    const aiData = await aiRes.json();
    const texte = (aiData.choices?.[0]?.message?.content || '').trim();

    res.status(200).json({ description: texte });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
