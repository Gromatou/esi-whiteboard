#!/usr/bin/env bash
# =============================================================================
# esi-whiteboard — installation sur un serveur Debian/Ubuntu vierge
#
#   curl -fsSL https://raw.githubusercontent.com/Gromatou/esi-whiteboard/main/install.sh | bash
#
# Le script :
#   1. installe Node 22 + nginx + certbot
#   2. copie l'app dans /opt/tldraw, installe les dépendances, build le client
#   3. écrit un .env (à compléter ensuite)
#   4. crée le service systemd + le reverse proxy nginx + un backup quotidien
#
# Relance-le sans risque : il est idempotent.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tldraw}"
DOMAIN="${DOMAIN:-}"            # ex: whiteboard.example.com (laisser vide pour IP only)
REPO_URL="${REPO_URL:-https://github.com/Gromatou/esi-whiteboard.git}"

log() { echo -e "\033[1;34m==>\033[0m $*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Lancez en root (sudo)."; exit 1; fi

# --- 1. Dépendances système --------------------------------------------------
log "Installation des paquets (node, nginx, certbot, build tools)"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg nginx certbot python3-certbot-nginx build-essential python3
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y -qq nodejs
fi
log "Node $(node -v), npm $(npm -v)"

# --- 2. Code + build ---------------------------------------------------------
log "Récupération du code dans $APP_DIR"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
	git -C "$APP_DIR" pull --ff-only || true
else
	git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

log "Installation des dépendances serveur"
cd "$APP_DIR/server" && npm install --omit=dev

log "Build du client (vite)"
cd "$APP_DIR/client" && npm install && npm run build
rm -rf "$APP_DIR/public" && mkdir -p "$APP_DIR/public"
cp -r "$APP_DIR/client/dist/." "$APP_DIR/public/"

# Place server.mjs à la racine d'exécution
cp "$APP_DIR/server/server.mjs" "$APP_DIR/server.mjs"
mkdir -p "$APP_DIR/data/rooms" "$APP_DIR/data/assets"

# --- 3. Fichier .env ---------------------------------------------------------
if [ ! -f "$APP_DIR/.env" ]; then
	log "Création de $APP_DIR/.env (à compléter !)"
	SECRET="$(openssl rand -hex 32)"
	SED_APP_URL="https://${DOMAIN:-CHANGEZ-MOI}"
	sed -e "s#SESSION_SECRET=.*#SESSION_SECRET=${SECRET}#" \
	    -e "s#APP_URL=.*#APP_URL=${SED_APP_URL}#" \
	    -e "s#DATA_DIR=.*#DATA_DIR=${APP_DIR}/data#" \
	    "$APP_DIR/.env.example" > "$APP_DIR/.env"
	chmod 600 "$APP_DIR/.env"
	echo "  -> éditez $APP_DIR/.env (DISCORD_*, AGENT_API_KEY, APP_URL)"
else
	log ".env déjà présent, inchangé"
fi

# --- 4. systemd --------------------------------------------------------------
log "Service systemd tldraw"
cat > /etc/systemd/system/tldraw.service <<EOF
[Unit]
Description=esi-whiteboard (tldraw sync + Discord auth + AI agent)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node ${APP_DIR}/server.mjs
Restart=always
RestartSec=5
MemoryMax=400M
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tldraw
systemctl restart tldraw

# --- 5. nginx + TLS ----------------------------------------------------------
if [ -n "$DOMAIN" ]; then
	log "Reverse proxy nginx pour $DOMAIN"
	cat > /etc/nginx/sites-available/tldraw <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;
    client_max_body_size 0;

    location /auth/ {
        proxy_pass http://127.0.0.1:5858;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location = /auth/verify {
        internal;
        proxy_pass http://127.0.0.1:5858/auth/verify;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
    }
    location / {
        auth_request /auth/verify;
        proxy_pass http://127.0.0.1:5858;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
	rm -f /etc/nginx/sites-enabled/default
	ln -sf /etc/nginx/sites-available/tldraw /etc/nginx/sites-enabled/tldraw
	nginx -t
	certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || \
		echo "  (certbot a échoué — DNS pas encore pointé ? relancez: certbot --nginx -d $DOMAIN)"
	systemctl reload nginx
else
	log "DOMAIN vide : accès direct via http://<ip>:5858 (pas de TLS)"
fi

# --- 6. Backup quotidien -----------------------------------------------------
log "Timer de backup quotidien (3h, rétention 14 jours)"
cat > "$APP_DIR/backup.sh" <<'EOF'
#!/usr/bin/env bash
set -e
DATA="${DATA_DIR:-/opt/tldraw/data}"
DEST="$DATA/backups"; mkdir -p "$DEST"
tar czf "$DEST/data-$(date +%F).tgz" -C "$DATA" rooms assets agent.db usage.log 2>/dev/null || true
find "$DEST" -name 'data-*.tgz' -mtime +14 -delete
EOF
chmod +x "$APP_DIR/backup.sh"
cat > /etc/systemd/system/tldraw-backup.service <<EOF
[Unit]
Description=Backup esi-whiteboard
[Service]
Type=oneshot
EnvironmentFile=${APP_DIR}/.env
ExecStart=${APP_DIR}/backup.sh
EOF
cat > /etc/systemd/system/tldraw-backup.timer <<'EOF'
[Unit]
Description=Backup quotidien esi-whiteboard
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now tldraw-backup.timer

log "Terminé."
echo
echo "  Étape suivante : compléter $APP_DIR/.env puis"
echo "      systemctl restart tldraw"
echo
echo "  Statut  : systemctl status tldraw"
echo "  Logs    : journalctl -u tldraw -f"
