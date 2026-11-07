#!/usr/bin/env bash
# Kala server installer (Ubuntu/Debian).
#   sudo bash install.sh <domain> [email]
# Installs: Node.js 22, nginx + Let's Encrypt SSL (certbot), Kala as a systemd service,
# Python/pip, Java 17, Android SDK + Gradle, Godot (headless) + export templates,
# Claude Code CLI and OpenCode CLI. Safe to run again (updates in place).
set -euo pipefail

DOMAIN="${1:-skkapap.fun}"
EMAIL="${2:-admin@${DOMAIN}}"
APP_USER="kala"
APP_DIR="/opt/kala"
DATA_DIR="/var/lib/kala"
PORT="3000"
GODOT_VERSION="${GODOT_VERSION:-4.6-stable}"
ANDROID_HOME="/opt/android-sdk"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { echo -e "\n\033[1;34m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[!] $*\033[0m"; }
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "Системные пакеты"
apt-get update -y
apt-get install -y curl wget git unzip zip ca-certificates gnupg build-essential \
  nginx certbot python3-certbot-nginx python3 python3-pip python3-venv python-is-python3 \
  openjdk-17-jdk-headless ffmpeg imagemagick jq sqlite3 rsync util-linux \
  libfontconfig1 libxi6 libxrender1 libxcursor1 libxinerama1 libxrandr2 libgl1 || \
  apt-get install -y curl wget git unzip zip ca-certificates gnupg build-essential nginx certbot python3-certbot-nginx python3 python3-pip python3-venv openjdk-17-jdk-headless

log "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

log "Пользователь $APP_USER (sudo без пароля — ИИ может ставить пакеты)"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-kala
chmod 440 /etc/sudoers.d/90-kala
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"

log "Копирование сервера в $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"
rsync -a --delete --exclude node_modules --exclude data "$SRC_DIR/" "$APP_DIR/"
cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

log "CLI агенты: Claude Code и OpenCode"
npm install -g @anthropic-ai/claude-code opencode-ai --no-audit --no-fund || warn "Не удалось установить CLI (можно позже: npm i -g @anthropic-ai/claude-code)"

log "Android SDK ($ANDROID_HOME)"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$ANDROID_HOME/cmdline-tools" && cd /tmp
  wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdtools.zip
  rm -rf cmdline-tools && unzip -q cmdtools.zip && rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" && rm cmdtools.zip
fi
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null \
  || warn "Android SDK установлен не полностью"
chown -R "$APP_USER:$APP_USER" "$ANDROID_HOME"

log "Gradle"
if ! command -v gradle >/dev/null; then
  cd /tmp && wget -q https://services.gradle.org/distributions/gradle-8.14.3-bin.zip -O gradle.zip \
    && unzip -qo gradle.zip -d /opt && ln -sfn /opt/gradle-8.14.3/bin/gradle /usr/local/bin/gradle && rm gradle.zip \
    || warn "Gradle не установлен"
fi

log "Godot $GODOT_VERSION (headless) + шаблоны экспорта"
if ! command -v godot >/dev/null; then
  cd /tmp && wget -q "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_linux.x86_64.zip" -O godot.zip \
    && unzip -qo godot.zip && install -m 755 "Godot_v${GODOT_VERSION}_linux.x86_64" /usr/local/bin/godot && rm -f godot.zip "Godot_v${GODOT_VERSION}_linux.x86_64" \
    || warn "Godot не установлен"
