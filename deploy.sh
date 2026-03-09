#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   SERVER=user@host APP_DIR=/opt/assist-bot ./deploy.sh
# Optional:
#   BRANCH=main PM2_PROCESS=assist-bot SERVICE_NAME=assist-bot

REPO_SSH="git@github.com:horumiko/assist-bot.git"
BRANCH="${BRANCH:-main}"
SERVER="${SERVER:-}"
APP_DIR="${APP_DIR:-}"
PM2_PROCESS="${PM2_PROCESS:-assist-bot}"
SERVICE_NAME="${SERVICE_NAME:-}"

if [[ -z "$SERVER" || -z "$APP_DIR" ]]; then
  echo "Set SERVER and APP_DIR. Example: SERVER=user@host APP_DIR=/opt/assist-bot ./deploy.sh"
  exit 1
fi

echo "[1/3] Push local branch '$BRANCH' to origin"
git push origin "$BRANCH"

echo "[2/3] Update code on server: $SERVER:$APP_DIR"
ssh "$SERVER" "REPO_SSH='$REPO_SSH' APP_DIR='$APP_DIR' BRANCH='$BRANCH' PM2_PROCESS='$PM2_PROCESS' SERVICE_NAME='$SERVICE_NAME' bash -s" <<'REMOTE'
set -euo pipefail

mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [[ ! -d .git ]]; then
  git clone "$REPO_SSH" .
fi

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

npm ci
npm run build

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe "$PM2_PROCESS" >/dev/null 2>&1; then
    pm2 restart "$PM2_PROCESS"
  else
    pm2 start npm --name "$PM2_PROCESS" -- start
  fi
  pm2 save
elif [[ -n "$SERVICE_NAME" ]] && command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart "$SERVICE_NAME"
else
  echo "Code updated and built, but no process manager action was taken."
  echo "Set PM2_PROCESS or SERVICE_NAME to restart the bot automatically."
fi
REMOTE

echo "[3/3] Done"
