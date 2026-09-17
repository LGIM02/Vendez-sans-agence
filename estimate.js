// api/estimate.js
// Fonction serverless (Vercel) — GET /api/estimate?ville=...&adresse=...&surface=...&type=Maison
//
// Étapes :
//   1. Si une adresse précise est fournie, la géocode via la Base Adresse Nationale
//      (BAN) pour obtenir des coordonnées GPS exactes et la commune correspondante.
//      Sinon, résout juste la ville / le code postal en commune (moins précis).
//   2. Interroge la base DVF (Demandes de Valeurs Foncières) pour les ventes réelles
//      de cette commune.
//   3. Si on a des coordonnées précises, ne garde que les ventes proches géographiquement
//      (rayon progressif : 3 km, puis 6, puis 12, puis toute la commune si besoin).
//   4. Ne garde ensuite que les comparables de surface proche du bien (± 40 %), si assez nombreux.
//   5. Écarte les valeurs aberrantes par méthode IQR (interquartile).
//   6. Calcule un prix médian au m² et une fourchette basée sur la dispersion réelle des comparables.
//   7. Repli sur une moyenne nationale si aucune donnée fiable n'est trouvée.
//
// Sources :
//   - api-adresse.data.gouv.fr → Base Adresse Nationale (BAN), API officielle, gratuite, sans clé
//   - geo.api.gouv.fr          → API officielle de La Poste / IGN, gratuite, sans clé
//   - api.cquest.org/dvf       → API communautaire non-officielle sur les données DVF (DGFiP / Etalab).
//                                 ATTENTION : disponibilité non garantie par son auteur (voir README).

const NATIONAL_FALLBACK_PRICE_M2 = 2510; // Century 21, prix moyen maison France 2025
const NATIONAL_FALLBACK_DISPERSION = 0.07;
const MIN_PRICE_M2 = 400;
const MAX_PRICE_M2 = 20000;
const YEARS_LOOKBACK = 3;
const SURFACE_TOLERANCE = 0.4;
const MIN_COMPARABLES = 3; // seuil minimum pour qu'un filtrage (surface ou distance) soit jugé fiable
const MIN_DISPERSION = 0.04;
const MAX_DISPERSION = 0.18;
const RADII_KM = [3, 6, 12]; // rayons testés successivement autour de l'adresse précise
const BAN_MIN_SCORE = 0.4; // en dessous, le géocodage est trop incertain pour être utilisé

async function geocodeAdresse(query) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('ban_api_error');
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature || (feature.properties.score ?? 0) < BAN_MIN_SCORE) return null;

  return {
    lat: feature.geometry.coordinates[1],
    lon: feature.geometry.coordinates[0],
    codeInsee: feature.properties.citycode,
    nom: feature.properties.city,
  };
}

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

// Distance à vol d'oiseau entre deux points GPS, en kilomètres.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

function removeIqrOutliers(values) {
  if (values.length < 4) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const filtered = values.filter(v => v >= lowerBound && v <= upperBound);
  return filtered.length > 0 ? filtered : values;
}

// Extrait les comparables exploitables (ventes récentes, surface renseignée,
// bornes de sécurité grossières), avec leurs coordonnées GPS si disponibles.
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
    if (prixM2 < MIN_PRICE_M2 || prixM2 > MAX_PRICE_M2) continue;

    comparables.push({
      prixM2,
      surfaceBati,
      lat: parseFloat(sale.lat),
      lon: parseFloat(sale.lon),
    });
  }
  return comparables;
}

function computeStats(sales, targetSurface, targetCoords) {
  const comparables = extractComparables(sales);
  if (comparables.length === 0) return null;

  // 1. Filtrage géographique par rayon progressif, si on a une adresse géocodée.
  let pool = comparables;
  let rayonUtilise = null;
  if (targetCoords) {
    const withCoords = comparables.filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));
    for (const rayon of RADII_KM) {
      const within = withCoords.filter(
        c => haversineKm(targetCoords.lat, targetCoords.lon, c.lat, c.lon) <= rayon
      );
      if (within.length >= MIN_COMPARABLES) {
        pool = within;
        rayonUtilise = rayon;
        break;
      }
    }
    // Aucun rayon testé n'a suffi : on garde toute la commune plutôt que de
    // se fier à une poignée de ventes trop dispersées géographiquement.
  }

  // 2. Filtrage par surface proche du bien, sur le pool déjà réduit géographiquement.
  let surfaceFiltree = false;
  if (targetSurface) {
    const low = targetSurface * (1 - SURFACE_TOLERANCE);
    const high = targetSurface * (1 + SURFACE_TOLERANCE);
    const filtered = pool.filter(c => c.surfaceBati >= low && c.surfaceBati <= high);
    if (filtered.length >= MIN_COMPARABLES) {
      pool = filtered;
      surfaceFiltree = true;
    }
  }

  // 3. Écarte les valeurs aberrantes (méthode IQR).
  let prices = pool.map(c => c.prixM2);
  prices = removeIqrOutliers(prices);
  if (prices.length === 0) return null;

  const sorted = [...prices].sort((a, b) => a - b);
  const p25 = percentile(sorted, 25);
  const p75 = percentile(sorted, 75);
  const med = median(prices);

  const dispersionBrute = med > 0 ? (p75 - p25) / med / 2 : NATIONAL_FALLBACK_DISPERSION;
  const dispersion = Math.min(Math.max(dispersionBrute, MIN_DISPERSION), MAX_DISPERSION);

  return {
    nbTransactions: prices.length,
    prixM2Moyen: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    prixM2Median: Math.round(med),
    dispersion,
    surfaceFiltree,
    rayonUtilise, // null = pas de filtrage géographique (pas d'adresse précise, ou pas assez de comparables proches)
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { ville, adresse, surface, type } = req.query;
    if (!ville && !adresse) {
      res.status(400).json({ error: 'Paramètre "ville" ou "adresse" requis.' });
      return;
    }
    const typeLocal = type === 'Appartement' ? 'Appartement' : 'Maison';
    const targetSurface = parseFloat(surface) || null;

    // Priorité à l'adresse précise (géocodage BAN) si elle est fournie et exploitable.
    let commune = null;
    let targetCoords = null;
    if (adresse) {
      const geocoded = await geocodeAdresse(String(adresse));
      if (geocoded) {
        commune = { codeInsee: geocoded.codeInsee, nom: geocoded.nom };
        targetCoords = { lat: geocoded.lat, lon: geocoded.lon };
      }
    }
    if (!commune && ville) {
      commune = await resolveCommune(String(ville));
    }

    if (!commune) {
      res.status(200).json({
        source: 'fallback_national',
        prix_m2: NATIONAL_FALLBACK_PRICE_M2,
        dispersion: NATIONAL_FALLBACK_DISPERSION,
        nb_transactions: 0,
        fiabilite: 'faible',
        message: `Adresse ou commune "${adresse || ville}" introuvable — estimation basée sur la moyenne nationale.`,
      });
      return;
    }

    let sales = await fetchDvfSales(commune.codeInsee, typeLocal);
    let stats = computeStats(sales, targetSurface, targetCoords);

    let typeUtilise = typeLocal;
    if ((!stats || stats.nbTransactions < 3) && typeLocal === 'Maison') {
      const salesAppart = await fetchDvfSales(commune.codeInsee, 'Appartement');
      const statsAppart = computeStats(salesAppart, targetSurface, targetCoords);
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
        message: 'Pas assez de ventes DVF exploitables pour cette zone — moyenne nationale utilisée.',
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
      rayon_km: stats.rayonUtilise, // null = estimation à l'échelle de la commune entière
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
