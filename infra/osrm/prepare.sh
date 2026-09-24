#!/usr/bin/env bash
# One-time: build OSRM MLD graphs for the Hyderabad bbox, car + foot profiles.
#
#   telangana.osm.pbf (~100 MB) ─osmium extract─► hyderabad.osm.pbf (~tens of MB)
#     ─► osrm-extract ─► osrm-partition ─► osrm-customize      (×2 profiles)
#
# Clipping first is what keeps preprocessing inside ~8 GB RAM and the artefacts well under
# the 2 GiB GitHub release-asset cap (BUILD_PLAN Stage 0). Output: infra/osrm/data/{car,foot}/
# Re-run is idempotent; pass --force to rebuild.
set -euo pipefail
cd "$(dirname "$0")"
source ../hyderabad.env

FORCE=${1:-}
DATA=data
mkdir -p "$DATA"

command -v docker >/dev/null || { echo "prepare: docker is required" >&2; exit 1; }
command -v osmium >/dev/null || {
  echo "prepare: osmium is required — 'brew install osmium-tool' or 'apt-get install osmium-tool'" >&2
  exit 1
}

SRC="$DATA/source.osm.pbf"
HYD="$DATA/hyderabad.osm.pbf"

if [[ ! -f "$SRC" || "$FORCE" == "--force" ]]; then
  echo "prepare: downloading $OSM_SOURCE_URL"
  curl -fL --retry 3 -o "$SRC.part" "$OSM_SOURCE_URL" && mv "$SRC.part" "$SRC"
fi

if [[ ! -f "$HYD" || "$FORCE" == "--force" ]]; then
  echo "prepare: clipping to Hyderabad bbox $HYD_BBOX"
  osmium extract --bbox "$HYD_BBOX" --strategy smart --overwrite -o "$HYD" "$SRC"
fi

for profile in car foot; do
  out="$DATA/$profile"
  if [[ -f "$out/hyderabad.osrm.mldgr" && "$FORCE" != "--force" ]]; then
    echo "prepare: $profile already built"; continue
  fi
  rm -rf "$out" && mkdir -p "$out" && cp "$HYD" "$out/hyderabad.osm.pbf"
  echo "prepare: $profile — extract / partition / customize"
  docker run --rm -v "$PWD/$out:/data" "$OSRM_IMAGE" osrm-extract -p "/opt/$profile.lua" /data/hyderabad.osm.pbf
  docker run --rm -v "$PWD/$out:/data" "$OSRM_IMAGE" osrm-partition /data/hyderabad.osrm
  docker run --rm -v "$PWD/$out:/data" "$OSRM_IMAGE" osrm-customize /data/hyderabad.osrm
  rm "$out/hyderabad.osm.pbf"
done

du -sh "$DATA"/car "$DATA"/foot
echo "prepare: done — publish infra/osrm/data/{car,foot} as a release asset if each archive < 2 GiB, else R2/S3"
