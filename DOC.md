# esi-whiteboard — guide simple

> Doc express. Pour les détails (chunking, cache, agent), voir le [README](./README.md).

## C'est quoi ?

Un tableau blanc en ligne, **auto-hébergé**, sur lequel on dessine/écrit, avec un
**assistant IA** qui peut regarder ce qu'on a écrit pour aider (vérifier des calculs,
expliquer). Connexion via **Discord**.

## Installation en 5 minutes

Sur un serveur Debian/Ubuntu, avec un domaine qui pointe vers l'IP :

```bash
sudo DOMAIN=whiteboard.mondomaine.fr bash install.sh
```

Puis :

```bash
sudo nano /opt/tldraw/.env     # remplir DISCORD_* et AGENT_API_KEY
sudo systemctl restart tldraw
```

Ouvre `https://whiteboard.mondomaine.fr` → connecte-toi avec Discord. C'est prêt.

## Ce qu'il faut préparer

1. **Un domaine** qui pointe vers l'IP du serveur (pour le HTTPS).
2. **Une app Discord** : <https://discord.com/developers/applications>
   - Redirect URI : `https://TON_DOMAINE/auth/callback`
   - Récupère **Client ID** + **Client Secret**
   - Clic droit serveur (mode dev) → **Copier l'ID du serveur** (`DISCORD_GUILD_ID`)
3. **Une clé DeepSeek** : <https://platform.deepseek.com> → API Keys (`AGENT_API_KEY`).

Détails complets du setup Discord : section [Setup Discord](./README.md#setup-discord) du README.

## Utiliser l'app

- **Créer un tableau** : change le nom dans l'URL. Ex. `…/maths-TP2` → tableau sauvegardé
  à cette adresse, définitivement.
- **Menu ☰** : lister les tableaux, en changer, en supprimer.
- **📎 Charger un média** : images, vidéos et **PDF** (les pages PDF sont posées sur le tableau).
- **🤖 Assistant** (icône dans la barre) : ouvre le panneau de l'IA.
  - Écris ta demande, appuie sur **↑** (ou Entrée).
  - L'IA **demande toute seule une capture de ce que tu vois** si elle en a besoin
    (tu verras « 📷 Le modèle a téléchargé ta vue, étalée sur N images »).
  - Si elle a déjà ce qu'il faut en mémoire, elle répond sans rien recharger.
- En bas du panneau : **total de tokens** et **coût estimé** de la conversation.

## Comment ça marche (version courte)

- L'IA ne voit **que ta vue actuelle** (jamais le reste du tableau).
- Sa vue est découpée en **petites tuiles** pour qu'elle lise bien l'écriture au stylet.
- Elle **mémorise ce qu'elle a vérifié** en texte : elle ne redemande pas les zones inchangées.
- **Effacer** l'historique réinitialise aussi cette mémoire (l'IA repart de zéro).

## Commandes utiles

```bash
systemctl status tldraw       # état
journalctl -u tldraw -f       # logs
systemctl restart tldraw      # redémarrer après modif du .env
cat /opt/tldraw/data/usage-totals.txt   # tokens / coût par utilisateur
```

## Un souci ?

Voir la section [Dépannage](./README.md#dépannage) du README.

---

*Vibe codé avec DeepSeek 4.1.*
