// api/leads.js
// POST /api/leads → enregistre un acheteur intéressé par une annonce
// (formulaire "je suis intéressé par ce bien" côté front, à construire plus tard)

const { getSupabaseClient } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }

  try {
    const supabase = getSupabaseClient();
    const body = req.body || {};
    const { annonce_id, nom, email } = body;

    if (!annonce_id || !nom || !email) {
      res.status(400).json({ error: 'Champs requis manquants : annonce_id, nom, email.' });
      return;
    }

    const { data, error } = await supabase
      .from('leads')
      .insert([{
        annonce_id,
        nom,
        email,
        telephone: body.telephone || null,
        message: body.message || null,
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ lead: data });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
  }
};