fi
TPL_DIR="$APP_HOME/.local/share/godot/export_templates/${GODOT_VERSION/-/.}"
if [ ! -d "$TPL_DIR" ]; then
  cd /tmp && wget -q "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_export_templates.tpz" -O tpl.zip \
    && rm -rf templates && unzip -qo tpl.zip && mkdir -p "$TPL_DIR" && mv templates/* "$TPL_DIR/" && rm -rf templates tpl.zip \
    && chown -R "$APP_USER:$APP_USER" "$APP_HOME/.local" || warn "Шаблоны Godot не установлены"
fi
# Godot needs the Android SDK path + a debug keystore to export Android APKs
sudo -u "$APP_USER" mkdir -p "$APP_HOME/.config/godot"
if [ ! -f "$APP_HOME/debug.keystore" ]; then
  sudo -u "$APP_USER" keytool -genkeypair -keystore "$APP_HOME/debug.keystore" -alias androiddebugkey -storepass android -keypass android \
    -keyalg RSA -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1 || true
fi
GODOT_MINOR="$(echo "$GODOT_VERSION" | cut -d- -f1 | cut -d. -f1-2)"
for GODOT_SETTINGS in "$APP_HOME/.config/godot/editor_settings-${GODOT_MINOR}.tres" "$APP_HOME/.config/godot/editor_settings-4.tres"; do
  [ -f "$GODOT_SETTINGS" ] && continue
  cat > "$GODOT_SETTINGS" <<EOF
[gd_resource type="EditorSettings" format=3]

[resource]
export/android/android_sdk_path = "$ANDROID_HOME"
export/android/java_sdk_path = "/usr/lib/jvm/java-17-openjdk-amd64"
export/android/debug_keystore = "$APP_HOME/debug.keystore"
export/android/debug_keystore_user = "androiddebugkey"
export/android/debug_keystore_pass = "android"
EOF
  chown "$APP_USER:$APP_USER" "$GODOT_SETTINGS"
done

log "Переменные окружения для ИИ"
cat > /etc/profile.d/kala.sh <<EOF
export ANDROID_HOME=$ANDROID_HOME
export ANDROID_SDK_ROOT=$ANDROID_HOME
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH=\$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:\$HOME/.local/bin
export PIP_BREAK_SYSTEM_PACKAGES=1
EOF

log "systemd сервис"
cat > /etc/systemd/system/kala.service <<EOF
[Unit]
Description=Kala AI agent server
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=KALA_DATA_DIR=$DATA_DIR
Environment=KALA_WORKSPACES_DIR=$APP_HOME/projects
Environment=KALA_PUBLIC_URL=https://$DOMAIN
Environment=ANDROID_HOME=$ANDROID_HOME
Environment=ANDROID_SDK_ROOT=$ANDROID_HOME
Environment=JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
Environment=PIP_BREAK_SYSTEM_PACKAGES=1
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$APP_HOME/.local/bin
ExecStart=/usr/bin/env node src/index.js
Restart=always
RestartSec=3
KillMode=process
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kala >/dev/null
systemctl restart kala

log "nginx для $DOMAIN"
cat > /etc/nginx/sites-available/kala <<EOF
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    client_max_body_size 2g;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
ln -sfn /etc/nginx/sites-available/kala /etc/nginx/sites-enabled/kala
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 'Nginx Full' || true; ufw allow OpenSSH || true; fi

log "SSL сертификат Let's Encrypt"
DOMAINS="-d $DOMAIN"
if getent ahosts "www.$DOMAIN" >/dev/null 2>&1; then DOMAINS="$DOMAINS -d www.$DOMAIN"; fi
certbot --nginx $DOMAINS --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring \
  || warn "Сертификат не получен. Проверьте, что A-запись $DOMAIN указывает на IP сервера и порт 80 открыт, затем: sudo certbot --nginx -d $DOMAIN"
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  log "Готово! Kala работает: https://$DOMAIN"
  echo "  • Откройте приложение Kala (или сайт) и создайте аккаунт владельца (первый аккаунт = владелец)."
  echo "  • Логи:       journalctl -u kala -f"
  echo "  • Обновить:   cd $SRC_DIR/.. && git pull && sudo bash server/install.sh $DOMAIN $EMAIL"
  echo "  • Данные:     $DATA_DIR   Проекты: $APP_HOME/projects"
else
  warn "Сервер не ответил. Смотрите: journalctl -u kala -n 50"
fi
