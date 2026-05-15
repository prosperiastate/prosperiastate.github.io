#!/usr/bin/env python3
"""
iri_pipeline.py  —  Incremental IRI pipeline (combine of new_iri.py + gdb_3.py)

Usage:
    python iri_pipeline.py <input_folder> <output_folder> [options]

Schedule this to run every 5 minutes (cron example):
    */5 * * * * /usr/bin/python3 /path/to/iri_pipeline.py /data/raw /data/output >> /data/iri_pipeline.log 2>&1

Behaviour:
  - Scans <input_folder> subfolders for new RAW-*.csv files not yet processed.
  - Writes <stem>-whole.json and <stem>-segment.json into <output_folder> (mirrored subfolders).
  - Converts segment JSONs to GeoJSON features and APPENDS them to iri.geojson.
  - A small state file (.processed_files.json) tracks which RAW CSVs have already
    been processed so reruns are safe and only new files are touched.
"""

import argparse
import json
import math
import os
import re
import statistics
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
from shapely.geometry import LineString

# ============================================================
# SETTINGS
# ============================================================
OUTPUT_GEOJSON   = "iri.geojson"        # final GeoJSON (appended each run)
STATE_FILE       = ".processed_files.json"  # tracks already-processed RAW paths
CRS              = "EPSG:4326"

# ============================================================
# UNIT CONSTANTS
# ============================================================
M_PER_KM_TO_IN_PER_MILE = 63.36
KM_TO_MILE               = 0.621371

# ============================================================
# IRI CLASSIFICATION
# ============================================================
def classify_iri(iri_in_mi):
    if iri_in_mi < 85:
        return "Excellent", "#2E7D32"
    elif iri_in_mi < 105:
        return "Good", "#8BC34A"
    elif iri_in_mi < 125:
        return "Fair", "#FFFF00"
    elif iri_in_mi < 145:
        return "Acceptable", "#FF9800"
    return "Bad", "#D32F2F"

# ============================================================
# USA BOUNDING BOX CHECK (rough; includes AK & HI)
# ============================================================
def is_in_usa(lat, lon):
    return (18.0 <= lat <= 72.0) and (-180.0 <= lon <= -64.0)

# ============================================================
# FILENAME PARSER
# ============================================================
ROAD_TYPES = {"highway", "county_road", "city_street", "granular_road", "granular"}
SURFACES   = {"concrete", "asphalt", "granular"}
DIRECTIONS = {"north", "south", "east", "west"}

def parse_filename(fname):
    base = os.path.basename(fname)
    base = re.sub(r'-segment\.json$', '', base, flags=re.IGNORECASE)
    base = re.sub(r'\.csv.*$',        '', base, flags=re.IGNORECASE)
    base = re.sub(r'^RAW-',           '', base, flags=re.IGNORECASE)

    dt_match = re.search(r'-(\d{4}-\d{2}-\d{2})-(\d{2}-\d{2}-\d{2})$', base)
    collect_dt = collect_tm = None
    if dt_match:
        collect_dt = dt_match.group(1)
        collect_tm = dt_match.group(2).replace('-', ':')
        base = base[:dt_match.start()]

    parts = base.split('-')
    if len(parts) < 3:
        return _empty_meta(collect_dt, collect_tm)

    vehicle     = parts[0].lower()
    sample_rate = None
    m = re.match(r'(\d+)hz', parts[1].lower())
    if m:
        sample_rate = int(m.group(1))
    mount_type = parts[2].lower()
    rest = parts[3:]

    surface = road_type = direction = None
    if rest and rest[-1].lower() in SURFACES:
        surface = rest.pop().lower()
    if rest:
        rt = rest[-1].lower().replace(' ', '_')
        if rt in ROAD_TYPES:
            road_type = rt
            rest.pop()
    if rest:
        cand = rest[-1].lower()
        if cand in DIRECTIONS:
            direction = cand
            rest.pop()
        elif cand == 'direction':
            rest.pop()

    road_tokens = [t for t in rest if t.lower() != 'direction']
    road = '-'.join(road_tokens).strip('- ').strip()

    return {
        'vehicle': vehicle, 'sample_rate': sample_rate, 'mount_type': mount_type,
        'road': road if road else None, 'direction': direction,
        'road_type': road_type, 'surface': surface,
        'date': collect_dt, 'time': collect_tm,
    }

