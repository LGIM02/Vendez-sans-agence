// api/search-prestataires.js
// GET /api/search-prestataires?ville=...&metier=diagnostiqueur+immobilier
// Header: Authorization: Bearer <access_token Supabase de l'utilisateur connecté>
//
// Cherche des prestataires locaux (diagnostiqueurs, etc.) via de vrais
// résultats Google, grâce à Serper.dev — gratuit jusqu'à 2 500 requêtes,
// sans carte bancaire, adapté à un POC.
//
// Nécessite la variable d'environnement SERPER_API_KEY sur Vercel
// (clé gratuite à créer sur serper.dev).

async function verifySupabaseUser(token) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: process.env.SUPABASE_ANON_KEY,
    },
  });
  return res.ok;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token || !(await verifySupabaseUser(token))) {
      res.status(401).json({ error: 'Non authentifié.' });
      return;
    }

    if (!process.env.SERPER_API_KEY) {
      res.status(500).json({ error: 'Clé API de recherche manquante côté serveur (SERPER_API_KEY).' });
      return;
    }

    const { ville, metier } = req.query;
    if (!ville) {
      res.status(400).json({ error: 'Paramètre "ville" requis.' });
      return;
    }

    const requete = `${metier || 'diagnostiqueur immobilier'} ${ville}`;

    const serperRes = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: requete, gl: 'fr', hl: 'fr', num: 6 }),
    });

    if (!serperRes.ok) {
      res.status(502).json({ error: 'Le service de recherche est indisponible.' });
      return;
    }

    const data = await serperRes.json();
    const resultats = (data.organic || []).slice(0, 6).map(r => ({
      titre: r.title,
      lien: r.link,
      extrait: r.snippet,
    }));

    res.status(200).json({ resultats, requete });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
