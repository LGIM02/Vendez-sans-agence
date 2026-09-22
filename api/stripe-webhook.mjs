// api/stripe-webhook.mjs
//
// ⚠️ Ce fichier utilise la syntaxe moderne (ESM, extension .mjs), contrairement
// aux autres fonctions de ce projet qui utilisent l'ancienne syntaxe
// (module.exports). Raison : Stripe exige le corps BRUT (non modifié) de la
// requête pour vérifier sa signature — la méthode actuellement documentée par
// Vercel pour y accéder est cette syntaxe avec request.text(). Ne renomme pas
// ce fichier en .js, et ne le convertis pas vers l'ancienne syntaxe : la
// vérification de signature échouerait silencieusement.
//
// Stripe appelle cette URL directement (jamais le navigateur) dès qu'un
// paiement Checkout se termine — c'est la SEULE façon dont un paiement passe
// au statut "payé" dans notre base : le navigateur ne peut jamais l'écrire
// lui-même (voir les policies RLS de la table "paiements").
//
// Configuration nécessaire sur Vercel : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// (obtenue en configurant l'endpoint dans le Dashboard Stripe — voir le README).

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export async function POST(request) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Configuration Stripe manquante côté serveur.', { status: 500 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Signature Stripe invalide : ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    await supabase
      .from('paiements')
      .update({
        statut: 'paye',
        stripe_payment_intent_id: session.payment_intent,
        paid_at: new Date().toISOString(),
      })
      .eq('stripe_session_id', session.id);
  }

  return Response.json({ received: true });
}
