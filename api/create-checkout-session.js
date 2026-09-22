// api/create-checkout-session.js
// POST /api/create-checkout-session   Body: { annonce_id }
// Header: Authorization: Bearer <access_token Supabase du vendeur>
//
// Crée une session de paiement Stripe Checkout (page hébergée par Stripe —
// aucune donnée de carte bancaire ne transite par nos serveurs) pour le
// forfait Clef. Le paiement n'est confirmé que via le webhook Stripe
// (api/stripe-webhook.mjs), jamais directement depuis cette fonction —
// Stripe est la seule source de vérité sur le fait qu'un paiement a
// réellement abouti.
//
// Nécessite STRIPE_SECRET_KEY sur Vercel (clé "Secret key" du Dashboard
// Stripe, en mode test pour commencer — elle commence par sk_test_...).

const Stripe = require('stripe');
const { getSupabaseClient } = require('./_supabase');

const FORFAIT_EUR = 390;

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non supportée.' });
    return;
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      res.status(500).json({ error: 'Clé Stripe manquante côté serveur (STRIPE_SECRET_KEY).' });
      return;
    }
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    const user = token ? await verifySupabaseUser(token) : null;
    if (!user) {
      res.status(401).json({ error: 'Non authentifié.' });
      return;
    }

    const { annonce_id } = req.body || {};
    if (!annonce_id) {
      res.status(400).json({ error: 'Paramètre "annonce_id" requis.' });
      return;
    }

    const supabase = getSupabaseClient();

    // Vérifie que l'annonce appartient bien au vendeur authentifié.
    const { data: annonce, error: annonceError } = await supabase
      .from('annonces').select('id, user_id, ville').eq('id', annonce_id).single();

    if (annonceError || !annonce || annonce.user_id !== user.id) {
      res.status(403).json({ error: 'Accès refusé à cette annonce.' });
      return;
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Forfait Clef — Vente accompagnée',
            description: annonce.ville ? `Bien à ${annonce.ville}` : undefined,
          },
          unit_amount: FORFAIT_EUR * 100, // Stripe attend des centimes
        },
        quantity: 1,
      }],
      metadata: { annonce_id, user_id: user.id },
      success_url: `${origin}/dashboard.html?paiement=succes`,
      cancel_url: `${origin}/dashboard.html?paiement=annule`,
    });

    // Trace la tentative de paiement — le statut ne passera à "paye" que
    // lorsque le webhook confirmera l'événement Stripe correspondant.
    await supabase.from('paiements').insert([{
      annonce_id,
      montant: FORFAIT_EUR,
      statut: 'en_attente',
      stripe_session_id: session.id,
    }]);

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
  }
};
