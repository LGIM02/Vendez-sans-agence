// api/analyze-acheteur.js
// POST /api/analyze-acheteur   Body: { acheteur_id }
// Header: Authorization: Bearer <access_token Supabase du vendeur>
//
// Lit les documents déposés pour un acheteur (images uniquement pour
// l'instant — voir note plus bas) via un modèle multimodal (Groq,
// qwen/qwen3.8-27b) et produit une synthèse indicative.
//
// ⚠️ CE SCORE N'EST PAS UNE DÉCISION. Conformément à l'article 22 du RGPD
// sur les décisions individuelles automatisées, ce résultat doit toujours
// être présenté comme une aide à la lecture à vérifier par le vendeur,
// jamais comme un verdict. Le front-end doit afficher cet avertissement
// de façon visible à chaque affichage du résultat.
//
// LIMITE ACTUELLE : seuls les documents au format image (JPEG/PNG) sont
// analysés. Les PDF sont stockés mais pas encore lus par l'IA — la
// conversion PDF → image nécessite une étape supplémentaire non encore
// construite (voir le README pour la piste d'implémentation).

const { createClient } = require('@supabase/supabase-js');

function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function verifySupabaseUser(token) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: process.env.SUPABASE_ANON_KEY,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

const LABELS = {
  accord_principe: "Accord de principe bancaire",
  avis_imposition: "Avis d'imposition",
  justificatif_apport: "Justificatif d'apport personnel",
  bulletins_salaire: "Bulletin de salaire",
  attestation_employeur: "Attestation employeur",
  piece_identite: "Pièce d'identité",
  libre: "Document libre",
};

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function buildPrompt(documentsLabels){
  return `Tu es un assistant qui aide un particulier (vendeur d'un bien immobilier, sans agence) à relire les documents financiers qu'un acheteur potentiel lui a transmis.

Documents fournis, dans l'ordre des images jointes :
${documentsLabels.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Analyse ces documents et réponds UNIQUEMENT avec un objet JSON valide (aucun texte autour), au format exact suivant :

{
  "score": <entier de 0 à 100, indicatif>,
  "categorie": "solide" | "a_approfondir" | "fragile" | "indetermine",
  "synthese": "<2-3 phrases factuelles résumant ce que montrent les documents>",
  "points_forts": ["<point factuel>", ...],
  "points_attention": ["<incohérence, information manquante ou à vérifier>", ...]
}

Consignes strictes :
- Base-toi UNIQUEMENT sur ce qui est écrit dans les documents. N'invente aucun chiffre.
- Si un document est illisible ou incomplet, dis-le dans "points_attention" plutôt que de deviner.
- "categorie": "indetermine" si les documents ne permettent pas de conclure.
- Ce n'est PAS une décision de financement — reste factuel et descriptif, jamais péremptoire ("cet acheteur ne pourra pas financer" est interdit ; "le montant de l'accord de principe est inférieur au prix affiché" est correct).`;
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
    const user = token ? await verifySupabaseUser(token) : null;
    if (!user) {
      res.status(401).json({ error: 'Non authentifié.' });
      return;
    }

    if (!process.env.GROQ_API_KEY) {
      res.status(500).json({ error: 'Clé API IA manquante côté serveur (GROQ_API_KEY).' });
      return;
    }

    const { acheteur_id } = req.body || {};
    if (!acheteur_id) {
      res.status(400).json({ error: 'Paramètre "acheteur_id" requis.' });
      return;
    }

    const supabase = getServiceClient();

    // Vérifie que l'acheteur appartient bien à une annonce du vendeur authentifié
    // (le service role contourne RLS — ce contrôle applicatif est donc indispensable).
    const { data: acheteur, error: acheteurError } = await supabase
      .from('acheteurs')
      .select('id, annonces!inner(user_id)')
      .eq('id', acheteur_id)
      .single();

    if (acheteurError || !acheteur || acheteur.annonces.user_id !== user.id) {
      res.status(403).json({ error: 'Accès refusé à cet acheteur.' });
      return;
    }

    const { data: documents } = await supabase
      .from('acheteur_documents')
      .select('*')
      .eq('acheteur_id', acheteur_id);

    const imageDocuments = (documents || []).filter(d =>
      IMAGE_EXTENSIONS.some(ext => d.fichier_url.toLowerCase().endsWith(ext))
    );

    if (imageDocuments.length === 0) {
      res.status(200).json({
        score: null,
        categorie: 'indetermine',
        synthese: "Aucun document au format image n'a pu être lu. Les fichiers PDF ne sont pas encore analysés automatiquement — vérifiez-les manuellement pour le moment.",
        points_forts: [],
        points_attention: ["Aucun document image exploitable."],
        documents_manquants: [],
      });
      return;
    }

    // Télécharge chaque image et l'encode en base64 pour l'envoyer au modèle multimodal.
    const contentBlocks = [];
    const labels = [];
    for (const doc of imageDocuments.slice(0, 6)) { // plafond raisonnable par analyse
      const { data: fileBlob, error: dlError } = await supabase.storage
        .from('acheteur-documents')
        .download(doc.fichier_url);
      if (dlError || !fileBlob) continue;

      const buffer = Buffer.from(await fileBlob.arrayBuffer());
      const base64 = buffer.toString('base64');
      const label = doc.categorie === 'libre' && doc.nom_libre ? doc.nom_libre : (LABELS[doc.type] || 'Document');
      labels.push(label);

      contentBlocks.push({
        type: 'image_url',
        image_url: { url: `data:${doc.mime_type || 'image/jpeg'};base64,${base64}` },
      });
    }

    if (contentBlocks.length === 0) {
      res.status(502).json({ error: 'Impossible de récupérer les documents depuis le stockage.' });
      return;
    }

    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: buildPrompt(labels) }, ...contentBlocks],
    }];

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        max_tokens: 800,
        messages,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      res.status(502).json({ error: `Erreur Groq (${aiRes.status}) : ${errText.slice(0, 300)}` });
      return;
    }

    const aiData = await aiRes.json();
    const rawText = (aiData.choices?.[0]?.message?.content || '').trim();

    let parsed;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
    } catch (e) {
      res.status(502).json({ error: "La réponse de l'IA n'a pas pu être interprétée. Réessayez." });
      return;
    }

    // Documents obligatoires manquants — calculé en code, pas par le modèle (plus fiable).
    const typesPresents = new Set((documents || []).map(d => d.type));
    const obligatoires = ['accord_principe', 'avis_imposition', 'justificatif_apport'];
    const manquants = obligatoires.filter(t => !typesPresents.has(t)).map(t => LABELS[t]);

    const resultat = {
      score: parsed.score ?? null,
      categorie: parsed.categorie || 'indetermine',
      synthese: parsed.synthese || '',
      points_forts: parsed.points_forts || [],
      points_attention: parsed.points_attention || [],
      documents_manquants: manquants,
      modele_utilise: 'qwen/qwen3.8-27b (Groq)',
    };

    await supabase.from('qualifications_acheteur').insert([{ acheteur_id, ...resultat }]);

    res.status(200).json(resultat);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
