// api/annonces.js
// GET  /api/annonces        → liste des annonces publiées
// POST /api/annonces        → crée une nouvelle annonce (statut "brouillon")
//
// Une annonce naît en "brouillon" (le vendeur n'a pas encore validé la mise
// en ligne) — un futur endpoint /api/annonces/:id pourra la faire passer à
// "publiee". Pas nécessaire pour ce premier jet.

const { getSupabaseClient } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const supabase = getSupabaseClient();

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('annonces')
        .select('*')
        .eq('statut', 'publiee')
        .order('created_at', { ascending: false });

      if (error) throw error;
      res.status(200).json({ annonces: data });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { ville, surface, contact_email } = body;

      if (!ville || !surface || !contact_email) {
        res.status(400).json({ error: 'Champs requis manquants : ville, surface, contact_email.' });
        return;
      }

      const { data, error } = await supabase
        .from('annonces')
        .insert([{
          ville: body.ville,
          code_insee: body.code_insee || null,
          code_postal: body.code_postal || null,
          surface: body.surface,
          pieces: body.pieces || null,
          type_bien: body.type_bien || 'Maison',
          dpe: body.dpe || null,
          jardin: !!body.jardin,
          piscine: !!body.piscine,
          garage: !!body.garage,
          terrasse: !!body.terrasse,
          etat: body.etat || 'Correct',
          prix_estime: body.prix_estime || null,
          prix_souhaite: body.prix_souhaite || null,
          description: body.description || null,
          statut: 'brouillon',
          contact_nom: body.contact_nom || null,
          contact_email: body.contact_email,
          contact_telephone: body.contact_telephone || null,
        }])
        .select()
        .single();

      if (error) throw error;
      res.status(201).json({ annonce: data });
      return;
    }

    res.status(405).json({ error: 'Méthode non supportée.' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
  }
};
