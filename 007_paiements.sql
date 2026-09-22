-- db/007_paiements.sql
-- À exécuter dans Supabase → SQL Editor → Run.

create table paiements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  annonce_id uuid references annonces(id) on delete cascade not null,

  montant numeric not null,
  statut text default 'en_attente' check (statut in ('en_attente', 'paye', 'echoue', 'annule')),

  stripe_session_id text,
  stripe_payment_intent_id text,
  paid_at timestamptz
);

create index idx_paiements_annonce on paiements(annonce_id);
create index idx_paiements_session on paiements(stripe_session_id);

alter table paiements enable row level security;

-- Lecture seule pour l'utilisateur : il voit le statut de ses paiements,
-- mais ne peut ni les créer, ni les modifier depuis le navigateur. Toute
-- écriture passe exclusivement par les fonctions serverless (clé
-- service_role, qui contourne RLS) — c'est ce qui empêche quiconque de se
-- marquer "payé" en modifiant une requête depuis la console du navigateur.
create policy "Un utilisateur voit les paiements de ses annonces"
  on paiements for select
  using (annonce_id in (select id from annonces where user_id = auth.uid()));
