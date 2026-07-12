# Espace étudiant — Planning

Un espace web permettant aux étudiants de **consulter et modifier leur planning**,
dont les données sont stockées dans un document **Grist** (instance DINUM :
[grist.numerique.gouv.fr](https://grist.numerique.gouv.fr)).

Les étudiants n'ont **pas besoin de compte Grist** : ils se connectent avec un
**code personnel** que tu leur remets.

## Architecture

```
Étudiant ──▶ Site web (GitHub Pages, dossier docs/)
                 │  code personnel
                 ▼
             Proxy API (Cloudflare Worker, dossier worker/)
                 │  clé API Grist (secrète, jamais côté navigateur)
                 ▼
             Document Grist (DINUM)
```

Le proxy garantit que chaque étudiant ne voit et ne modifie **que ses propres
créneaux**.

## 1. Préparer le document Grist

Dans ton document Grist, crée (ou adapte) deux tables :

### Table `Etudiants`

| Colonne  | Type  | Rôle                                        |
|----------|-------|---------------------------------------------|
| `Nom`    | Texte | Nom de l'étudiant                            |
| `Prenom` | Texte | Prénom                                       |
| `Code`   | Texte | **Code personnel secret** (min. 8 caractères, unique) |

> Astuce : génère les codes avec une formule Grist ou un générateur de mots de
> passe. Ne réutilise jamais le même code pour deux étudiants.

### Table `Planning`

| Colonne         | Type  | Rôle                                   |
|-----------------|-------|-----------------------------------------|
| `Code_Etudiant` | Texte | Code de l'étudiant propriétaire du créneau |
| `Date`          | Date  | Jour du créneau                         |
| `Heure_Debut`   | Texte | ex. `09:00`                             |
| `Heure_Fin`     | Texte | ex. `12:00`                             |
| `Activite`      | Texte | Intitulé (cours, stage…)                |
| `Lieu`          | Texte | Salle, site…                            |
| `Notes`         | Texte | Commentaire libre                       |

Si tes tables ou colonnes portent d'autres noms, adapte les variables dans
`worker/wrangler.toml`.

### Clé API Grist

1. Sur Grist : avatar en haut à droite → **Paramètres du profil** → **Clé API** → créer/copier la clé.
2. Note aussi l'**identifiant du document** (dans l'URL du document, ou menu du document → *Paramètres*).

## 2. Déployer le proxy (Cloudflare Workers)

Prérequis : un compte gratuit sur [cloudflare.com](https://dash.cloudflare.com/sign-up)
et Node.js installé.

```bash
cd worker
# Renseigne GRIST_DOC_ID (et les noms de tables si besoin) dans wrangler.toml
npm install
npx wrangler login          # ouvre le navigateur pour autoriser
npx wrangler secret put GRIST_API_KEY    # colle ta clé API Grist
npx wrangler deploy
```

`wrangler deploy` affiche l'URL du worker, par exemple
`https://espace-etudiant-api.moncompte.workers.dev`.

## 3. Configurer et publier le site (GitHub Pages)

1. Dans `docs/config.js`, remplace `API_URL` par l'URL de ton worker.
2. Pousse le dépôt sur GitHub, puis dans **Settings → Pages** du dépôt :
   *Source* = branche `main`, dossier `/docs`.
3. Le site est disponible sous `https://toncompte.github.io/nom-du-depot/`.
4. **Sécurité** : dans `worker/wrangler.toml`, remplace `ALLOWED_ORIGIN = "*"`
   par l'origine de ton site (ex. `"https://toncompte.github.io"`) et
   redéploie (`npx wrangler deploy`).

## 4. Distribuer les codes

Remets à chaque étudiant son code personnel (colonne `Code`). Il se connecte
sur le site, voit son planning de la semaine, et peut ajouter, modifier ou
supprimer ses créneaux. Toutes les modifications apparaissent en direct dans
ton document Grist.

## Sécurité — points d'attention

- La clé API Grist n'est stockée **que** dans le secret Cloudflare, jamais dans
  le code ni sur GitHub.
- Le code personnel fait office de mot de passe : privilégie des codes longs
  (8+ caractères aléatoires) et change-les en cas de doute.
- Le proxy n'autorise que la lecture/écriture des créneaux du code authentifié,
  et uniquement les champs du planning (pas d'accès au reste du document).

## Développement local

```bash
cd worker && npx wrangler dev        # proxy sur http://localhost:8787
# puis mettre API_URL: "http://localhost:8787" dans docs/config.js
# et ouvrir docs/index.html dans un navigateur
```
