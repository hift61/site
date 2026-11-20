"""Read WATERful capture logs and summarize energy only for a known drive interval."""
import csv
import io
import json
import math
from datetime import datetime
from pathlib import PurePath

MAX_CSV_BYTES = 1_000_000
MAX_CASE_BYTES = 65_536
COLUMNS = ('pc_elapsed_s', 'utc', 'source', 'mcu_ms', 'f_hz', 'mod', 'g', 'V', 'I_A', 'P_W')


def finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError
    return number


def sensor_value(value):
    if value.strip().lower() in ('', 'nan', '+nan', '-nan'):
        return None
    return finite(value)


def timestamp(value):
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() is None:
        raise ValueError
    return parsed


def decode_case(text):
    if text is None:
        return None
    cause = 'case.json에서 케이스 ID, 실험 시각, 구동 조건을 확인하세요.'
    if not isinstance(text, str) or len(text.encode()) > MAX_CASE_BYTES:
        raise ValueError(cause)
    try:
        data = json.loads(text.lstrip('\ufeff'))
        key = data['case_id']
        if not isinstance(key, str) or not key.strip() or len(key) > 100 or any(ord(c) < 32 for c in key):
            raise ValueError
        f_hz, wave, modulation = (finite(data[name]) for name in ('f_hz', 'wave_duty', 'mod_fixed'))
        if f_hz < 0 or not 0 <= wave <= 1 or not 0 <= modulation <= 1:
            raise ValueError
        started = timestamp(data['started_utc'])
        ended = timestamp(data['finished_utc'])
        if ended < started:
            raise ValueError
        drive = [data.get(name) for name in ('drive_started_case_s', 'drive_stopped_case_s')]
        if all(value is not None for value in drive):
            drive = [finite(value) for value in drive]
            if not 0 <= drive[0] < drive[1]:
                raise ValueError
        else:
            drive = None
    except (TypeError, KeyError, ValueError, OverflowError) as exc:
        raise ValueError(cause) from exc
    return {
        'case_id': key, 'f_hz': f_hz, 'wave_duty': wave, 'mod_fixed': modulation,
        'variable_control': data.get('variable_control') is not False or bool(data.get('control_changes')),
        'status': data.get('status'), 'energy_complete': data.get('energy_complete') is True,
        'started': started, 'ended': ended, 'drive': drive
    }


def measurement_log(attachment, case_text=None):
    if not isinstance(attachment, dict):
        raise ValueError('같은 회차의 measurements.csv를 선택하세요.')
    name = attachment.get('name')
    content = attachment.get('csv')
    if (not isinstance(name, str) or not 0 < len(name) <= 160
            or any(ord(c) < 32 or c in '/\\' for c in name)
            or PurePath(name).suffix.lower() != '.csv'):
        raise ValueError('측정 파일 이름과 확장자(.csv)를 확인하세요.')
    if not isinstance(content, str) or not 0 < len(content.encode()) <= MAX_CSV_BYTES:
        raise ValueError('측정 CSV는 1 MB 이하여야 합니다.')

    meta = decode_case(case_text)
    reader = csv.DictReader(io.StringIO(content.lstrip('\ufeff')), strict=True)
    try:
        if tuple(reader.fieldnames or ()) != COLUMNS:
            raise ValueError
        samples = []
        for row in reader:
            if None in row or any(v is None for v in row.values()):
                raise ValueError
            t = finite(row['pc_elapsed_s'])
            voltage, current, power = (sensor_value(row[k]) for k in ('V', 'I_A', 'P_W'))
            captured = timestamp(row['utc'])
            if t < 0 or row['source'] not in ('D', 'STAT', 'STAT_missing'):
                raise ValueError
            if row['source'] == 'STAT_missing':
                power = None
            for key in ('mcu_ms', 'f_hz', 'mod', 'g'):
                sensor_value(row[key])
            samples.append((t, voltage, current, power, captured))
    except (TypeError, KeyError, ValueError, OverflowError, csv.Error) as exc:
        raise ValueError('수집 프로그램의 원본 measurements.csv 형식을 확인하세요.') from exc
    if not samples:
        raise ValueError('측정 CSV에 기록된 측정값이 없습니다.')

    samples.sort(key=lambda sample: sample[0])
    if meta and any(not -2 <= (s[4] - meta['started']).total_seconds()
                    <= (meta['ended'] - meta['started']).total_seconds() + 2
                    for s in samples):
        raise ValueError('measurements.csv와 case.json의 기록 시각이 다릅니다. 같은 케이스 폴더의 파일을 선택하세요.')

    def invalid(sample):
        _, voltage, current, power, _ = sample
        return voltage is None or current is None or power is None or voltage <= 0 or power < 0
    info = {
        'file_name': name, 'samples': len(samples),
        'invalid_samples': sum(invalid(s) for s in samples),
        'duration_s': round(samples[-1][0] - samples[0][0], 4),
        'energy_complete': False, 'energy_wh': None, 'energy_note': '구동 시간 확인 필요',
    }
    if not meta:
        return content, info
    info.update({key: meta[key] for key in ('case_id', 'f_hz', 'wave_duty', 'mod_fixed', 'variable_control')})
    info['capture_started_utc'] = meta['started'].isoformat()
    if not meta['drive']:
        return content, info
    start, stop = meta['drive']
    info.update(drive_started_case_s=start, drive_stopped_case_s=stop)
    info['drive_duration_s'] = round(stop - start, 4)
    used = [s for s in samples if start <= s[0] <= stop]
    gaps = [b[0] - a[0] for a, b in zip(used, used[1:])]
    if not meta['energy_complete'] or meta['status'] not in ('complete', 'awaiting_video'):
        info['energy_note'] = '수집 프로그램이 에너지 기록을 불완전으로 표시함'
    elif len(used) < 2 or not any(gaps) or any(invalid(s) for s in used):
        info['energy_note'] = '구동 중 유효 전력 측정 부족'
    elif used[0][0] - start > 2 or stop - used[-1][0] > 2 or max(gaps) > 5:
        info['energy_note'] = '구동 구간 전력 기록에 결측 있음'
    else:
        energy = math.fsum(dt * (a[3] / 2 + b[3] / 2) / 3600 for dt, a, b in zip(gaps, used, used[1:]))
        info.update(energy_complete=True, energy_wh=round(energy, 7), energy_note=None)
    return content, info
