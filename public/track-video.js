/* Seeded template matching, running on the browser's decoded frames. */
(() => {
  const minScore = 0.78;
  const shortGap = 2;
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
    const [x, y] = state.pending ?? state.center;
    const [dx, dy] = state.velocity;
    const ahead = state.pending ? 0 : Math.min(state.gap + 1, 3);
    const cx = Math.round(x + dx * ahead), cy = Math.round(y + dy * ahead);
    const rank = (x0, y0, score) => score - 0.035 * Math.hypot(x0 - cx, y0 - cy) / search;
    let best = {center: [x, y], score: -1, rank: -2};
    const coarse = [];
    const check = (px, py, includeForAmbiguity = false) => {
      const raw = score(px, py);
      if (raw < best.rank && (!includeForAmbiguity || raw < minScore)) return;
      const ranked = rank(px, py, raw);
      if (ranked > best.rank) best = {center: [px, py], score: raw, rank: ranked};
      if (includeForAmbiguity && raw >= minScore) coarse.push({center: [px, py], rank: ranked});
    };
    const stride = state.gap || search <= 21 ? 1 : 2;
    for (let y0 = cy - search; y0 <= cy + search; y0 += stride) {
      for (let x0 = cx - search; x0 <= cx + search; x0 += stride) check(x0, y0, true);
    }
    for (let j = -5; j <= 5; j++) {
      for (let i = -5; i <= 5; i++) check(cx + i, cy + j);
    }
    const [bx, by] = best.center;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) check(bx + i, by + j);
    }
    const ambiguity = coarse.some(c => c.rank >= best.rank - 0.035 &&
      distance(c.center, best.center) > Math.max(6, radius * 0.8));
    return {...best, ambiguity};
  }

  function startTracks(pixels, width, height, seeds, patch) {
    const coordinates = Object.entries(seeds).map(([label, [x, y]]) =>
      [label, [Math.round(x * width), Math.round(y * height)]]);
    return coordinates.map(([label, center]) => {
      const [x, y] = center;
      const closest = Math.min(...coordinates.filter(row => row[0] !== label).map(row => distance(center, row[1])));
      const limit = Math.min(Math.floor((closest - 1) / 2), x, y, width - 1 - x, height - 1 - y);
      let appearance = null;
      for (const radius of new Set([Math.min(patch, limit), Math.min(18, limit), 4])) {
        if (radius < 4 || radius > limit) continue;
        try {
          appearance = template(pixels, width, center, radius);
          break;
        } catch {
          // Try sampling the outline if the region around the center has little texture.
        }
      }
      return {label, center, velocity: [0, 0], template: appearance, minimum: null,
        gap: 0, missed: 0, found: false, pending: null};
    });
  }

  function updateAppearance(current, pixels, width, center) {
    const sample = template(pixels, width, center, current.radius);
    const centered = current.centered.map((value, i) => value * 0.85 + sample.centered[i] * 0.15);
    const norm = Math.hypot(...centered);
    if (norm >= 8 * Math.sqrt(centered.length)) return {...current, centered, norm};
    return current;
  }

  function advance(pixels, width, height, tracks, corners, search, isLast) {
    const matches = tracks.map(track => {
      if (!track.template || (track.gap >= 8 && !track.pending && !isLast && track.gap % 4 !== 0)) return null;
      const window = track.pending ? search : Math.min(72, search + track.gap * 5);
      const candidate = match(pixels, width, height, track, window);
      const [x, y] = candidate.center;
      const threshold = track.gap > shortGap ? 0.89 : track.gap ? 0.84 : minScore;
      return candidate.score >= threshold && !candidate.ambiguity && contained([x / width, y / height], corners)
        ? candidate : null;
    });
    const uninterrupted = tracks.map(track => track.gap === 0);
    for (const [i, track] of tracks.entries()) {
      const match = matches[i];
      const conflict = match && matches.some((other, j) => other && i !== j &&
        (!uninterrupted[i] || uninterrupted[j]) &&
        distance(match.center, other.center) < Math.max(4, Math.min(track.template.radius, tracks[j].template.radius) * 0.7));
      const viable = match && !conflict;
      const recovering = track.gap > shortGap;
      const confirmed = !recovering || (track.pending && viable && distance(track.pending, match.center) <= search);
      track.found = Boolean(viable && confirmed);
      if (!track.found) {
        track.pending = viable ? match.center : null;
        track.gap++;
        track.missed++;
        continue;
      }
      track.pending = null;
      const elapsed = track.gap + 1;
      track.velocity = match.center.map((n, axis) =>
        ((n - track.center[axis]) / elapsed) * 0.65 + track.velocity[axis] * 0.35);
      if (!track.gap && match.score >= 0.92) {
        try {
          track.template = updateAppearance(track.template, pixels, width, match.center);
        } catch {
          // Keep the previous appearance if the current image has insufficient contrast.
        }
      }
      track.center = match.center;
      track.minimum = Math.min(track.minimum ?? 1, match.score);
      track.gap = 0;
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

  async function trackVideo({url, stream = false, start, end, seeds, corners, patch, signal, progress, reviewEnds}) {
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
        if (tracks.every(t => !t.template)) {
          for (const track of tracks) track.missed += steps - i + 1;
          progress(steps, steps);
          break;
        }
        const seconds = start + (end - start) * (i / steps);
        advance(await read(seconds), width, height, tracks, corners, search, i === steps);
        if (i % 4 === 0 || i === steps) progress(i, steps);
      }
      const ends = Object.fromEntries(tracks.filter(t => t.found).map(({label, center: [x, y]}) => [label, [x / width, y / height]]));
      const missing = tracks.filter(t => !t.found).map(t => t.label);
      const manual = missing.length ? await reviewEnds({seconds: end, missing, ends}) : {};
      const missingFrames = tracks.map(t => {
        const marked = Object.hasOwn(manual, t.label);
        const missed = t.missed - (marked && !t.found ? 1 : 0);
        return [t.label, missed];
      }).filter(([, n]) => n > 0);
      return {
        end_seconds: end, samples: steps + 1,
        ends: {...ends, ...manual},
        min_score: Object.fromEntries(tracks.map(t => {
          const replacedOnlyMatch = t.found && t.missed === steps - 1 && Object.hasOwn(manual, t.label);
          return [t.label, replacedOnlyMatch ? null : t.minimum];
        })),
        manual_frames: Object.fromEntries(Object.keys(manual).map(label => [label, 1])),
        missing_frames: Object.fromEntries(missingFrames)
      };
    } finally {
      video.removeAttribute('src');
      video.load();
      if (ownsUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  window.waterfulTrackVideo = trackVideo;
})();
