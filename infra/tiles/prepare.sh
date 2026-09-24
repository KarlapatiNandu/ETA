#!/usr/bin/env bash
# One-time: render Hyderabad vector tiles (OpenMapTiles schema) with Planetiler (ADR-0005).
# Reuses the clipped extract from infra/osrm/prepare.sh so tiles and routing agree.
# Output: infra/tiles/data/hyderabad.mbtiles, served by tileserver-gl in docker-compose.dev.yml.
set -euo pipefail
cd "$(dirname "$0")"
source ../hyderabad.env

HYD=../osrm/data/hyderabad.osm.pbf
[[ -f "$HYD" ]] || { echo "tiles: run infra/osrm/prepare.sh first (needs $HYD)" >&2; exit 1; }
#
# Usage: prepare.sh [--inland|--full] [--force]
#   --inland (default)  empty stand-ins for ocean polygons, Natural Earth and lake centerlines
#                       (empty_sources.py). ~1.4 GB less to download; nothing visible is lost for
#                       an inland city at z10+. Lake labels become points instead of curves.
#   --full              let Planetiler --download the real auxiliary sources (one-time, cached).
MODE=--inland; FORCE=
for a in "$@"; do case "$a" in --inland|--full) MODE=$a ;; --force) FORCE=1 ;; esac; done

mkdir -p data
[[ -f data/hyderabad.mbtiles && -z "$FORCE" ]] && { echo "tiles: already built"; exit 0; }

AUX=(--download)
if [[ "$MODE" == --inland ]]; then
  python3 empty_sources.py data/sources
  AUX=()
fi

cp "$HYD" data/hyderabad.osm.pbf
docker run --rm -e JAVA_TOOL_OPTIONS="-Xmx2g" -v "$PWD/data:/data" -w / "$PLANETILER_IMAGE" \
  --osm-path=/data/hyderabad.osm.pbf --bounds="$HYD_BBOX" ${AUX[@]+"${AUX[@]}"} \
  --download-dir=/data/sources --output=/data/hyderabad.mbtiles --force
rm -rf data/hyderabad.osm.pbf data/tmp
du -sh data/hyderabad.mbtiles
