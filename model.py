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


def frequency_plan(items, start, end, step):
    """Plan interpolation within each observed (wave duty, modulation) family."""
    start, end, step = map(num, (start, end, step))
    if start <= 0 or end < start or step < 0.1:
        raise ValueError('주파수 범위와 간격을 확인하세요 (최소 간격 0.1 Hz).')
    size = math.floor((end - start) / step + 1e-8) + 1
    if size > 201:
        raise ValueError('주파수 지점은 최대 201개입니다.')
    grid = [round(start + i * step, 8) for i in range(size)]
    families = defaultdict(lambda: defaultdict(list))
    excluded = []
    for row in sorted(items, key=lambda r: r['id']):
        case = row['payload']
        if case['condition'][0] != LAYOUT or set(case['objects']) != OBJECTS:
            excluded.append(row['id'])
            continue
        _, frequency, wave, mod = case['condition']
        frequency, wave, mod = map(num, (frequency, wave, mod))
        if frequency <= 0:
            raise ValueError('실측 주파수는 0 Hz보다 커야 합니다.')
        for distance, speed in case['objects'].values():
            num(distance); num(speed)
        families[(wave, mod)][frequency].append(row)
    plan, skipped = [], []
    for (wave, mod), knots in sorted(families.items()):
        frequencies = sorted(knots)
        for f in grid:
            exact = next((x for x in frequencies if abs(x - f) < 1e-7), None)
            if exact is not None:
                plan.append((f, wave, mod, exact, exact, 0.0))
            elif frequencies[0] < f < frequencies[-1]:
                lo = max(x for x in frequencies if x < f)
                hi = min(x for x in frequencies if x > f)
                plan.append((f, wave, mod, lo, hi, (f - lo) / (hi - lo)))
            else:
                skipped.append(dict(condition=[LAYOUT, f, wave, mod],
                                    reason='outside_observed_frequency_range'))
    return families, plan, skipped, excluded


