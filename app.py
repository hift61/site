import os, json, hmac, urllib.request, urllib.error
import csv
import io
from uuid import uuid4
from flask import Flask, request, jsonify, Response
from werkzeug.exceptions import HTTPException
from model import LAYOUT, parse_csv, generate
from media import media_routes, video_storage

app=Flask(__name__)
app.config['MAX_CONTENT_LENGTH']=2_000_000

def db(table, query='', data=None, *, method=None, prefer='return=minimal'):
    key=os.environ['SUPABASE_SERVICE_ROLE_KEY']
    url=os.environ['SUPABASE_URL'].rstrip('/')+'/rest/v1/'+table+'?'+query
    req=urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(), method=method, headers={
        'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json','Prefer':prefer})
    with urllib.request.urlopen(req,timeout=12) as res: return json.loads(res.read() or 'null')

def listing(table,fields):
    rows=[]
    while True:
        page=db(table,f'select={fields}&order=id&limit=100&offset={len(rows)}')
        rows.extend(page)
        if len(page)<100:return rows

@app.before_request
def auth():
    if not request.path.startswith('/api/'):
        return
    token=os.getenv('TEAM_PASSWORD','')
    if not token:return jsonify(error='서버 환경변수를 설정하세요.'),503
    if not hmac.compare_digest(request.headers.get('Authorization','').encode(),('Bearer '+token).encode()):
        return jsonify(error='팀 암호를 확인하세요.'),401

@app.after_request
def private(res):
    if request.path.startswith('/api/'):
        res.headers['Cache-Control']='no-store'
    return res

@app.errorhandler(Exception)
def fail(e):
    if isinstance(e,HTTPException):return jsonify(error=e.description),e.code
    if isinstance(e,urllib.error.HTTPError) and e.code==409:return jsonify(error='이미 저장된 ID가 있습니다. 이번 업로드 전체를 취소했습니다.'),409
    if isinstance(e,(ValueError,KeyError)) and not isinstance(e,urllib.error.URLError):return jsonify(error=str(e)),400
    return jsonify(error='요청을 처리할 수 없습니다. 서버 설정과 입력 크기를 확인하세요.'),getattr(e,'code',None) or 503

@app.get('/api/session')
def session():
    return jsonify(connected=True, video_storage=video_storage(),
                   google_drive_client_id=os.environ.get('GOOGLE_DRIVE_CLIENT_ID', '').strip())

@app.get('/api/state')
def state():
    cases=listing('wf_cases','id,payload')
    return jsonify(cases=[dict(id=r['id'],condition=r['payload']['condition'],energy=r['payload']['energy']) for r in cases],
                   runs=listing('wf_runs','id,created_at'))

@app.post('/api/cases')
def upload():
    rows=parse_csv(request.get_data(as_text=True))
    db('wf_cases',data=rows)
    return jsonify(count=len(rows)),201

@app.get('/api/cases/export.<format>')
def export_cases(format):
    if format not in ('csv', 'json'):
        return jsonify(error='CSV 또는 JSON 형식을 선택하세요.'),400
    rows=listing('wf_cases','id,payload')
    if format == 'json':
        content=json.dumps({'cases': rows},ensure_ascii=False,allow_nan=False,indent=2)
        mime='application/json'
    else:
        output=io.StringIO(newline='')
        writer=csv.writer(output)
        writer.writerow([
            'case_id','object_id','object_type','f_hz','wave_duty','mod_fixed',
            'variable_control','energy_complete','E_total_Wh',
            'initial_distance_mm','signed_convergence_speed_mm_s'
        ])
        for row in rows:
            payload=row['payload']
            layout,frequency,wave,modulation=payload['condition']
            energy=payload['energy']
            for object_id,(distance,speed) in sorted(payload['objects'].items()):
                object_type=object_id[0] if layout == LAYOUT else layout
                writer.writerow([
                    row['id'],object_id,object_type,frequency,wave,modulation,
                    'false',str(energy is not None).lower(),
                    '' if energy is None else energy,distance,speed
                ])
        content='\ufeff'+output.getvalue()
        mime='text/csv'
    return Response(content,mimetype=mime,headers={
        'Content-Disposition': f'attachment; filename="waterful_measured_cases.{format}"'
    })

@app.post('/api/runs')
def run():
    args=request.get_json()
    n=int(args['count']);seed=int(args['seed'])
    if not 1<=n<=200:raise ValueError('생성 수는 조건당 1~200입니다.')
    rows=listing('wf_cases','id,payload')
    if n*len(set(tuple(r['payload']['condition']) for r in rows if r['payload']['condition'][0] == LAYOUT))>1500:raise ValueError('생성 수를 줄여주세요 (전체 최대 1500).')
    result=generate(rows,n,seed)
    if not result['synthetic']: raise ValueError('같은 조건에서 A 6개와 B 6개를 함께 측정한 실험이 2회 이상 필요합니다.')
    key=str(uuid4()); db('wf_runs',data=dict(id=key,payload=result))
    return jsonify(id=key,count=len(result['synthetic']),skipped=len(result['skipped'])),201

@app.get('/api/runs/<uuid:key>')
def get_run(key):
    rows=db('wf_runs',f'id=eq.{key}&select=payload')
    if not rows:return jsonify(error='결과가 없습니다.'),404
    return jsonify(rows[0]['payload'])

app.register_blueprint(media_routes(db))