def _empty_meta(dt, tm, vehicle=None, sample_rate=None, mount_type=None):
    return {
        'vehicle': vehicle, 'sample_rate': sample_rate, 'mount_type': mount_type,
        'road': None, 'direction': None, 'road_type': None, 'surface': None,
        'date': dt, 'time': tm,
    }

# ============================================================
# IRI MATH  (iri_astm / iri_methods — unchanged)
# ============================================================
def _IRI(PROF, NSAMP, K1, K2, C, MU):
    DX = 0.0254; BASE = 0.25; UNITSC = 1000.0
    AMAT, BMAT, CMAT = _SETABC(K1, K2, C, MU)
    ST, PR = _SETSTM(DX / (80.0 / 3.6), AMAT, BMAT)
    IBASE = max(int(BASE / DX + 0.5), 1)
    SFPI  = UNITSC / (DX * IBASE)
    I11   = min(int(11.0 / DX + 0.5) + 1, NSAMP)
    XIN   = [0.0] * 4
    XIN[0] = UNITSC * (PROF[I11] - PROF[1]) / (DX * I11)
    XIN[2] = XIN[0]
    NSAMP -= IBASE
    for I in range(NSAMP):
        PROF[I] = SFPI * (PROF[I + IBASE] - PROF[I])
    PROF = _STFILT(PROF, NSAMP, ST, PR, CMAT, XIN)
    return round(sum(abs(PROF[I]) for I in range(NSAMP)) / NSAMP, 3)

def _SETABC(K1, K2, C, MU):
    AMAT = [[0.0]*4 for _ in range(4)]; BMAT = [0.0]*4; CMAT = [0.0]*4
    AMAT[0][1]=1.0; AMAT[2][3]=1.0
    AMAT[1][0]=-K2; AMAT[1][1]=-C; AMAT[1][2]=K2; AMAT[1][3]=C
    AMAT[3][0]=K2/MU; AMAT[3][1]=C/MU; AMAT[3][2]=-((K1+K2)/MU); AMAT[3][3]=-(C/MU)
    BMAT[3]=K1/MU; CMAT[0]=-1.0; CMAT[2]=1.0
    return AMAT, BMAT, CMAT

def _SETSTM(DT, A, B):
    A1=[[0.0]*4 for _ in range(4)]; A2=[[0.0]*4 for _ in range(4)]
    ST=[[0.0]*4 for _ in range(4)]; PR=[0.0]*4
    for J in range(4): A1[J][J]=1.0; ST[J][J]=1.0
    ITER=0; MORE=True
    while MORE:
        ITER+=1; MORE=False
        for J in range(4):
            for I in range(4):
                A2[I][J] = sum(A1[I][K]*A[K][J] for K in range(4))
        for J in range(4):
            for I in range(4):
                A1[I][J] = A2[I][J]*DT/ITER
                if ST[I][J]+A1[I][J] != ST[I][J]: MORE=True
                ST[I][J] += A1[I][J]
    A = np.linalg.inv(A); TEMP=[[0.0]*4 for _ in range(4)]
    for I in range(4):
        PR[I] = -sum(A[I][K]*B[K] for K in range(4))
    for J in range(4):
        for I in range(4):
            TEMP[J][I] = sum(A[J][K]*ST[K][I] for K in range(4))
        for K in range(4):
            PR[J] += TEMP[J][K]*B[K]
    return ST, PR

def _STFILT(PROF, NSAMP, ST, PR, C, XIN):
    X=list(XIN); XN=[0.0]*4
    for I in range(NSAMP):
        for J in range(4):
            XN[J] = PR[J]*PROF[I] + sum(X[K]*ST[J][K] for K in range(4))
        X=list(XN)
        PROF[I] = X[0]*C[0]+X[1]*C[1]+X[2]*C[2]+X[3]*C[3]
    return PROF

def _my_integration(y1, y2, period): return (y1+y2)*period/2

