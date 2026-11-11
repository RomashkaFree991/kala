#!/usr/bin/env bash
# Kala diagnostics: sudo bash doctor.sh skkapap.fun   — пришлите вывод целиком.
D="${1:-skkapap.fun}"
PORT="$(cat /etc/kala.port 2>/dev/null || echo 3000)"
ok(){ echo -e "  \033[32m✓\033[0m $*"; }; bad(){ echo -e "  \033[31m✗\033[0m $*"; }
echo "== Kala doctor ($D, порт $PORT) =="
echo "ОС: $(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")  node: $(node -v 2>/dev/null || echo нет)"
systemctl is-active --quiet kala && ok "служба kala запущена" || bad "служба kala НЕ запущена"
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && ok "Kala отвечает на 127.0.0.1:$PORT" || bad "Kala не отвечает на 127.0.0.1:$PORT"
systemctl is-active --quiet nginx && ok "nginx запущен" || bad "nginx НЕ запущен"
echo "-- кто слушает 80/443:"; ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' | sed 's/^/   /'
curl -fsS -H "Host: $D" http://127.0.0.1/api/health >/dev/null 2>&1 && ok "nginx → Kala (http)" || bad "nginx не проксирует $D на Kala"
MYIP="$(curl -4 -fsS https://api.ipify.org 2>/dev/null)"; DNSIP="$(getent ahostsv4 "$D" | awk '{print $1; exit}')"
echo "-- IP сервера: ${MYIP:-?}  DNS $D → ${DNSIP:-нет}"
[ -n "$MYIP" ] && [ "$MYIP" = "$DNSIP" ] && ok "DNS указывает на этот сервер" || bad "DNS указывает не сюда (или Cloudflare-прокси)"
[ -d "/etc/letsencrypt/live/$D" ] && ok "сертификат есть: $(openssl x509 -enddate -noout -in /etc/letsencrypt/live/$D/fullchain.pem 2>/dev/null)" || bad "сертификата для $D нет"
curl -fsS --max-time 10 "https://$D/api/health" >/dev/null 2>&1 && ok "https://$D/api/health работает снаружи" || bad "https://$D не открывается"
curl -fsS --max-time 10 "http://$D/api/health" >/dev/null 2>&1 && ok "http://$D/api/health работает" || bad "http://$D не открывается"
echo "-- диск и inode:"; df -h / /tmp /var 2>/dev/null | sed 's/^/   /'; df -i / /tmp 2>/dev/null | sed 's/^/   /'
for d in /tmp /var/tmp /var/cache/apt /var/lib/apt/lists /var/lib/dpkg; do
  dd if=/dev/zero of="$d/.kala-wtest" bs=1M count=2 >/dev/null 2>&1 && ok "запись в $d" || bad "НЕ могу писать в $d"; rm -f "$d/.kala-wtest"
done
command -v gpgv >/dev/null && ok "gpgv есть" || bad "gpgv отсутствует (apt не может проверять подписи): sudo apt-get install --reinstall gpgv"
command -v ufw >/dev/null && echo "-- ufw: $(ufw status | head -1)"
echo "-- последние логи kala:"; journalctl -u kala -n 15 --no-pager 2>/dev/null | sed 's/^/   /'
echo "-- ошибки nginx:"; tail -n 5 /var/log/nginx/error.log 2>/dev/null | sed 's/^/   /'
