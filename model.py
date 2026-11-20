import csv
import io
import math
import random
import statistics as st
from collections import defaultdict

TYPES = ("A", "B")
OBJECTS = {f"{kind}{i}" for kind in TYPES for i in range(1, 7)}
LAYOUT = "A6+B6"


def num(x):
    n = float(x)
    if not math.isfinite(n):
        raise ValueError("유한한 수를 입력하세요.")
    return n


def parse_csv(content):
    cases = {}
    for r in csv.DictReader(io.StringIO(content.lstrip("\ufeff"))):
        key = r["case_id"].strip()
        if not key or len(key) > 100:
            raise ValueError("케이스 ID를 확인하세요.")
        if r["variable_control"].lower() != "false":
            raise ValueError(f"{key}: 고정 조건 케이스만 지원합니다.")
        obj = r["object_id"].strip()
        if obj not in OBJECTS or r["object_type"].strip() != obj[0]:
            raise ValueError(f"{key}: 종류와 번호(A1~A6, B1~B6)를 확인하세요.")
        info = [LAYOUT, num(r["f_hz"]), num(r["wave_duty"]), num(r["mod_fixed"])]
        if not 0 <= info[2] <= 1:
            raise ValueError(f"{key}: 파도 듀티는 0~1입니다.")
        complete = r["energy_complete"].strip().lower()
        if complete not in ("true", "false"):
            raise ValueError(f"{key}: energy_complete는 true 또는 false입니다.")
        energy = num(r["E_total_Wh"]) if complete == "true" else None
        case = cases.setdefault(key, dict(condition=info, energy=energy, objects={}))
        if case["condition"] != info or case["energy"] != energy:
            raise ValueError(f"{key}: 같은 실험의 구동 조건과 에너지 기록은 일치해야 합니다.")
        if obj in case["objects"]:
            raise ValueError(f"{key}: {obj} 번호가 중복되었습니다.")
        case["objects"][obj] = [num(r["initial_distance_mm"]), num(r["signed_convergence_speed_mm_s"])]
    if not cases:
        raise ValueError("CSV에 실험 데이터가 없습니다.")
    for key, case in cases.items():
        missing = OBJECTS.difference(case["objects"])
        if missing:
            raise ValueError(f"{key}: 한 케이스에서 빠진 부유물 {', '.join(sorted(missing))}")
    return [dict(id=k, payload=v) for k, v in cases.items()]


def fit_by_distance(group, kind):
    ranked = []
    for row in group:
        objects = row["payload"]["objects"]
        same_type = [(x, obj, y) for obj, (x, y) in objects.items() if obj.startswith(kind)]
        ranked.append(sorted(same_type))
    points = [p for case in ranked for p in case]
    mx = st.mean(x for x, _, y in points)
    my = st.mean(y for x, _, y in points)
    var = sum((x - mx) ** 2 for x, _, y in points)
    slope = sum((x - mx) * (y - my) for x, _, y in points) / var if var else 0
    distances = [st.mean(p[0] for p in rank) for rank in zip(*ranked)]
    return ranked, slope, distances


def generate(items, n, seed):
    rng = random.Random(seed)
    groups = defaultdict(list)
    eligible = []
    legacy = []
    for row in sorted(items, key=lambda r: r["id"]):
        case = row["payload"]
        if case["condition"][0] != LAYOUT or set(case["objects"]) != OBJECTS:
            legacy.append(row["id"])
            continue
        groups[tuple(case["condition"])].append(row)
        eligible.append(row["id"])
    output = []
    skipped = []
    for cond, group in sorted(groups.items()):
        if len(group) < 2:
            skipped.append(list(cond))
            continue
        fits = {kind: fit_by_distance(group, kind) for kind in TYPES}
        for i in range(n):
            j = rng.randrange(len(group))
            donor = group[j]
            objects = {}
            means = {}
            for kind, (ranked, slope, distances) in fits.items():
                speeds = []
                for d, (x, obj, y) in zip(distances, ranked[j]):
                    speed = round(y + slope * (d - x), 6)
                    objects[obj] = dict(distance_mm=d, speed_mm_s=speed)
                    speeds.append(speed)
                means[kind] = st.mean(speeds)
            output.append(dict(condition=list(cond), sample=i + 1, donor=donor["id"],
                               objects=objects, mean_speed_by_type_mm_s=means,
                               mean_speed_mm_s=st.mean(means.values()),
                               energy_Wh=donor["payload"]["energy"]))
    return dict(seed=seed, per_condition=n, case_ids=eligible, skipped=skipped,
                excluded_case_ids=legacy, synthetic=output)