def _A_to_V(acce_list, samp_freq):
    velocity=[0]; period=1.0/samp_freq; pre_acc=0
    for Acce in acce_list:
        velocity.append(velocity[-1]+_my_integration(pre_acc, Acce, period))
        pre_acc=Acce
    del velocity[0]; return velocity

def _V_to_X(velo_list, samp_freq):
    displacement=[0]; period=1.0/samp_freq; pre_vel=0
    for Vel in velo_list:
        displacement.append(displacement[-1]+_my_integration(pre_vel, Vel, period))
        pre_vel=Vel
    del displacement[0]; return displacement

def _Ft_to_Fx(input_list, delta_x):
    profile_x=[0]
    if delta_x<=0 or not input_list: return input_list[:]
    ratio=delta_x/0.0254
    num_of_increment=max(int(ratio)+(1 if ratio-int(ratio)>0.5 else 0), 1)
    for index in range(len(input_list)-1):
        increment=(input_list[index+1]-input_list[index])/num_of_increment
        for num in range(num_of_increment):
            profile_x.append(input_list[index]+increment*num)
    profile_x.append(input_list[-1]); return profile_x

def _IRI_computation(acc_list, speed, freq, K1, K2, C, MU):
    list_len=len(acc_list)
    distance=round(speed*(list_len/freq/3600), 3)
    delta_x=distance*1000/list_len
    Vz=_A_to_V(acc_list, freq); Xz=_V_to_X(Vz, freq)
    Xz_profile=_Ft_to_Fx(Xz, delta_x)
    prof_len=len(Xz_profile)
    aviri=_IRI(Xz_profile, prof_len-2, K1, K2, C, MU)
    return aviri, distance

def _haversine_km(lat1, lon1, lat2, lon2):
    R=6371.0
    phi1,phi2=math.radians(lat1),math.radians(lat2)
    dphi=math.radians(lat2-lat1); dlambda=math.radians(lon2-lon1)
    a=math.sin(dphi/2)**2+math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return R*2*math.atan2(math.sqrt(a), math.sqrt(1-a))

def _gps_distance_km(lat, lon):
    total=0.0
    for i in range(1, len(lat)):
        if math.isnan(lat[i-1]) or math.isnan(lat[i]): continue
        total+=_haversine_km(lat[i-1], lon[i-1], lat[i], lon[i])
    return total

TRUCK_PARAMS = dict(K1=653.0, K2=63.0, C=6.0, MU=0.15)

# ============================================================
# CSV LOADERS
# ============================================================
def load_raw(path, col_acc, col_speed, col_lat=1, col_lon=2):
    df=pd.read_csv(path, header=0)
    acc  =pd.to_numeric(df.iloc[:, col_acc],   errors="coerce").fillna(0).tolist()
    speed_vals=pd.to_numeric(df.iloc[:, col_speed], errors="coerce").dropna()
    lat  =pd.to_numeric(df.iloc[:, col_lat],   errors="coerce").tolist()
    lon  =pd.to_numeric(df.iloc[:, col_lon],   errors="coerce").tolist()
    speed=float(speed_vals.mean()) if len(speed_vals) else 0.0
    return acc, speed, lat, lon

def calc_offset(wn_path, col_acc):
    df=pd.read_csv(wn_path, header=0)
    vals=pd.to_numeric(df.iloc[:, col_acc], errors="coerce").dropna()
    return float(vals.mean()) if len(vals) else 9.8

def calc_stdev(acc_raw):
    return round(statistics.stdev(acc_raw), 3) if len(acc_raw) > 1 else 0.0

def _safe_stem(raw_path: str) -> str:
    name=Path(raw_path).name
    if name.startswith("RAW-"): name=name[4:]
    stem=Path(name).stem
    return "".join(ch if ch.isalnum() or ch in ("-","_") else "_" for ch in stem)

