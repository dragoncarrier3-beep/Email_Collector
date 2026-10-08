#!/bin/bash
# Run this script on a fresh Ubuntu/Debian VPS as root
# Usage: bash setup.sh

set -e

echo "=== Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "=== Installing PM2 ==="
npm install -g pm2

echo "=== Creating app directory ==="
mkdir -p /root/realman/data

echo "=== Copying files ==="
# Files should already be in /root/realman/ (uploaded via scp or sftp)
cd /root/realman

echo "=== Installing dependencies ==="
npm install

echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. cp .env.example .env"
echo "  2. nano .env   ← fill in GH_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD"
echo "  3. pm2 start index.js --name realman"
echo "  4. pm2 save && pm2 startup   ← auto-restart on reboot"
echo "  5. pm2 logs realman          ← watch live logs"
