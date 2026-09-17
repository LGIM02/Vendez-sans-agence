// api/estimate.js
// Fonction serverless (Vercel) — GET /api/estimate?ville=...&surface=...&type=Maison
//
// Étapes :
//   1. Résout la ville / le code postal en code commune INSEE (API officielle geo.api.gouv.fr)
//   2. Interroge la base DVF (Demandes de Valeurs Foncières) pour les ventes réelles de cette commune
//   3. Ne garde que les comparables de surface proche du bien (± 40 %), si assez nombreux
//   4. Écarte les valeurs aberrantes par méthode IQR (interquartile), plus robuste qu'un simple seuil fixe
//   5. Calcule un prix médian au m² et une fourchette basée sur la dispersion réelle des comparables
//   6. Repli sur une moyenne nationale si aucune donnée fiable n'est trouvée
//
// Sources :
//   - geo.api.gouv.fr        → API officielle de La Poste / IGN, gratuite, sans clé
//   - api.cquest.org/dvf     → API communautaire non-officielle sur les données DVF (DGFiP / Etalab).
//                              ATTENTION : disponibilité non garantie par son auteur (à surveiller en prod,
//                              voir la note "Fiabilité" dans le README).

const NATIONAL_FALLBACK_PRICE_M2 = 2510; // Century 21, prix moyen maison France 2025
const NATIONAL_FALLBACK_DISPERSION = 0.07; // fourchette par défaut quand on n'a aucun comparable
const MIN_PRICE_M2 = 400;   // bornes de sécurité grossières, avant le filtrage statistique IQR
const MAX_PRICE_M2 = 20000;
const YEARS_LOOKBACK = 3;
const SURFACE_TOLERANCE = 0.4; // ± 40 % autour de la surface du bien pour choisir les comparables
const MIN_COMPARABLES_FOR_SURFACE_FILTER = 3;
const MIN_DISPERSION = 0.04; // bornes d'affichage : une fourchette trop étroite ou trop large n'aide pas l'utilisateur
const MAX_DISPERSION = 0.18;

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

function percentile(sortedValues, p) {
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedValues[lower];
  const weight = idx - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 50);
}

// Écarte les valeurs aberrantes avec la méthode de l'écart interquartile (IQR) :
// plus robuste qu'un simple seuil fixe, car elle s'adapte à la dispersion réelle
// des ventes de la commune plutôt que d'utiliser une borne identique partout.
function removeIqrOutliers(values) {
  if (values.length < 4) return values; // pas assez de points pour que l'IQR ait un sens
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const filtered = values.filter(v => v >= lowerBound && v <= upperBound);
  return filtered.length > 0 ? filtered : values;
}

// Extrait les prix au m² exploitables (ventes récentes, surface renseignée,
// bornes de sécurité grossières) sans encore filtrer par surface ni par IQR.
function extractComparables(sales) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - YEARS_LOOKBACK);

  const comparables = [];
  for (const sale of sales) {
    const valeur = parseFloat(sale.valeur_fonciere);
    const surfaceBati = parseFloat(sale.surface_reelle_bati);
    const dateStr = sale.date_mutation;
    if (!valeur || !surfaceBati || surfaceBati <= 0) continue;
    if (dateStr && new Date(dateStr) < cutoff) continue;

    const prixM2 = valeur / surfaceBati;
    if (prixM2 < MIN_PRICE_M2 || prixM2 > MAX_PRICE_M2) continue; // écarte les erreurs de saisie évidentes
    comparables.push({ prixM2, surfaceBati });
  }
  return comparables;
}

function computeStats(sales, targetSurface) {
  const comparables = extractComparables(sales);
  if (comparables.length === 0) return null;

  // Filtre par surface proche du bien, uniquement si ça laisse assez de comparables —
  // sinon, sur une petite commune, on se retrouverait avec 1 seule vente, pas plus fiable.
  let pool = comparables;
  let surfaceFiltree = false;
  if (targetSurface) {
    const low = targetSurface * (1 - SURFACE_TOLERANCE);
    const high = targetSurface * (1 + SURFACE_TOLERANCE);
    const filtered = comparables.filter(c => c.surfaceBati >= low && c.surfaceBati <= high);
    if (filtered.length >= MIN_COMPARABLES_FOR_SURFACE_FILTER) {
      pool = filtered;
      surfaceFiltree = true;
    }
  }

  let prices = pool.map(c => c.prixM2);
  prices = removeIqrOutliers(prices);
  if (prices.length === 0) return null;

  const sorted = [...prices].sort((a, b) => a - b);
  const p25 = percentile(sorted, 25);
  const p75 = percentile(sorted, 75);
  const med = median(prices);

  // Dispersion relative bornée : reflète la vraie variabilité des comparables,
  // sans donner une fourchette absurdement étroite (peu de ventes très proches)
  // ou absurdement large (ventes très hétérogènes) à l'utilisateur.
  const dispersionBrute = med > 0 ? (p75 - p25) / med / 2 : NATIONAL_FALLBACK_DISPERSION;
  const dispersion = Math.min(Math.max(dispersionBrute, MIN_DISPERSION), MAX_DISPERSION);

  return {
    nbTransactions: prices.length,
    prixM2Moyen: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    prixM2Median: Math.round(med),
    dispersion,
    surfaceFiltree,
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
    const targetSurface = parseFloat(surface) || null;

    const commune = await resolveCommune(String(ville));
    if (!commune) {
      res.status(200).json({
        source: 'fallback_national',
        prix_m2: NATIONAL_FALLBACK_PRICE_M2,
        dispersion: NATIONAL_FALLBACK_DISPERSION,
        nb_transactions: 0,
        fiabilite: 'faible',
        message: `Commune "${ville}" introuvable — estimation basée sur la moyenne nationale.`,
      });
      return;
    }

    let sales = await fetchDvfSales(commune.codeInsee, typeLocal);
    let stats = computeStats(sales, targetSurface);

    // Repli : si trop peu de ventes de maisons, on élargit aux appartements
    // pour au moins donner un ordre de grandeur local plutôt que rien.
    let typeUtilise = typeLocal;
    if ((!stats || stats.nbTransactions < 3) && typeLocal === 'Maison') {
      const salesAppart = await fetchDvfSales(commune.codeInsee, 'Appartement');
      const statsAppart = computeStats(salesAppart, targetSurface);
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
        dispersion: NATIONAL_FALLBACK_DISPERSION,
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
      dispersion: stats.dispersion,
      nb_transactions: stats.nbTransactions,
      surface_filtree: stats.surfaceFiltree,
      fiabilite: stats.nbTransactions >= 8 ? 'haute' : stats.nbTransactions >= 3 ? 'moyenne' : 'faible',
      periode: `${YEARS_LOOKBACK} dernières années`,
    });
  } catch (err) {
    res.status(200).json({
      source: 'fallback_national',
      prix_m2: NATIONAL_FALLBACK_PRICE_M2,
      dispersion: NATIONAL_FALLBACK_DISPERSION,
      nb_transactions: 0,
      fiabilite: 'faible',
      message: 'Service de données indisponible — estimation basée sur la moyenne nationale.',
    });
  }
};
