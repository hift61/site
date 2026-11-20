"""Shared media uploads and manual, frame-based annotation."""
import json
import math
import os
from pathlib import PurePath
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import BadGateway, BadRequest, Conflict, NotFound
from measurements import measurement_log
from tracking import generate_input

BUCKET = 'waterful-media'
MAX_BYTES = 50_000_000
PAGE_SIZE = 30
MEDIA_TYPES = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
}
LABELS = {f'{group}{i}' for group in 'AB' for i in range(1, 7)}
SUMMARY = 'id,name,mime_type,size_bytes,created_at,status,measurement_summary'
TABLE = 'wf_media'


def storage(path, method='GET', payload=None, *, is_object=False):
    root = os.environ['SUPABASE_URL'].rstrip('/')
    key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
    headers = {'apikey': key, 'Authorization': f'Bearer {key}'}
    body = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(payload).encode()
    if is_object:
        headers['Range'] = 'bytes=0-0'
    req = Request(f'{root}/storage/v1/{path}', data=body, method=method, headers=headers)
    try:
        with urlopen(req, timeout=12) as res:
            if is_object:
                size = (res.headers.get('Content-Range', '').rsplit('/', 1)[-1]
                        if res.status == 206 else res.headers.get('Content-Length'))
                return (int(size) if size and size.isdigit() else None, res.headers.get_content_type())
            return json.load(res)
    except HTTPError as exc:
        error_body = exc.read(4096)
        try:
            code = json.loads(error_body).get('code')
        except (ValueError, AttributeError):
            code = None
        current_app.logger.warning('Media storage operation %s failed (HTTP %s).', method, exc.code)
        if is_object and (exc.code == 404 or code in ('NoSuchKey', 'not_found')):
            raise Conflict('아직 파일 전송이 완료되지 않았습니다.') from exc
        raise BadGateway('영상 저장소에 연결하지 못했습니다. Supabase Storage 설정을 확인하세요.') from exc
    except URLError as exc:
        raise BadGateway('영상 저장소에 연결하지 못했습니다. 잠시 후 다시 시도하세요.') from exc


def signed_url(path, expected_prefix):
    if not isinstance(path, str):
        raise BadGateway('영상 저장소가 올바른 주소를 반환하지 않았습니다.')
    link = urlsplit(path)
    if link.scheme or link.netloc or not link.path.startswith(expected_prefix):
        raise BadGateway('영상 저장소가 올바른 주소를 반환하지 않았습니다.')
    return os.environ['SUPABASE_URL'].rstrip('/') + '/storage/v1' + path


def json_body():
    body = request.get_json()
    if not isinstance(body, dict):
        raise BadRequest('입력 형식을 확인하세요.')
    return body


def unit(value, maximum=1):
    return type(value) in (int, float) and 0 <= value <= maximum and math.isfinite(value)


def point(coords):
    if not isinstance(coords, list) or len(coords) != 2 or not all(unit(v) for v in coords):
        raise BadRequest('프레임 좌표는 0과 1 사이여야 합니다.')
    return [round(v, 8) for v in coords]


def points(coords, maximum):
    if not isinstance(coords, list) or len(coords) > maximum:
        raise BadRequest('수조 기준점 개수를 확인하세요.')
    parsed = [point(p) for p in coords]
    if len({tuple(p) for p in parsed}) != len(parsed):
        raise BadRequest('수조 기준점을 서로 다른 위치에 표시하세요.')
    return parsed


def annotation(body, is_video):
    marks = body.get('objects')
    walls = body.get('curves')
    if not isinstance(marks, dict) or not set(marks).issubset(LABELS):
        raise BadRequest('부유물은 A1~A6, B1~B6으로 지정하세요.')
    if not isinstance(walls, dict) or set(walls) != {'left', 'right'}:
        raise BadRequest('양쪽 끝 벽 지정 형식을 확인하세요.')
    corners = points(body.get('corners'), 4)
    curves = {side: points(coords, 3) for side, coords in walls.items()}
    objects = {label: point(coords) for label, coords in marks.items()}
    if len({tuple(p) for p in objects.values()}) != len(objects):
        raise BadRequest('부유물 중심을 서로 다른 위치에 표시하세요.')
    if len(corners) == 4:
        turns = []
        for i in range(4):
            a, b, c = (corners[(i + offset) % 4] for offset in range(3))
            turns.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
        if any(turn <= 1e-8 for turn in turns):
            raise BadRequest('수조 꼭짓점을 왼쪽 위부터 시계 방향으로 선택하세요.')
    seconds = body.get('frame_seconds')
    if is_video and not unit(seconds, 86_400):
        raise BadRequest('영상 기준 프레임의 시간을 확인하세요.')
    dimensions = (body.get('width'), body.get('height'))
    if any(type(d) is not int or not 1 <= d <= 16384 for d in dimensions):
        raise BadRequest('프레임 크기를 확인하세요.')
    result = {
        'frame_seconds': seconds if is_video else None,
        'width': dimensions[0], 'height': dimensions[1],
        'objects': objects, 'corners': corners, 'curves': curves,
    }
    settings = body.get('tracking')
    if settings is not None:
        if not is_video or not isinstance(settings, dict):
            raise BadRequest('영상 추적 설정을 확인하세요.')
        size = settings.get('tank_mm')
        end = settings.get('end_seconds')
        if (not isinstance(size, list) or len(size) != 2
                or not all(unit(n, 20000) and n >= 1 for n in size)
                or not unit(end, 86400) or not 0.2 <= end - seconds <= 600):
            raise BadRequest('수조 실측 크기와 분석 종료 시각을 확인하세요. 분석 구간은 0.2초~10분입니다.')
        result['tracking'] = {'tank_mm': size, 'end_seconds': end, 'target': point(settings.get('target'))}
    return result


