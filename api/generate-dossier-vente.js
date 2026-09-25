// api/generate-dossier-vente.js
// GET /api/generate-dossier-vente?annonce_id=...
// Header: Authorization: Bearer <access_token Supabase du vendeur>
//
// Génère un PDF récapitulatif de la vente (adresse, prix final, acheteur
// retenu, état des diagnostics) — utile au vendeur pour transmettre un
// dossier propre à son notaire. C'est un simple compte-rendu factuel, pas
// un contrat : aucun texte à valeur juridique n'est rédigé ici.
//
// ⚠️ VERROU DE PAIEMENT : ce document n'est généré QUE si un paiement au
// statut "paye" existe pour cette annonce. C'est le mécanisme qui rend le
// paiement effectivement nécessaire (plutôt que facultatif) — sans lui,
// rien n'empêchait un vendeur d'utiliser tout le service gratuitement.

const PDFDocument = require('pdfkit');
const { getSupabaseClient } = require('./_supabase');

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

const DIAGNOSTIC_LABELS = {
  dpe: 'DPE', amiante: 'Amiante', plomb_crep: 'Plomb (CREP)', termites: 'Termites',
  gaz: 'Installation gaz', electricite: 'Installation électrique',
  erp: 'État des risques et pollutions', assainissement: 'Assainissement non collectif',
  carrez: 'Métrage Carrez',
};
const DIAGNOSTIC_STATUT_LABELS = {
  realise: 'Réalisé', non_concerne: 'Non concerné', planifie: 'Planifié', a_faire: 'À faire',
};

function buildPdf({ annonce, offreAcceptee, acheteur, diagnostics }){
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(20).text('Dossier de vente', { align: 'left' });
    doc.fontSize(10).fillColor('#666').text('Document récapitulatif généré par Clef — à transmettre à votre notaire', { align: 'left' });
    doc.moveDown(1.5);

    doc.fontSize(13).fillColor('#000').text('Bien concerné');
    doc.fontSize(10).fillColor('#333');
    doc.text(`Ville : ${annonce.ville || '—'}${annonce.code_postal ? ' (' + annonce.code_postal + ')' : ''}`);
    if (annonce.surface) doc.text(`Surface habitable : ${annonce.surface} m²`);
    if (annonce.pieces) doc.text(`Nombre de pièces : ${annonce.pieces}`);
    if (annonce.dpe) doc.text(`DPE : ${annonce.dpe}`);
    doc.moveDown(1);

    doc.fontSize(13).fillColor('#000').text('Prix de vente retenu');
    doc.fontSize(10).fillColor('#333');
    doc.text(offreAcceptee ? `${Number(offreAcceptee.montant).toLocaleString('fr-FR')} €` : 'Non renseigné');
    doc.moveDown(1);

    doc.fontSize(13).fillColor('#000').text('Acheteur');
    doc.fontSize(10).fillColor('#333');
    if (acheteur) {
      doc.text(`${acheteur.nom}`);
      doc.text(`${acheteur.email}${acheteur.telephone ? ' · ' + acheteur.telephone : ''}`);
    } else {
      doc.text('Non renseigné');
    }
    doc.moveDown(1);

    doc.fontSize(13).fillColor('#000').text('État des diagnostics');
    doc.fontSize(10).fillColor('#333');
    const byType = Object.fromEntries((diagnostics || []).map(d => [d.type, d]));
    Object.entries(DIAGNOSTIC_LABELS).forEach(([type, label]) => {
      const d = byType[type];
      const statut = d ? (DIAGNOSTIC_STATUT_LABELS[d.statut] || d.statut) : 'Non renseigné';
      const date = d?.date_realisation ? ` (${new Date(d.date_realisation).toLocaleDateString('fr-FR')})` : '';
      doc.text(`${label} : ${statut}${date}`);
    });

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#999').text(
      `Généré le ${new Date().toLocaleDateString('fr-FR')} — document informatif compilé automatiquement, sans valeur contractuelle. Le compromis de vente reste à établir par votre notaire.`
    );

    doc.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
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

    const { annonce_id } = req.query;
    if (!annonce_id) {
      res.status(400).json({ error: 'Paramètre "annonce_id" requis.' });
      return;
    }

    const supabase = getSupabaseClient();

    const { data: annonce, error: annonceError } = await supabase
      .from('annonces').select('*').eq('id', annonce_id).single();
    if (annonceError || !annonce || annonce.user_id !== user.id) {
      res.status(403).json({ error: 'Accès refusé à cette annonce.' });
      return;
    }

    // ---------- Le verrou de paiement ----------
    const { data: paiements } = await supabase
      .from('paiements').select('*').eq('annonce_id', annonce_id).eq('statut', 'paye').limit(1);

    if (!paiements || paiements.length === 0) {
      res.status(402).json({
        error: 'Le dossier de vente est disponible après le paiement du forfait Clef.',
        code: 'PAIEMENT_REQUIS',
      });
      return;
    }

    // Récupère l'offre acceptée (s'il y en a une) et l'acheteur correspondant.
    const { data: acheteurs } = await supabase
      .from('acheteurs').select('*').eq('annonce_id', annonce_id);
    const acheteurIds = (acheteurs || []).map(a => a.id);

    let offreAcceptee = null;
    let acheteur = null;
    if (acheteurIds.length > 0) {
      const { data: offres } = await supabase
        .from('offres').select('*').in('acheteur_id', acheteurIds).eq('statut', 'acceptee')
        .order('created_at', { ascending: false }).limit(1);
      if (offres && offres.length > 0) {
        offreAcceptee = offres[0];
        acheteur = (acheteurs || []).find(a => a.id === offreAcceptee.acheteur_id) || null;
      }
    }

    const { data: diagnostics } = await supabase
      .from('diagnostics').select('*').eq('annonce_id', annonce_id);

    const pdfBuffer = await buildPdf({ annonce, offreAcceptee, acheteur, diagnostics });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dossier-vente-${annonce.ville || 'bien'}.pdf"`);
    res.status(200).end(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur serveur.' });
  }
};
