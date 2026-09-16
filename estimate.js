// api/estimate.js
// Fonction serverless (Vercel) — GET /api/estimate?ville=...&surface=...&type=Maison
//
// Étapes :
//   1. Résout la ville / le code postal en code commune INSEE (API officielle geo.api.gouv.fr)
//   2. Interroge la base DVF (Demandes de Valeurs Foncières) pour les ventes réelles de cette commune
//   3. Calcule un prix moyen et médian au m² à partir des comparables
//   4. Repli sur une moyenne nationale si aucune donnée fiable n'est trouvée
//
// Sources :
//   - geo.api.gouv.fr        → API officielle de La Poste / IGN, gratuite, sans clé
//   - api.cquest.org/dvf     → API communautaire non-officielle sur les données DVF (DGFiP / Etalab).
//                              ATTENTION : disponibilité non garantie par son auteur (à surveiller en prod,
//                              voir la note "Fiabilité" dans le README).

const NATIONAL_FALLBACK_PRICE_M2 = 2510; // Century 21, prix moyen maison France 2025
const MIN_PRICE_M2 = 400;   // bornes de sécurité pour écarter les lignes DVF aberrantes
const MAX_PRICE_M2 = 20000;
const YEARS_LOOKBACK = 3;

async function resolveCommune(query) {
  const isPostalCode = /^\d{5}$/.test(query.trim());
  const url = isPostalCode
    ? `https://geo.api.gouv.fr/communes?codePostal=${encodeURIComponent(query.trim())}&fields=code,nom,codesPostaux&limit=1`
    : `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(query.trim())}&fields=code,nom,codesPostaux&boost=population&limit=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('geo_api_error');
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return { codeInsee: data[0].code, nom: data[0].nom };
}

async function fetchDvfSales(codeInsee, typeLocal) {
  const url = `http://api.cquest.org/dvf?code_commune=${encodeURIComponent(codeInsee)}&nature_mutation=Vente&type_local=${encodeURIComponent(typeLocal)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('dvf_api_error');
  const data = await res.json();
  return Array.isArray(data.resultats) ? data.resultats : [];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeStats(sales) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - YEARS_LOOKBACK);

  const pricesM2 = [];
  for (const sale of sales) {
    const valeur = parseFloat(sale.valeur_fonciere);
    const surface = parseFloat(sale.surface_reelle_bati);
    const dateStr = sale.date_mutation;
    if (!valeur || !surface || surface <= 0) continue;
    if (dateStr && new Date(dateStr) < cutoff) continue;

    const prixM2 = valeur / surface;
    if (prixM2 < MIN_PRICE_M2 || prixM2 > MAX_PRICE_M2) continue; // écarte les lignes aberrantes (donation, lot multiple, saisie erronée...)
    pricesM2.push(prixM2);
  }

  if (pricesM2.length === 0) return null;

  return {
    nbTransactions: pricesM2.length,
    prixM2Moyen: Math.round(pricesM2.reduce((a, b) => a + b, 0) / pricesM2.length),
    prixM2Median: Math.round(median(pricesM2)),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { ville, surface, type } = req.query;
    if (!ville) {
      res.status(400).json({ error: 'Paramètre "ville" (nom ou code postal) requis.' });
      return;
    }
    const typeLocal = type === 'Appartement' ? 'Appartement' : 'Maison';

    const commune = await resolveCommune(String(ville));
    if (!commune) {
      res.status(200).json({
        source: 'fallback_national',
        prix_m2: NATIONAL_FALLBACK_PRICE_M2,
        nb_transactions: 0,
        fiabilite: 'faible',
        message: `Commune "${ville}" introuvable — estimation basée sur la moyenne nationale.`,
      });
      return;
    }

    let sales = await fetchDvfSales(commune.codeInsee, typeLocal);
    let stats = computeStats(sales);

    // Repli : si trop peu de ventes de maisons, on élargit aux appartements
    // pour au moins donner un ordre de grandeur local plutôt que rien.
    let typeUtilise = typeLocal;
    if ((!stats || stats.nbTransactions < 3) && typeLocal === 'Maison') {
      const salesAppart = await fetchDvfSales(commune.codeInsee, 'Appartement');
      const statsAppart = computeStats(salesAppart);
      if (statsAppart && (!stats || statsAppart.nbTransactions > stats.nbTransactions)) {
        stats = statsAppart;
        typeUtilise = 'Appartement (peu de ventes de maisons disponibles)';
      }
    }

    if (!stats) {
      res.status(200).json({
        source: 'fallback_national',
        commune: commune.nom,
        code_insee: commune.codeInsee,
        prix_m2: NATIONAL_FALLBACK_PRICE_M2,
        nb_transactions: 0,
        fiabilite: 'faible',
        message: 'Pas assez de ventes DVF exploitables pour cette commune — moyenne nationale utilisée.',
      });
      return;
    }

    res.status(200).json({
      source: 'dvf',
      commune: commune.nom,
      code_insee: commune.codeInsee,
      type_bien_utilise: typeUtilise,
      prix_m2: stats.prixM2Median,
      prix_m2_moyen: stats.prixM2Moyen,
      nb_transactions: stats.nbTransactions,
      fiabilite: stats.nbTransactions >= 8 ? 'haute' : stats.nbTransactions >= 3 ? 'moyenne' : 'faible',
      periode: `${YEARS_LOOKBACK} dernières années`,
    });
  } catch (err) {
    res.status(200).json({
      source: 'fallback_national',
      prix_m2: NATIONAL_FALLBACK_PRICE_M2,
      nb_transactions: 0,
      fiabilite: 'faible',
      message: 'Service de données indisponible — estimation basée sur la moyenne nationale.',
    });
  }
};