# ============================================================
# PROCESS WHOLE  (writes -whole.json, returns result + path)
# ============================================================
def process_whole(raw_path, wn_path, col_acc, col_speed, freq, params, out_dir):
    acc_raw, speed, lat, lon = load_raw(raw_path, col_acc, col_speed)
    offset = calc_offset(wn_path, col_acc) if wn_path else 9.8
    acc_list = [float(a)-offset for a in acc_raw]
    aviri, dist_speed_km = _IRI_computation(acc_list, speed, freq, **params)
    dist_gps_km = _gps_distance_km(lat, lon)
    dist_km = dist_gps_km if dist_gps_km > 0 else dist_speed_km
    dist_mi = round(dist_km/1.60934, 3)
    result = {
        "iris": [aviri],
        "distance_km": round(dist_km, 3),
        "distance_mi": dist_mi,
        "startPositions": [[lat[0], lon[0]]],
        "endPositions":   [[lat[-1], lon[-1]]],
        "speed": round(speed, 3),
        "stdev": calc_stdev(acc_raw),
    }
    stem = _safe_stem(str(raw_path))
    out_path = Path(out_dir) / f"{stem}-whole.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    return result, out_path

# ============================================================
# PROCESS SEGMENT  (writes -segment.json, returns result + path)
# ============================================================
def process_segment(raw_path, wn_path, col_acc, col_speed, freq, params, seg_len_miles, out_dir):
    acc_raw, speed, lat, lon = load_raw(raw_path, col_acc, col_speed)
    offset = calc_offset(wn_path, col_acc) if wn_path else 9.8

    n_rows = len(acc_raw)
    seg_len_km = seg_len_miles * 1.60934

    cum_km = [0.0]*n_rows
    for i in range(1, n_rows):
        if math.isnan(lat[i-1]) or math.isnan(lat[i]):
            cum_km[i]=cum_km[i-1]; continue
        cum_km[i]=cum_km[i-1]+_haversine_km(lat[i-1], lon[i-1], lat[i], lon[i])

    total_km = cum_km[-1]
    n_full = math.floor(total_km/seg_len_km)
    include_last = (total_km-n_full*seg_len_km)>1e-9
    n_seg = n_full+(1 if include_last else 0)

    b_lat=[lat[0] if not math.isnan(lat[0]) else 0.0]
    b_lon=[lon[0] if not math.isnan(lon[0]) else 0.0]
    b_idx=[0]; b_dist=[0.0]; j=1

    for k in range(1, n_seg+1):
        target=min(seg_len_km*k, total_km)
        while j<n_rows-1 and cum_km[j]<target: j+=1
        hi,lo=j,max(0,j-1)
        d_lo,d_hi=cum_km[lo],cum_km[hi]
        t=0.0 if d_hi==d_lo else max(0.0, min(1.0, (target-d_lo)/(d_hi-d_lo)))
        lat_lo=lat[lo] if not math.isnan(lat[lo]) else lat[hi]
        lon_lo=lon[lo] if not math.isnan(lon[lo]) else lon[hi]
        lat_hi=lat[hi] if not math.isnan(lat[hi]) else lat_lo
        lon_hi=lon[hi] if not math.isnan(lon[hi]) else lon_lo
        b_lat.append(lat_lo+t*(lat_hi-lat_lo))
        b_lon.append(lon_lo+t*(lon_hi-lon_lo))
        b_dist.append(target)
        idx=max(hi,b_idx[-1]+1) if hi<=b_idx[-1] else hi
        idx=min(idx, n_rows-1)
        b_idx.append(idx)

    iri_list,dist_list,start_pos,end_pos=[],[],[],[]
    for k in range(n_seg):
        s,e=b_idx[k],b_idx[k+1]
        if e<=s: continue
        seg_acc=[float(acc_raw[i])-offset for i in range(s,e)]
        if len(seg_acc)<=1: continue
        iri,_=_IRI_computation(seg_acc, speed, freq, **params)
        seg_dist_km=round(b_dist[k+1]-b_dist[k], 3)
        iri_list.append(iri); dist_list.append(seg_dist_km)
        start_pos.append([round(b_lat[k],7), round(b_lon[k],7)])
        end_pos.append([round(b_lat[k+1],7), round(b_lon[k+1],7)])

    total_km=sum(dist_list)
    result={
        "iris": iri_list, "distances_km": dist_list,
        "total_distance_km": round(total_km,3),
        "total_distance_mi": round(total_km/1.60934,3),
        "startPositions": start_pos, "endPositions": end_pos,
        "speed": round(speed,3), "stdev": calc_stdev(acc_raw),
    }
    stem=_safe_stem(str(raw_path))
    out_path=Path(out_dir)/f"{stem}-segment.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    return result, out_path

