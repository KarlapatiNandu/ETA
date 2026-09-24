#!/usr/bin/env bash
# Stage 0 exit criterion: both OSRM profiles answer a test route and the tile server
# returns a tile. Exit non-zero with the failing service named.
set -uo pipefail
# CBIT (Gandipet) → Mehdipatnam — a real bus corridor inside the Hyderabad bbox.
FROM="78.3197,17.3924"; TO="78.4386,17.3950"
TILE="14/11756/7388"   # z14 tile containing CBIT
fail=0

retry() { for _ in $(seq 1 30); do "$@" 2>/dev/null && return 0; sleep 2; done; return 1; }

route_ok() {
  curl -fsS "$1/route/v1/$2/$FROM;$TO?overview=false" | grep -q '"code":"Ok"'
}
for pair in "car http://127.0.0.1:5000 driving" "foot http://127.0.0.1:5001 foot"; do
  set -- $pair
  if retry route_ok "$2" "$3"; then echo "smoke: osrm-$1 ok"; else echo "smoke: osrm-$1 FAILED" >&2; fail=1; fi
done

tile_ok() {
  # Use the URL template the server advertises (tiles[0] in data.json) — that is what MapLibre
  # will request. The dataset id ("hyderabad") is NOT the path segment ("v3").
  local tpl url
  tpl=$(curl -fsS http://127.0.0.1:8080/data.json | grep -o '"tiles":\["[^"]*"' | head -1 | cut -d'"' -f4)
  [[ -n "$tpl" ]] || return 1
  url=${tpl/\{z\}\/\{x\}\/\{y\}/$TILE}
  url=${url/localhost/127.0.0.1}
  [[ $(curl -fsS -o /dev/null -w '%{http_code}' "$url") == 200 ]]
}
if retry tile_ok; then echo "smoke: tiles ok"; else echo "smoke: tiles FAILED" >&2; fail=1; fi

if retry sh -c 'docker compose -f infra/docker/docker-compose.dev.yml exec -T redis redis-cli ping | grep -q PONG'; then
  echo "smoke: redis ok"; else echo "smoke: redis FAILED" >&2; fail=1; fi

exit $fail
