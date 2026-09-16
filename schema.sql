-- db/schema.sql
-- À exécuter une seule fois dans Supabase : Project → SQL Editor → coller → Run

create extension if not exists "pgcrypto"; -- pour gen_random_uuid()

-- Table des annonces (biens mis en vente par les utilisateurs)
create table annonces (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),

  ville text not null,
  code_insee text,
  code_postal text,
  surface numeric not null,
  pieces integer,
  type_bien text default 'Maison',
  dpe text,
  jardin boolean default false,
  piscine boolean default false,
  garage boolean default false,
  terrasse boolean default false,
  etat text default 'Correct',

  prix_estime numeric,
  prix_souhaite numeric,
  description text,

  statut text default 'brouillon', -- brouillon | publiee | vendue

  contact_nom text,
  contact_email text not null,
  contact_telephone text
);

-- Table des leads (acheteurs intéressés par une annonce)
create table leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),

  annonce_id uuid references annonces(id) on delete cascade,
  nom text not null,
  email text not null,
  telephone text,
  message text,

  statut text default 'nouveau' -- nouveau | contacte | qualifie
);

create index idx_annonces_statut on annonces(statut);
create index idx_leads_annonce on leads(annonce_id);

-- Sécurité : Row Level Security activée sur les deux tables.
-- Les fonctions serverless utilisent la clé "service role", qui contourne
-- ces règles — RLS protège ici contre un accès direct via la clé publique
-- ("anon key") si jamais elle est utilisée plus tard côté front.
alter table annonces enable row level security;
alter table leads enable row level security;

create policy "Lecture publique des annonces publiées"
  on annonces for select
  using (statut = 'publiee');
