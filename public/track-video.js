/* Seeded template matching, running on the browser's decoded frames. */
(() => {
  const minScore = 0.78;
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const contained = ([x, y], corners) => corners.every(([ax, ay], i) => {
    const [bx, by] = corners[(i + 1) % corners.length];
    return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= -1e-8;
  });

  function template(pixels, width, [x, y], radius) {
    const offsets = [];
    const values = [];
    const index = y * width + x;
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        const offset = Math.round(i * radius / 3) * width + Math.round(j * radius / 3);
        offsets.push(offset);
        values.push(pixels[index + offset]);
      }
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const centered = values.map(v => v - mean);
    const norm = Math.hypot(...centered);
    if (norm < 8 * Math.sqrt(values.length)) throw Error('중심 주변이 너무 균일합니다. 부유물 중심이나 추적 범위를 조정하세요.');
    return {offsets, centered, norm, radius};
  }

  function match(pixels, width, height, state, search) {
    const {offsets, centered, norm, radius} = state.template;
    const score = (x, y) => {
      if (x < radius || x >= width - radius || y < radius || y >= height - radius) return -1;
      const index = y * width + x;
      let sum = 0, squared = 0, dot = 0;
      for (let i = 0; i < offsets.length; i++) {
        const v = pixels[index + offsets[i]];
        sum += v;
        squared += v * v;
        dot += v * centered[i];
      }
      const variance = squared - sum * sum / offsets.length;
      return variance > 4 * offsets.length ? Math.min(1, dot / (norm * Math.sqrt(variance))) : -1;
    };
    const [x, y] = state.center;
    const [dx, dy] = state.velocity;
    const cx = Math.round(x + dx), cy = Math.round(y + dy);
    const rank = (x0, y0, score) => score - 0.035 * Math.hypot(x0 - cx, y0 - cy) / search;
    let best = {center: [x, y], score: -1, rank: -2};
    const coarse = [];
    const check = (px, py) => {
      const raw = score(px, py), ranked = rank(px, py, raw);
      const candidate = {center: [px, py], score: raw, rank: ranked};
      if (ranked > best.rank) best = candidate;
      return candidate;
    };
    for (let y0 = cy - search; y0 <= cy + search; y0 += 2) {
      for (let x0 = cx - search; x0 <= cx + search; x0 += 2) coarse.push(check(x0, y0));
    }
    for (let j = -5; j <= 5; j++) {
      for (let i = -5; i <= 5; i++) check(cx + i, cy + j);
    }
    const [bx, by] = best.center;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) check(bx + i, by + j);
    }
    const ambiguity = coarse.some(c => distance(c.center, best.center) > Math.max(6, radius * 0.8)
      && c.score >= 0.91 && c.rank >= best.rank - 0.025);
    return {...best, ambiguity};
  }

  function startTracks(pixels, width, height, seeds, patch) {
    const coordinates = Object.entries(seeds).map(([label, [x, y]]) =>
      [label, [Math.round(x * width), Math.round(y * height)]]);
    return coordinates.map(([label, center]) => {
      const [x, y] = center;
      const closest = Math.min(...coordinates.filter(row => row[0] !== label).map(row => distance(center, row[1])));
      const radius = Math.min(patch, Math.floor(closest / 2) - 1);
      if (radius < 4 || x < radius || x >= width - radius || y < radius || y >= height - radius) {
        throw Error(label + ' 주변에 추적할 공간이 부족합니다.');
      }
      try {
        return {label, center, velocity: [0, 0], template: template(pixels, width, center, radius), minimum: 1};
      } catch (error) {
        throw Error(label + ' — ' + error.message);
      }
    });
  }

  function advance(pixels, width, height, tracks, corners, search, seconds) {
    const candidates = tracks.map(t => match(pixels, width, height, t, search));
    const abort = label => { throw Error(label + '를 ' + seconds.toFixed(2) + '초에서 구분하지 못했습니다. 시작점을 확인하거나 분석 구간을 줄여주세요.'); };
    const overlap = (i, j) => distance(candidates[i].center, candidates[j].center) <
      Math.max(4, Math.min(tracks[i].template.radius, tracks[j].template.radius) * 0.7);
    for (let i = 0; i < tracks.length; i++) {
      const result = candidates[i];
      const [x, y] = result.center;
      if (result.score < minScore || result.ambiguity || !contained([x / width, y / height], corners)
          || candidates.some((_, j) => i !== j && overlap(i, j))) abort(tracks[i].label);
    }
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i], result = candidates[i];
      t.velocity = result.center.map((n, axis) => (n - t.center[axis]) * 0.65 + t.velocity[axis] * 0.35);
      t.center = result.center;
      t.minimum = Math.min(t.minimum, result.score);
    }
  }

  function mediaEvent(video, name, signal, action) {
    return new Promise((resolve, reject) => {
      let timeout;
      const settle = error => {
        clearTimeout(timeout);
        video.removeEventListener(name, done);
        video.removeEventListener('error', failed);
        signal.removeEventListener('abort', stopped);
        if (error) reject(error);
        else resolve();
      };
      const done = () => settle();
      const failed = () => settle(Error('영상 프레임을 읽지 못했습니다. H.264 MP4로 다시 시도하세요.'));
      const stopped = () => settle(Error('추적을 취소했습니다.'));
      if (signal.aborted) return stopped();
      video.addEventListener(name, done);
      video.addEventListener('error', failed);
      signal.addEventListener('abort', stopped);
      timeout = setTimeout(failed, 15000);
      try { action(); } catch (error) { settle(error); }
    });
  }

  async function trackVideo({url, stream = false, start, end, seeds, corners, patch, signal, progress}) {
    const ownsUrl = !stream && !url.startsWith('blob:');
    let objectUrl = url;
    if (ownsUrl) {
      const response = await fetch(url, {signal});
      if (!response.ok) throw Error('영상을 읽지 못했습니다. 항목을 다시 열어주세요.');
      objectUrl = URL.createObjectURL(await response.blob());
    }
    const video = document.createElement('video');
    if (stream) video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    try {
      await mediaEvent(video, 'loadeddata', signal, () => { video.src = objectUrl; });
      if (end >= video.duration || end <= start) throw Error('분석 종료 시각이 영상 범위를 벗어났습니다.');
      const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      const width = canvas.width = Math.round(video.videoWidth * scale);
      const height = canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      const grayscale = new Uint8Array(width * height);
      async function read(seconds) {
        if (signal.aborted) throw Error('추적을 취소했습니다.');
        if (Math.abs(video.currentTime - seconds) > 0.0005 || video.seeking) {
          await mediaEvent(video, 'seeked', signal, () => { video.currentTime = seconds; });
        }
        ctx.drawImage(video, 0, 0, width, height);
        const rgba = ctx.getImageData(0, 0, width, height).data;
        for (let i = 0, j = 0; i < grayscale.length; i++, j += 4) {
          grayscale[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
        }
        return grayscale;
      }
      for (const [label, p] of Object.entries(seeds)) {
        if (!contained(p, corners)) throw Error(label + ' 시작점이 수조 안에 있어야 합니다.');
      }
      const tracks = startTracks(await read(start), width, height, seeds, patch);
      const steps = Math.max(2, Math.ceil((end - start) * 8));
      const search = Math.max(14, Math.min(24, patch * 2));
      for (let i = 1; i <= steps; i++) {
        const seconds = start + (end - start) * (i / steps);
        advance(await read(seconds), width, height, tracks, corners, search, seconds);
        if (i % 4 === 0 || i === steps) progress(i, steps);
      }
      return {
        end_seconds: end, samples: steps + 1,
        ends: Object.fromEntries(tracks.map(({label, center: [x, y]}) => [label, [x / width, y / height]])),
        min_score: Object.fromEntries(tracks.map(({label, minimum}) => [label, minimum]))
      };
    } finally {
      video.removeAttribute('src');
      video.load();
      if (ownsUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  window.waterfulTrackVideo = trackVideo;
})();
