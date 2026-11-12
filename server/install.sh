#!/usr/bin/env bash
# Kala server installer (Ubuntu/Debian).
#   sudo bash install.sh <domain> [email]
# Part 1 (fast): Node.js, Kala service, nginx, SSL  -> the app can connect.
# Part 2 (slow): Python, Java, Android SDK, Gradle, Godot, Claude Code / OpenCode CLI.
# Safe to run again (updates in place). Errors in part 2 never break part 1.
set -uo pipefail

DOMAIN="${1:-skkapap.fun}"
EMAIL="${2:-admin@${DOMAIN}}"
# --takeover: disable other nginx sites that use the same domain (they are backed up, not deleted)
TAKEOVER="${KALA_TAKEOVER:-0}"
for a in "$@"; do [ "$a" = "--takeover" ] && TAKEOVER=1; done
[ "$EMAIL" = "--takeover" ] && EMAIL="admin@${DOMAIN}"
APP_USER="kala"
APP_DIR="/opt/kala"
DATA_DIR="/var/lib/kala"
GODOT_VERSION="${GODOT_VERSION:-4.6-stable}"
ANDROID_HOME="/opt/android-sdk"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { echo -e "\n\033[1;34m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[!] $*\033[0m"; }
die()  { echo -e "\033[1;31m[X] $*\033[0m"; echo "Диагностика: sudo bash $SRC_DIR/doctor.sh $DOMAIN"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
command -v apt-get >/dev/null || die "Нужен Ubuntu/Debian (apt-get)"

# install packages one by one so a missing package never stops the install
APT_LOG=/var/log/kala-apt.log
apt_try() {
  for p in "$@"; do
    if ! apt-get install -y -q "$p" >"$APT_LOG.last" 2>&1; then
      warn "пакет $p не установлен: $(grep -E '^(E:|dpkg:)' "$APT_LOG.last" | head -2 | tr '\n' ' ')"
      cat "$APT_LOG.last" >> "$APT_LOG"
    fi
  done
}
port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

########################## ЧАСТЬ 1: сервер ##########################
log "0/6 Диск: использую весь объём VPS"
bash "$SRC_DIR/expand-disk.sh" 2>&1 | tail -4 || warn "Не удалось расширить диск автоматически"

log "1/6 Базовые пакеты"
FREE_MB="$(df -Pm / | awk 'NR==2{print $4}')"
echo "Свободно на диске: ${FREE_MB} МБ"
[ "${FREE_MB:-0}" -lt 6000 ] && warn "Мало места на диске (<6 ГБ). Android SDK + Godot требуют ~5 ГБ."
# Find which folder apt can't write to ("No space left on device" while / has free space
# usually means a full small /tmp or /var mount, or no free inodes).
apt-get clean >/dev/null 2>&1 || true
rm -f /var/cache/apt/*.bin 2>/dev/null || true
SPACE_BAD=""
for d in /tmp /var/tmp /var/cache/apt /var/lib/apt/lists /var/lib/dpkg /var/log; do
  [ -d "$d" ] || continue
  if ! dd if=/dev/zero of="$d/.kala-wtest" bs=1M count=2 >/dev/null 2>&1; then
    SPACE_BAD="$SPACE_BAD $d"
    warn "Не могу записать в $d: $(df -h "$d" | awk 'NR==2{print "раздел " $6 ", свободно " $4}') $(df -i "$d" | awk 'NR==2{print ", свободных inode " $4}')"
  fi
  rm -f "$d/.kala-wtest"
done
if echo "$SPACE_BAD" | grep -q "/tmp"; then
  mkdir -p /var/lib/kala/tmp && chmod 1777 /var/lib/kala/tmp
  export TMPDIR=/var/lib/kala/tmp
  warn "/tmp переполнен — временные файлы перенесены в $TMPDIR. Почистить /tmp: sudo find /tmp -mindepth 1 -mtime +1 -delete"
fi
INODES_FREE="$(df -Pi / | awk 'NR==2{print $4}')"
[ "${INODES_FREE:-1000000}" -lt 50000 ] 2>/dev/null && warn "На диске почти кончились inode (свободно $INODES_FREE). Обычно это миллионы мелких файлов: логи, кэш, сессии. Посмотреть: sudo du --inodes -x / 2>/dev/null | sort -n | tail -15"

# finish interrupted installs / wait for unattended-upgrades
for i in $(seq 1 60); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; [ $i = 1 ] && echo "Жду, пока освободится apt (идут автообновления)…"; sleep 5; done
dpkg --configure -a >/dev/null 2>&1 || true
apt-get -f install -y -q >/dev/null 2>&1 || true
apt-get update -y -q || warn "apt-get update завершился с ошибкой"
apt_try curl wget git unzip zip ca-certificates gnupg rsync iproute2 nginx certbot python3-certbot-nginx dnsutils

log "2/6 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 || warn "не удалось добавить репозиторий NodeSource"
  apt-get install -y -q nodejs >/dev/null 2>&1 || die "Node.js не установился"
fi
echo "node $(node -v)"

log "3/6 Сервер Kala"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
echo "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-kala && chmod 440 /etc/sudoers.d/90-kala
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
mkdir -p "$APP_DIR" "$DATA_DIR" "$APP_HOME/projects"
rsync -a --delete --exclude node_modules --exclude data "$SRC_DIR/" "$APP_DIR/" || cp -a "$SRC_DIR/." "$APP_DIR/"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) || die "npm install не сработал"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR" "$APP_HOME/projects"

# Choose a free local port (your other Node apps may already use 3000)
PORT=""
if [ -f /etc/kala.port ]; then PORT="$(cat /etc/kala.port)"; fi
if [ -z "$PORT" ]; then
  for p in 3777 3778 3779 3780 4777 5777; do port_busy "$p" || { PORT="$p"; break; }; done
  echo "$PORT" > /etc/kala.port
fi
echo "Kala будет слушать 127.0.0.1:$PORT"

JAVA_HOME_GUESS="/usr/lib/jvm/default-java"
cat > /etc/systemd/system/kala.service <<EOF
[Unit]
Description=Kala AI agent server
After=network-online.target
Wants=network-online.target
# keep retrying forever (never give up after a few fast failures)
StartLimitIntervalSec=0

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
Environment=JAVA_HOME=$JAVA_HOME_GUESS
Environment=PIP_BREAK_SYSTEM_PACKAGES=1
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$APP_HOME/.local/bin
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=3
KillMode=process
LimitNOFILE=65535
# under memory pressure the kernel kills the AI's heavy jobs, not Kala itself
OOMScoreAdjust=-800

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kala >/dev/null 2>&1
systemctl restart kala
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || { journalctl -u kala -n 30 --no-pager; die "Сервер Kala не запустился (лог выше)"; }
echo "Kala отвечает локально ✓"

log "4/6 nginx для $DOMAIN"
# Who else is on port 80/443?
OTHER80="$(ss -ltnpH '( sport = :80 )' 2>/dev/null | grep -v nginx || true)"
if [ -n "$OTHER80" ]; then
  warn "Порт 80 занят другой программой (не nginx):"; echo "$OTHER80"
  warn "Остановите её (например: systemctl stop apache2 && systemctl disable apache2) и запустите установку снова."
fi
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
# Other nginx sites that claim the same domain would hide Kala
CONFLICTS=""
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -e "$f" ] || continue
  [ "$(readlink -f "$f")" = /etc/nginx/sites-available/kala ] && continue
  grep -qE "server_name[^;]*[[:space:]]$DOMAIN[[:space:];]" "$f" 2>/dev/null && CONFLICTS="$CONFLICTS $f"
done
if [ -n "$CONFLICTS" ]; then
  if [ "$TAKEOVER" = 1 ]; then
    mkdir -p /etc/nginx/kala-disabled
    for f in $CONFLICTS; do
      mv "$f" /etc/nginx/kala-disabled/ && warn "Отключён сайт $f (копия: /etc/nginx/kala-disabled/$(basename "$f"))"
    done
  else
    warn "Домен $DOMAIN уже занят другим сайтом nginx:$CONFLICTS"
    echo "  Из-за этого https://$DOMAIN открывает старый сайт, а не Kala."
    echo "  Отдать домен Kala (старый сайт отключится, копия сохранится):"
    echo "    sudo bash $SRC_DIR/install.sh $DOMAIN $EMAIL --takeover"
    die "Установка остановлена из-за конфликта домена"
  fi
fi
nginx -t || die "Ошибка в конфигурации nginx (см. выше)"
systemctl enable nginx >/dev/null 2>&1
systemctl restart nginx || die "nginx не запустился: systemctl status nginx"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow OpenSSH >/dev/null
fi
curl -fsS -H "Host: $DOMAIN" http://127.0.0.1/api/health >/dev/null 2>&1 && echo "nginx → Kala ✓" || warn "nginx не проксирует на Kala"

log "5/6 SSL сертификат"
MYIP="$(curl -4 -fsS https://api.ipify.org 2>/dev/null || true)"
DNSIP="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')"
echo "IP сервера: ${MYIP:-?}   $DOMAIN указывает на: ${DNSIP:-нет записи}"
[ -n "$MYIP" ] && [ -n "$DNSIP" ] && [ "$MYIP" != "$DNSIP" ] && \
  warn "Домен указывает НЕ на этот сервер (или через Cloudflare-прокси). Поставьте A-запись $DOMAIN → $MYIP."
DOMS="-d $DOMAIN"
[ -n "$(getent ahostsv4 "www.$DOMAIN" | head -1)" ] && DOMS="$DOMS -d www.$DOMAIN"
SSL_OK=0
if certbot --nginx $DOMS --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring; then SSL_OK=1
elif [ "$DOMS" != "-d $DOMAIN" ] && certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring; then SSL_OK=1
fi
[ "$SSL_OK" = 1 ] && echo "SSL ✓" || warn "Сертификат не получен. Приложение пока можно подключить по адресу http://$DOMAIN"
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

echo
echo -e "\033[1;32m Сервер готов: $([ $SSL_OK = 1 ] && echo https || echo http)://$DOMAIN — можно подключаться из приложения.\033[0m"
echo " Дальше ставятся инструменты для ИИ (Android SDK, Godot…), это займёт 5-15 минут."

########################## ЧАСТЬ 2: инструменты ИИ ##########################
log "6/6 Инструменты для ИИ"
apt_try build-essential python3 python3-pip python3-venv python-is-python3 ffmpeg imagemagick jq sqlite3 \
  libfontconfig1 libxi6 libxrender1 libxcursor1 libxinerama1 libxrandr2 libgl1
for j in openjdk-17-jdk-headless openjdk-21-jdk-headless default-jdk-headless; do
  apt-get install -y -q "$j" >/dev/null 2>&1 && { echo "Java: $j"; break; }
done
JHOME="$(dirname "$(dirname "$(readlink -f "$(command -v javac 2>/dev/null || command -v java 2>/dev/null || echo /usr/bin/java)")")")"
[ -d "$JHOME" ] && sed -i "s#^Environment=JAVA_HOME=.*#Environment=JAVA_HOME=$JHOME#" /etc/systemd/system/kala.service

echo "· Claude Code CLI и OpenCode CLI"
npm install -g @anthropic-ai/claude-code opencode-ai --no-audit --no-fund >/dev/null 2>&1 || warn "CLI не установлены (позже: sudo npm i -g @anthropic-ai/claude-code)"

echo "· Браузер для ИИ (Chromium)"
node "$APP_DIR/node_modules/playwright-core/cli.js" install-deps chromium >/dev/null 2>&1 || warn "системные библиотеки для Chromium не установлены (ИИ попробует сам)"
sudo -u "$APP_USER" -H node "$APP_DIR/node_modules/playwright-core/cli.js" install chromium >/dev/null 2>&1 || warn "Chromium не скачан (скачается при первом запуске браузера)"

echo "· Android SDK"
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$ANDROID_HOME/cmdline-tools" && cd /tmp && \
  wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdtools.zip && \
  rm -rf cmdline-tools && unzip -q cmdtools.zip && rm -rf "$ANDROID_HOME/cmdline-tools/latest" && \
  mv cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" && rm -f cmdtools.zip || warn "Android cmdline-tools не скачались"
fi
if [ -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME" JAVA_HOME="$JHOME"
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
  "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null 2>&1 \
    || warn "Android SDK установлен не полностью"
  chown -R "$APP_USER:$APP_USER" "$ANDROID_HOME"
fi

echo "· Gradle"
if ! command -v gradle >/dev/null; then
  cd /tmp && wget -q https://services.gradle.org/distributions/gradle-8.14.3-bin.zip -O gradle.zip \
    && unzip -qo gradle.zip -d /opt && ln -sfn /opt/gradle-8.14.3/bin/gradle /usr/local/bin/gradle && rm -f gradle.zip \
    || warn "Gradle не установлен"
fi

echo "· Godot $GODOT_VERSION + шаблоны экспорта"
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
sudo -u "$APP_USER" mkdir -p "$APP_HOME/.config/godot"
if [ ! -f "$APP_HOME/debug.keystore" ] && command -v keytool >/dev/null; then
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
export/android/java_sdk_path = "$JHOME"
export/android/debug_keystore = "$APP_HOME/debug.keystore"
export/android/debug_keystore_user = "androiddebugkey"
export/android/debug_keystore_pass = "android"
EOF
  chown "$APP_USER:$APP_USER" "$GODOT_SETTINGS"
done

cat > /etc/profile.d/kala.sh <<EOF
export ANDROID_HOME=$ANDROID_HOME
export ANDROID_SDK_ROOT=$ANDROID_HOME
export JAVA_HOME=$JHOME
export PATH=\$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:\$HOME/.local/bin
export PIP_BREAK_SYSTEM_PACKAGES=1
EOF
systemctl daemon-reload && systemctl restart kala

log "Готово!"
echo "  Адрес для приложения: $([ $SSL_OK = 1 ] && echo https || echo http)://$DOMAIN"
echo "  Первый созданный аккаунт = владелец."
echo "  Логи:          journalctl -u kala -f"
echo "  Диагностика:   sudo bash $SRC_DIR/doctor.sh $DOMAIN"
echo "  Обновить:      cd $(dirname "$SRC_DIR") && git pull && sudo bash server/install.sh $DOMAIN $EMAIL"
