// =====================================================================
//  교사(관리자) 화면 로직 (admin.html)
// =====================================================================
//  흐름 요약
//    1) 이메일+비밀번호로 로그인 → is_admin() 이 true 인지 확인
//    2) 대시보드: 투표 시작/마감 스위치, 현황 숫자, 제목·안내문
//    3) 작품: 여러 장 업로드(Storage + artworks 표), 숨김/수정/삭제
//    4) 명단: CSV 파싱 → 미리보기 → allowed_students 에 upsert
//    5) 댓글: 실제 이름과 함께 보기, 숨김/삭제
//    6) 결과: admin_results() 집계표, CSV 내려받기
//
//  관리자 권한은 전부 DB 의 RLS 정책이 검사합니다. 이 파일은 "화면"만 담당하며,
//  관리자가 아닌 사람이 이 페이지를 열어도 DB 가 거부하므로 아무것도 바꿀 수 없습니다.
// =====================================================================

(function () {
  'use strict';

  // -------------------------------------------------------------------
  // 0. 도우미
  // -------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const CFG = window.APP_CONFIG || {};

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString('ko-KR', {
        year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('toast--error', isError);
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3000);
  }

  function showFatal(html) {
    const el = $('fatalAlert');
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  /** 2차원 배열 → CSV 문자열 (쉼표/따옴표/줄바꿈이 있으면 따옴표로 감쌈) */
  function toCsv(rows) {
    return rows.map((row) =>
      row.map((cell) => {
        const s = String(cell ?? '');
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',')
    ).join('\r\n');
  }

  /** 파일 내려받기. 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 을 앞에 붙입니다. */
  function downloadText(filename, text) {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** 오늘 날짜를 20251008 형태로 (파일 이름용) */
  function todayStamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * CSV 문자열 → 2차원 배열.
   * 따옴표로 감싼 칸(안에 쉼표·줄바꿈 포함)도 처리하는 간단한 파서입니다.
   */
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    const s = text.replace(/^﻿/, ''); // BOM 제거

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; }   // "" → "
          else inQuotes = false;
        } else cell += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell); cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // 완전히 빈 줄 제거
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  /** 파일을 글자로 읽기. UTF-8 로 읽어 깨진 글자가 있으면 EUC-KR(엑셀 기본 CSV)로 다시 시도 */
  async function readTextSmart(file) {
    const buf = await file.arrayBuffer();
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('�')) return utf8;
    try { return new TextDecoder('euc-kr').decode(buf); } catch { return utf8; }
  }

  // -------------------------------------------------------------------
  // 1. 설정 확인 + 클라이언트
  // -------------------------------------------------------------------
  const configMissing =
    !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY ||
    CFG.SUPABASE_URL.includes('YOUR-PROJECT') || CFG.SUPABASE_ANON_KEY.includes('YOUR-ANON');

  if (configMissing) {
    showFatal('<b>Supabase 설정이 비어 있습니다.</b><br/><code>js/config.js</code> 에 URL 과 anon key 를 입력해 주세요.');
    return;
  }
  if (typeof window.supabase === 'undefined') {
    showFatal('<b>supabase-js 라이브러리를 불러오지 못했습니다.</b> 인터넷 연결을 확인해 주세요.');
    return;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const BUCKET = CFG.STORAGE_BUCKET || 'artworks';
  const imageUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const state = {
    user: null,
    settings: null,
    uploadQueue: [],      // [{ file, previewUrl, status }]
    artworkInfo: [],      // 작품 정보 CSV [{ title, author, description, keyword }]
    roster: [],           // 등록된 명단 (검색용 캐시)
    rosterParsed: null,   // CSV 미리보기 데이터
    loaded: {},           // 각 탭을 한 번 불러왔는지
  };

  // -------------------------------------------------------------------
  // 2. 로그인 / 권한 확인
  // -------------------------------------------------------------------
  async function init() {
    bindEvents();
    const { data: { session } } = await sb.auth.getSession();
    // 학생 화면에서 만든 익명 세션은 관리자 세션이 아니므로 무시
    if (session && !session.user.is_anonymous) {
      await enterAdmin(session.user);
    } else {
      showLogin();
    }
  }

  function showLogin() {
    $('loginView').classList.remove('hidden');
    $('adminView').classList.add('hidden');
    $('adminChip').classList.add('hidden');
  }

  /** 로그인은 됐지만 admins 표에 없는 이메일이면 거부 */
  async function enterAdmin(user) {
    let { data: isAdmin, error } = await sb.rpc('is_admin');

    // 관리자가 아니면: "아직 관리자가 아무도 없는 상태"인지 확인해 첫 관리자로 등록 시도
    // (bootstrap_admin 은 실제 로그인 계정이 있는 관리자가 한 명이라도 있으면 false 를 돌려줌)
    if (!error && !isAdmin) {
      const boot = await sb.rpc('bootstrap_admin');
      if (!boot.error && boot.data === true) isAdmin = true;
    }

    if (error || !isAdmin) {
      await sb.auth.signOut();
      showLogin();
      $('loginError').textContent =
        '이 계정은 관리자로 등록되어 있지 않습니다. 다른 관리자에게 "교사 계정 → 교사 추가"로 등록을 요청하세요.';
      return;
    }
    state.user = user;
    $('adminEmail').textContent = user.email;
    $('adminChip').classList.remove('hidden');
    $('loginView').classList.add('hidden');
    $('adminView').classList.remove('hidden');
    switchView('dashboard', true);
  }

  async function onLogin(e) {
    e.preventDefault();
    const errEl = $('loginError');
    errEl.textContent = '';
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!email || !password) { errEl.textContent = '이메일과 비밀번호를 입력해 주세요.'; return; }

    const btn = $('loginSubmit');
    btn.disabled = true; btn.textContent = '확인 중…';

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = '로그인';

    if (error) {
      if (/invalid/i.test(error.message)) errEl.textContent = '이메일 또는 비밀번호가 올바르지 않습니다.';
      else if (/not confirmed/i.test(error.message)) errEl.textContent = '아직 활성화되지 않은 계정입니다. 다른 관리자에게 "교사 계정 → 교사 추가"로 등록을 요청하세요.';
      else errEl.textContent = error.message;
      return;
    }
    $('password').value = '';
    await enterAdmin(data.user);
  }

  async function onLogout() {
    await sb.auth.signOut();
    state.user = null;
    state.loaded = {};
    showLogin();
  }

  /** 처음 설정: 첫 관리자 계정 만들기 (회원가입 → bootstrap_admin) */
  async function onBootstrap(e) {
    e.preventDefault();
    const errEl = $('bootError');
    errEl.textContent = '';
    const email = $('bootEmail').value.trim().toLowerCase();
    const password = $('bootPassword').value;
    if (!email) { errEl.textContent = '이메일을 입력해 주세요.'; return; }
    if (password.length < 8) { errEl.textContent = '비밀번호는 8자 이상으로 해 주세요.'; return; }

    const btn = $('bootSubmit');
    btn.disabled = true; btn.textContent = '만드는 중…';

    try {
      // 1) 회원가입. 이 클라이언트로 가입하면 (Confirm email 이 꺼진 경우) 바로 로그인 세션이 생깁니다.
      let { data, error } = await sb.auth.signUp({ email, password });
      if (error) {
        // 이미 있는 계정이면 그 비밀번호로 로그인 시도
        if (/already|registered|exists/i.test(error.message)) {
          const r = await sb.auth.signInWithPassword({ email, password });
          if (r.error) throw new Error('이미 있는 계정인데 비밀번호가 다릅니다. 로그인 칸에서 기존 비밀번호로 로그인하세요.');
          data = r.data;
        } else {
          throw new Error(mapSignUpError(error.message));
        }
      }

      if (!data.session) {
        // Confirm email 이 켜진 프로젝트: 세션이 없으므로 DB 함수로 이메일 확인 + 관리자 등록을 대신 처리
        const { data: ok, error: bErr } = await sb.rpc('bootstrap_admin_confirm', { p_email: email });
        if (bErr) throw bErr;
        if (!ok) throw new Error('이미 관리자가 있어 이 메뉴로는 등록할 수 없습니다. 기존 관리자에게 "교사 계정 → 교사 추가"를 요청하세요.');

        // 확인 처리가 끝났으니 방금 정한 비밀번호로 로그인
        const r = await sb.auth.signInWithPassword({ email, password });
        if (r.error) throw new Error('계정은 만들어졌지만 로그인에 실패했습니다: ' + r.error.message);
        data = r.data;
      }

      // 2) 세션이 있으면 관리자 등록 확인 (enterAdmin 안에서 필요 시 bootstrap_admin 호출)
      $('bootPassword').value = '';
      await enterAdmin(data.session.user);
      if (state.user) toast('첫 관리자 계정이 만들어졌습니다. 환영합니다!');
    } catch (err) {
      console.error('첫 관리자 만들기 실패', err);
      errEl.textContent = err.message || '실패했습니다.';
    } finally {
      btn.disabled = false; btn.textContent = '계정 만들고 관리자로 등록';
    }
  }

  // -------------------------------------------------------------------
  // 3. 탭 전환 (처음 열 때만 데이터 로드, 새로고침 버튼으로 다시 로드)
  // -------------------------------------------------------------------
  const loaders = {
    dashboard: async () => { await Promise.all([loadSettings(), loadSummary(), loadAdmins()]); },
    artworks: loadArtworks,
    roster: loadRoster,
    comments: loadComments,
    results: loadResults,
  };

  function switchView(name, force = false) {
    document.querySelectorAll('.admin-nav__item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
    document.querySelectorAll('.admin-section').forEach((s) => s.classList.toggle('hidden', s.id !== `view-${name}`));
    if (force || !state.loaded[name]) {
      state.loaded[name] = true;
      loaders[name]().catch((err) => { console.error(err); toast('불러오기 실패: ' + err.message, true); });
    }
  }

  // -------------------------------------------------------------------
  // 4. 대시보드
  // -------------------------------------------------------------------
  async function loadSettings() {
    const { data, error } = await sb.from('settings').select('*').eq('id', 1).single();
    if (error) throw error;
    state.settings = data;
    $('votingSwitch').checked = !!data.voting_open;
    renderVotingText();
    $('siteTitleInput').value = data.site_title || '';
    $('noticeInput').value = data.notice || '';
  }

  function renderVotingText() {
    const open = $('votingSwitch').checked;
    $('votingStateText').textContent = open ? '🟢 투표 진행 중 (학생이 하트·댓글 가능)' : '⚪ 투표 마감 (보기만 가능)';
  }

  async function onToggleVoting() {
    const sw = $('votingSwitch');
    const next = sw.checked;
    sw.disabled = true;
    const { error } = await sb.from('settings').update({ voting_open: next, updated_at: new Date().toISOString() }).eq('id', 1);
    sw.disabled = false;
    if (error) {
      sw.checked = !next;   // 실패하면 원위치
      toast('변경 실패: ' + error.message, true);
      return;
    }
    renderVotingText();
    toast(next ? '투표를 시작했습니다.' : '투표를 마감했습니다.');
  }

  async function onSaveSettings(e) {
    e.preventDefault();
    const { error } = await sb.from('settings').update({
      site_title: $('siteTitleInput').value.trim() || '캐릭터 공모전 투표',
      notice: $('noticeInput').value.trim(),
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    if (error) { toast('저장 실패: ' + error.message, true); return; }
    toast('저장했습니다.');
  }

  async function loadSummary() {
    const { data, error } = await sb.rpc('admin_summary');
    if (error) throw error;
    const s = Array.isArray(data) ? data[0] : data;
    if (!s) return;
    $('statArtworks').textContent = s.artwork_count;
    $('statRoster').textContent = s.roster_count;
    $('statLogins').textContent = s.login_count;
    $('statLikes').textContent = s.like_total;
    $('statComments').textContent = s.comment_total;
  }

  // -------------------------------------------------------------------
  // 4-1. 교사 계정 관리
  // -------------------------------------------------------------------
  //  anon key 로는 Supabase 의 "관리자 API"(사용자 강제 생성)를 쓸 수 없으므로,
  //  일반 회원가입(signUp)으로 계정을 만든 뒤 admins 표에 이메일을 등록하는 방식입니다.
  //  회원가입은 별도의 클라이언트(세션 저장 안 함)로 호출해서,
  //  지금 로그인한 교사의 세션이 새 계정으로 바뀌지 않게 합니다.
  // -------------------------------------------------------------------
  async function loadAdmins() {
    const { data, error } = await sb.from('admins').select('*').order('created_at');
    const table = $('adminTable');
    if (error) { table.innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`; return; }
    $('adminCount').textContent = `(${data.length})`;
    const me = (state.user?.email || '').toLowerCase();
    table.innerHTML =
      '<thead><tr><th>이메일</th><th>등록일</th><th></th></tr></thead><tbody>' +
      data.map((a) => {
        const isMe = a.email.toLowerCase() === me;
        return `
          <tr data-email="${escapeHtml(a.email)}">
            <td>${escapeHtml(a.email)}${isMe ? ' <span class="tag">나</span>' : ''}</td>
            <td>${formatDate(a.created_at)}</td>
            <td class="actions">${isMe ? '' : '<button class="btn btn--small btn--danger" data-action="remove-admin">권한 해제</button>'}</td>
          </tr>`;
      }).join('') + '</tbody>';
  }

  async function onAddAdmin(e) {
    e.preventDefault();
    const errEl = $('adminAddError');
    errEl.textContent = '';
    const email = $('newAdminEmail').value.trim().toLowerCase();
    const password = $('newAdminPassword').value;

    if (!email) { errEl.textContent = '이메일을 입력해 주세요.'; return; }
    if (password && password.length < 8) { errEl.textContent = '비밀번호는 8자 이상으로 해 주세요.'; return; }

    const btn = $('adminAddBtn');
    btn.disabled = true; btn.textContent = '처리 중…';
    let note = '';

    try {
      // (1) 비밀번호를 입력했으면 Supabase 로그인 계정 생성
      if (password) {
        const tmp = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const { data, error } = await tmp.auth.signUp({ email, password });
        if (error) {
          // 이미 있는 계정이면 등록만 진행
          if (/already|registered|exists/i.test(error.message)) note = ' (이미 있는 계정이라 등록만 했습니다)';
          else throw new Error(mapSignUpError(error.message));
        } else if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          // Confirm email 이 켜진 프로젝트는 중복 가입 시 빈 identities 를 돌려줍니다.
          note = ' (이미 있는 계정이라 등록만 했습니다)';
        }
      }

      // (2) admins 표에 이메일 등록 (RLS: 관리자만 가능)
      const { error: insErr } = await sb.from('admins').upsert({ email }, { onConflict: 'email' });
      if (insErr) throw insErr;

      // (3) Confirm email 설정이 켜져 있어도 바로 로그인할 수 있도록 이메일 확인을 대신 처리
      if (password) {
        const { error: cErr } = await sb.rpc('confirm_admin_email', { p_email: email });
        if (cErr) note += ' (계정 활성화 실패: ' + cErr.message + ')';
      }

      toast(`${email} 을(를) 관리자로 등록했습니다.${note}`);
      $('newAdminEmail').value = '';
      $('newAdminPassword').value = '';
      await loadAdmins();
    } catch (err) {
      console.error('교사 추가 실패', err);
      errEl.textContent = err.message || '추가에 실패했습니다.';
    } finally {
      btn.disabled = false; btn.textContent = '계정 만들고 등록';
    }
  }

  function mapSignUpError(msg) {
    if (/signups? not allowed|disabled/i.test(msg)) return 'Supabase 에서 새 회원가입이 꺼져 있습니다. Authentication → Sign In / Providers → "Allow new users to sign up" 을 켜 주세요.';
    if (/password/i.test(msg)) return '비밀번호가 Supabase 의 규칙(최소 길이 등)에 맞지 않습니다: ' + msg;
    if (/email rate limit/i.test(msg)) return 'Supabase 가입 요청 한도에 걸렸습니다. 1시간 뒤 다시 시도하거나, Supabase → Authentication → Sign In / Providers → Email → "Confirm email" 을 끄면 한도 없이 바로 만들어집니다.';
    if (/rate limit|too many/i.test(msg)) return '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.';
    return msg;
  }

  async function removeAdmin(email) {
    if (!confirm(`${email} 의 관리자 권한을 해제할까요?\n(Supabase 로그인 계정 자체는 남아 있으며, 대시보드 Users 에서 따로 삭제할 수 있습니다)`)) return;
    const { error } = await sb.from('admins').delete().eq('email', email);
    if (error) { toast(error.message, true); return; }
    toast('권한을 해제했습니다.');
    await loadAdmins();
  }

  // -------------------------------------------------------------------
  // 5. 작품 업로드
  // -------------------------------------------------------------------
  function onFilesSelected(files) {
    const list = Array.from(files || []).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    syncQueueInputs();           // 이미 입력해 둔 값이 사라지지 않도록 먼저 저장
    list.forEach((file) => {
      const item = {
        file,
        previewUrl: URL.createObjectURL(file),
        status: 'ready',   // ready | uploading | done | error
        error: '',
        infoIndex: -1,     // 작품 정보 CSV 에서 고른 행 번호 (-1: 없음)
      };
      // 파일명에 CSV 의 "파일명키워드"가 들어 있으면 자동으로 짝지음 (예: 서라_대표시안.jpg ↔ 서라)
      const idx = state.artworkInfo.findIndex((info) => info.keyword && file.name.includes(info.keyword));
      if (idx >= 0) applyArtworkInfo(item, idx);
      state.uploadQueue.push(item);
    });
    renderUploadQueue();
    $('fileInput').value = '';   // 같은 파일을 다시 골라도 change 가 발생하도록 초기화
  }

  /** 작품 정보 CSV 읽기 (제목, 출품자, 설명, 파일명키워드) */
  async function onArtworkInfoFile(file) {
    if (!file) return;
    const rows = parseCsv(await readTextSmart(file));
    if (rows.length && /제목|title/i.test(rows[0][0] || '')) rows.shift(); // 제목 행 제거
    state.artworkInfo = rows
      .map((r) => ({
        title: (r[0] || '').trim(),
        author: (r[1] || '').trim(),
        description: (r[2] || '').trim(),
        keyword: (r[3] || '').trim(),
      }))
      .filter((info) => info.title);
    $('artworkInfoFile').value = '';
    if (!state.artworkInfo.length) { toast('CSV 에서 작품 정보를 찾지 못했습니다.', true); return; }
    $('artworkInfoStatus').textContent = `작품 정보 ${state.artworkInfo.length}개 불러옴: ` +
      state.artworkInfo.map((i) => i.title).join(', ');
    toast(`작품 정보 ${state.artworkInfo.length}개를 불러왔습니다.`);

    // 이미 고른 이미지가 있으면 키워드로 다시 짝지어 봄
    syncQueueInputs();
    state.uploadQueue.forEach((item) => {
      if (item.infoIndex >= 0) return;
      const idx = state.artworkInfo.findIndex((info) => info.keyword && item.file.name.includes(info.keyword));
      if (idx >= 0) applyArtworkInfo(item, idx);
    });
    renderUploadQueue();
  }

  /** 대기열 항목에 CSV 의 작품 정보를 채워 넣음 */
  function applyArtworkInfo(item, idx) {
    const info = state.artworkInfo[idx];
    item.infoIndex = idx;
    if (!info) return;
    item.title = info.title;
    item.author = info.author;
    item.description = info.description;
  }

  function renderUploadQueue() {
    const wrap = $('uploadQueue');
    const q = state.uploadQueue;
    $('uploadActions').classList.toggle('hidden', q.length === 0);

    wrap.innerHTML = q.map((item, i) => {
      const defaultTitle = item.file.name.replace(/\.[^.]+$/, ''); // 확장자 뺀 파일명
      const sizeMb = (item.file.size / 1024 / 1024).toFixed(1);
      const statusText = { ready: '대기', uploading: '업로드 중…', done: '완료 ✓', error: '실패: ' + item.error }[item.status];
      // 작품 정보 CSV 를 불러온 경우에만 드롭다운 표시
      const infoSelect = state.artworkInfo.length ? `
            <select data-field="info">
              <option value="-1">📋 작품 정보에서 고르기…</option>
              ${state.artworkInfo.map((info, k) =>
                `<option value="${k}" ${item.infoIndex === k ? 'selected' : ''}>${escapeHtml(info.title)}${info.author ? ' · ' + escapeHtml(info.author) : ''}</option>`
              ).join('')}
            </select>` : '';
      return `
        <div class="upload-item ${item.status === 'done' ? 'is-done' : ''} ${item.status === 'error' ? 'is-error' : ''}" data-index="${i}">
          <img src="${item.previewUrl}" alt="" />
          <div class="upload-item__fields">
            ${infoSelect}
            <input type="text" data-field="title" placeholder="제목 (필수)" value="${escapeHtml(item.title ?? defaultTitle)}" maxlength="80" />
            <input type="text" data-field="author" placeholder="출품자 (선택, 예: 2학년 3반 홍길동)" value="${escapeHtml(item.author ?? '')}" maxlength="60" />
            <textarea data-field="description" rows="2" placeholder="작품 설명 (선택)" maxlength="3000">${escapeHtml(item.description ?? '')}</textarea>
            <div class="upload-item__meta">
              <span>${escapeHtml(item.file.name)} · ${sizeMb}MB · ${statusText}</span>
              ${item.status === 'uploading' ? '' : '<button type="button" class="btn btn--ghost btn--small" data-action="remove">빼기</button>'}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  /** 입력칸의 값을 queue 상태에 저장 (렌더링을 다시 해도 값이 안 사라지도록) */
  function syncQueueInputs() {
    document.querySelectorAll('.upload-item').forEach((el) => {
      const item = state.uploadQueue[Number(el.dataset.index)];
      if (!item) return;
      item.title = el.querySelector('[data-field="title"]').value;
      item.author = el.querySelector('[data-field="author"]').value;
      item.description = el.querySelector('[data-field="description"]').value;
    });
  }

  async function uploadAll() {
    syncQueueInputs();
    const targets = state.uploadQueue.filter((it) => it.status !== 'done');
    if (!targets.length) return;
    if (targets.some((it) => !(it.title || '').trim())) { toast('제목이 비어 있는 작품이 있습니다.', true); return; }
    if (targets.some((it) => it.file.size > 10 * 1024 * 1024)) { toast('10MB 를 넘는 파일이 있습니다.', true); return; }

    const btn = $('uploadBtn');
    btn.disabled = true;
    let done = 0, failed = 0;

    // 한 장씩 순서대로 올립니다 (동시에 올리면 느린 와이파이에서 실패가 잦음)
    for (const item of targets) {
      item.status = 'uploading';
      renderUploadQueue();
      $('uploadProgress').textContent = `${done + failed + 1} / ${targets.length} 업로드 중…`;

      try {
        // 파일 경로: 2025-10-08/랜덤id.jpg  (한글 파일명은 Storage 에서 문제가 될 수 있어 사용하지 않음)
        const ext = (item.file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${todayStamp()}/${crypto.randomUUID()}.${ext}`;

        const { error: upErr } = await sb.storage.from(BUCKET).upload(path, item.file, {
          contentType: item.file.type,
          upsert: false,
        });
        if (upErr) throw upErr;

        const { error: dbErr } = await sb.from('artworks').insert({
          title: item.title.trim(),
          author_name: (item.author || '').trim(),
          description: (item.description || '').trim(),
          image_path: path,
          created_by: state.user.id,
        });
        if (dbErr) {
          // DB 저장이 실패하면 올라간 파일은 지워서 고아 파일을 남기지 않음
          await sb.storage.from(BUCKET).remove([path]);
          throw dbErr;
        }
        item.status = 'done';
        done++;
      } catch (err) {
        console.error('업로드 실패', err);
        item.status = 'error';
        item.error = err.message || '알 수 없는 오류';
        failed++;
      }
    }

    btn.disabled = false;
    $('uploadProgress').textContent = `완료 ${done}장` + (failed ? `, 실패 ${failed}장` : '');
    renderUploadQueue();
    toast(failed ? `${done}장 성공, ${failed}장 실패` : `${done}장 업로드 완료!`, failed > 0);

    // 완료된 항목은 잠시 뒤 목록에서 치움
    setTimeout(() => {
      state.uploadQueue = state.uploadQueue.filter((it) => it.status !== 'done');
      renderUploadQueue();
      if (!state.uploadQueue.length) $('uploadProgress').textContent = '';
    }, 1500);

    await loadArtworks();
    loadSummary().catch(() => {});
  }

  // -------------------------------------------------------------------
  // 6. 작품 목록 (숨김 / 수정 / 삭제)
  // -------------------------------------------------------------------
  async function loadArtworks() {
    const wrap = $('artworkList');
    const { data, error } = await sb.from('artworks').select('*').order('created_at', { ascending: false });
    if (error) { wrap.innerHTML = `<div class="state state--error">${escapeHtml(error.message)}</div>`; return; }

    $('artworkListCount').textContent = `(${data.length})`;
    if (!data.length) { wrap.innerHTML = '<div class="state">아직 작품이 없습니다. 위에서 업로드하세요.</div>'; return; }

    wrap.innerHTML = data.map((a) => `
      <div class="artwork-row ${a.is_hidden ? 'is-hidden-item' : ''}" data-id="${a.id}" data-path="${escapeHtml(a.image_path)}">
        <a href="${imageUrl(a.image_path)}" target="_blank" rel="noopener"><img src="${imageUrl(a.image_path)}" alt="" loading="lazy" /></a>
        <div class="artwork-row__info">
          <p class="artwork-row__title">${escapeHtml(a.title)}${a.is_hidden ? '<span class="tag tag--hidden">숨김</span>' : ''}</p>
          <p class="artwork-row__sub">${escapeHtml(a.author_name || '출품자 미입력')} · ${formatDate(a.created_at)}</p>
          ${a.description ? `<p class="artwork-row__sub">${escapeHtml(a.description).slice(0, 80)}${a.description.length > 80 ? '…' : ''}</p>` : ''}
        </div>
        <div class="artwork-row__actions">
          <button class="btn btn--small" data-action="edit">수정</button>
          <button class="btn btn--small" data-action="toggle-hide" data-hidden="${a.is_hidden}">${a.is_hidden ? '보이기' : '숨기기'}</button>
          <button class="btn btn--small btn--danger" data-action="delete">삭제</button>
        </div>
      </div>`).join('');
  }

  /** 수정 버튼: 행을 입력칸으로 바꿔 제목·출품자·설명을 고침 */
  async function editArtwork(row) {
    const id = row.dataset.id;
    const { data: a, error } = await sb.from('artworks').select('*').eq('id', id).single();
    if (error) { toast(error.message, true); return; }

    row.querySelector('.artwork-row__info').innerHTML = `
      <div class="upload-item__fields">
        <input type="text" data-field="title" value="${escapeHtml(a.title)}" maxlength="80" placeholder="제목" />
        <input type="text" data-field="author" value="${escapeHtml(a.author_name)}" maxlength="60" placeholder="출품자" />
        <textarea data-field="description" rows="3" maxlength="1000" placeholder="설명">${escapeHtml(a.description)}</textarea>
      </div>`;
    row.querySelector('.artwork-row__actions').innerHTML = `
      <button class="btn btn--small btn--primary" data-action="save">저장</button>
      <button class="btn btn--small" data-action="cancel">취소</button>`;
  }

  async function saveArtwork(row) {
    const id = row.dataset.id;
    const title = row.querySelector('[data-field="title"]').value.trim();
    if (!title) { toast('제목은 비울 수 없습니다.', true); return; }
    const { error } = await sb.from('artworks').update({
      title,
      author_name: row.querySelector('[data-field="author"]').value.trim(),
      description: row.querySelector('[data-field="description"]').value.trim(),
    }).eq('id', id);
    if (error) { toast('저장 실패: ' + error.message, true); return; }
    toast('수정했습니다.');
    await loadArtworks();
  }

  async function toggleHideArtwork(row, currentlyHidden) {
    const { error } = await sb.from('artworks').update({ is_hidden: !currentlyHidden }).eq('id', row.dataset.id);
    if (error) { toast(error.message, true); return; }
    toast(currentlyHidden ? '학생 화면에 다시 보입니다.' : '학생 화면에서 숨겼습니다.');
    await loadArtworks();
  }

  async function deleteArtwork(row) {
    const title = row.querySelector('.artwork-row__title')?.textContent || '이 작품';
    if (!confirm(`"${title}" 을(를) 삭제할까요?\n하트와 댓글도 함께 사라지며 되돌릴 수 없습니다.`)) return;

    // 1) DB 행 삭제 (likes, comments 는 cascade 로 함께 삭제됨)
    const { error } = await sb.from('artworks').delete().eq('id', row.dataset.id);
    if (error) { toast('삭제 실패: ' + error.message, true); return; }
    // 2) Storage 파일 삭제 (실패해도 DB 는 이미 지워졌으므로 경고만)
    const { error: stErr } = await sb.storage.from(BUCKET).remove([row.dataset.path]);
    if (stErr) console.warn('이미지 파일 삭제 실패', stErr);

    toast('삭제했습니다.');
    await loadArtworks();
    loadSummary().catch(() => {});
  }

  // -------------------------------------------------------------------
  // 7. 참가 명단
  // -------------------------------------------------------------------
  function downloadTemplate() {
    downloadText('참가명단_예시.csv', toCsv([
      ['학교', '학번', '이름'],
      ['한빛중학교', '10101', '홍길동'],
      ['한빛중학교', '10102', '김영희'],
    ]));
  }

  async function onRosterFile(file) {
    if (!file) return;
    const text = await readTextSmart(file);
    const rows = parseCsv(text);
    if (!rows.length) { toast('비어 있는 파일입니다.', true); return; }

    // 첫 줄이 제목 행이면 제거 ("학교" 또는 "school" 글자가 있으면 제목으로 간주)
    const first = rows[0].map((c) => c.trim().toLowerCase());
    if (first.some((c) => c.includes('학교') || c.includes('school') || c.includes('이름') || c.includes('name'))) rows.shift();

    const valid = [];
    const invalid = [];
    rows.forEach((r, i) => {
      const school = (r[0] || '').trim();
      const student_no = (r[1] || '').trim();
      const name = (r[2] || '').trim();
      if (school && student_no && name) valid.push({ school, student_no, name });
      else invalid.push(i + 1);
    });

    // 같은 (학교, 학번)이 파일 안에서 중복이면 마지막 것만 남김
    const map = new Map();
    valid.forEach((v) => map.set(`${v.school}\u0000${v.student_no}`, v));
    state.rosterParsed = Array.from(map.values());

    $('rosterPreviewInfo').textContent =
      `${state.rosterParsed.length}명 인식` +
      (valid.length !== state.rosterParsed.length ? ` (파일 안 중복 ${valid.length - state.rosterParsed.length}건 제거)` : '') +
      (invalid.length ? ` · 빈 칸이 있어 건너뛴 줄: ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? '…' : ''}` : '');

    const preview = state.rosterParsed.slice(0, 20);
    $('rosterPreviewTable').innerHTML =
      '<thead><tr><th>학교</th><th>학번</th><th>이름</th></tr></thead><tbody>' +
      preview.map((r) => `<tr><td>${escapeHtml(r.school)}</td><td>${escapeHtml(r.student_no)}</td><td>${escapeHtml(r.name)}</td></tr>`).join('') +
      (state.rosterParsed.length > 20 ? `<tr><td colspan="3" class="empty">… 외 ${state.rosterParsed.length - 20}명</td></tr>` : '') +
      '</tbody>';
    $('rosterPreviewWrap').classList.remove('hidden');
    $('rosterFile').value = '';
  }

  async function uploadRoster() {
    const rows = state.rosterParsed || [];
    if (!rows.length) return;
    const btn = $('rosterUploadBtn');
    btn.disabled = true; btn.textContent = '등록 중…';

    // 500명씩 나눠서 upsert (한 번에 너무 많이 보내면 요청이 커짐)
    let failed = null;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await sb.from('allowed_students').upsert(chunk, { onConflict: 'school,student_no' });
      if (error) { failed = error; break; }
    }
    btn.disabled = false; btn.textContent = '이대로 등록';

    if (failed) { toast('등록 실패: ' + failed.message, true); return; }
    toast(`${rows.length}명을 등록했습니다.`);
    state.rosterParsed = null;
    $('rosterPreviewWrap').classList.add('hidden');
    await loadRoster();
    loadSummary().catch(() => {});
  }

  async function loadRoster() {
    const { data, error } = await sb.from('allowed_students').select('*')
      .order('school').order('student_no').limit(5000);
    if (error) { $('rosterTable').innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`; return; }
    state.roster = data;
    renderRoster();
  }

  function renderRoster() {
    const q = $('rosterSearch').value.trim().toLowerCase();
    const list = q
      ? state.roster.filter((r) => r.name.toLowerCase().includes(q) || r.student_no.includes(q) || r.school.toLowerCase().includes(q))
      : state.roster;
    $('rosterCount').textContent = `(${state.roster.length}명${q ? `, 검색 ${list.length}명` : ''})`;

    if (!list.length) { $('rosterTable').innerHTML = '<tr><td class="empty">명단이 없습니다. CSV 를 업로드하세요.</td></tr>'; return; }
    $('rosterTable').innerHTML =
      '<thead><tr><th>학교</th><th>학번</th><th>이름</th><th></th></tr></thead><tbody>' +
      list.slice(0, 500).map((r) => `
        <tr data-id="${r.id}">
          <td>${escapeHtml(r.school)}</td><td>${escapeHtml(r.student_no)}</td><td>${escapeHtml(r.name)}</td>
          <td class="actions"><button class="btn btn--small btn--ghost" data-action="delete-roster">삭제</button></td>
        </tr>`).join('') +
      (list.length > 500 ? `<tr><td colspan="4" class="empty">… 외 ${list.length - 500}명 (검색으로 좁혀 보세요)</td></tr>` : '') +
      '</tbody>';
  }

  async function deleteRosterRow(id) {
    const { error } = await sb.from('allowed_students').delete().eq('id', id);
    if (error) { toast(error.message, true); return; }
    state.roster = state.roster.filter((r) => r.id !== id);
    renderRoster();
  }

  async function clearRoster() {
    if (!confirm('등록된 명단을 전부 삭제할까요?\n(이미 로그인한 학생의 투표 기록은 그대로 남습니다)')) return;
    if (prompt('정말 삭제하려면 "삭제" 라고 입력하세요.') !== '삭제') return;
    // Supabase 는 조건 없는 delete 를 막으므로 "항상 참"인 조건을 붙입니다.
    const { error } = await sb.from('allowed_students').delete().gte('created_at', '1970-01-01');
    if (error) { toast(error.message, true); return; }
    toast('명단을 모두 삭제했습니다.');
    await loadRoster();
    loadSummary().catch(() => {});
  }

  // -------------------------------------------------------------------
  // 8. 댓글 관리
  // -------------------------------------------------------------------
  async function loadComments() {
    const hiddenOnly = $('showHiddenOnly').checked;
    // 외래키 덕분에 작품 제목과 학생 정보를 한 번에 조인해서 가져올 수 있습니다.
    let query = sb.from('comments')
      .select('id, body, author_masked, is_hidden, created_at, artworks(title), student_profiles(school, student_no, name)')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (hiddenOnly) query = query.eq('is_hidden', true);

    const { data, error } = await query;
    const table = $('commentTable');
    if (error) { table.innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`; return; }

    $('commentCount').textContent = `(${data.length})`;
    if (!data.length) { table.innerHTML = '<tr><td class="empty">댓글이 없습니다.</td></tr>'; return; }

    table.innerHTML =
      '<thead><tr><th>시간</th><th>작품</th><th>학생</th><th>내용</th><th></th></tr></thead><tbody>' +
      data.map((c) => {
        const s = c.student_profiles || {};
        return `
          <tr data-id="${c.id}" class="${c.is_hidden ? 'is-hidden-row' : ''}">
            <td>${formatDate(c.created_at)}</td>
            <td>${escapeHtml(c.artworks?.title || '(삭제된 작품)')}</td>
            <td>${escapeHtml(s.name || '?')}<br/><small>${escapeHtml(s.school || '')} ${escapeHtml(s.student_no || '')}</small></td>
            <td class="body-cell">${escapeHtml(c.body)}${c.is_hidden ? ' <span class="tag tag--hidden">숨김</span>' : ''}</td>
            <td class="actions">
              <button class="btn btn--small" data-action="toggle-hide-comment" data-hidden="${c.is_hidden}">${c.is_hidden ? '보이기' : '숨기기'}</button>
              <button class="btn btn--small btn--danger" data-action="delete-comment">삭제</button>
            </td>
          </tr>`;
      }).join('') + '</tbody>';
  }

  async function toggleHideComment(id, currentlyHidden) {
    const { error } = await sb.from('comments').update({ is_hidden: !currentlyHidden }).eq('id', id);
    if (error) { toast(error.message, true); return; }
    await loadComments();
  }

  async function deleteComment(id) {
    if (!confirm('이 댓글을 완전히 삭제할까요?')) return;
    const { error } = await sb.from('comments').delete().eq('id', id);
    if (error) { toast(error.message, true); return; }
    toast('삭제했습니다.');
    await loadComments();
  }

  // -------------------------------------------------------------------
  // 9. 결과 집계 / CSV
  // -------------------------------------------------------------------
  let lastResults = [];

  async function loadResults() {
    const { data, error } = await sb.rpc('admin_results');
    const table = $('resultsTable');
    if (error) { table.innerHTML = `<tr><td class="empty">${escapeHtml(error.message)}</td></tr>`; return; }
    lastResults = data || [];
    if (!lastResults.length) { table.innerHTML = '<tr><td class="empty">작품이 없습니다.</td></tr>'; return; }

    table.innerHTML =
      '<thead><tr><th>순위</th><th>작품</th><th>출품자</th><th class="num">하트</th><th class="num">댓글</th><th>상태</th></tr></thead><tbody>' +
      lastResults.map((r, i) => `
        <tr class="${r.is_hidden ? 'is-hidden-row' : ''}">
          <td>${i + 1}</td>
          <td>${escapeHtml(r.title)}</td>
          <td>${escapeHtml(r.author_name)}</td>
          <td class="num"><b>${r.like_count}</b></td>
          <td class="num">${r.comment_count}</td>
          <td>${r.is_hidden ? '숨김' : '공개'}</td>
        </tr>`).join('') + '</tbody>';
  }

  function downloadResults() {
    if (!lastResults.length) { toast('먼저 결과를 불러오세요.', true); return; }
    downloadText(`투표결과_${todayStamp()}.csv`, toCsv([
      ['순위', '작품', '출품자', '하트', '댓글', '상태'],
      ...lastResults.map((r, i) => [i + 1, r.title, r.author_name, r.like_count, r.comment_count, r.is_hidden ? '숨김' : '공개']),
    ]));
  }

  /** 누가 어떤 작품에 하트를 눌렀는지 (검증용) */
  async function downloadLikesDetail() {
    const { data, error } = await sb.from('likes')
      .select('created_at, artworks(title), student_profiles(school, student_no, name)')
      .order('created_at').limit(20000);
    if (error) { toast(error.message, true); return; }
    downloadText(`하트상세_${todayStamp()}.csv`, toCsv([
      ['시간', '작품', '학교', '학번', '이름'],
      ...data.map((l) => [formatDate(l.created_at), l.artworks?.title, l.student_profiles?.school, l.student_profiles?.student_no, l.student_profiles?.name]),
    ]));
  }

  async function downloadCommentsDetail() {
    const { data, error } = await sb.from('comments')
      .select('created_at, body, is_hidden, artworks(title), student_profiles(school, student_no, name)')
      .order('created_at').limit(20000);
    if (error) { toast(error.message, true); return; }
    downloadText(`댓글상세_${todayStamp()}.csv`, toCsv([
      ['시간', '작품', '학교', '학번', '이름', '내용', '숨김'],
      ...data.map((c) => [formatDate(c.created_at), c.artworks?.title, c.student_profiles?.school, c.student_profiles?.student_no, c.student_profiles?.name, c.body, c.is_hidden ? 'Y' : '']),
    ]));
  }

  // -------------------------------------------------------------------
  // 10. 이벤트 연결
  // -------------------------------------------------------------------
  function bindEvents() {
    $('loginForm').addEventListener('submit', onLogin);
    $('logoutBtn').addEventListener('click', onLogout);
    $('bootstrapForm').addEventListener('submit', onBootstrap);

    document.querySelectorAll('.admin-nav__item').forEach((b) => {
      b.addEventListener('click', () => switchView(b.dataset.view));
    });

    // 대시보드
    $('votingSwitch').addEventListener('change', onToggleVoting);
    $('settingsForm').addEventListener('submit', onSaveSettings);

    // 교사 계정
    $('adminAddForm').addEventListener('submit', onAddAdmin);
    $('reloadAdmins').addEventListener('click', loadAdmins);
    $('adminTable').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="remove-admin"]');
      if (btn) removeAdmin(btn.closest('tr').dataset.email);
    });

    // 작품 업로드: 파일 선택 + 드래그 앤 드롭
    $('fileInput').addEventListener('change', (e) => onFilesSelected(e.target.files));
    const drop = $('fileDrop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
    drop.addEventListener('drop', (e) => onFilesSelected(e.dataTransfer.files));

    $('uploadQueue').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="remove"]');
      if (!btn) return;
      syncQueueInputs();
      const idx = Number(btn.closest('.upload-item').dataset.index);
      URL.revokeObjectURL(state.uploadQueue[idx].previewUrl);
      state.uploadQueue.splice(idx, 1);
      renderUploadQueue();
    });
    // 작품 정보 CSV 불러오기 + 드롭다운에서 고르면 칸 채우기
    $('artworkInfoFile').addEventListener('change', (e) => onArtworkInfoFile(e.target.files[0]));
    $('uploadQueue').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-field="info"]');
      if (!sel) return;
      syncQueueInputs();
      const item = state.uploadQueue[Number(sel.closest('.upload-item').dataset.index)];
      applyArtworkInfo(item, Number(sel.value));
      renderUploadQueue();
    });
    $('uploadBtn').addEventListener('click', uploadAll);
    $('reloadArtworks').addEventListener('click', loadArtworks);

    // 작품 목록 버튼들 (이벤트 위임)
    $('artworkList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const row = btn.closest('.artwork-row');
      switch (btn.dataset.action) {
        case 'edit': editArtwork(row); break;
        case 'save': saveArtwork(row); break;
        case 'cancel': loadArtworks(); break;
        case 'toggle-hide': toggleHideArtwork(row, btn.dataset.hidden === 'true'); break;
        case 'delete': deleteArtwork(row); break;
      }
    });

    // 명단
    $('downloadTemplate').addEventListener('click', downloadTemplate);
    $('rosterFile').addEventListener('change', (e) => onRosterFile(e.target.files[0]));
    $('rosterUploadBtn').addEventListener('click', uploadRoster);
    $('rosterCancelBtn').addEventListener('click', () => { state.rosterParsed = null; $('rosterPreviewWrap').classList.add('hidden'); });
    $('rosterSearch').addEventListener('input', renderRoster);
    $('rosterClearBtn').addEventListener('click', clearRoster);
    $('rosterTable').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="delete-roster"]');
      if (btn) deleteRosterRow(btn.closest('tr').dataset.id);
    });

    // 댓글
    $('reloadComments').addEventListener('click', loadComments);
    $('showHiddenOnly').addEventListener('change', loadComments);
    $('commentTable').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.closest('tr').dataset.id;
      if (btn.dataset.action === 'toggle-hide-comment') toggleHideComment(id, btn.dataset.hidden === 'true');
      if (btn.dataset.action === 'delete-comment') deleteComment(id);
    });

    // 결과
    $('reloadResults').addEventListener('click', loadResults);
    $('downloadResults').addEventListener('click', downloadResults);
    $('downloadLikesDetail').addEventListener('click', downloadLikesDetail);
    $('downloadCommentsDetail').addEventListener('click', downloadCommentsDetail);

    // 세션이 만료되거나 다른 탭에서 로그아웃하면 로그인 화면으로
    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { state.user = null; showLogin(); }
    });
  }

  init().catch((err) => {
    console.error(err);
    showFatal('초기화 중 오류: ' + escapeHtml(err.message || ''));
  });
})();
