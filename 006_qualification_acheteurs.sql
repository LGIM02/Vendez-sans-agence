-- db/006_qualification_acheteurs.sql
-- À exécuter dans Supabase → SQL Editor → Run.

-- ============================================================
-- Documents déposés pour un acheteur (par le vendeur, en son nom)
-- ============================================================
create table acheteur_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  acheteur_id uuid references acheteurs(id) on delete cascade not null,

  categorie text not null check (categorie in ('obligatoire', 'facultatif', 'libre')),
  type text check (type in (
    'accord_principe', 'avis_imposition', 'justificatif_apport',
    'bulletins_salaire', 'attestation_employeur', 'piece_identite', 'libre'
  )),
  nom_libre text, -- libellé choisi par le vendeur, uniquement pour la catégorie "libre"

  fichier_url text not null, -- chemin dans le bucket privé "acheteur-documents"
  mime_type text
);

create index idx_acheteur_documents_acheteur on acheteur_documents(acheteur_id);

alter table acheteur_documents enable row level security;
create policy "Un utilisateur gère les documents de ses acheteurs"
  on acheteur_documents for all
  using (acheteur_id in (
    select a.id from acheteurs a
    join annonces an on an.id = a.annonce_id
    where an.user_id = auth.uid()
  ))
  with check (acheteur_id in (
    select a.id from acheteurs a
    join annonces an on an.id = a.annonce_id
    where an.user_id = auth.uid()
  ));


-- ============================================================
-- Résultats d'analyse IA (historisés — une ligne par analyse lancée)
-- ============================================================
create table qualifications_acheteur (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  acheteur_id uuid references acheteurs(id) on delete cascade not null,

  score integer, -- indicatif, 0 à 100
  categorie text check (categorie in ('solide', 'a_approfondir', 'fragile', 'indetermine')),
  synthese text,
  points_forts jsonb default '[]',
  points_attention jsonb default '[]',
  documents_manquants jsonb default '[]',
  modele_utilise text
);

create index idx_qualifications_acheteur on qualifications_acheteur(acheteur_id);

alter table qualifications_acheteur enable row level security;
create policy "Un utilisateur voit les qualifications de ses acheteurs"
  on qualifications_acheteur for all
  using (acheteur_id in (
    select a.id from acheteurs a
    join annonces an on an.id = a.annonce_id
    where an.user_id = auth.uid()
  ))
  with check (acheteur_id in (
    select a.id from acheteurs a
    join annonces an on an.id = a.annonce_id
    where an.user_id = auth.uid()
  ));


-- ============================================================
-- Stockage privé des documents acheteurs
-- ============================================================
-- Données financières sensibles de tiers : jamais public, accès strictement
-- réservé au vendeur propriétaire de l'annonce concernée.
insert into storage.buckets (id, name, public)
values ('acheteur-documents', 'acheteur-documents', false)
on conflict (id) do nothing;

create policy "Un utilisateur dépose les documents de ses acheteurs"
  on storage.objects for insert
  with check (
    bucket_id = 'acheteur-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Un utilisateur lit les documents de ses acheteurs"
  on storage.objects for select
  using (
    bucket_id = 'acheteur-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Un utilisateur supprime les documents de ses acheteurs"
  on storage.objects for delete
  using (
    bucket_id = 'acheteur-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
