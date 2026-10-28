# Déploiement du fork sur VPS1

https://overleaf.foriel.pro, Community Edition construite depuis ce fork.

- **Image** : `.github/workflows/docker-image.yml` construit l'image à chaque push sur `main` et la publie sur
  `ghcr.io/vforiel/overleaf` (`latest` + empreinte du commit). TeX Live complet (`scheme-full`) est installé
  dans l'image de base (`deploy/Dockerfile-texlive`), qui ne se reconstruit que si son Dockerfile change.
- **VPS1** : `~/Overleaf` contient `compose.yaml`, `mongodb-init-replica-set.js`, `.env` (secrets, hors git)
  et `data/` (projets, MongoDB, Redis). Le conteneur `overleaf` est relié au réseau `proxy` ;
  `overleaf.caddy` est copié dans `~/reverse-proxy/sites/`.

## Mise à jour

```sh
# après la fin du workflow GitHub Actions
ssh VPS1 'cd ~/Overleaf && docker compose pull overleaf && docker compose up -d'
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

## Comptes

Pas d'inscription publique. Créer un compte (un lien pour choisir le mot de passe est affiché) :

```sh
ssh VPS1 'docker exec overleaf bash -c "cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user.mjs --email=adresse@exemple.org"'
```

Ajouter `--admin` pour un administrateur (page `/admin`). Les compilations LaTeX ne sont pas isolées
(Community Edition) : n'ouvrir des comptes qu'à des personnes de confiance.
