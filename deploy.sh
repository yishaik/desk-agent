#!/usr/bin/env bash
# Desk Agent — one-shot deployment.
#
#   ./deploy.sh <domain> [console-domain]
#   e.g. ./deploy.sh agent.example.com oc.example.com
#
# What it does, in order:
#   1. Installs Docker if missing
#   2. Generates .env with fresh random tokens (idempotent — keeps an existing .env)
#   3. Opens ports 80/443 in iptables if the host firewall blocks them
#   4. Detects a 80/443 bind conflict (e.g. tailscaled) and binds Caddy to the
#      primary private IP via docker-compose.override.yml
#   5. Builds and starts the stack, waits for health + live HTTPS
#   6. Prints the wizard login URL
#
# Prerequisites you must do yourself BEFORE running:
#   - Two DNS A records pointing at this server's public IP:
#       <domain>          (the agent)
#       <console-domain>  (the Open Connector console)
#   - Cloud-level firewall (OCI security list/NSG, Hetzner firewall, etc.)
#     allowing TCP 80+443 in.
set -euo pipefail
trap 'echo "❌ deploy.sh failed at line $LINENO" >&2' ERR

DOMAIN="${1:-}"
CONSOLE_DOMAIN="${2:-}"

if [ -z "$DOMAIN" ]; then
  echo "usage: $0 <domain> [console-domain]" >&2
  exit 1
fi
if [ -z "$CONSOLE_DOMAIN" ]; then
  CONSOLE_DOMAIN="oc.${DOMAIN}"
fi

cd "$(dirname "$0")"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

# --- 1. Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Docker not found — installing"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker info >/dev/null 2>&1; then
  echo "docker is installed but not usable by this user (try: sudo usermod -aG docker \$USER && re-login, or run with sudo)" >&2
  exit 1
fi

# --- 2. .env ---------------------------------------------------------------
if [ -f .env ]; then
  say ".env exists — keeping it (delete it for a truly fresh install)"
else
  say "Generating .env with fresh tokens"
  umask 077
  cat > .env <<EOF
PAIR_TOKEN=$(openssl rand -hex 32)
OPEN_CONNECTOR_TOKEN=$(openssl rand -hex 32)
CONNECTOR_ENCRYPTION_KEY=$(openssl rand -hex 32)
CONNECTOR_ADMIN_TOKEN=$(openssl rand -hex 32)
DOMAIN=${DOMAIN}
CONSOLE_DOMAIN=${CONSOLE_DOMAIN}
CONSOLE_URL=https://${CONSOLE_DOMAIN}
CONNECTOR_ORIGIN=https://${DOMAIN}
CONNECTOR_ALLOWED_ACTIONS=*
LOG_LEVEL=info
NODE_ENV=production
EOF
fi

# --- 3. Host firewall (Oracle/Ubuntu images ship a restrictive INPUT chain) -
if command -v iptables >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  for PORT in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT 2>/dev/null; then
      say "Opening port ${PORT} in iptables"
      sudo iptables -I INPUT 1 -p tcp --dport "$PORT" -m state --state NEW -j ACCEPT
    fi
  done
  sudo netfilter-persistent save >/dev/null 2>&1 || true
fi

# --- 4. Port conflict → bind Caddy to a specific IP -------------------------
# On a shared server set DESK_BIND_IP to the (secondary) private IP dedicated
# to this stack; otherwise a conflict falls back to the primary private IP.
BIND_IP="${DESK_BIND_IP:-}"
if [ -z "$BIND_IP" ]; then
  for PORT in 80 443; do
    if ss -tln "( sport = :${PORT} )" 2>/dev/null | grep -q LISTEN; then
      BIND_IP="$(hostname -I | awk '{print $1}')"
    fi
  done
fi
if [ -n "$BIND_IP" ]; then
  say "Port 80/443 already has a listener — binding Caddy to ${BIND_IP} only"
  cat > docker-compose.override.yml <<EOF
services:
  caddy:
    ports: !override
      - "${BIND_IP}:80:80"
      - "${BIND_IP}:443:443"
EOF
else
  rm -f docker-compose.override.yml
fi

# --- 5. DNS sanity (warn only) ---------------------------------------------
PUBLIC_IP="$(curl -s --max-time 8 ifconfig.me || true)"
for NAME in "$DOMAIN" "$CONSOLE_DOMAIN"; do
  RESOLVED="$(getent ahostsv4 "$NAME" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  if [ -z "$RESOLVED" ]; then
    echo "⚠️  ${NAME} does not resolve yet — create its A record (→ ${PUBLIC_IP:-this server}), HTTPS will fail until it does"
  elif [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
    echo "⚠️  ${NAME} resolves to ${RESOLVED}, but this server's public IP is ${PUBLIC_IP}"
  fi
done

# --- 6. Up + wait ----------------------------------------------------------
say "Building and starting the stack (first build takes a few minutes)"
docker compose up -d --build

say "Waiting for the agent to become healthy"
for _ in $(seq 1 60); do
  STATUS="$(docker inspect --format '{{.State.Health.Status}}' desk-agent 2>/dev/null || echo starting)"
  [ "$STATUS" = "healthy" ] && break
  sleep 5
done
if [ "${STATUS:-}" != "healthy" ]; then
  echo "agent did not become healthy — check: docker logs desk-agent" >&2
  exit 1
fi

say "Waiting for live HTTPS on https://${DOMAIN} (certificate issuance)"
HTTP_OK=""
for _ in $(seq 1 60); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${DOMAIN}/" || true)"
  if [ "$CODE" = "200" ]; then HTTP_OK=1; break; fi
  sleep 5
done
if [ -z "$HTTP_OK" ]; then
  echo "site is not serving 200 yet — check DNS and: docker logs desk-caddy" >&2
  exit 1
fi

# --- 7. Done ---------------------------------------------------------------
PAIR_TOKEN="$(grep '^PAIR_TOKEN=' .env | cut -d= -f2)"

say "Deployed!"
echo
echo "Open the setup wizard in your browser:"
echo "    https://${DOMAIN}/"
echo
echo "When prompted, enter the PAIR_TOKEN from .env (shown below once)."
echo "This token is NOT printed to logs — copy it now or retrieve from .env later."
echo
# Display token to terminal only (not captured in script logs or Caddy access logs)
printf '    PAIR_TOKEN: %s\n' "$PAIR_TOKEN"
echo
echo "Console (after setup, login with the admin token shown once in the wizard):"
echo "    https://${CONSOLE_DOMAIN}"
