#!/usr/bin/env bash
# VPS bootstrap for coturn TURN server.
# Run as root on a fresh Ubuntu 24.04 VPS.
set -euo pipefail

echo "=== Installing Docker ==="
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "=== Installing Tailscale ==="
curl -fsSL https://tailscale.com/install.sh | sh

echo "=== Configuring UFW ==="
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw allow 3478/udp comment "coturn TURN"
ufw allow 49152:49200/udp comment "coturn relay range"
ufw --force enable

echo "=== Enabling unattended upgrades ==="
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "=== Done ==="
echo "Next steps:"
echo "  1. Run: tailscale up"
echo "  2. Set TURN_SECRET in .env and run: docker compose up -d"
