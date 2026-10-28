# Déploiement du fork sur VPS1

https://overleaf.foriel.pro, Community Edition construite depuis ce fork.

- **Image** : `.github/workflows/docker-image.yml` construit l'image à chaque push sur `main` et la publie sur
  `ghcr.io/vforiel/overleaf` (`latest` + empreinte du commit). TeX Live complet (`scheme-full`) est installé
  dans l'image de base (`deploy/Dockerfile-texlive`), qui ne se reconstruit que si son Dockerfile change.
- **VPS1** : `~/Overleaf` contient `compose.yaml`, `mongodb-init-replica-set.js`, `.env` (secrets, hors git)
  et `data/` (projets, MongoDB, Redis). Le conteneur `overleaf` est relié au réseau `proxy` ;
  `overleaf.caddy` est copié dans `~/reverse-proxy/sites/`. MongoDB est en 8.2 : la 8.0 refuse de démarrer
  sur les noyaux Linux 6.19 et plus récents (SERVER-121912).
- **Construction** : le workflow construit depuis une copie du Dockerfile sans le `tmpfs` sur `/tmp`
  (monté `noexec` par BuildKit, ce qui empêche de construire la dépendance git `codemirror-indentation-markers`).
- **Classes** : `aa.cls` (A&A) n'est pas dans TeX Live ; il faut l'ajouter au projet.

## Mise à jour

Automatique : quand « Docker image » réussit sur `main`, `.github/workflows/deploy.yml` se connecte à VPS1 avec une
clé limitée à `~/deploy/gate.sh overleaf`, qui tire la nouvelle image et relance le conteneur (journal :
`~/deploy/logs/overleaf-prod.log`). À la main :

```sh
ssh VPS1 '~/deploy/deploy.sh overleaf'
```

## Synchroniser le fork avec Overleaf

```sh
git fetch upstream && git merge upstream/main && git push
```

Les fichiers propres au fork (`deploy/`, `.github/workflows/`) n'existent pas en amont : pas de conflit.

## `.env` (sur le VPS uniquement)

```sh
OVERLEAF_INVITE_TOKEN_SECRET=...   # openssl rand -base64 32, à ne jamais changer
OVERLEAF_SESSION_SECRET=...        # idem, sinon les sessions sautent à chaque recréation du conteneur
```

## Connecteur IA (MCP)

Module `services/web/modules/mcp` (propre au fork) : un serveur MCP intégré au service `web`, qui permet à une IA
externe (Claude…) de lister les projets d'un compte, de lire, écrire, modifier, déplacer et supprimer leurs fichiers
texte, de compiler et de créer un projet. Les modifications passent par l'éditeur : elles apparaissent en direct chez
les collaborateurs et dans l'historique (source « mcp »), avec les droits du compte.

- Chaque personne crée ses liens sur https://overleaf.foriel.pro/user/mcp (lien « Connecteur IA » dans la barre du
  haut, `OVERLEAF_HEADER_EXTRAS`). Lien : `https://overleaf.foriel.pro/mcp/olmcp_…`, affiché une seule fois ; seule
  son empreinte SHA-256 est gardée (collection MongoDB `mcpTokens`). Le jeton peut aussi passer en
  `Authorization: Bearer` sur `/mcp`.
- Transport « Streamable HTTP » sans état : un POST JSON-RPC, une réponse JSON ; GET répond 405. 600 requêtes par
  minute et par lien.
- Claude : Paramètres › Connecteurs › « Ajouter un connecteur personnalisé », URL = le lien. Claude Code :
  `claude mcp add --transport http overleaf <lien>`.

## Comptes

Pas d'inscription publique. Créer un compte (un lien pour choisir le mot de passe est affiché) :

```sh
ssh VPS1 'docker exec overleaf bash -c "cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user.mjs --email=adresse@exemple.org"'
```

Ajouter `--admin` pour un administrateur (page `/admin`). Les compilations LaTeX ne sont pas isolées
(Community Edition) : n'ouvrir des comptes qu'à des personnes de confiance.
