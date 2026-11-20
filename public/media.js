(() => {
  const labels = ['A', 'B'].flatMap(group => Array.from({length: 6}, (_, i) => group + (i + 1)));
  const corners = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];
  const walls = {left: '왼쪽', right: '오른쪽'};
  const statuses = {uploaded: '평가 대기', draft: '작성 중', evaluated: '평가 완료'};
  let maxVideoBytes = 1_000_000_000;
  const maxPhotoBytes = 50_000_000;
  const maxCsvBytes = 1_000_000;
  const maxCaseBytes = 65_536;
  let page = 0;
  let listVersion = 0;
  let detailVersion = 0;
  let session = null;
  let saveCount = 0;
  const uploadQueue = [];
  let uploadingBatch = false;
  let openRequest = null;

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
        details.textContent = [statuses[item.status], linked, item.storage_backend === 'drive' ? 'Drive' : null,
          new Date(item.created_at).toLocaleString('ko-KR')].filter(Boolean).join(' · ');
        button.append(name, details);
        button.addEventListener('click', () => openFromList(item));
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

  async function openFromList(item) {
    if (saveCount) return;
    try {
      if (item.storage_backend === 'drive') await window.waterfulDrive.connect();
      await open(item.id);
    } catch (error) {
      say('media-list-message', error.message);
    }
  }

  function sendFile(url, blob, filename, progress, rawMime = null) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) progress(event.loaded / event.total);
      };
      xhr.timeout = rawMime ? 1_800_000 : 300_000;
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(Error('파일 전송이 중단되었습니다. 다시 시도하세요.'));
      xhr.onload = () => {
        if ((xhr.status >= 200 && xhr.status < 300) || (rawMime && xhr.status === 412)) resolve();
        else if (xhr.status === 413) reject(Error('저장소에서 크기 또는 사용량 제한으로 전송을 거절했습니다.'));
        else if (rawMime && xhr.status === 403) reject(Error('R2에 영상을 저장할 권한이 없습니다. 버킷 토큰과 설정을 확인하세요.'));
        else reject(Error('파일을 전송하지 못했습니다 (HTTP ' + xhr.status + ').'));
      };
      if (rawMime) {
        xhr.setRequestHeader('Content-Type', rawMime);
        xhr.setRequestHeader('If-None-Match', '*');
        xhr.send(blob);
        return;
      }
      const form = new FormData();
      form.append('cacheControl', '3600');
      form.append('', blob, filename);
      xhr.send(form);
    });
  }

  async function sendParts(pending, progress) {
    const {file, setup} = pending;
    const count = Math.ceil(file.size / setup.part_size);
    while (pending.next < count) {
      const index = pending.next;
      const start = index * setup.part_size;
      const blob = file.slice(start, Math.min(start + setup.part_size, file.size), 'application/octet-stream');
      const report = fraction => progress((start + blob.size * fraction) / file.size);
      report(0);
      pending.message.textContent = '영상 전송 중 · ' + (index + 1) + ' / ' + count;
      const part = await api('media/' + setup.id + '/upload-part/' + index, {method: 'POST'});
      if (!part.stored) await sendFile(part.upload_url, blob, 'part-' + index, report);
      pending.next++;
      report(1);
    }
  }

  function updateUploadControls() {
    const active = uploadQueue.filter(item => item.state !== 'done');
    el('media-file').disabled = uploadingBatch;
    el('media-upload').disabled = uploadingBatch || active.length === 0;
    say('media-upload', active.length && active.every(item => item.state === 'failed') ? '실패한 파일 다시 올리기' : '일괄 업로드');
    for (const item of uploadQueue) {
      const canEdit = !uploadingBatch && !item.attempt && item.state !== 'done';
      item.measurement.disabled = item.caseFile.disabled = !canEdit;
      item.remove.disabled = uploadingBatch;
    }
  }

  function attachmentControl(text, accept) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    label.append(text, input);
    return {label, input};
  }

  function addUploads() {
    const picker = el('media-file');
    if (uploadingBatch) return;
    for (const file of picker.files) {
      const isVideo = /\.(mp4|mov|webm)$/i.test(file.name);
      const row = document.createElement('li');
      row.className = 'queued-media';
      row.dataset.status = 'queued';
      const header = document.createElement('div');
      header.className = 'media-line';
      const name = document.createElement('strong');
      name.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = '목록에서 제거';
      remove.setAttribute('aria-label', file.name + ' 목록에서 제거');
      header.append(name, remove);
      const attachments = document.createElement('div');
      attachments.className = 'media-line';
      const measurement = attachmentControl('measurements.csv (' + (isVideo ? '필수' : '선택') + ')', '.csv');
      const caseFile = attachmentControl('case.json (선택)', '.json');
      attachments.append(measurement.label, caseFile.label);
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.hidden = true;
      progress.setAttribute('aria-label', file.name + ' 전송 진행률');
      const message = document.createElement('p');
      message.className = 'media-message';
      message.setAttribute('role', 'status');
      row.append(header, attachments, progress, message);

      const item = {file, isVideo, row, remove, attachments, progress, message, state: 'queued',
        measurement: measurement.input, caseFile: caseFile.input, attempt: null};
      remove.onclick = () => {
        uploadQueue.splice(uploadQueue.indexOf(item), 1);
        row.remove();
        updateUploadControls();
      };
      uploadQueue.push(item);
      el('upload-queue').append(row);
    }
    picker.value = '';
    say('upload-message');
    updateUploadControls();
  }

  async function uploadItem(item) {
    const {file, isVideo, progress, message} = item;
    const measurementFile = item.measurement.files[0];
    const caseFile = item.caseFile.files[0];
    if (!file.size) throw Error('빈 파일입니다.');
    if (file.size > (isVideo ? maxVideoBytes : maxPhotoBytes)) {
      throw Error('영상은 ' + maxVideoBytes / 1_000_000_000 + ' GB 이하, 사진은 50 MB 이하로 올려주세요.');
    }
    if (!measurementFile && (isVideo || caseFile)) throw Error('같은 회차의 measurements.csv를 선택하세요.');
    if (measurementFile?.size > maxCsvBytes) throw Error('측정 CSV는 1 MB 이하여야 합니다.');
    if (caseFile?.size > maxCaseBytes) throw Error('case.json은 64 KiB 이하여야 합니다.');

    message.textContent = '업로드 중…';
    progress.hidden = false;
    if (!item.attempt) {
      const measurement = measurementFile ? {name: measurementFile.name, csv: await measurementFile.text()} : null;
      const caseJson = caseFile ? await caseFile.text() : null;
      const setup = await api('media/upload', post('POST', {
        name: file.name, size_bytes: file.size, measurement, case_json: caseJson
      }));
      item.attempt = {file, setup, next: 0, message};
    }

    const attempt = item.attempt;
    const {setup} = attempt;
    const report = fraction => { progress.value = fraction * 100; };
    if (setup.backend === 'r2' && attempt.next === 0) {
      const {upload_url} = await api('media/' + setup.id + '/upload-url', {method: 'POST'});
      await sendFile(upload_url, file, file.name, report, setup.mime_type);
      attempt.next = 1;
    } else if (setup.part_size) {
      await sendParts(attempt, report);
    } else if (attempt.next === 0) {
      await sendFile(setup.upload_url, file.slice(0, file.size, setup.mime_type), file.name, report);
      attempt.next = 1;
    }
    await api('media/' + setup.id + '/finish', {method: 'POST'});
  }

  async function upload(event) {
    event.preventDefault();
    if (uploadingBatch) return;
    const batch = uploadQueue.filter(item => item.state !== 'done');
    if (!batch.length) return;

    uploadingBatch = true;
    updateUploadControls();
    let completed = 0;
    try {
      for (const [index, item] of batch.entries()) {
        say('upload-message', '일괄 업로드 중 · ' + (index + 1) + ' / ' + batch.length);
        item.state = item.row.dataset.status = 'uploading';
        try {
          await uploadItem(item);
          item.state = item.row.dataset.status = 'done';
          item.message.textContent = '업로드 완료';
          item.attachments.hidden = true;
          item.remove.textContent = '대기 목록에서 숨기기';
          item.remove.setAttribute('aria-label', item.file.name + ' 대기 목록에서 숨기기');
          item.file = item.attempt = null;
          item.measurement.value = item.caseFile.value = '';
          completed++;
          page = 0;
          void list().catch(() => {});
        } catch (error) {
          item.state = item.row.dataset.status = 'failed';
          item.message.textContent = error.message;
        } finally {
          item.progress.hidden = true;
        }
      }
      const failed = batch.length - completed;
      say('upload-message', completed + '개 완료' + (failed ? ' · ' + failed + '개 실패' : ''));
    } finally {
      uploadingBatch = false;
      updateUploadControls();
    }
  }

  async function importDrive(event) {
    event.preventDefault();
    const button = el('drive-import-button');
    if (button.disabled) return;
    button.disabled = true;
    const errors = el('drive-import-errors');
    errors.replaceChildren();
    say('drive-import-message', 'Google Drive 연결 중…');
    try {
      const drive = window.waterfulDrive;
      await drive.connect();
      const folders = await drive.getFolders(el('drive-folder').value.trim());
      let added = 0, reused = 0, failed = 0;
      for (const [index, folder] of folders.entries()) {
        say('drive-import-message', '실험 가져오는 중 · ' + (index + 1) + ' / ' + folders.length);
        try {
          const data = await drive.readCase(folder);
          const result = await api('media/import-drive', post('POST', data));
          if (result.already_registered) reused++;
          else added++;
        } catch (error) {
          failed++;
          const li = document.createElement('li');
          li.textContent = folder.name + ' · ' + error.message;
          errors.append(li);
        }
      }
      say('drive-import-message', added + '개 등록 · ' + reused + '개 이미 등록됨 · ' + failed + '개 실패');
      page = 0;
      await list().catch(() => {});
    } catch (error) {
      say('drive-import-message', error.message);
    } finally {
      button.disabled = false;
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

  async function joinParts(parts, item, signal) {
    const buffers = [];
    let received = 0;
    for (const part of parts) {
      const response = await fetch(part.url, {signal});
      if (!response.ok) throw Error('영상 일부를 받지 못했습니다. 목록에서 다시 열어주세요.');
      const blob = await response.blob();
      if (blob.size !== part.size) throw Error('받은 영상 조각의 크기가 일치하지 않습니다.');
      buffers.push(blob);
      received += blob.size;
      say('evaluation-message', '영상 불러오는 중 · ' + Math.round(100 * received / item.size_bytes) + '%');
    }
    if (received !== item.size_bytes) throw Error('받은 영상의 크기가 일치하지 않습니다.');
    return URL.createObjectURL(new Blob(buffers, {type: item.mime_type}));
  }

  async function open(id) {
    if (saveCount) return;
    if (session?.dirty && !window.confirm('저장하지 않은 표시가 있습니다. 다른 항목을 열까요?')) return;
    const version = ++detailVersion;
    openRequest?.abort();
    const controller = new AbortController();
    openRequest = controller;
    session?.media?.pause?.();
    if (session?.url?.startsWith('blob:')) URL.revokeObjectURL(session.url);
    session = null;
    await go('evaluation');
    el('evaluation-empty').hidden = true;
    el('evaluation-editor').hidden = false;
    el('media-view').replaceChildren();
    el('media-overlay').replaceChildren();
    for (const name of ['mark-tools', 'frame-actions', 'evaluation-save', 'tracking-controls', 'track-result', 'track-correction']) el(name).hidden = true;
    say('track-message');
    el('evaluation-case-file').value = '';
    say('evaluation-title', '항목 불러오는 중…');
    say('evaluation-status');
    say('evaluation-message');
    el('evaluation-measurements').hidden = true;
    try {
      const {item, media_url, media_parts, registered} = await api('media/' + id, {signal: controller.signal});
      if (version !== detailVersion) return;
      say('evaluation-title', item.name);
      let url = media_url;
      if (media_parts || item.storage_backend === 'drive') {
        say('evaluation-message', item.storage_backend === 'drive' ? 'Drive 영상 불러오는 중…' : '영상 불러오는 중…');
        url = media_parts ? await joinParts(media_parts, item, controller.signal)
          : await window.waterfulDrive.openVideo(item, controller.signal);
        if (version !== detailVersion) {
          URL.revokeObjectURL(url);
          return;
        }
        say('evaluation-message');
      }
      const video = item.mime_type.startsWith('video/');
      const media = document.createElement(video ? 'video' : 'img');
      const state = {
        item, media, video, url, registered, preview: false, tracker: null, correction: null,
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
    } finally {
      if (openRequest === controller) openRequest = null;
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
    if (!state?.locked || state.media.seeking || (saveCount && !state.correction) || state.preview) return;
    const rect = el('media-overlay').getBoundingClientRect();
    const clamp = value => Math.min(1, Math.max(0, value));
    const p = [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)];
    if (state.correction) {
      const correction = state.correction;
      if (Math.abs(state.media.currentTime - correction.seconds) > 0.005 || !state.media.paused) {
        correction.message = '종료 위치를 수정하려면 종료 장면 보기를 누르세요.';
        render();
        return;
      }
      const corners = state.marks.corners;
      const inside = corners.every(([ax, ay], i) => {
        const [bx, by] = corners[(i + 1) % corners.length];
        return (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) >= -1e-8;
      });
      if (!inside) {
        correction.message = '수조 안에 있는 조각의 중심을 클릭하세요.';
      } else {
        correction.manual[correction.selected] = p;
        correction.selected = correction.missing.find(label => !Object.hasOwn(correction.manual, label)) ?? correction.selected;
        correction.message = '';
      }
      render();
      return;
    }
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
    overlay.classList.toggle('marking', !!(s?.locked && !s.media.seeking && (!saveCount || s.correction) && !s.preview));
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
    if (s.correction) {
      const {automatic, manual, selected, seconds, history, start, step} = s.correction;
      if (Math.abs(s.media.currentTime - seconds) > 0.005) {
        const frame = history[Math.round((s.media.currentTime - start) / step)] ?? {};
        for (const [label, point] of Object.entries(frame)) {
          marker(point, label, label === selected ? '#fff087' : rgb[label[0]], label === selected);
        }
        return;
      }
      for (const [label, point] of Object.entries({...automatic, ...manual})) {
        marker(point, label, Object.hasOwn(manual, label) ? '#fff087' : rgb[label[0]], label === selected);
      }
      return;
    }
    if (s.tracker && Math.abs(s.media.currentTime - s.seconds) > 0.0005) return;
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
    const correction = s.correction;
    el('track-correction').hidden = !correction;
    if (correction) {
      const pending = correction.missing.filter(label => !Object.hasOwn(correction.manual, label));
      el('track-correct-continue').disabled = false;
      el('track-review-time').value = s.media.currentTime;
      for (const button of el('track-end-markers').children) {
        const label = button.dataset.label;
        button.textContent = pending.includes(label) ? label + ' · 확인 필요' : label;
        button.classList.toggle('secondary', !pending.includes(label));
        button.setAttribute('aria-pressed', String(correction.selected === label));
      }
      say('track-correction-help', s.media.currentTime.toFixed(2) + '초 · ' + correction.selected + ' · ' +
        (correction.message || ('미확정 ' + pending.length + '개. 번호를 눌러 마지막 확인 위치를 본 뒤 재생하세요. 식별이 어려우면 그대로 저장하세요.')));
    }
    el('mark-tools').hidden = !locked || s.preview || !!correction;
    el('evaluation-save').hidden = !locked || s.preview || !!correction;
    el('mark-target').hidden = !s.video;
    el('tracking-controls').hidden = !locked || !s.video;
    el('track-register').disabled = !!saveCount || s.media.seeking || s.preview;
    el('track-preview').disabled = !!saveCount || (!s.preview && s.media.seeking);
    for (const id of ['tank-length', 'tank-width', 'track-end', 'track-patch', 'track-review']) el(id).disabled = !!saveCount || s.preview;
    el('frame-actions').hidden = !s.video || !s.ready || !!correction;
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
    for (const label of labels) {
      const values = payload.objects[label];
      const row = body.insertRow();
      for (const cell of [label, values?.[0]?.toFixed(2) ?? '—', values?.[1]?.toFixed(3) ?? '미확정']) row.insertCell().textContent = cell;
    }
    const manualCount = Object.values(payload.tracking.manual_frames ?? {}).reduce((a, b) => a + b, 0);
    say('track-message', id + (payload.tracking.unresolved?.length ? ' · 부분 결과 저장 · 생성기 학습 제외' : ' · 생성기에 등록된 실측값') + (manualCount ? ' · 수동 표시 ' + manualCount + '건' : '') +
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

  function lastSeen(s) {
    const c = s.correction;
    for (let i = c.history.length - 1; i >= 0; i--) {
      if (c.history[i][c.selected]) return c.start + c.step * i;
    }
    return c.start;
  }

  function reviewEndpoints(s, signal, {seconds, missing, ends, history, start, step}) {
    return new Promise((resolve, reject) => {
      const abort = () => finish(null, Error('추적을 취소했습니다.'));
      const fail = () => finish(null, Error('보정할 영상 프레임을 열지 못했습니다.'));
      const finish = (positions, error) => {
        signal.removeEventListener('abort', abort);
        s.media.removeEventListener('error', fail);
        s.media.removeEventListener('timeupdate', updateTime);
        s.media.pause();
        if (error) reject(error);
        else resolve(positions);
      };
      const updateTime = () => {
        if (!s.correction) return;
        if (s.media.currentTime >= seconds && !s.media.paused) {
          s.media.pause();
          s.media.currentTime = seconds;
        }
        render();
      };
      if (signal.aborted) return abort();
      s.media.addEventListener('timeupdate', updateTime);
      s.correction = {seconds, missing, history, start, step, automatic: ends, manual: {}, selected: missing[0], message: '', finish};
      signal.addEventListener('abort', abort, {once: true});
      s.media.addEventListener('error', fail, {once: true});
      el('track-review-time').min = start;
      el('track-review-time').max = seconds;
      try {
        s.media.currentTime = lastSeen(s);
      } catch {
        fail();
        return;
      }
      say('track-message', '자동 분석 완료 · 종료 위치 확인 대기');
      render();
      el('track-correction').scrollIntoView({block: 'start'});
    });
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
      const result = await window.waterfulTrackVideo({url: s.url, stream: s.item.storage_backend === 'r2',
        start: s.seconds, end: settings.end_seconds,
        seeds: s.marks.objects, corners: s.marks.corners, patch: Number(el('track-patch').value), signal: controller.signal,
        reviewEnds: el('track-review').checked ? review => reviewEndpoints(s, controller.signal, review) : null,
        progress: (done, total) => {
          progress.value = Math.round(100 * done / total);
          say('track-message', '부유물 12개 추적 중 · ' + progress.value + '%');
        }
      });
      if (controller.signal.aborted) throw Error('추적을 취소했습니다.');
      cancel.hidden = true;
      if (result.unresolved.some(label => s.registered?.payload.objects[label])) {
        throw Error('기존에 저장된 좌표 중 이번 분석에서 미확정된 항목이 있어 이전 결과를 보존했습니다. 영상 검토를 선택해 다시 확인할 수 있습니다.');
      }
      say('track-message', '추적 결과 저장 중…');
      s.registered = await api('media/' + s.item.id + '/register-tracking', post('POST', {...result, revision: s.item.revision}));
      showRegistration(s);
    } catch (error) {
      say('track-message', controller.signal.aborted ? '추적을 취소했습니다.' : error.message);
    } finally {
      cancel.hidden = progress.hidden = true;
      s.tracker = null;
      s.correction = null;
      if (!s.media.error && Math.abs(s.media.currentTime - s.seconds) > 0.0005) {
        s.media.currentTime = s.seconds;
      }
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
    const endButton = button.cloneNode();
    endButton.onclick = () => {
      if (!session?.correction) return;
      session.media.pause();
      session.correction.selected = label;
      session.media.currentTime = lastSeen(session);
      session.correction.message = '';
      render();
    };
    el('track-end-markers').append(endButton);
  }
  for (const [button, mode] of [['mark-tank', 'tank'], ['mark-left', 'left'], ['mark-right', 'right'], ['mark-target', 'target']]) {
    el(button).onclick = () => setMode(mode);
  }
  action('connect', async () => {
    const {video_storage, google_drive_client_id} = await api('session');
    window.waterfulDrive.configure(google_drive_client_id);
    el('drive-import').hidden = !google_drive_client_id;
    if (video_storage) maxVideoBytes = video_storage.limit_bytes;
    const location = video_storage?.backend === 'r2' ? '공유 영상 저장소 연결됨' : 'Supabase에 영상 저장';
    say('media-size-label', '영상 최대 ' + maxVideoBytes / 1_000_000_000 + ' GB · 사진 최대 50 MB · ' + location);
    el('tabs').hidden = false;
    await go('uploads').catch(() => {});
    return '연결했습니다.';
  });
  el('media-upload-form').onsubmit = upload;
  el('media-file').onchange = addUploads;
  el('drive-import-form').onsubmit = importDrive;
  el('measurement-download').onclick = downloadMeasurement;
  el('attach-case-button').onclick = attachCase;
  el('track-register').onclick = runTracking;
  el('track-cancel').onclick = () => session?.tracker?.abort();
  el('track-correct-cancel').onclick = el('track-cancel').onclick;
  el('track-replay').onclick = () => {
    const s = session;
    if (!s?.correction) return;
    s.media.currentTime = Math.max(s.correction.start, lastSeen(s) - 0.5);
    s.media.play().catch(() => say('track-correction-help', '슬라이더로 검토 시각을 조절하세요.'));
  };
  el('track-review-time').oninput = event => {
    session.media.pause();
    session.media.currentTime = Number(event.target.value);
  };
  el('track-end-frame').onclick = () => {
    session.media.pause();
    session.media.currentTime = session.correction.seconds;
    session.correction.message = '확인한 조각의 중심을 클릭하거나 그대로 저장하세요.';
    render();
  };
  el('track-correct-continue').onclick = () => {
    const s = session;
    if (!s?.correction) return;
    const {automatic, manual, finish} = s.correction;
    const positions = Object.entries({...automatic, ...manual});
    const scale = Math.min(1, 800 / Math.max(s.width, s.height));
    for (const [i, [label, [x, y]]] of positions.entries()) {
      const overlap = positions.slice(i + 1).find(([, [ox, oy]]) =>
        Math.hypot((x - ox) * s.width, (y - oy) * s.height) * scale < 3);
      if (overlap) {
        s.correction.message = label + '와 ' + overlap[0] + '의 점이 겹칩니다. 두 조각의 중심을 각각 확인하세요.';
        render();
        return;
      }
    }
    s.correction = null;
    render();
    finish(manual);
  };
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
