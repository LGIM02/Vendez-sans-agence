// api/analyze-acheteur.js
// POST /api/analyze-acheteur   Body: { acheteur_id }
// Header: Authorization: Bearer <access_token Supabase du vendeur>
//
// Lit les documents déposés pour un acheteur et produit une synthèse
// indicative :
//   - PDF avec un texte réel (la majorité des documents officiels
//     générés numériquement — avis d'imposition, accords de principe) :
//     extraction du texte via pdf-parse, pas de rendu image nécessaire.
//     Plus fiable qu'une lecture visuelle : aucun risque de mal lire
//     un chiffre.
//   - Images (JPEG/PNG, ex. photo d'un bulletin de salaire papier) :
//     lues directement par un modèle multimodal (Groq, qwen/qwen3.8-27b).
//   - PDF scanné sans texte réel (un document papier passé au scanner) :
//     non exploitable pour l'instant — signalé dans "points_attention"
//     plutôt que deviné. Une vraie OCR serait nécessaire pour ce cas,
//     plus lourde à mettre en place.
//
// ⚠️ CE SCORE N'EST PAS UNE DÉCISION. Conformément à l'article 22 du RGPD
// sur les décisions individuelles automatisées, ce résultat doit toujours
// être présenté comme une aide à la lecture à vérifier par le vendeur,
// jamais comme un verdict. Le front-end doit afficher cet avertissement
// de façon visible à chaque affichage du résultat.
 
const { createClient } = require('@supabase/supabase-js');
// Import direct du module interne : le point d'entrée standard de pdf-parse
// contient un code de "mode debug" qui tente de lire un fichier de test au
// chargement et plante en environnement serverless (fichier absent). Ce
// chemin d'import l'évite complètement.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
 
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
  accord_principe: 'Accord de principe bancaire',
  avis_imposition: "Avis d'imposition",
  justificatif_apport: 'Justificatif d\'apport personnel',
  bulletins_salaire: 'Bulletin de salaire',
  attestation_employeur: 'Attestation employeur',
  piece_identite: "Pièce d'identité",
  libre: 'Document libre',
};
 
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const MIN_TEXT_LENGTH = 40; // en dessous, on considère le PDF comme un scan sans texte exploitable
 
function docLabel(doc){
  return doc.categorie === 'libre' && doc.nom_libre ? doc.nom_libre : (LABELS[doc.type] || 'Document');
}
 
function buildPrompt(textBlocksLabels, imageBlocksLabels){
  const toutesLesPieces = [...textBlocksLabels, ...imageBlocksLabels];
  return `Tu es un assistant qui aide un particulier (vendeur d'un bien immobilier, sans agence) à relire les documents financiers qu'un acheteur potentiel lui a transmis.
 
Documents fournis :
${toutesLesPieces.map((l, i) => `${i + 1}. ${l}`).join('\n')}
${textBlocksLabels.length ? `\nLe texte extrait de chaque document PDF est donné ci-dessous, précédé de son nom. ` : ''}${imageBlocksLabels.length ? `Les documents restants sont fournis sous forme d'image, dans le même ordre que listés ci-dessus après les textes.` : ''}
 
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
 
    const { data: allDocuments } = await supabase
      .from('acheteur_documents')
      .select('*')
      .eq('acheteur_id', acheteur_id);
 
    const documents = allDocuments || [];
    if (documents.length === 0) {
      res.status(200).json({
        score: null,
        categorie: 'indetermine',
        synthese: 'Aucun document déposé pour cet acheteur.',
        points_forts: [],
        points_attention: [],
        documents_manquants: [],
      });
      return;
    }
 
    // Répartit les documents entre "PDF à texte extractible" et "images",
    // et repère ceux qu'on ne peut pas exploiter (PDF scannés sans texte).
    const textBlocks = [];    // { label, texte }
    const imageBlocks = [];   // { label, contentBlock }
    const nonExploitables = [];
 
    for (const doc of documents.slice(0, 8)) { // plafond raisonnable par analyse
      const lowerUrl = doc.fichier_url.toLowerCase();
      const { data: fileBlob, error: dlError } = await supabase.storage
        .from('acheteur-documents')
        .download(doc.fichier_url);
 
      if (dlError || !fileBlob) {
        nonExploitables.push(`${docLabel(doc)} (fichier introuvable dans le stockage)`);
        continue;
      }
      const buffer = Buffer.from(await fileBlob.arrayBuffer());
 
      if (lowerUrl.endsWith('.pdf')) {
        try {
          const parsed = await pdfParse(buffer);
          const texte = (parsed.text || '').trim();
          if (texte.length >= MIN_TEXT_LENGTH) {
            textBlocks.push({ label: docLabel(doc), texte: texte.slice(0, 6000) }); // borne la taille envoyée au modèle
          } else {
            nonExploitables.push(`${docLabel(doc)} (PDF scanné sans texte détectable — non lisible automatiquement pour l'instant)`);
          }
        } catch (e) {
          nonExploitables.push(`${docLabel(doc)} (erreur de lecture du PDF)`);
        }
      } else if (IMAGE_EXTENSIONS.some(ext => lowerUrl.endsWith(ext))) {
        imageBlocks.push({
          label: docLabel(doc),
          contentBlock: {
            type: 'image_url',
            image_url: { url: `data:${doc.mime_type || 'image/jpeg'};base64,${buffer.toString('base64')}` },
          },
        });
      } else {
        nonExploitables.push(`${docLabel(doc)} (format non pris en charge)`);
      }
    }
 
    if (textBlocks.length === 0 && imageBlocks.length === 0) {
      res.status(200).json({
        score: null,
        categorie: 'indetermine',
        synthese: "Aucun document n'a pu être lu automatiquement.",
        points_forts: [],
        points_attention: nonExploitables.length ? nonExploitables : ['Aucun document exploitable.'],
        documents_manquants: [],
      });
      return;
    }
 
    const textLabels = textBlocks.map(b => b.label);
    const imageLabels = imageBlocks.map(b => b.label);
    const promptText = buildPrompt(textLabels, imageLabels)
      + (textBlocks.length ? '\n\n' + textBlocks.map(b => `--- ${b.label} ---\n${b.texte}`).join('\n\n') : '');
 
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: promptText }, ...imageBlocks.map(b => b.contentBlock)],
    }];
 
    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.8-27b',
        max_tokens: 900,
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
    const typesPresents = new Set(documents.map(d => d.type));
    const obligatoires = ['accord_principe', 'avis_imposition', 'justificatif_apport'];
    const manquants = obligatoires.filter(t => !typesPresents.has(t)).map(t => LABELS[t]);
 
    const resultat = {
      score: parsed.score ?? null,
      categorie: parsed.categorie || 'indetermine',
      synthese: parsed.synthese || '',
      points_forts: parsed.points_forts || [],
      points_attention: [...(parsed.points_attention || []), ...nonExploitables],
      documents_manquants: manquants,
      modele_utilise: 'qwen/qwen3.8-27b (Groq) + extraction de texte PDF',
    };
 
    await supabase.from('qualifications_acheteur').insert([{ acheteur_id, ...resultat }]);
 
    res.status(200).json(resultat);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
 