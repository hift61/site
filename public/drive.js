/* Drive access uses each team member's Google session. Tokens stay in memory. */
(() => {
  const scope = 'https://www.googleapis.com/auth/drive.readonly';
  const filesUrl = 'https://www.googleapis.com/drive/v3/files';
  const folderMime = 'application/vnd.google-apps.folder';
  let clientId = '';
  let token = '';
  let expiresAt = 0;

  const connected = () => Boolean(token) && Date.now() < expiresAt;

  function configure(id) {
    if (clientId !== id) {
      token = '';
      expiresAt = 0;
    }
    clientId = id || '';
  }

  function connect() {
    if (!clientId) return Promise.reject(Error('Google Drive 연결 설정이 필요합니다.'));
    if (connected()) return Promise.resolve();
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) return Promise.reject(Error('Google 연결 기능을 불러오지 못했습니다. 페이지를 새로고침하세요.'));
    return new Promise((resolve, reject) => {
      const auth = oauth.initTokenClient({
        client_id: clientId,
        scope,
        callback: result => {
          if (result.error || !result.access_token || !result.scope?.split(' ').includes(scope)) {
            reject(Error('Google Drive 읽기 권한을 연결하지 못했습니다.'));
            return;
          }
          token = result.access_token;
          expiresAt = Date.now() + Math.max(0, Number(result.expires_in) - 30) * 1000;
          resolve();
        },
        error_callback: () => reject(Error('Google 로그인 창을 열거나 완료할 수 없습니다. 팝업을 확인하세요.'))
      });
      auth.requestAccessToken();
    });
  }

  async function request(url, signal) {
    if (!connected()) throw Error('Google Drive에 다시 연결하세요.');
    const response = await fetch(url, {headers: {Authorization: 'Bearer ' + token}, signal, cache: 'no-store'});
    if (response.status === 401) {
      token = '';
      throw Error('Google 연결이 만료되었습니다. 다시 연결하세요.');
    }
    if (response.status === 403 || response.status === 404) {
      throw Error('현재 Google 계정으로 이 Drive 파일이나 폴더를 열 수 없습니다. 팀 폴더 공유 권한을 확인하세요.');
    }
    if (!response.ok) throw Error('Google Drive를 읽지 못했습니다 (HTTP ' + response.status + ').');
    return response;
  }

  function folderId(link) {
    let url;
    try { url = new URL(link); } catch (_) { throw Error('Google Drive 폴더 링크를 붙여넣으세요.'); }
    const match = url.pathname.match(/\/folders\/([A-Za-z0-9_-]{10,200})\/?$/);
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || !match) {
      throw Error('Google Drive 폴더 링크를 붙여넣으세요.');
    }
    return match[1];
  }

  async function listFolder(folder) {
    const query = new URLSearchParams({
      q: "'" + folder + "' in parents and trashed = false",
      fields: 'nextPageToken,files(id,name,size,mimeType)',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '100'
    });
    const files = [];
    while (true) {
      const result = await (await request(filesUrl + '?' + query)).json();
      files.push(...result.files);
      if (!result.nextPageToken) return files;
      query.set('pageToken', result.nextPageToken);
    }
  }

  async function getFolders(link) {
    const id = folderId(link);
    const info = await (await request(filesUrl + '/' + id + '?fields=id,name,mimeType&supportsAllDrives=true')).json();
    if (info.mimeType !== folderMime) throw Error('영상 파일 링크 대신 폴더 링크를 입력하세요.');
    const contents = await listFolder(id);
    const children = contents.filter(item => item.mimeType === folderMime);
    const hasFiles = contents.some(item => /\.(mp4|mov|webm)$/i.test(item.name));
    return hasFiles || !children.length ? [{...info, contents}] : children;
  }

  function download(id, signal) {
    return request(filesUrl + '/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', signal);
  }

  async function readCase(folder) {
    const files = folder.contents || await listFolder(folder.id);
    const videos = files.filter(file => /\.(mp4|mov|webm)$/i.test(file.name) && Number(file.size) > 0);
    const csv = files.find(file => file.name.toLowerCase() === 'measurements.csv');
    const meta = files.find(file => file.name.toLowerCase() === 'case.json');
    if (videos.length !== 1 || !csv) throw Error('영상 1개와 measurements.csv가 필요합니다.');
    if (!(Number(csv.size) > 0 && Number(csv.size) <= 1_000_000)) throw Error('measurements.csv는 1 MB 이하여야 합니다.');
    if (meta && !(Number(meta.size) > 0 && Number(meta.size) <= 65_536)) throw Error('case.json은 64 KiB 이하여야 합니다.');
    const video = videos[0];
    return {
      file_id: video.id, name: video.name, size_bytes: Number(video.size),
      measurement: {name: csv.name, csv: await (await download(csv.id)).text()},
      case_json: meta ? await (await download(meta.id)).text() : null
    };
  }

  async function openVideo(item, signal) {
    const blob = await (await download(item.drive_file_id, signal)).blob();
    if (blob.size !== item.size_bytes) throw Error('Drive 영상이 등록 당시와 달라졌습니다. 원본을 확인하세요.');
    return URL.createObjectURL(blob.type === item.mime_type ? blob : blob.slice(0, blob.size, item.mime_type));
  }

  window.waterfulDrive = {configure, connected, connect, getFolders, readCase, openVideo};
})();
