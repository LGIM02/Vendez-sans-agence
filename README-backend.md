# Backend — estimation DVF + base de données (annonces & leads)

## Architecture d'ensemble

```
ton-repo/
├── vendez-sans-agence.html   (front-end)
├── package.json
├── api/
│   ├── estimate.js           → GET  /api/estimate    (prix au m² réel, données DVF)
│   ├── annonces.js           → GET/POST /api/annonces (créer / lister des biens à vendre)
│   ├── leads.js              → POST /api/leads       (un acheteur se dit intéressé)
│   └── _supabase.js          → client Supabase partagé (pas un endpoint)
└── db/
    └── schema.sql            → à exécuter une fois dans Supabase
```

Deux services, aucun serveur à gérer :

- **Vercel** héberge le site et les fonctions serverless (le code de `api/`)
- **Supabase** héberge la base de données PostgreSQL (les annonces, les leads)

Vercel et Supabase ont chacun un plan gratuit largement suffisant pour un
prototype ou un lancement en petit volume.

## Pourquoi Supabase pour la base de données

- Une vraie base PostgreSQL managée (pas de serveur à administrer)
- Un client JavaScript simple (`@supabase/supabase-js`) qui s'utilise
  directement dans les fonctions serverless
- Un éditeur SQL intégré pour créer les tables en collant le fichier
  `db/schema.sql`
- Gratuit jusqu'à un volume confortable pour démarrer

## Mise en place, étape par étape

### 1. Créer le projet Supabase

1. Va sur [supabase.com](https://supabase.com), crée un compte, puis un nouveau projet
2. Une fois le projet créé, ouvre **SQL Editor** dans le menu de gauche
3. Colle le contenu de `db/schema.sql` et clique sur **Run** — ça crée les
   tables `annonces` et `leads`
4. Va dans **Project Settings → API** : note l'**URL** du projet et la clé
   **`service_role`** (pas la clé `anon` — la `service_role` a tous les
   droits et ne doit jamais apparaître dans le code du front-end)

### 2. Vérifier les variables d'environnement sur Vercel

Si tu as connecté l'**intégration Supabase** directement depuis Vercel
(Marketplace → Supabase), les variables sont déjà créées automatiquement —
pas besoin de les ajouter à la main. Vérifie juste que ces deux-là sont
bien présentes dans **Settings → Environment Variables** :

| Nom                          | Rôle                                      |
|-------------------------------|--------------------------------------------|
| `SUPABASE_URL`                | URL du projet Supabase                     |
| `SUPABASE_SERVICE_ROLE_KEY`   | clé tous droits, utilisée côté serveur uniquement |

Si tu configures Supabase manuellement (sans passer par l'intégration
Vercel), va dans **Project Settings → API** sur Supabase pour récupérer
ces deux valeurs et les ajouter toi-même sur Vercel.

### 3. Pousser le code

```
git add .
git commit -m "Ajout du back-end : estimation DVF + base de données"
git push
```

Vercel redéploie automatiquement. Les trois fonctions (`estimate`,
`annonces`, `leads`) sont alors actives.

## Tester que ça marche

Une fois déployé (`ton-projet.vercel.app`) :

```
GET  /api/estimate?ville=Rennes&type=Maison
POST /api/annonces   { "ville": "Rennes", "surface": 90, "contact_email": "test@exemple.fr" }
GET  /api/annonces
```

Une annonce créée via `POST` apparaît en base avec le statut `brouillon` —
elle ne remonte pas encore dans `GET /api/annonces`, qui ne renvoie que les
annonces `publiee`. C'est volontaire : il manque encore un mécanisme de
validation/publication (par exemple, un lien de confirmation envoyé par
email) — à construire à l'étape suivante.

## Ce qui n'est pas encore fait (volontairement, pour rester scope)

- **Formulaire front-end** pour créer une annonce ou envoyer un lead — pour
  l'instant seule l'API existe, sans interface. Je peux la construire
  ensuite si tu veux avancer dans cette direction.
- **Authentification** des vendeurs (pour qu'ils retrouvent leur annonce,
  la modifient) — pas nécessaire pour un premier test, mais Supabase
  intègre un système d'auth prêt à l'emploi le moment venu.
- **Publication de l'annonce** (passage de `brouillon` à `publiee`) —
  actuellement à faire manuellement dans Supabase (Table Editor), le temps
  qu'un vrai parcours de validation soit construit.

## Fiabilité de la source DVF (rappel)

Le calcul d'estimation (`api/estimate.js`) s'appuie sur `api.cquest.org/dvf`,
une API communautaire non-officielle sur les données DVF — pratique pour
un prototype, mais sans garantie de disponibilité. Le jour où le volume
justifie plus de robustesse, il faudra importer les fichiers DVF officiels
directement dans Supabase plutôt que de dépendre d'un service tiers — je
peux préparer cette migration le moment venu.
