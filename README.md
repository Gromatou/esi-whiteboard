# esi-whiteboard

> Tableau blanc collaboratif **auto-hébergé** basé sur [tldraw](https://tldraw.dev),
> avec **auth Discord**, **persistance par tableau**, **import PDF**, et un
> **agent IA** (DeepSeek) qui lit ce que tu écris au stylet.

> ⚡ **Vibe codé avec DeepSeek 4.1.** L'intégralité de ce dépôt (serveur, client,
> agent, doc) a été écrite en pair-programmation avec DeepSeek 4.1.

---

## Pourquoi cet outil ?

L'idée est un **complément à Discord** pour le travail à plusieurs (cours, TP, révisions) :

- **Fini les partages d'écran et les streams.** On ouvre un tableau partagé et **chacun
  voit en temps réel** ce que les autres écrivent (avec le curseur et le pseudo de chaque
  personne).
- **On travaille les équations ensemble.** Chacun écrit à la main (stylet) ou tape du
  texte ; tout le monde voit la même chose au même moment, sans rien avoir à diffuser.
- **L'IA aide et corrige.** En plus des humains, un assistant IA regarde la vue et peut
  vérifier des calculs, signaler une erreur précise ou expliquer un point bloquant —
  comme un prof disponible à côté du tableau.

Bref : un tableau blanc partagé où l'on **discute, résout et fait corriger en direct**,
sans avoir à streamer sa fenêtre.

### Ce qui n'est PAS implémenté (assumé)

- **Aucun système de compte** propre à l'application : pas d'inscription, pas de mot de
  passe, pas de gestion de profil. L'identité vient **uniquement** de Discord (OAuth).
- **Aucune permission ni rôle** : tous ceux qui peuvent se connecter ont les mêmes
  droits. La seule restriction possible est à la porte, via `DISCORD_GUILD_ID`
  (un unique serveur Discord autorisé).
