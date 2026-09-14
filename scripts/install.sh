#!/usr/bin/env bash
# Circuit Barn installer — Ubuntu 24.04+ with an NVIDIA GPU.
# Safe to re-run: it only installs what's missing and rebuilds the apps.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(id -un)"
export DEBIAN_FRONTEND=noninteractive

say()  { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] && fail "run this as your normal user, not root (it uses sudo where needed)"
command -v sudo >/dev/null || fail "sudo is required"

say "Checking the GPU"
if command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1; then
  ok "$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader)"
else
  echo "  No working NVIDIA driver found. Install it first:"
  echo "    sudo ubuntu-drivers install && sudo reboot"
  fail "then run this script again"
fi

say "Base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg >/dev/null
ok "curl, git"

say "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
sudo npm install -g npm@11 >/dev/null 2>&1 || true
ok "node $(node -v), npm $(npm -v)"

say "PostgreSQL"
if ! command -v psql >/dev/null; then
  sudo apt-get install -y -qq postgresql postgresql-contrib >/dev/null
fi
sudo systemctl enable --now postgresql >/dev/null
ok "$(psql --version)"

say "Ollama"
if ! command -v ollama >/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh >/dev/null 2>&1
fi
sudo systemctl enable --now ollama >/dev/null 2>&1 || true
ok "$(ollama --version 2>/dev/null | head -1)"

say "Database"
ENV_FILE="$ROOT/api/.env"
if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  ok "api/.env already exists — keeping it"
else
  DB_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -qc "CREATE ROLE circuitbarn LOGIN PASSWORD '$DB_PASS';" 2>/dev/null \
    || sudo -u postgres psql -qc "ALTER ROLE circuitbarn LOGIN PASSWORD '$DB_PASS';"
  sudo -u postgres psql -qc "CREATE DATABASE circuitbarn OWNER circuitbarn;" 2>/dev/null || true
  mkdir -p "$ROOT/data/images"
  cat > "$ENV_FILE" <<EOF
DATABASE_URL="postgresql://circuitbarn:$DB_PASS@localhost:5432/circuitbarn"
JWT_SECRET=$(openssl rand -hex 32)
OLLAMA_URL=http://127.0.0.1:11434
COMFY_URL=http://127.0.0.1:8188
CHAT_MODEL=qwen3:8b
VISION_MODEL=qwen2.5vl:7b
SD_CHECKPOINT=RealVisXL_Lightning.safetensors
SD_CHECKPOINT_HQ=RealVisXL_V5.safetensors
IMAGES_DIR=$ROOT/data/images
EOF
  chmod 600 "$ENV_FILE"
  ok "database created, api/.env written"
fi

say "Building the API"
cd "$ROOT/api"
npm install --no-audit --no-fund >/dev/null
# npm 11 blocks native build scripts by default; these are the ones we need
for p in bcrypt esbuild @parcel/watcher msgpackr-extract unrs-resolver workerd; do
  npm install-scripts approve "$p" >/dev/null 2>&1 || true
done
npm rebuild >/dev/null 2>&1 || true
npx prisma generate >/dev/null
npx prisma db push --skip-generate >/dev/null
npm run build >/dev/null
ok "api built"

say "Building the UI"
cd "$ROOT/ui"
npm install --no-audit --no-fund >/dev/null
npm run build >/dev/null 2>&1
ok "ui built"

say "Services"
sudo tee /etc/systemd/system/circuitbarn-api.service >/dev/null <<EOF
[Unit]
Description=Circuit Barn API
After=network-online.target postgresql.service ollama.service
Wants=postgresql.service

[Service]
User=$APP_USER
WorkingDirectory=$ROOT/api
EnvironmentFile=$ROOT/api/.env
ExecStart=$(command -v node) dist/main.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo tee /etc/systemd/system/circuitbarn-ui.service >/dev/null <<EOF
[Unit]
Description=Circuit Barn UI
After=network-online.target circuitbarn-api.service

[Service]
User=$APP_USER
WorkingDirectory=$ROOT/ui
Environment=PORT=3000
ExecStart=$(command -v npm) start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
# the api restarts the image service itself when the gpu needs freeing
echo "$APP_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart comfyui" | sudo tee /etc/sudoers.d/circuitbarn-comfy >/dev/null
sudo chmod 440 /etc/sudoers.d/circuitbarn-comfy
sudo systemctl daemon-reload
sudo systemctl enable --now circuitbarn-api circuitbarn-ui >/dev/null
sudo systemctl restart circuitbarn-api circuitbarn-ui
ok "circuitbarn-api and circuitbarn-ui running"

if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  say "Firewall"
  sudo ufw allow OpenSSH >/dev/null
  sudo ufw allow 3000/tcp comment "Circuit Barn UI" >/dev/null
  sudo ufw allow 3001/tcp comment "Circuit Barn API" >/dev/null
  ok "ports 3000 and 3001 open"
fi

IP="$(hostname -I | awk '{print $1}')"
printf '\n\033[1;32mDone.\033[0m Open  \033[1mhttp://%s:3000\033[0m  from any device on your network.\n' "$IP"
printf 'The first account you create becomes the admin.\n'
printf 'Want image generation? Run  ./scripts/install-images.sh  (about 25 GB of models).\n\n'
