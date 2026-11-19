# Project pages that read COGs from S3

New versions of `project1.html`, `project2.html`, `project3.html` and `project5.html`.
The originals in the parent folder are unchanged.

Instead of R2 XYZ tile folders, each overlay reads a Cloud Optimized GeoTIFF straight from
`s3://drone-cogs-sourav` (us-east-2) using range requests
(Leaflet 1.9.4 + georaster + georaster-layer-for-leaflet). A layer's file is only opened
when the layer is switched on.

To publish: copy the four HTML files **and** the `js/` and `css/` folders into the site root.

## Before it works on the live site

The bucket policy only allows public `s3:GetObject` on `drone-cogs-sourav/cogs/*`, but the
COGs sit at the bucket root (`Project_1_Bridge_Crack/...` etc.), so browsers get 403.
Either:

* change the policy resource to `arn:aws:s3:::drone-cogs-sourav/Project_*` (keeps
  `manifest.json` and `convert.log` private), or
* copy the `Project_*` folders under `cogs/` and set `DEFAULT_BASE` in `js/cog-layers.js`
  to `https://drone-cogs-sourav.s3.us-east-2.amazonaws.com/cogs/`.

CORS is already fine (GET/HEAD with `Range` allowed from `https://prosperiastate.github.io`
and `http://localhost:8000`).

## Testing locally

Add `?cog_base=<url>` to point the pages at another copy of the COGs, for example a local
server with Range support on port 8001:
`http://localhost:8000/project2.html?cog_base=http://localhost:8001/`

## Layer kinds (`kind` in each page)

| kind | used for | rendering |
|---|---|---|
| `rgba` | 4-band orthos and thermal JPG mosaics | band 4 is alpha |
| `rgb` | 3-band 2026 Astro orthos | black = transparent |
| `hillshade` | 1-band Byte hillshades | gray, 255 = transparent |
| `dem` | 1-band Float32 DEMs | colour ramp, 2-98 % range, legend shown |
| `thermal` | 1-band Float32 radiometric thermal | heat ramp, 0 = transparent, legend shown |

Hillshades and `Perry_60ftRGB_clipped2.tif` store a custom CRS without an EPSG code, so the
page sets `epsg` (6344 for UTM 15N files, 3857 for the Oskaloosa hillshades).