# ============================================================
# LOAD WHOLE JSON  (companion to segment JSON)
# ============================================================
def load_whole_json(segment_filepath):
    whole_path = str(segment_filepath).replace('-segment.json', '-whole.json')
    if not os.path.exists(whole_path):
        return None
    with open(whole_path) as f:
        w=json.load(f)
    whole_iri_m_km = w['iris'][0] if w.get('iris') else None
    if 'distance_km' in w:
        whole_len_km = w['distance_km']
        whole_len_mi = w.get('distance_mi', round(whole_len_km*KM_TO_MILE, 3))
    elif 'distances' in w and w['distances']:
        whole_len_km = w['distances'][0]
        whole_len_mi = round(whole_len_km*KM_TO_MILE, 3)
    else:
        whole_len_km = whole_len_mi = None
    whole_iri_in_mi  = round(whole_iri_m_km*M_PER_KM_TO_IN_PER_MILE, 2) if whole_iri_m_km else None
    whole_speed_kmh  = w.get('speed', None)
    whole_speed_mph  = round(whole_speed_kmh * 0.621371, 2) if whole_speed_kmh is not None else None
    return {
        'whole_iri_m_km':  whole_iri_m_km,  'whole_iri_in_mi': whole_iri_in_mi,
        'whole_len_km':    whole_len_km,     'whole_len_mi':    whole_len_mi,
        'whole_speed_kmh': whole_speed_kmh,  'whole_speed_mph': whole_speed_mph,
    }

# ============================================================
# CONVERT SEGMENT JSON → GeoJSON ROWS
# ============================================================
def segment_json_to_rows(segment_filepath, segment_data, whole_data):
    """
    Convert a segment JSON (already loaded) into a list of feature-dicts
    ready for GeoDataFrame construction.
    """
    meta = parse_filename(os.path.basename(str(segment_filepath)))

    # FILTER 1: need a road id
    if not meta.get('road'):
        return []

    whole_iri_in_mi = whole_data['whole_iri_in_mi'] if whole_data else None

    # FILTER 2: whole IRI > 300 in/mile
    if whole_iri_in_mi is not None and whole_iri_in_mi > 300:
        return []

    iris_si  = segment_data['iris']
    dists_km = segment_data.get('distances_km', segment_data.get('distances', []))
    starts   = segment_data['startPositions']
    ends     = segment_data['endPositions']

    rows = []
    for i in range(len(iris_si)):
        dist_km = dists_km[i]
        if dist_km == 0:                          # FILTER 3: zero-length
            continue
        seg_iri_m_km  = iris_si[i]
        seg_iri_in_mi = round(seg_iri_m_km*M_PER_KM_TO_IN_PER_MILE, 2)
        if seg_iri_in_mi > 300:                   # FILTER 4: > 300 in/mile
            continue
        start, end = starts[i], ends[i]
        if not is_in_usa(start[0], start[1]):     # FILTER 5: outside USA
            continue
        dist_mi = round(dist_km*KM_TO_MILE, 4)
        iri_class, color = classify_iri(seg_iri_in_mi)
        geom = LineString([(start[1], start[0]), (end[1], end[0])])
        rows.append({
            'segment_id':    i+1,
            'file_name':     os.path.basename(str(segment_filepath)),
            'road_id':       meta['road'],
            'direction':     meta['direction'],
            'road_type':     meta['road_type'],
            'surface':       meta['surface'],
            'mount_type':    meta['mount_type'],
            'vehicle':       meta['vehicle'],
            'sample_hz':     meta['sample_rate'],
            'collect_dt':    meta['date'],
            'collect_tm':    meta['time'],
            'seg_iri_m_km':  seg_iri_m_km,
            'iri_in_mi':     seg_iri_in_mi,
            'iri_class':     iri_class,
            'color_hex':     color,
            'seg_len_km':    round(dist_km, 4),
            'seg_len_mi':    dist_mi,
            'lat_start':     start[0], 'lon_start': start[1],
            'lat_end':       end[0],   'lon_end':   end[1],
            'whole_iri_m_km':  whole_data['whole_iri_m_km']  if whole_data else None,
            'whole_iri_in_mi': whole_iri_in_mi,
            'whole_len_km':    whole_data['whole_len_km']    if whole_data else None,
            'whole_len_mi':    whole_data['whole_len_mi']    if whole_data else None,
            'whole_speed_kmh': whole_data['whole_speed_kmh'] if whole_data else None,
            'whole_speed_mph': whole_data['whole_speed_mph'] if whole_data else None,
            'geometry':        geom,
        })
    return rows

