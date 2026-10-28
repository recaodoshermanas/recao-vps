#!/usr/bin/env bash
# Recao VPS · instalación inicial
# Uso (como root):  curl -fsSL https://raw.githubusercontent.com/recaodoshermanas/recao-vps/main/install.sh | bash
# Es seguro volver a ejecutarlo: reutiliza la clave del conector si ya existe.
set -euo pipefail

DOMAIN_MCP="${DOMAIN_MCP:-mcp.elrecao.com}"
REPO_RAW="https://raw.githubusercontent.com/recaodoshermanas/recao-vps/main"
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Ejecuta este script como root"; exit 1; }

say "1/8 Actualizando el sistema"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get install -y -q curl ca-certificates gnupg ufw fail2ban unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https nodejs git jq htop

say "2/8 Zona horaria y actualizaciones de seguridad automáticas"
timedatectl set-timezone Europe/Madrid || true
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now fail2ban

say "3/8 Memoria swap (2 GB)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "4/8 Firewall (SSH, HTTP, HTTPS)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

say "5/8 Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

say "6/8 Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi
mkdir -p /etc/caddy/sites
cat > /etc/caddy/Caddyfile <<EOF
# Cada servicio tiene su fichero en /etc/caddy/sites/
import /etc/caddy/sites/*.caddy
EOF
cat > /etc/caddy/sites/mcp.caddy <<EOF
${DOMAIN_MCP} {
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
		transport http {
			read_timeout 35m
			write_timeout 35m
		}
	}
}
EOF

say "7/8 Conector de Claude"
mkdir -p /opt/recao-mcp
curl -fsSL "$REPO_RAW/mcp/server.mjs" -o /opt/recao-mcp/server.mjs
if [ ! -f /etc/recao-mcp.env ]; then
  echo "MCP_SECRET=$(openssl rand -hex 32)" > /etc/recao-mcp.env
fi
chmod 600 /etc/recao-mcp.env
cat > /etc/systemd/system/recao-mcp.service <<'EOF'
[Unit]
Description=Recao VPS - conector MCP para Claude
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/recao-mcp.env
ExecStart=/usr/bin/node /opt/recao-mcp/server.mjs
WorkingDirectory=/root
Restart=always
RestartSec=3
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable recao-mcp
systemctl restart recao-mcp
systemctl reload caddy || systemctl restart caddy

say "8/8 Comprobando DNS y certificado"
MYIP=$(curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DNSIP=$(getent ahostsv4 "$DOMAIN_MCP" | awk 'NR==1{print $1}' || true)
SECRET=$(grep MCP_SECRET /etc/recao-mcp.env | cut -d= -f2)
OK=0
if [ "$DNSIP" != "$MYIP" ]; then
  echo "AVISO: $DOMAIN_MCP apunta a '${DNSIP:-nada}' y este servidor es $MYIP."
  echo "Crea o corrige el registro A 'mcp' en el DNS. Caddy reintentará el certificado solo."
else
  for i in $(seq 1 24); do
    if curl -fsS "https://$DOMAIN_MCP/health" >/dev/null 2>&1; then OK=1; break; fi
    sleep 5
  done
fi

echo
echo "============================================================"
if [ "$OK" = 1 ]; then
  echo " TODO LISTO. Dirección del conector (es una contraseña, no la compartas):"
else
  echo " Instalado, pero el HTTPS aún no responde (revisa el DNS)."
  echo " Cuando el DNS esté bien, esta será la dirección del conector:"
fi
echo
echo "   https://$DOMAIN_MCP/$SECRET/mcp"
echo
echo " Añádela en claude.ai > Ajustes > Conectores > Añadir conector personalizado"
echo "============================================================"
