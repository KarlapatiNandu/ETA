#!/usr/bin/env python3
"""Write empty stand-ins for Planetiler's three auxiliary sources (infra/tiles/prepare.sh --inland).

  water-polygons-split-3857.zip   ocean polygons     — Hyderabad is ~300 km from any coast;
                                                       lakes and rivers come from OSM itself
  natural_earth_vector.sqlite.zip  low-zoom (z0–6) boundaries/landcover — a city map lives at z10+
  lake_centerline.shp.zip          curved lake-name label lines — labels fall back to points

Together they are ~1.4 GB to download; for an inland city map they contribute nothing
visible. Standard library only, so it runs anywhere python3 does.
"""
import io, sqlite3, struct, sys, tempfile, zipfile
from pathlib import Path

WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]'
MERC = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",' + WGS84 + ',PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",0],PARAMETER["Standard_Parallel_1",0],PARAMETER["Auxiliary_Sphere_Type",0],UNIT["Meter",1]]'

def shp_header(shape_type: int) -> bytes:
    # ESRI shapefile header: big-endian file code + length (in 16-bit words), little-endian rest
    return struct.pack(">i5ii", 9994, 0, 0, 0, 0, 0, 50) + struct.pack("<ii4d4d", 1000, shape_type, 0, 0, 0, 0, 0, 0, 0, 0)

def dbf(field: str) -> bytes:
    hdr_len, rec_len = 32 + 32 + 1, 1 + 10
    head = struct.pack("<BBBBIHH20x", 0x03, 126, 1, 1, 0, hdr_len, rec_len)
    desc = struct.pack("<11sc4xBB14x", field.encode(), b"C", 10, 0)
    return head + desc + b"\x0d\x1a"

def shapefile_zip(path: Path, stem: str, shape_type: int, prj: str, field: str) -> None:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(f"{stem}.shp", shp_header(shape_type))
        z.writestr(f"{stem}.shx", shp_header(shape_type))
        z.writestr(f"{stem}.dbf", dbf(field))
        z.writestr(f"{stem}.prj", prj)

def natural_earth_zip(path: Path) -> None:
    with tempfile.TemporaryDirectory() as d:
        db = Path(d) / "natural_earth_vector.sqlite"
        sqlite3.connect(db).close()  # a valid, empty SQLite database
        with zipfile.ZipFile(path, "w") as z:
            z.write(db, "packages/natural_earth_vector.sqlite")

if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "data/sources")
    out.mkdir(parents=True, exist_ok=True)
    shapefile_zip(out / "water-polygons-split-3857.zip", "water_polygons", 5, MERC, "FID")
    shapefile_zip(out / "lake_centerline.shp.zip", "lake_centerline", 3, WGS84, "OSM_ID")
    natural_earth_zip(out / "natural_earth_vector.sqlite.zip")
    print(f"empty auxiliary sources written to {out}")