# ============================================================
# STATE FILE  (tracks processed RAW csv paths)
# ============================================================
def load_state(state_path):
    if os.path.exists(state_path):
        with open(state_path) as f:
            return set(json.load(f))
    return set()

def save_state(state_path, processed):
    with open(state_path, 'w') as f:
        json.dump(sorted(processed), f, indent=2)

# ============================================================
# GEOJSON APPEND
# ============================================================
def append_to_geojson(new_rows, geojson_path):
    """
    Appends new_rows to geojson_path.  Creates the file on first run.
    """
    if not new_rows:
        return 0

    new_gdf = gpd.GeoDataFrame(new_rows, geometry='geometry', crs=CRS)
    new_gdf = new_gdf.to_crs('EPSG:4326')
    new_gdf['geometry'] = new_gdf.geometry.simplify(0.000001)

    if os.path.exists(geojson_path):
        existing_gdf = gpd.read_file(geojson_path)
        combined     = gpd.GeoDataFrame(
            pd.concat([existing_gdf, new_gdf], ignore_index=True),
            geometry='geometry', crs='EPSG:4326'
        )
    else:
        combined = new_gdf

    combined.to_file(geojson_path, driver='GeoJSON')
    return len(new_rows)

# ============================================================
# SUBFOLDER DISCOVERY
# ============================================================
def find_subfolders(input_dir):
    root = Path(input_dir)
    results = []
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        raw_files = sorted(folder.glob("RAW-*.csv"))
        if not raw_files:
            continue
        wn_files = sorted(folder.glob("WhiteNoise-*.csv"))
        wn_path  = wn_files[0] if wn_files else None
        if len(wn_files) > 1:
            print(f"  WARNING: {folder.name} has {len(wn_files)} WhiteNoise files — using {wn_files[0].name}")
        results.append((folder, wn_path, raw_files))
    return results

