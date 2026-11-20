(() => {
  const labels = ['A', 'B'].flatMap(group => Array.from({length: 6}, (_, i) => group + (i + 1)));
  const corners = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];
  const walls = {left: '왼쪽', right: '오른쪽'};
  const statuses = {uploaded: '평가 대기', draft: '작성 중', evaluated: '평가 완료'};
  const maxBytes = 50_000_000;
  const maxCsvBytes = 1_000_000;
  const maxCaseBytes = 65_536;
  let page = 0;
  let listVersion = 0;
  let detailVersion = 0;
  let session = null;
  let saveCount = 0;
  let pendingFinish = null;

  const post = (method, data) => ({
    method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)
  });
  const say = (id, message = '') => { el(id).textContent = message; };
  const freshMarks = () => ({objects: {}, corners: [], curves: {left: [], right: []}, target: null});

  async function go(tab) {
    for (const name of ['uploads', 'evaluation', 'analysis']) el(name).hidden = name !== tab;
    for (const button of el('tabs').querySelectorAll('button')) {
      if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (tab !== 'evaluation') session?.media?.pause?.();
    if (tab === 'uploads') await list();
    if (tab === 'analysis') await refresh();
  }

  async function list() {
    const version = ++listVersion;
    const target = el('media-list');
    say('media-list-message', '목록 불러오는 중…');
    try {
      const result = await api('media?page=' + page);
      if (version !== listVersion) return;
      const rows = result.items.map(item => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'media-row';
        const name = document.createElement('span');
        name.textContent = item.name;
        const details = document.createElement('small');
        const measurement = item.measurement_summary;
        const linked = measurement?.case_id || (measurement ? '측정 CSV 연결됨' : '측정 CSV 없음');
        details.textContent = [statuses[item.status], linked, new Date(item.created_at).toLocaleString('ko-KR')].join(' · ');
        button.append(name, details);
        button.addEventListener('click', () => open(item.id));
        li.append(button);
        return li;
      });
      target.replaceChildren(...rows);
      el('media-pages').hidden = !result.more && page === 0;
      el('media-prev').disabled = page === 0;
      el('media-next').disabled = !result.more;
      say('media-page', String(page + 1));
      say('media-list-message', rows.length ? '' : '올린 파일이 없습니다.');
    } catch (error) {
      if (version !== listVersion) return;
      say('media-list-message', error.message);
      throw error;
    }
  }

  function sendFile(url, file, mime) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) el('media-progress').value = 100 * event.loaded / event.total;
      };
      xhr.timeout = 300_000;
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(Error('파일 전송이 중단되었습니다. 다시 시도하세요.'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(Error('파일을 전송하지 못했습니다 (HTTP ' + xhr.status + '). Storage의 파일 크기 제한을 확인하세요.'));
      };
      const form = new FormData();
      form.append('cacheControl', '3600');
      form.append('', file.slice(0, file.size, mime), file.name);
      xhr.send(form);
    });
  }

  async function upload(event) {
    event.preventDefault();
    const file = el('media-file').files[0];
    const measurementFile = el('measurement-file').files[0];
    const caseFile = el('case-file').files[0];
    if (!file) return;
    if (file.size > maxBytes) {
      say('upload-message', '파일은 50 MB 이하여야 합니다. 영상은 평가할 구간만 잘라 올려주세요.');
      return;
    }
    if (!measurementFile && (/\.(mp4|mov|webm)$/i.test(file.name) || caseFile)) {
      say('upload-message', '같은 회차의 measurements.csv를 선택하세요.');
      return;
    }
    if (measurementFile && measurementFile.size > maxCsvBytes) {
      say('upload-message', '측정 CSV는 1 MB 이하여야 합니다.');
      return;
    }
    if (caseFile && caseFile.size > maxCaseBytes) {
      say('upload-message', 'case.json은 64 KiB 이하여야 합니다.');
      return;
    }
    const progress = el('media-progress');
    const button = el('media-upload');
    button.disabled = true;
    progress.value = 0;
    progress.hidden = false;
    say('upload-message', '파일 업로드 중…');
    try {
      if (pendingFinish?.file !== file || pendingFinish.measurementFile !== measurementFile || pendingFinish.caseFile !== caseFile) {
        const measurement = measurementFile ? {name: measurementFile.name, csv: await measurementFile.text()} : null;
        const caseJson = caseFile ? await caseFile.text() : null;
        const setup = await api('media/upload', post('POST', {
          name: file.name, size_bytes: file.size, measurement, case_json: caseJson
        }));
        await sendFile(setup.upload_url, file, setup.mime_type);
        pendingFinish = {file, measurementFile, caseFile, id: setup.id};
      }
      await api('media/' + pendingFinish.id + '/finish', {method: 'POST'});
      pendingFinish = null;
      el('media-file').value = '';
      el('measurement-file').value = '';
      el('case-file').value = '';
      say('upload-message', '업로드 완료. 목록에서 항목을 열어 평가할 수 있습니다.');
      page = 0;
      await list().catch(() => {});
    } catch (error) {
      say('upload-message', error.message);
    } finally {
      button.disabled = false;
      progress.hidden = true;
    }
  }

  function showMeasurement(item) {
    const summary = item.measurement_summary;
    el('evaluation-measurements').hidden = !summary;
    el('attach-case').hidden = !summary || !!summary.case_id;
    say('measurement-message');
    if (!summary) return;
    const parts = [summary.file_name, '측정 ' + summary.samples + '건'];
    if (summary.case_id) parts.unshift('케이스 ' + summary.case_id);
    if (summary.case_id) {
      parts.push(summary.f_hz + ' Hz', '파도 듀티 ' + (summary.wave_duty * 100).toFixed(1) + '%');
      if (summary.variable_control) parts.push('구동 조건 변경됨');
    }
    if (summary.energy_complete) parts.push('구동 에너지 ' + summary.energy_wh + ' Wh');
    else parts.push('구동 에너지 미확정 (' + summary.energy_note + ')');
    if (summary.invalid_samples) parts.push('유효하지 않은 전력 기록 ' + summary.invalid_samples + '건');
    say('measurement-details', parts.join(' · '));
  }

  async function attachCase() {
    const s = session;
    const file = el('evaluation-case-file').files[0];
    if (!s || saveCount) return;
    if (!file || file.size > maxCaseBytes) {
      say('measurement-message', '같은 회차의 case.json을 선택하세요.');
      return;
    }
    saveCount++;
    el('attach-case-button').disabled = true;
    render();
    try {
      const saved = await api('media/' + s.item.id + '/case-metadata', post('PUT', {case_json: await file.text()}));
      Object.assign(s.item, saved);
      showMeasurement(s.item);
    } catch (error) {
      say('measurement-message', error.message);
    } finally {
      saveCount--;
      el('attach-case-button').disabled = false;
      render();
    }
  }

  async function downloadMeasurement() {
    const item = session?.item;
    if (!item?.measurement_summary) return;
    try {
      const {name, csv} = await api('media/' + item.id + '/measurement');
      const link = document.createElement('a');
      const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (session?.item === item) say('measurement-message', error.message);
    }
  }

  async function open(id) {
    if (saveCount) return;
    if (session?.dirty && !window.confirm('저장하지 않은 표시가 있습니다. 다른 항목을 열까요?')) return;
    const version = ++detailVersion;
    session?.media?.pause?.();
    session = null;
    await go('evaluation');
    el('evaluation-empty').hidden = true;
    el('evaluation-editor').hidden = false;
    el('media-view').replaceChildren();
    el('media-overlay').replaceChildren();
    for (const name of ['mark-tools', 'frame-actions', 'evaluation-save', 'tracking-controls', 'track-result']) el(name).hidden = true;
    say('track-message');
    el('evaluation-case-file').value = '';
    say('evaluation-title', '항목 불러오는 중…');
    say('evaluation-status');
    say('evaluation-message');
    el('evaluation-measurements').hidden = true;
    try {
      const {item, media_url: url, registered} = await api('media/' + id);
      if (version !== detailVersion) return;
      const video = item.mime_type.startsWith('video/');
      const media = document.createElement(video ? 'video' : 'img');
      const state = {
        item, media, video, url, registered, preview: false, tracker: null,
        width: 0, height: 0, locked: false, ready: false,
        seconds: null, marks: freshMarks(), mode: 'objects', selected: 'A1', history: [], dirty: false
      };
      session = state;
      say('evaluation-title', item.name);
      say('evaluation-status', statuses[item.status]);
      showMeasurement(item);
      const loaded = () => {
        if (session !== state || state.ready) return;
        state.width = video ? media.videoWidth : media.naturalWidth;
        state.height = video ? media.videoHeight : media.naturalHeight;
        if (!state.width || !state.height) return;
        state.ready = true;
        const saved = item.evaluation;
        if (saved) {
          state.marks = {objects: saved.objects, corners: saved.corners, curves: saved.curves,
            target: saved.tracking?.target ?? null};
          state.seconds = saved.frame_seconds;
          if (video && Math.abs(media.currentTime - state.seconds) > 0.001) {
            media.currentTime = state.seconds;
          }
        }
        if (!video || saved) {
          state.locked = true;
          if (video) media.controls = false;
        }
        if (video) {
          const tracking = saved?.tracking;
          el('tank-length').value = tracking?.tank_mm[0] ?? 1000;
          el('tank-width').value = tracking?.tank_mm[1] ?? 500;
          el('track-patch').value = '10';
          el('track-end').value = tracking?.end_seconds ?? defaultEnd(state);
          el('track-end').max = Math.max(0, media.duration - 0.001);
        }
        showRegistration(state);
        render();
      };
      media.addEventListener(video ? 'loadedmetadata' : 'load', loaded);
      if (video) {
        media.controls = true;
        media.playsInline = true;
        media.preload = 'metadata';
        media.addEventListener('seeking', render);
        media.addEventListener('seeked', render);
      } else media.alt = '수조 평가 사진';
      media.addEventListener('error', () => {
        if (session === state) say('evaluation-message', '파일을 표시하지 못했습니다. 영상은 H.264 MP4로 변환하거나 목록에서 다시 열어주세요.');
      });
      el('media-view').append(media);
      media.src = url;
    } catch (error) {
      if (version === detailVersion) say('evaluation-message', error.message);
    }
  }

  function setMode(mode, label) {
    if (!session?.locked) return;
    session.mode = mode;
    if (label) session.selected = label;
    render();
  }

  function selectGroup(group) {
    if (!session?.locked) return;
    const groupLabels = labels.filter(label => label.startsWith(group));
    setMode('objects', groupLabels.find(label => !session.marks.objects[label]) || groupLabels[0]);
  }

  function changeMarks(update) {
    if (!session || saveCount || session.preview) return;
    session.history.push({marks: structuredClone(session.marks), mode: session.mode, selected: session.selected});
    update(session);
    session.dirty = true;
    say('evaluation-message');
    render();
  }

  function place(event) {
    const state = session;
    if (!state?.locked || state.media.seeking || saveCount || state.preview) return;
    const rect = el('media-overlay').getBoundingClientRect();
    const clamp = value => Math.min(1, Math.max(0, value));
    const p = [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)];
    if (state.mode === 'target') {
      changeMarks(s => { s.marks.target = p; });
      return;
    }
    if (state.mode === 'objects') {
      changeMarks(s => {
        s.marks.objects[s.selected] = p;
        const group = s.selected[0];
        const next = labels.find(label => label.startsWith(group) && !s.marks.objects[label]);
        if (next) s.selected = next;
      });
      return;
    }
    const points = state.mode === 'tank' ? state.marks.corners : state.marks.curves[state.mode];
    const max = state.mode === 'tank' ? 4 : 3;
    if (points.length === max) return;
    changeMarks(() => { points.push(p); });
  }

  function clear() {
    changeMarks(s => {
      if (s.mode === 'objects') delete s.marks.objects[s.selected];
      else if (s.mode === 'tank') s.marks.corners = [];
      else if (s.mode === 'target') s.marks.target = null;
      else s.marks.curves[s.mode] = [];
    });
  }

  function undo() {
    if (!session?.history.length || saveCount || session.preview) return;
    Object.assign(session, session.history.pop());
    session.dirty = true;
    render();
  }

  function lockFrame() {
    if (!session?.video || !session.ready || session.media.seeking) return;
    session.media.pause();
    session.seconds = session.media.currentTime;
    session.media.controls = false;
    session.locked = true;
    el('track-end').value = defaultEnd(session);
    render();
  }

  function resetFrame() {
    if (!session?.video || saveCount || session.preview) return;
    const {objects, corners: markedCorners, curves} = session.marks;
    const hasMarks = Object.keys(objects).length || markedCorners.length || curves.left.length || curves.right.length || session.marks.target;
    if (hasMarks && !window.confirm('다른 프레임을 선택하면 현재 표시를 지웁니다. 계속할까요?')) return;
    Object.assign(session, {locked: false, seconds: null, marks: freshMarks(), mode: 'objects', selected: 'A1', history: [], dirty: true});
    session.media.controls = true;
    render();
  }

  function graphic(type, attrs, text) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', type);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
    if (text) element.textContent = text;
    el('media-overlay').append(element);
  }

  function draw(s) {
    const overlay = el('media-overlay');
    overlay.replaceChildren();
    overlay.classList.toggle('marking', !!(s?.locked && !s.media.seeking && !saveCount && !s.preview));
    if (!s?.locked || !s.width || s.media.seeking) return;
    overlay.setAttribute('viewBox', '0 0 ' + s.width + ' ' + s.height);
    overlay.setAttribute('preserveAspectRatio', 'none');
    const xy = ([x, y]) => [x * s.width, y * s.height];
    const rgb = {tank: '#76e9d7', left: '#ffbd60', right: '#ff9ce2', A: '#bff67c', B: '#a9caff'};
    const scale = Math.max(1, Math.min(s.width, s.height) / 265);
    function marker(p, label, color, active = false) {
      const [x, y] = xy(p);
      graphic('circle', {cx: x, cy: y, r: (active ? 4.5 : 3.3) * scale, fill: color, stroke: '#101c19', 'stroke-width': scale});
      const right = p[0] > 0.91;
      graphic('text', {
        x: x + (right ? -6 : 6) * scale, y: y + 4 * scale, fill: color, stroke: '#101c19',
        'stroke-width': 2 * scale, 'paint-order': 'stroke', 'font-size': 10 * scale,
        'font-weight': 700, 'text-anchor': right ? 'end' : 'start'
      }, label);
    }
    if (s.preview) {
      for (const [label, p] of Object.entries(s.registered.payload.tracking.ends)) marker(p, label, rgb[label[0]]);
      marker(s.registered.payload.tracking.target, '진동원', '#fff087');
      return;
    }
    const vertices = s.marks.corners.map(xy);
    if (vertices.length > 1) {
      graphic(vertices.length === 4 ? 'polygon' : 'polyline', {
        points: vertices.map(p => p.join(',')).join(' '), fill: 'none',
        stroke: rgb.tank, 'stroke-width': 1.2 * scale, 'stroke-dasharray': [5 * scale, 3 * scale].join(' ')
      });
    }
    s.marks.corners.forEach((p, i) => marker(p, String(i + 1), rgb.tank));
    for (const side of ['left', 'right']) {
      const curve = s.marks.curves[side];
      if (curve.length === 3) {
        const [a, b, c] = curve.map(xy);
        const cp = b.map((coord, i) => 2 * coord - (a[i] + c[i]) / 2);
        const path = 'M ' + a.join(' ') + ' Q ' + cp.join(' ') + ' ' + c.join(' ');
        graphic('path', {d: path + ' Z', fill: rgb[side], 'fill-opacity': .3});
        graphic('path', {d: path, fill: 'none', stroke: rgb[side], 'stroke-width': 2 * scale});
        graphic('line', {x1: a[0], y1: a[1], x2: c[0], y2: c[1], stroke: rgb[side],
          'stroke-width': scale, 'stroke-dasharray': [4 * scale, 3 * scale].join(' ')});
      }
      curve.forEach((p, i) => marker(p, ['시작', '중간', '끝'][i], rgb[side]));
    }
    for (const [label, p] of Object.entries(s.marks.objects)) {
      marker(p, label, rgb[label[0]], s.mode === 'objects' && s.selected === label);
    }
    if (s.marks.target) marker(s.marks.target, '진동원', '#fff087', s.mode === 'target');
  }

  function render() {
    const s = session;
    if (!s) return;
    const locked = s.ready && s.locked;
    el('mark-tools').hidden = !locked || s.preview;
    el('evaluation-save').hidden = !locked || s.preview;
    el('mark-target').hidden = !s.video;
    el('tracking-controls').hidden = !locked || !s.video;
    el('track-register').disabled = !!saveCount || s.media.seeking || s.preview;
    el('track-preview').disabled = !!saveCount || (!s.preview && s.media.seeking);
    for (const id of ['tank-length', 'tank-width', 'track-end', 'track-patch']) el(id).disabled = !!saveCount || s.preview;
    el('frame-actions').hidden = !s.video || !s.ready;
    el('lock-frame').hidden = locked;
    el('lock-frame').disabled = s.media.seeking;
    el('reset-frame').hidden = !locked;
    el('reset-frame').disabled = !!saveCount || s.preview;
    el('undo-mark').disabled = !s.history.length || !!saveCount;
    el('draft-evaluation').disabled = el('save-evaluation').disabled = !!saveCount || s.media.seeking;
    if (s.video) {
      const time = s.preview ? s.registered.payload.tracking.end_seconds : s.seconds;
      const label = s.preview ? '등록한 종료 프레임' : '평가 프레임';
      say('frame-label', locked ? label + ' · ' + time.toFixed(3) + '초' : '영상에서 평가할 장면을 고르세요.');
    }
    for (const button of el('float-markers').children) {
      const label = button.dataset.label;
      button.dataset.marked = String(label in s.marks.objects);
      button.setAttribute('aria-pressed', String(s.mode === 'objects' && s.selected === label));
    }
    for (const [button, mode] of [['mark-tank', 'tank'], ['mark-left', 'left'], ['mark-right', 'right'], ['mark-target', 'target']]) {
      el(button).setAttribute('aria-pressed', String(s.mode === mode));
    }
    let help;
    const count = Object.keys(s.marks.objects).length;
    if (s.mode === 'objects') {
      help = s.selected + '의 중심을 클릭하세요. (' + count + '/12 지정)';
    } else if (s.mode === 'tank') {
      const n = s.marks.corners.length;
      help = n === 4 ? '수조 꼭짓점 4개를 지정했습니다.' : corners[n] + ' 꼭짓점을 클릭하세요. (' + n + '/4 지정)';
    } else if (s.mode === 'target') {
      help = '수면에서 거리를 잴 기준점인 진동원 중심을 클릭하세요.';
    } else {
      const n = s.marks.curves[s.mode].length;
      const side = walls[s.mode] + ' 끝 벽';
      const steps = ['휘어 보이기 시작하는 점', '휘어진 경계의 중간점', '휘어 보이는 구간이 끝나는 점'];
      help = n === 3 ? side + '의 휘어진 구간을 표시했습니다.' : side + '에서 ' + steps[n] + '을 클릭하세요.';
    }
    say('mark-help', help);
    draw(s);
  }

  function defaultEnd(s) {
    if (!Number.isFinite(s.media.duration)) return '';
    return Math.floor(Math.max(0, Math.min(s.media.duration - 0.04, (s.seconds ?? 0) + 600)) * 1000) / 1000;
  }

  function trackingSettings(s) {
    const tank_mm = [Number(el('tank-length').value), Number(el('tank-width').value)];
    const end_seconds = Number(el('track-end').value);
    const span = end_seconds - s.seconds;
    if (!s.video || !s.marks.target || !tank_mm.every(n => n >= 1 && n <= 20000)
        || !(span >= 0.2 && span <= 600 && end_seconds < s.media.duration)) return null;
    return {target: s.marks.target, tank_mm, end_seconds};
  }

  async function storeEvaluation(s, complete, tracking) {
    const {objects, corners, curves} = s.marks;
    const saved = await api('media/' + s.item.id + '/evaluation', post('PUT', {
      objects, corners, curves, tracking, frame_seconds: s.seconds,
      width: s.width, height: s.height, revision: s.item.revision, complete
    }));
    Object.assign(s.item, saved);
    s.dirty = false;
    say('evaluation-status', statuses[saved.status]);
  }

  async function save(complete) {
    const s = session;
    if (!s?.locked || s.media.seeking || saveCount) return;
    saveCount++;
    render();
    say('evaluation-message', '평가 저장 중…');
    try {
      await storeEvaluation(s, complete, trackingSettings(s));
      if (s === session) {
        say('evaluation-message', complete ? '평가를 완료했습니다.' : '표시를 임시 저장했습니다.');
      }
    } catch (error) {
      if (s === session) say('evaluation-message', error.message);
    } finally {
      saveCount--;
      render();
    }
  }

  function showRegistration(s) {
    el('track-result').hidden = !s.registered;
    const body = el('track-results-body');
    body.replaceChildren();
    if (!s.registered) return;
    const {id, payload} = s.registered;
    for (const [label, values] of Object.entries(payload.objects)) {
      const row = body.insertRow();
      for (const cell of [label, values[0].toFixed(2), values[1].toFixed(3)]) row.insertCell().textContent = cell;
    }
    say('track-message', id + ' · 생성기에 등록된 실측값' +
      (payload.energy === null ? ' · 에너지 미확정' : ' · 구동 전체 에너지 ' + payload.energy + ' Wh'));
  }

  function previewTracking() {
    const s = session;
    if (!s?.locked || !s.registered || saveCount) return;
    s.preview = !s.preview;
    const end = s.registered.payload.tracking.end_seconds;
    s.media.currentTime = s.preview ? end : s.seconds;
    say('track-preview', s.preview ? '기준 프레임으로 돌아가기' : '등록한 종료 위치 보기');
    render();
  }

  async function runTracking() {
    const s = session;
    if (!s?.locked || !s.video || s.preview || saveCount || s.media.seeking) return;
    const summary = s.item.measurement_summary;
    const settings = trackingSettings(s);
    if (!summary?.case_id) return say('track-message', '같은 회차의 case.json을 먼저 연결하세요.');
    if (summary.variable_control) return say('track-message', '현재 생성기는 구동 조건이 일정한 실험을 지원합니다.');
    if (Object.keys(s.marks.objects).length !== 12 || s.marks.corners.length !== 4 || !s.marks.target) {
      return say('track-message', '부유물 12개와 수조 꼭짓점 4개, 진동원 중심을 먼저 지정하세요.');
    }
    if (!settings) return say('track-message', '수조 실제 크기와 영상 종료 시각을 확인하세요.');
    const progress = el('track-progress');
    const cancel = el('track-cancel');
    const controller = new AbortController();
    s.tracker = controller;
    saveCount++;
    render();
    cancel.hidden = false;
    progress.hidden = false;
    progress.value = 0;
    say('track-message', '기준 프레임 저장 중…');
    try {
      await storeEvaluation(s, true, settings);
      say('track-message', '영상 불러오는 중…');
      const result = await window.waterfulTrackVideo({url: s.url, start: s.seconds, end: settings.end_seconds,
        seeds: s.marks.objects, corners: s.marks.corners, patch: Number(el('track-patch').value), signal: controller.signal,
        progress: (done, total) => {
          progress.value = Math.round(100 * done / total);
          say('track-message', '부유물 12개 추적 중 · ' + progress.value + '%');
        }
      });
      if (controller.signal.aborted) throw Error('추적을 취소했습니다.');
      cancel.hidden = true;
      say('track-message', '생성기에 등록 중…');
      s.registered = await api('media/' + s.item.id + '/register-tracking', post('POST', {...result, revision: s.item.revision}));
      showRegistration(s);
    } catch (error) {
      say('track-message', controller.signal.aborted ? '추적을 취소했습니다.' : error.message);
    } finally {
      cancel.hidden = progress.hidden = true;
      s.tracker = null;
      saveCount--;
      render();
    }
  }

  for (const label of labels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.label = label;
    button.onclick = () => setMode('objects', label);
    el('float-markers').append(button);
  }
  for (const [button, mode] of [['mark-tank', 'tank'], ['mark-left', 'left'], ['mark-right', 'right'], ['mark-target', 'target']]) {
    el(button).onclick = () => setMode(mode);
  }
  action('connect', async () => {
    await api('session');
    el('tabs').hidden = false;
    await go('uploads').catch(() => {});
    return '연결했습니다.';
  });
  el('media-upload-form').onsubmit = upload;
  el('measurement-download').onclick = downloadMeasurement;
  el('attach-case-button').onclick = attachCase;
  el('track-register').onclick = runTracking;
  el('track-cancel').onclick = () => session?.tracker?.abort();
  el('track-preview').onclick = previewTracking;
  el('media-refresh').onclick = () => list().catch(() => {});
  el('media-prev').onclick = () => { if (page) page--; list().catch(() => {}); };
  el('media-next').onclick = () => { page++; list().catch(() => {}); };
  el('return-list').onclick = () => go('uploads').catch(() => {});
  for (const button of el('tabs').querySelectorAll('button')) {
    button.onclick = () => go(button.dataset.tab).catch(error => say('msg', error.message));
  }
  el('mark-a').onclick = () => selectGroup('A');
  el('mark-b').onclick = () => selectGroup('B');
  el('lock-frame').onclick = lockFrame;
  el('reset-frame').onclick = resetFrame;
  el('media-overlay').onpointerup = place;
  el('undo-mark').onclick = undo;
  el('clear-mark').onclick = clear;
  el('draft-evaluation').onclick = () => save(false);
  el('save-evaluation').onclick = () => save(true);
})();
