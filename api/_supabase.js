// api/_supabase.js
// Client Supabase partagé par les fonctions serverless.
// Utilise la clé "service role" : elle a tous les droits sur la base et ne
// doit JAMAIS être exposée côté front-end — elle reste uniquement dans les
// variables d'environnement du serveur (Vercel).

const { createClient } = require('@supabase/supabase-js');

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Variables d'environnement manquantes : SUPABASE_URL et/ou SUPABASE_SERVICE_ROLE_KEY. " +
      'Voir le README pour la configuration sur Vercel.'
    );
  }

  return createClient(url, key);
}

module.exports = { getSupabaseClient };