# ============================================================
# MAIN
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="Incremental IRI pipeline")
    parser.add_argument("input_folder",  help="Root input folder with subfolders containing RAW-*.csv files")
    parser.add_argument("output_folder", help="Root output folder (mirrors subfolder structure for JSONs)")
    parser.add_argument("--geojson",    default=OUTPUT_GEOJSON,  help=f"Output GeoJSON path (default: {OUTPUT_GEOJSON})")
    parser.add_argument("--statefile",  default=STATE_FILE,      help=f"State file path (default: {STATE_FILE})")
    parser.add_argument("--freq",       type=float, default=100.0, help="Sampling frequency Hz (default 100)")
    parser.add_argument("--seglength",  type=float, default=0.1,   help="Segment length in miles (default 0.1)")
    parser.add_argument("--col_acc",    type=int,   default=6,     help="0-based column index for acceleration (default 6)")
    parser.add_argument("--col_speed",  type=int,   default=3,     help="0-based column index for speed (default 3)")
    parser.add_argument("--k1",  type=float, default=None)
    parser.add_argument("--k2",  type=float, default=None)
    parser.add_argument("--c",   type=float, default=None)
    parser.add_argument("--mu",  type=float, default=None)
    args = parser.parse_args()

    params = dict(TRUCK_PARAMS)
    if all(v is not None for v in [args.k1, args.k2, args.c, args.mu]):
        params = dict(K1=args.k1, K2=args.k2, C=args.c, MU=args.mu)

    # ── Load state ──────────────────────────────────────────
    processed = load_state(args.statefile)
    print(f"State file: {args.statefile}  ({len(processed)} already-processed files)")

    # ── Discover subfolders ──────────────────────────────────
    subfolders = find_subfolders(args.input_folder)
    if not subfolders:
        print("No subfolders with RAW-*.csv files found. Exiting.")
        sys.exit(0)

    sep = "=" * 70
    print(f"\n{sep}")
    print(f"  IRI Pipeline  |  freq={args.freq} Hz  |  seg={args.seglength} mi  |  GeoJSON={args.geojson}")
    print(f"  Params: K1={params['K1']} K2={params['K2']} C={params['C']} MU={params['MU']}")
    print(f"  Subfolders found: {len(subfolders)}")
    print(f"{sep}\n")

    all_new_rows = []
    newly_processed = set()

    for folder, wn_path, raw_files in subfolders:
        out_dir = Path(args.output_folder) / folder.name
        out_dir.mkdir(parents=True, exist_ok=True)

        # Filter to only new RAW files
        new_raw_files = [r for r in raw_files if str(r) not in processed]
        skipped       = len(raw_files) - len(new_raw_files)

        print(f"┌─ Subfolder: {folder.name}  ({len(raw_files)} RAW total, {skipped} already processed, {len(new_raw_files)} new)")
        if not new_raw_files:
            print("│  Nothing new — skipping.\n└" + "─"*68 + "\n")
            continue

        print(f"│  White noise : {wn_path.name if wn_path else 'NOT FOUND — using default offset 9.8'}")
        print(f"│  Output dir  : {out_dir}")
        print("│")

        for raw_path in new_raw_files:
            print(f"│  ▶ {raw_path.name}")
            try:
                # ── Compute whole-trip IRI + write -whole.json ──
                whole_res, whole_out = process_whole(
                    raw_path, wn_path, args.col_acc, args.col_speed,
                    args.freq, params, out_dir
                )
                whole_iri = whole_res["iris"][0] if whole_res["iris"] else "N/A"
                print(f"│    Whole IRI={whole_iri} m/km  dist={whole_res['distance_km']} km "
                      f"({whole_res['distance_mi']} mi)  speed={whole_res['speed']} km/h")
                print(f"│    -> {whole_out.name}")

                # ── Compute segmented IRI + write -segment.json ──
                seg_res, seg_out = process_segment(
                    raw_path, wn_path, args.col_acc, args.col_speed,
                    args.freq, params, args.seglength, out_dir
                )
                n_segs = len(seg_res["iris"])
                seg_total_km = seg_res["total_distance_km"]
                seg_total_mi = seg_res["total_distance_mi"]
                w_avg = (sum(i*d for i,d in zip(seg_res["iris"], seg_res["distances_km"]))/seg_total_km
                         if seg_total_km > 0 else 0.0)
                print(f"│    Segments ({args.seglength} mi)  count={n_segs}  "
                      f"total={seg_total_km} km ({seg_total_mi} mi)  weighted-avg-IRI={w_avg:.3f} m/km")
                print(f"│    -> {seg_out.name}")

                # ── Convert to GeoJSON rows ──────────────────────
                whole_for_geo = load_whole_json(seg_out)
                rows = segment_json_to_rows(seg_out, seg_res, whole_for_geo)
                print(f"│    -> {len(rows)} GeoJSON segment(s) passed filters")

                all_new_rows.extend(rows)
                newly_processed.add(str(raw_path))

            except Exception as e:
                print(f"│    ERROR processing {raw_path.name}: {e}")

            print("│")

        print("└" + "─"*68 + "\n")

    # ── Append to GeoJSON ────────────────────────────────────
    if all_new_rows:
        n_appended = append_to_geojson(all_new_rows, args.geojson)
        print(f"✓ Appended {n_appended} new segment(s) to {args.geojson}")
    else:
        print("No new segments to append to GeoJSON.")

    # ── Persist updated state ────────────────────────────────
    if newly_processed:
        processed |= newly_processed
        save_state(args.statefile, processed)
        print(f"✓ State updated — {len(processed)} total processed file(s) recorded in {args.statefile}")

    print("\nDONE")


if __name__ == "__main__":
    main()
