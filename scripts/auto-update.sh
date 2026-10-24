#!/bin/sh
# Polls the git remote and rebuilds the botter service from source when the
# branch moves. Runs inside the updater service of docker-compose.yml.
set -u

INTERVAL="${UPDATE_INTERVAL:-300}"
BRANCH="${UPDATE_BRANCH:-master}"

log() {
  printf '{"time":"%s","app":"botter-updater","level":"%s","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
}

apk add --no-cache git >/dev/null
git config --global --add safe.directory /repo
# A checkout made on Windows has CRLF line endings, which git in this Linux
# container sees as local changes. Match the checkout instead.
if [ -n "$(git status --porcelain --untracked-files=no)" ] && [ -z "$(git -c core.autocrlf=true status --porcelain --untracked-files=no)" ]; then
  git config --global core.autocrlf true
  log info "checkout has CRLF line endings, matching them"
fi
log info "watching origin/$BRANCH every ${INTERVAL}s"

while true; do
  if git fetch --quiet origin "$BRANCH"; then
    current=$(git rev-parse HEAD)
    latest=$(git rev-parse "origin/$BRANCH")
    if [ "$current" != "$latest" ]; then
      if git merge --ff-only --quiet "origin/$BRANCH"; then
        log info "rebuilding at $latest"
        if docker compose up -d --build botter; then
          log info "updated to $latest"
        else
          log error "rebuild failed at $latest"
        fi
      else
        log error "local changes block a fast-forward to $latest"
      fi
    fi
  else
    log warn "git fetch failed"
  fi
  sleep "$INTERVAL"
done
