"""Convert image coordinates into measured distances and build a generator input."""
from math import dist, isfinite

from model import LAYOUT, OBJECTS

TRACKING_METHOD = 'template-track-planar-v1'
MIN_SCORE = 0.78


def transform(corners, length, width):
    """Map ordered image corners to the rectangular surface of the tank."""
    plane = [(0, 0), (length, 0), (length, width), (0, width)]
    matrix = []
    for (x, y), (u, v) in zip(corners, plane):
        matrix += [[x, y, 1, 0, 0, 0, -u*x, -u*y, u],
                   [0, 0, 0, x, y, 1, -v*x, -v*y, v]]
    for i in range(8):
        pivot = max(range(i, 8), key=lambda row: abs(matrix[row][i]))
        matrix[i], matrix[pivot] = matrix[pivot], matrix[i]
        scale = matrix[i][i]
        if abs(scale) < 1e-8:
            raise ValueError('수조 꼭짓점을 다시 지정하세요.')
        matrix[i] = [value / scale for value in matrix[i]]
        for row in range(8):
            if row != i:
                factor = matrix[row][i]
                matrix[row] = [a - factor*b for a, b in zip(matrix[row], matrix[i])]
    a, b, c, d, e, f, g, h = [row[-1] for row in matrix]

    def to_mm(point):
        x, y = point
        divisor = g*x + h*y + 1
        if abs(divisor) < 1e-8:
            raise ValueError('수조 좌표를 변환할 수 없습니다.')
        return ((a*x + b*y + c)/divisor, (d*x + e*y + f)/divisor)
    return to_mm


def generate_input(media, ends, capture_end, sequences, quality):
    evaluation = media['evaluation']
    settings = evaluation.get('tracking')
    if not settings:
        raise ValueError('진동원 위치와 수조 크기, 종료 시각을 먼저 저장하세요.')
    if set(ends) != OBJECTS or set(evaluation['objects']) != OBJECTS:
        raise ValueError('부유물 12개의 시작점과 종료점이 필요합니다.')
    meta = media['measurement_summary'] or {}
    if not meta.get('case_id'):
        raise ValueError('같은 실험의 case.json을 연결하세요.')
    if meta['variable_control']:
        raise ValueError('현재 생성기는 구동 조건이 일정한 실험을 지원합니다.')
    start = evaluation['frame_seconds']
    duration = capture_end - start
    if not 0.2 <= duration or abs(capture_end - settings['end_seconds']) > 0.001:
        raise ValueError('영상의 분석 종료 시각을 확인하세요.')
    if not 3 <= sequences <= 5000 or min(quality.values(), default=0) < MIN_SCORE:
        raise ValueError('신뢰할 수 있는 추적 결과가 부족합니다.')
    length, width = settings['tank_mm']
    convert = transform(evaluation['corners'], length, width)
    def position(point):
        x, y = convert(point)
        if not (-1e-5 <= x <= length + 1e-5 and -1e-5 <= y <= width + 1e-5):
            raise ValueError('수조 경계를 벗어난 위치가 있습니다.')
        return (x, y)
    source = position(settings['target'])
    results = {}
    for label in sorted(OBJECTS):
        initial = dist(position(evaluation['objects'][label]), source)
        final = dist(position(ends[label]), source)
        speed = (initial-final)/duration
        if not all(isfinite(value) for value in (initial, final, speed)):
            raise ValueError('거리와 속도를 계산할 수 없습니다.')
        results[label] = [round(initial, 4), round(speed, 6)]
    payload = {
        'condition': [LAYOUT, meta['f_hz'], meta['wave_duty'], meta['mod_fixed']],
        'energy': meta['energy_wh'] if meta['energy_complete'] else None,
        'objects': results, 'source_media_id': str(media['id']),
        'tracking': {
            'method': TRACKING_METHOD, 'start_seconds': start, 'end_seconds': capture_end,
            'samples': sequences, 'min_score': quality, 'ends': ends, 'tank_mm': [length, width],
            'target': settings['target'], 'energy_drive_duration_s': meta.get('drive_duration_s')
        }
    }
    return meta['case_id'], payload