def generate_frequency(items, n, seed, start=30, end=40, step=1, limit=1500):
    """Distance correction + piecewise linear frequency interpolation.

    One whole donor case is drawn per anchor, preserving within-case A/B
    dependence. Synthetic object IDs denote distance rank, not physical identity.
    This resampling distribution is not a confidence interval or validation.
    """
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= 200:
        raise ValueError('생성 수는 조건당 1~200 정수입니다.')
    families, plan, skipped, excluded = frequency_plan(items, start, end, step)
    if n * len(plan) > limit:
        raise ValueError(f'전체 최대 {limit}개입니다. 생성 수나 주파수 범위를 줄여주세요.')
    if not plan:
        raise ValueError('선택한 범위에 예측 가능한 실측 주파수가 없습니다.')
    rng = random.Random(seed)
    fits, models, warnings, centers = {}, [], [], {}
    for (wave, mod), knots in sorted(families.items()):
        for f, group in sorted(knots.items()):
            type_models = {}
            for kind in TYPES:
                ranked, slope, distances = fit_by_distance(group, kind)
                fits[(wave, mod, f, kind)] = (ranked, slope, distances)
                points = [p for case in ranked for p in case]
                intercept = st.mean(y - slope * x for x, _, y in points)
                rank_offsets = [st.mean(row[rank][2] - slope * row[rank][0] - intercept
                                        for row in ranked) for rank in range(6)]
                centers[(wave, mod, f, kind)] = rank_offsets
                type_models[kind] = dict(slope=slope, intercept=intercept,
                    distance_range_mm=[min(p[0] for p in points), max(p[0] for p in points)],
                    reference_distances_mm=distances)
            models.append(dict(condition=[LAYOUT, f, wave, mod],
                source_case_ids=[r['id'] for r in group], source_case_count=len(group),
                by_type=type_models))
            if len(group) < 2:
                warnings.append(dict(condition=[LAYOUT, f, wave, mod],
                    reason='single_source_case_no_between_case_variability'))
    output, summaries = [], []
    for f, wave, mod, lo, hi, weight in plan:
        knots = families[(wave, mod)]
        anchors = [(lo, 1.0)] if lo == hi else [(lo, 1 - weight), (hi, weight)]
        generated = []
        for i in range(n):
            donors = [(anchor, w, rng.randrange(len(knots[anchor]))) for anchor, w in anchors]
            objects, means = {}, {}
            for kind in TYPES:
                speeds = []
                for rank in range(6):
                    d = sum(w * fits[(wave, mod, anchor, kind)][2][rank]
                            for anchor, w in anchors)
                    speed, sources, supported = 0.0, [], True
                    for anchor, w, j in donors:
                        ranked, slope, _ = fits[(wave, mod, anchor, kind)]
                        x, obj, y = ranked[j][rank]
                        speed += w * (y + slope * (d - x) - centers[(wave, mod, anchor, kind)][rank])
                        all_distances = [p[0] for row in ranked for p in row]
                        supported &= min(all_distances) <= d <= max(all_distances)
                        sources.append(dict(case_id=knots[anchor][j]['id'], object_id=obj))
                    speed = round(speed, 6)
                    objects[f'{kind}{rank + 1}'] = dict(distance_mm=d, speed_mm_s=speed,
                        distance_within_anchor_support=supported, source_objects=sources)
                    speeds.append(speed)
                means[kind] = st.mean(speeds)
            energy_values = [knots[anchor][j]['payload']['energy'] for anchor, _, j in donors]
            valid_energy = all(e is not None and math.isfinite(float(e)) and float(e) >= 0
                               for e in energy_values)
            energy = sum(w * float(e) for (_, w, _), e in zip(donors, energy_values)) if valid_energy else None
            record = dict(condition=[LAYOUT, f, wave, mod], sample=i + 1,
                donor=knots[lo][donors[0][2]]['id'] if lo == hi else None,
                donors=[dict(case_id=knots[anchor][j]['id'], frequency_hz=anchor, weight=w)
                        for anchor, w, j in donors],
                generation_method='distance_adjusted_resample' if lo == hi else 'frequency_interpolation',
                source_case_counts=[len(knots[anchor]) for anchor, _ in anchors],
                objects=objects, mean_speed_by_type_mm_s=means,
                mean_speed_mm_s=st.mean(means.values()), energy_Wh=energy,
                energy_source=('resampled_measurement' if lo == hi else 'linear_frequency_interpolation')
                              if valid_energy else 'unavailable')
            output.append(record); generated.append(record)
        summaries.append(dict(condition=[LAYOUT, f, wave, mod],
            generated_sample_count=n, source_case_counts=[len(knots[a]) for a, _ in anchors],
            by_object={obj: dict(distance_mm=generated[0]['objects'][obj]['distance_mm'],
                mean_signed_speed_mm_s=st.mean(r['objects'][obj]['speed_mm_s'] for r in generated),
                approach_probability=sum(r['objects'][obj]['speed_mm_s'] > 0 for r in generated) / n,
                distance_within_anchor_support=generated[0]['objects'][obj]['distance_within_anchor_support'])
                for obj in sorted(OBJECTS)}))
    return dict(schema_version=2, mode='frequency_interpolation', seed=seed, per_condition=n,
        frequency_grid=dict(start_hz=num(start), end_hz=num(end), step_hz=num(step)),
        case_ids=sorted(r['id'] for knots in families.values() for group in knots.values() for r in group),
        excluded_case_ids=excluded, skipped=skipped, warnings=warnings, synthetic=output,
        condition_summaries=summaries, model=dict(method='piecewise_linear_frequency_distance_regression',
            formula='mu(f,d)=(1-t)*(a_lo+b_lo*d)+t*(a_hi+b_hi*d); t=(f-f_lo)/(f_hi-f_lo)',
            knots=models, object_ids='synthetic_distance_rank_within_type',
            speed_definition='signed_radial_displacement_per_time_positive_toward_vibrator',
            probability_definition='fraction_of_generated_samples_with_signed_speed_above_zero',
            uncertainty='empirical_resampling_spread_not_confidence_interval',
            frequency_extrapolation=False, validation_status='not_validated_at_intermediate_frequencies',
            energy_assumption='compare_only_cases_with_equal_drive_duration'))
