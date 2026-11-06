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

## Git (clone, pull, push)

Chaque projet est un dépôt git : `git clone https://overleaf.foriel.pro/git/<id du projet>`, nom d'utilisateur `git`,
mot de passe = un jeton git. C'est l'équivalent de l'intégration git de Server Pro, refaite pour le fork :

- **git-bridge** (`services/git-bridge`, code amont en Java) tourne dans son propre conteneur, image
  `ghcr.io/vforiel/overleaf-git-bridge` (`deploy/Dockerfile-git-bridge`, second job de « Docker image »), configuration
  `deploy/git-bridge.json` (copiée à côté de `compose.yaml`), dépôts dans `data/git-bridge` (appartient à l'uid 1000).
  Tas Java limité à 192 Mo, conteneur à 384 Mo.
- **Module `services/web/modules/git-bridge`** (propre au fork) : l'API que git-bridge appelle (`/api/v0/docs/…`,
  `/oauth/token/info`), les jetons (page https://overleaf.foriel.pro/user/git, collection MongoDB `gitTokens`, seule
  l'empreinte SHA-256 est gardée) et la carte « Git » de l'onglet « Intégrations » de l'éditeur. Activé par
  `GIT_BRIDGE_ENABLED=true` et `GIT_BRIDGE_PUBLIC_BASE_URL` (voir `server-ce/config/settings.js`).
- Une version git = une version de l'historique (history-v1). Les versions nommées de l'historique deviennent des
  commits à part, avec leur nom comme message. Un push passe par l'éditeur (source « git-bridge » dans l'historique) :
  fichiers modifiés remplacés, fichiers absents supprimés, dossiers vidés supprimés.
- **Caddy** (`overleaf.caddy`) ne laisse passer que `/git/<id>…` vers git-bridge, et coupe `/api/v0/*` et
  `/oauth/token/info` depuis Internet : ces routes ne servent qu'entre les deux conteneurs.

### Dépôt distant (Pull / Push depuis l'éditeur)

Carte « Dépôt distant » de l'onglet « Intégrations » : relie un projet à une branche d'un dépôt GitHub, GitLab…
(adresse https + jeton d'accès, par exemple un « fine-grained token » GitHub limité au dépôt, droit « Contents » en
lecture et écriture), avec des boutons Pull et Push et le choix de la branche. Code : `GitSync.mjs` du même module.

- Le propriétaire du projet relie, modifie ou délie le dépôt ; toute personne qui peut modifier le projet fait pull,
  push et change de branche. Le jeton est chiffré dans MongoDB (collection `gitSyncLinks`) et n'est jamais renvoyé.
- Chaque projet relié a un dépôt nu dans `/var/lib/overleaf/data/git-sync/<id>.git` (volume `data/overleaf`), dont la
  référence `sync` est le dernier état commun au projet et à la branche. Pull et push enregistrent d'abord le projet
  comme un commit au-dessus de `sync`. **Pull** « Fusionner » : `git merge-tree`, refusé en cas de conflit (liste des
  fichiers, rien n'est modifié) ; « Remplacer » : le projet devient la branche. **Push** : refusé si la branche a des
  commits que le projet n'a pas (faire un pull) ; jamais forcé. Le premier push vers une branche qui existe déjà demande
  un pull d'abord ; vers une branche vide ou nouvelle, il la crée.
- Pas de copie de travail sur le serveur (seulement des objets git) : liens symboliques et sous-modules du dépôt sont
  ignorés, comme les fichiers de plus de 50 Mo. git tourne sans configuration système, en https seulement, sans
  invite ; le jeton passe dans un en-tête HTTP par l'environnement, jamais dans une adresse ni un fichier.
- Les modifications apparaissent en direct dans l'éditeur, source « git-sync » dans l'historique.

Mise en place sur VPS1 (une fois) : copier `compose.yaml`, `git-bridge.json` et `overleaf.caddy`, puis

```sh
mkdir -p ~/Overleaf/data/git-bridge && sudo chown 1000:1000 ~/Overleaf/data/git-bridge
cd ~/Overleaf && docker compose pull && docker compose up -d
docker exec reverse-proxy caddy reload --config /etc/caddy/Caddyfile
```

`~/deploy/deploy.sh overleaf` tire les deux images (`docker compose pull overleaf git-bridge`).

## Comptes

Pas d'inscription publique. Créer un compte (un lien pour choisir le mot de passe est affiché) :

```sh
ssh VPS1 'docker exec overleaf bash -c "cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user.mjs --email=adresse@exemple.org"'
```

Ajouter `--admin` pour un administrateur (page `/admin`). Les compilations LaTeX ne sont pas isolées
(Community Edition) : n'ouvrir des comptes qu'à des personnes de confiance.
