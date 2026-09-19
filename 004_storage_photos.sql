-- db/004_storage_photos.sql
-- À exécuter dans Supabase → SQL Editor → Run.
--
-- Crée un bucket de stockage public pour les photos d'annonces (lecture
-- publique — nécessaire puisque les acheteurs doivent pouvoir les voir —
-- mais écriture restreinte : chaque utilisateur ne peut déposer/supprimer
-- que ses propres fichiers.
--
-- Convention de chemin : {user_id}/{annonce_id}/{nom-de-fichier}
-- Le premier segment du chemin (l'ID utilisateur) sert de base aux policies.

insert into storage.buckets (id, name, public)
values ('annonce-photos', 'annonce-photos', true)
on conflict (id) do nothing;

create policy "Lecture publique des photos d'annonces"
  on storage.objects for select
  using (bucket_id = 'annonce-photos');

create policy "Un utilisateur dépose ses propres photos"
  on storage.objects for insert
  with check (
    bucket_id = 'annonce-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Un utilisateur supprime ses propres photos"
  on storage.objects for delete
  using (
    bucket_id = 'annonce-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