def media_routes(db):
    bp = Blueprint('waterful_media', __name__, url_prefix='/api/media')

    def lookup(key, fields=SUMMARY + ',evaluation,revision'):
        rows = db(TABLE, f'id=eq.{key}&select={fields}&limit=1')
        if not rows:
            raise NotFound('업로드 항목이 없습니다.')
        return rows[0]

    def storage_key(row):
        return f"{BUCKET}/{row['id']}{PurePath(row['name']).suffix.lower()}"

    @bp.get('')
    def list_media():
        page = request.args.get('page', 0, type=int)
        if page < 0:
            raise BadRequest('목록 페이지를 확인하세요.')
        query = f'select={SUMMARY}&status=neq.pending&order=created_at.desc,id.desc&limit={PAGE_SIZE + 1}&offset={page * PAGE_SIZE}'
        rows = db(TABLE, query)
        return jsonify(items=rows[:PAGE_SIZE], more=len(rows) > PAGE_SIZE)

    @bp.post('/upload')
    def begin_upload():
        body = json_body()
        name = body.get('name')
        size = body.get('size_bytes')
        if not isinstance(name, str) or len(name) > 160 or any(ord(c) < 32 or c in '/\\' for c in name):
            raise BadRequest('올바른 파일 이름을 선택하세요. 최대 160자입니다.')
        mime = MEDIA_TYPES.get(PurePath(name).suffix.lower())
        if not mime:
            raise BadRequest('MP4, MOV, WebM, JPG, PNG, WebP 파일을 올려주세요.')
        if type(size) is not int or not 0 < size <= MAX_BYTES:
            raise BadRequest('파일은 50 MB 이하여야 합니다. 영상은 평가할 구간만 잘라 올려주세요.')
        row = dict(id=str(uuid4()), name=name, mime_type=mime, size_bytes=size, status='pending')
        measurement = body.get('measurement')
        if mime.startswith('video/') or measurement is not None:
            content, summary = measurement_log(measurement, body.get('case_json'))
            row.update(measurement_csv=content, measurement_summary=summary)
        elif body.get('case_json') is not None:
            raise BadRequest('case.json과 함께 measurements.csv를 선택하세요.')
        sign = storage(f'object/upload/sign/{storage_key(row)}', 'POST', {})
        url = signed_url(sign.get('url'), f'/object/upload/sign/{BUCKET}/')
        db(TABLE, data=row)
        return jsonify(id=row['id'], upload_url=url, mime_type=mime), 201

    @bp.post('/<uuid:key>/finish')
    def finish_upload(key):
        row = lookup(key)
        if row['status'] != 'pending':
            return jsonify(id=str(key))
        size, mime = storage(f'object/authenticated/{storage_key(row)}', is_object=True)
        if size != row['size_bytes'] or mime != row['mime_type']:
            raise Conflict('전송된 파일 정보가 일치하지 않습니다. 파일을 다시 올려주세요.')
        db(TABLE, f'id=eq.{key}&status=eq.pending', {'status': 'uploaded'}, method='PATCH')
        return jsonify(id=str(key))

    @bp.get('/<uuid:key>')
    def open_media(key):
        row = lookup(key)
        if row['status'] == 'pending':
            raise NotFound('아직 업로드가 완료되지 않았습니다.')
        sign = storage(f'object/sign/{storage_key(row)}', 'POST', {'expiresIn': 3600})
        url = signed_url(sign.get('signedURL'), f'/object/sign/{BUCKET}/')
        case_id = (row['measurement_summary'] or {}).get('case_id')
        existing = []
        if case_id:
            existing = db('wf_cases', urlencode({'id': f'eq.{case_id}', 'select': 'id,payload', 'limit': 1}))
        registered = existing[0] if existing and existing[0]['payload'].get('source_media_id') == str(key) else None
        return jsonify(item=row, media_url=url, registered=registered)

    @bp.get('/<uuid:key>/measurement')
    def download_measurement(key):
        row = lookup(key, 'status,measurement_csv,measurement_summary')
        if row['status'] == 'pending' or row['measurement_csv'] is None:
            raise NotFound('이 항목에 연결된 측정 CSV가 없습니다.')
        return jsonify(name=row['measurement_summary']['file_name'], csv=row['measurement_csv'])

    @bp.put('/<uuid:key>/case-metadata')
    def attach_metadata(key):
        row = lookup(key, 'status,revision,measurement_csv,measurement_summary')
        if row['status'] == 'pending' or row['measurement_csv'] is None:
            raise NotFound('이 항목에 연결된 측정 CSV가 없습니다.')
        body = json_body()
        if (row['measurement_summary'] or {}).get('case_id'):
            raise Conflict('이미 case.json이 연결되어 있습니다.')
        if not isinstance(body.get('case_json'), str):
            raise BadRequest('같은 실험의 case.json을 선택하세요.')
        _, summary = measurement_log({'name': row['measurement_summary']['file_name'], 'csv': row['measurement_csv']},
                                     body['case_json'])
        revision = row['revision']
        updated = db(TABLE, f'id=eq.{key}&revision=eq.{revision}&select=revision,measurement_summary',
                     dict(revision=revision + 1, measurement_summary=summary), method='PATCH', prefer='return=representation')
        if not updated:
            raise Conflict('다른 화면에서 평가가 수정되었습니다. 목록에서 다시 열어주세요.')
        return jsonify(updated[0])

    @bp.post('/<uuid:key>/register-tracking')
    def register_tracking(key):
        row = lookup(key)
        if row['status'] != 'evaluated':
            raise Conflict('평가 표시를 먼저 저장하세요.')
        body = json_body()
        revision = body.get('revision')
        if type(revision) is not int or revision != row['revision']:
            raise Conflict('다른 화면에서 평가가 수정되었습니다. 목록에서 다시 열어주세요.')
        end = body.get('end_seconds')
        samples = body.get('samples')
        ends = body.get('ends')
        quality = body.get('min_score')
        if (not unit(end, 86400) or type(samples) is not int or not isinstance(ends, dict)
                or not isinstance(quality, dict) or set(ends) != LABELS or set(quality) != LABELS
                or not all(unit(v) for v in quality.values())):
            raise BadRequest('부유물 12개의 추적 결과를 확인하세요.')
        case_id, payload = generate_input(row, {k: point(p) for k, p in ends.items()}, end, samples, quality)
        payload['source_revision'] = revision
        outcome = db('rpc/wf_register_tracked_case', data=dict(p_media=str(key), p_revision=revision,
                     p_case=case_id, p_payload=payload), prefer='return=representation')
        if outcome == 'duplicate':
            raise Conflict('같은 케이스 ID가 이미 다른 영상 또는 CSV로 등록되어 있습니다.')
        if outcome != 'saved':
            raise Conflict('다른 화면에서 평가가 수정되었습니다. 목록에서 다시 열어주세요.')
        return jsonify(id=case_id, payload=payload)

    @bp.put('/<uuid:key>/evaluation')
    def save_evaluation(key):
        row = lookup(key)
        if row['status'] == 'pending':
            raise NotFound('아직 업로드가 완료되지 않았습니다.')
        body = json_body()
        revision = body.get('revision')
        complete = body.get('complete')
        if type(revision) is not int or revision < 0 or type(complete) is not bool:
            raise BadRequest('평가 저장 형식을 확인하세요.')
        if revision != row['revision']:
            raise Conflict('다른 화면에서 평가가 수정되었습니다. 목록에서 다시 열어주세요.')
        data = annotation(body, row['mime_type'].startswith('video/'))
        curves_complete = all(len(coords) in (0, 3) for coords in data['curves'].values())
        if complete and (len(data['objects']) != 12 or len(data['corners']) != 4 or not curves_complete):
            raise BadRequest('A/B 12개, 수조 꼭짓점 4개를 표시하고 시작한 곡선은 모두 완성하세요.')
        status = 'evaluated' if complete else 'draft'
        updated = db(TABLE, f'id=eq.{key}&revision=eq.{revision}&select=revision,status',
                     dict(evaluation=data, status=status, revision=revision + 1),
                     method='PATCH', prefer='return=representation')
        if not updated:
            raise Conflict('다른 화면에서 평가가 수정되었습니다. 목록에서 다시 열어주세요.')
        return jsonify(updated[0])

    return bp