- **Aucun crédit / quota d'IA par utilisateur** : l'IA est **partagée**, sans limite de
  tokens par personne. L'usage est seulement **mesuré** (fichiers `data/usage.log` et
  `data/usage-totals.txt`) pour information.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Architecture](#architecture)
- [Le système de chunking](#le-système-de-chunking)
- [Le cache incrémental](#le-cache-incrémentiel)
- [Ce que voit l'agent (manifeste + mémoire)](#ce-que-voit-lagent)
- [Coût & usage](#coût--usage)
- [Setup Discord](#setup-discord)
- [Installation](#installation)
- [Configuration](#configuration)
- [Exploitation](#exploitation)
- [Dépannage](#dépannage)

---

## Fonctionnalités

- **Tableaux illimités** : une room par URL (`/<nom>`), synchronisation temps réel.
- **Persistance serveur** : chaque room est un fichier SQLite (`data/rooms/<room>.db`).
  Rien à faire, un tableau créé à `/<nom>` est sauvegardé définitivement à cette URL.
- **Auth Discord** : login OAuth2 restreint à un serveur (guild) optionnel.
- **Import PDF & médias** : les PDF sont rendus en pages-images haute résolution ; images/vidéos via le handler natif de tldraw.
- **Agent IA intégré** : panneau flottant, réponses en markdown + KaTeX.
  L'agent **voit ta vue** (et seulement ta vue), demande une capture quand il en a besoin.
- **Pseudo Discord** affiché à côté du curseur.
- **Backup quotidien** automatique (systemd timer, rétention 14 j).

---

## Architecture

```
                 ┌──────────────────────┐
  navigateur ──▶ │ nginx (TLS, auth)    │
                 └──────────┬───────────┘
                            │ proxy + auth_request /auth/verify
                 ┌──────────▼───────────┐
                 │ node server.mjs :5858│
                 │  • OAuth Discord     │
                 │  • sync tldraw (WS)  │
                 │  • API agent IA      │
                 │  • assets / uploads  │
                 └──────────┬───────────┘
                            │
              ┌─────────────┼───────────────┐
        SQLite rooms   agent.db        data/assets
     (data/rooms/*.db) (historique)   (PDF, images)
```

- **Un seul process Node** (`server.mjs`), pas de Docker.
- **Client** : app React + Vite qui embarque tldraw et le panneau agent.
- **Stockage** : SQLite par room (`@tldraw/sync-core`), `agent.db` pour les conversations, fichiers pour les assets.

Le client buildé est servi statiquement par le serveur (dossier `public/`).

---

## Le système de chunking

> Objectif : donner à l'agent une **image lisible de la vue de l'utilisateur**,
> sans lui envoyer tout le tableau ni dépendre de la résolution de son écran.

### Pourquoi découper

Le modèle vision de DeepSeek **réduit chaque image à ~800×800 px** avant l'inférence
(budget ≈ 384 tokens/image). Une seule image de toute la vue = un seul budget de 800px
pour toute la zone → l'écriture manuscrite devient illisible.

On envoie donc **plusieurs images** : une **vue d'ensemble** + des **tuiles** haute
définition. Chaque tuile a son propre budget de 800px.

### Chunks absolus (façon « chunks Minecraft »)

Le tableau est découpé en **chunks carrés de 450×450 unités**, **ancrés à l'origine
(0,0)** du tableau — pas sur le viewport :

```
        x →
   ┌────┬────┬────┬────┐
 y │c0_0│c1_0│c2_0│    │
 ↓ ├────┼────┼────┼────┤
   │c0_1│c1_1│c2_1│    │
   ├────┼────┼────┼────┤
   │    │    │    │    │
   └────┴────┴────┴────┘
```

Conséquence essentielle : **un chunk a des coordonnées et un contenu indépendants de
la vue**. Se déplacer (pan/zoom) ne rend donc PAS un chunk déjà envoyé « modifié ».
Seuls les chunks réellement modifiés ou nouvellement visibles sont renvoyés.

### Ce qui est envoyé

À chaque demande de vue, on calcule les chunks qui **intersectent le viewport** :

| Image | Contenu |
|---|---|
| `overview` (image 1) | la vue entière, **strictement limitée à l'écran** (contexte de disposition) |
| `tile` × N | chaque chunk visible, rendu à **1600 px** (supersampling → le downscale interne 800px est net) |

Nombre de chunks par appel : plafonné à **600 images** (limite DeepSeek), et par un
**budget de payload** de 45 Mo de base64 (< 48 MiB du corps de requête).

### Voile de résolution

Les tuiles sont rendues à `TILE_PX = 1600` (densité ~2 px/unité), donc une fois
réduites à 800px par le modèle, l'image reste nette (équivalent d'un sur-échantillonnage
×2). La résolution **ne dépend ni de l'écran ni du zoom** de l'utilisateur.

---

## Le cache incrémentiel

> Objectif : ne pas renvoyer la même chose au modèle à chaque message.

Chaque chunk possède une **signature** = hash des `id + props` des formes qu'il contient :

```js
boxSig(chunk) = hash( sort( shape.id + "#" + hash(shape.props) for shape in chunk ) )
```

- La signature **ne dépend pas de la vue** (chunk absolu) → pan/zoom ne la change pas.
- Pour chaque chunk on mémorise la **dernière signature envoyée** (`sentSigs`).

Au moment d'envoyer la vue, on ne retient que les chunks dont la signature **diffère**
de la dernière envoyée (modifiés) ou **jamais envoyés** (nouvelle zone).

| Scénario | Tuiles renvoyées |
|---|---|
| Premier envoi | toutes les chunks visibles |
| Message suivant, tableau inchangé | **0** |
| Un trait dessiné dans une zone | **uniquement le(s) chunk(s) touché(s)** |
| Déplacement vers une zone inédite | uniquement les chunks de cette zone |
| Retour sur une zone déjà vue (inchangée) | **0** |

Le cache est **délibérément pessimiste** : il est vidé quand on n'est plus sûr que le
modèle a vu les zones (effacement de l'historique, recharge de page) → on renvoie alors
tout. On ne se retrouve jamais avec un modèle sans mémoire **et** sans images.

> ⚠️ Effacer l'historique (`Effacer`) efface la **mémoire texte** du modèle côté serveur
> ET reset le cache client — les deux sont indissociables.

---

## Ce que voit l'agent

Trois mécanismes travaillent ensemble.

### 1. L'outil `request_view`

L'utilisateur n'a **qu'un seul bouton d'envoi**. C'est **le modèle** qui décide s'il a
besoin de voir le tableau, via un outil `request_view({ mode })` :

- `mode: "overview"` → vue d'ensemble seule (comprendre la disposition) ;
- `mode: "tiles"` → vue d'ensemble + tuiles HD (lire / vérifier des calculs).

Le client répond à l'appel d'outil **de façon transparente** (capture + renvoi), puis
le modèle produit sa réponse. Côté serveur, l'appel est reconstruit
(`assistant.tool_calls` → message `tool` → message `user` porteur des images), et le
`reasoning_content` du modèle (mode « thinking ») est **rejoué** dans la requête de
suivi — sinon l'API renvoie 400.

### 2. Le manifeste de coordonnées

Avec les images, on envoie un **manifeste texte** qui décrit, en coordonnées du tableau :

- la **région visible** (`x` de … à …, `y` de … à …) ;
- les **coordonnées de chaque image jointe** (vue d'ensemble, puis tuiles) ;
- les **tuiles de la vue NON jointes** (inchangées, vides, ou non attachées) et pourquoi.

Ainsi l'agent sait **où** est chaque contenu, quelle tuile correspond à quoi, et peut
répondre même à propos d'un chunk qu'il n'a pas reçu (« ce chunk est dans ta vue mais
je ne l'ai pas reçu »).

### 3. La mémoire texte

Le modèle est invité à **résumer en texte l'essentiel vérifié** (équations, résultats,
verdicts : « démonstration que x = y : calculs corrects »), sans recopier le superflu.
Ce résumé sert de **mémoire** pour les messages suivants, où les zones inchangées ne
sont pas renvoyées. Le modèle se fie à ce qu'il a déjà contrôlé.

---

## Coût & usage

- Le panneau affiche en bas le **total de tokens** et une **estimation de coût** de la conversation.
- Chaque appel modèle écrit **une ligne** dans `data/usage.log` (TSV) :
  `date · pseudo · room · tokens_entrée · tokens_sortie · coût_usd`.
- Le cumul **par pseudo** est maintenu dans `data/usage-totals.txt`.

```bash
cat /opt/tldraw/data/usage-totals.txt
grep Alice /opt/tldraw/data/usage.log | tail
```

Tarifs utilisés (estimation, DeepSeek) : entrée `$0,22` / cache `$0,007` / sortie `$0,66`
par million de tokens.

---

## Setup Discord

### 1. Créer l'application

1. <https://discord.com/developers/applications> → **New Application**.
2. Onglet **OAuth2** :
   - **Redirect URI** : `https://VOTRE_DOMAINE/auth/callback` (ajoutez aussi
     `http://localhost:5858/auth/callback` pour tester).
   - Notez le **Client ID** et le **Client Secret** (onglet OAuth2 → Reset Secret).
3. Onglet **Bot** → **Add Bot** (le bot n'a pas besoin de permissions particulières ;
   il sert via `guilds.members.read`).

### 2. Récupérer le Guild ID

Activez le mode développeur (Paramètres Discord → Avancés), clic droit sur votre
serveur → **Copier l'identifiant du serveur**. C'est `DISCORD_GUILD_ID`.

> Si `DISCORD_GUILD_ID` est vide, tout compte Discord peut se connecter.
> S'il est renseigné, seuls les membres de ce serveur sont acceptés.

### 3. Inviter le bot (pour `guilds.members.read`)

URL d'invitation (remplacez `CLIENT_ID`) :
```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=0
```
Le bot doit être **sur le serveur** pour pouvoir lire les pseudos via `guilds.members.read`.

### 4. Scopes utilisés par l'app

`identify` + `guilds.members.read` → l'app récupère ton pseudo de serveur
(`nick`) sinon ton nom global, sinon ton username.

---

## Installation

### Prérequis
- Un serveur Debian/Ubuntu vierge (testé sur Debian 13, 1 vCPU / 1 Go RAM).
- Un nom de domaine pointant vers l'IP (pour le TLS).
- Une clé API DeepSeek (<https://platform.deepseek.com>).
- Une application Discord (voir ci-dessus).

### Script automatique

```bash
sudo DOMAIN=whiteboard.example.com bash install.sh
```

Le script installe Node 22 + nginx + certbot, copie l'app dans `/opt/tldraw`,
build le client, crée le service systemd, le reverse proxy TLS et le backup.

Ensuite, complétez `/opt/tldraw/.env` (Discord, clé IA, `APP_URL`) puis :

```bash
sudo systemctl restart tldraw
```

### Manuel (résumé)

```bash
git clone https://github.com/Gromatou/esi-whiteboard.git /opt/tldraw
cd /opt/tldraw/server && npm install --omit=dev
cd ../client && npm install && npm run build
cp -r dist/. ../public/
cp ../server/server.mjs ../server.mjs
cp ../.env.example ../.env    # puis éditer
```

---

## Configuration

Toutes les variables sont dans `.env` (voir `.env.example`) :

| Variable | Rôle |
|---|---|
| `PORT` | port d'écoute Node (défaut 5858, derrière nginx) |
| `APP_URL` | URL publique HTTPS (`https://…`) ; sert au cookie `Secure` et au redirect OAuth |
| `DATA_DIR` | dossier de données (rooms, assets, agent, usage) |
| `SESSION_SECRET` | secret de signature du cookie de session (`openssl rand -hex 32`) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | OAuth2 Discord |
| `DISCORD_GUILD_ID` | (optionnel) restreint l'accès aux membres du serveur |
| `AGENT_PROVIDER` | `deepseek` (défaut), `openai`, `anthropic` ou `google` |
| `AGENT_API_KEY` | clé API du fournisseur IA |
| `AGENT_MODEL` | `deepseek-flash` (multimodal + tool-calling) |
| `AGENT_SYSTEM_PROMPT` | (optionnel) remplace tout le prompt système |

Les modèles non compatibles « OpenAI tools » (Anthropic/Google) utilisent un chemin
dégradé sans outil.

---

## Exploitation

```bash
systemctl status tldraw            # état du service
journalctl -u tldraw -f            # logs en direct
systemctl restart tldraw           # redémarrer
systemctl list-timers tldraw-backup # prochain backup
cat /opt/tldraw/data/usage-totals.txt   # usage par pseudo
```

- **Rooms** : `ls /opt/tldraw/data/rooms/*.db`
- **Reset d'un tableau** : depuis l'UI (menu ☰ → *Supprimer ce tableau…*), ou en
  supprimant `data/rooms/<room>.db` + redémarrage.
- **Garde disque** : si l'espace libre tombe sous 100 Mo, le service affiche une alerte
  et redirige vers une page d'information.

---

## Dépannage

| Symptôme | Piste |
|---|---|
| `401` partout | cookie de session absent/expiré → se reconnecter ; vérifier `APP_URL` = URL HTTPS réelle |
| Login Discord « not a member » | le bot n'est pas sur le serveur, ou `DISCORD_GUILD_ID` incorrect |
| L'agent ne voit rien | il n'a pas appelé `request_view`, ou la clé IA est absente (`AGENT_API_KEY`) |
| Réponse 400 côté IA après un tool call | `reasoning_content` non rejoué (bug de version du serveur) |
| Images « illisibles » par l'agent | zone trop grande pour 600 chunks → zoomer, ou augmenter le budget |
| Le client ne se met pas à jour | `npm run build` puis recopier `dist/` dans `public/` |

---

## Licence

Le code de ce dépôt est fourni tel quel. tldraw est distribué sous sa propre licence
(voir le fork [`Gromatou/tldraw`](https://github.com/Gromatou/tldraw)) : **vérifiez la
licence tldraw avant tout usage en production**.
