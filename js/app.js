// =====================================================================
//  학생 화면 로직 (index.html)
// =====================================================================
//  흐름 요약
//    1) config.js 의 URL/key 로 Supabase 클라이언트 생성
//    2) 설정(투표 중인지)과 기존 로그인 세션 복원
//    3) get_gallery() 로 작품 목록을 받아 카드로 그림
//    4) 하트 클릭 → toggle_like(), 댓글 → add_comment() / delete_my_comment()
//    5) 로그인 → 익명 로그인(signInAnonymously) → claim_student() 로 명단 확인
//
//  이 파일은 빌드 도구 없이 브라우저에서 바로 실행됩니다.
//  (function(){ ... })() 로 감싸서 전역 변수 오염을 막습니다.
// =====================================================================

(function () {
  'use strict';

  // -------------------------------------------------------------------
  // 0. 자주 쓰는 도우미
  // -------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const CFG = window.APP_CONFIG || {};

  /** 사용자가 입력한 글을 HTML 에 넣기 전에 특수문자를 바꿔 XSS 를 막습니다. */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 날짜를 "10월 8일 14:03" 형태로 */
  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString('ko-KR', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  }

  /** 화면 아래에 잠깐 뜨는 알림 */
  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('toast--error', isError);
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2600);
  }

  /** 심각한 오류(설정 누락 등)를 상단에 크게 표시 */
  function showFatal(html) {
    const el = $('fatalAlert');
    el.innerHTML = html;
    el.classList.remove('hidden');
    $('gallery').innerHTML = '';
    $('voteBadge').textContent = '오류';
  }

  // 시드 기반 난수 (같은 시드 → 같은 순서). 새로고침해도 랜덤 순서가 유지되도록 사용.
  function seededRandom(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(list, seed) {
    const arr = list.slice();
    const rand = seededRandom(seed);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 하트 SVG (카드마다 반복 사용)
  const HEART_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 21s-7.5-4.6-9.6-9.1C1 8.6 2.6 5 6.3 5c2 0 3.3 1.1 4.1 2.3L12 9l1.6-1.7C14.4 6.1 15.7 5 17.7 5c3.7 0 5.3 3.6 3.9 6.9C19.5 16.4 12 21 12 21z"/>
  </svg>`;

  // -------------------------------------------------------------------
  // 1. 설정 확인 + Supabase 클라이언트 생성
  // -------------------------------------------------------------------
  const configMissing =
    !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY ||
    CFG.SUPABASE_URL.includes('YOUR-PROJECT') || CFG.SUPABASE_ANON_KEY.includes('YOUR-ANON');

  if (configMissing) {
    showFatal(
      '<b>Supabase 설정이 비어 있습니다.</b><br/>' +
      '<code>js/config.js</code> 파일을 열어 <code>SUPABASE_URL</code> 과 ' +
      '<code>SUPABASE_ANON_KEY</code> 를 입력해 주세요. (README 2단계 참고)'
    );
    return;
  }

  if (typeof window.supabase === 'undefined') {
    showFatal('<b>supabase-js 라이브러리를 불러오지 못했습니다.</b><br/>인터넷 연결을 확인한 뒤 새로고침해 주세요.');
    return;
  }

  // 전역 `supabase` 는 라이브러리 이름이므로, 우리가 만든 클라이언트는 `sb` 라고 부릅니다.
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const BUCKET = CFG.STORAGE_BUCKET || 'artworks';

  /** Storage 경로 → 공개 이미지 URL */
  function imageUrl(path) {
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // -------------------------------------------------------------------
  // 2. 화면 상태 (한곳에 모아 두면 디버깅이 쉬움)
  // -------------------------------------------------------------------
  const state = {
    profile: null,          // 로그인한 학생 프로필 (student_profiles 행)
    settings: { voting_open: false, site_title: '', notice: '' },
    artworks: [],           // get_gallery() 결과
    sort: 'random',         // random | popular | newest
    seed: 0,                // 랜덤 정렬 시드
    currentId: null,        // 상세 모달에 열린 작품 id
    busyLikes: new Set(),   // 처리 중인 하트 (중복 클릭 방지)
  };

  // 랜덤 시드: 이 브라우저 탭에서는 같은 순서가 유지되도록 sessionStorage 에 저장
  try {
    const saved = sessionStorage.getItem('vote_seed');
    state.seed = saved ? Number(saved) : Math.floor(Math.random() * 1e9);
    sessionStorage.setItem('vote_seed', String(state.seed));
  } catch { state.seed = Math.floor(Math.random() * 1e9); }

  // -------------------------------------------------------------------
  // 3. 초기화
  // -------------------------------------------------------------------
  async function init() {
    bindEvents();
    // 설정과 세션은 서로 독립적이므로 동시에 불러옵니다.
    await Promise.all([loadSettings(), restoreSession()]);
    renderUser();
    await loadGallery();
  }

  /** settings 표에서 투표 상태/제목/안내문 읽기 */
  async function loadSettings() {
    const { data, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
    if (error) {
      console.error('설정 불러오기 실패', error);
      toast('설정을 불러오지 못했습니다.', true);
      return;
    }
    if (data) state.settings = data;
    renderSettings();
  }

  function renderSettings() {
    const s = state.settings;
    if (s.site_title) {
      $('siteTitle').textContent = s.site_title;
      document.title = s.site_title;
    }
    $('notice').textContent = s.notice || '';
    const badge = $('voteBadge');
    badge.textContent = s.voting_open ? '투표 중' : '투표 마감';
    badge.classList.toggle('badge--open', !!s.voting_open);
  }

  /** 이전에 로그인한 세션이 남아 있으면 프로필을 다시 불러옵니다. */
  async function restoreSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;

    // RLS 덕분에 "내 프로필"만 조회됩니다.
    const { data, error } = await sb
      .from('student_profiles')
      .select('*')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (error) { console.error('프로필 조회 실패', error); return; }

    if (data) {
      state.profile = data;
    } else {
      // 세션은 있지만 프로필이 없음 = 다른 기기에서 다시 로그인해서 연결이 끊긴 경우 등
      state.profile = null;
    }
  }

  /** 헤더의 로그인 버튼 / 사용자 칩 전환 */
  function renderUser() {
    const loggedIn = !!state.profile;
    $('loginBtn').classList.toggle('hidden', loggedIn);
    $('userChip').classList.toggle('hidden', !loggedIn);
    if (loggedIn) {
      $('userName').textContent = `${state.profile.name} (${state.profile.student_no})`;
    }
  }

  // -------------------------------------------------------------------
  // 4. 갤러리
  // -------------------------------------------------------------------
  async function loadGallery() {
    const { data, error } = await sb.rpc('get_gallery');
    const stateEl = $('galleryState');

    if (error) {
      console.error('갤러리 불러오기 실패', error);
      $('gallery').innerHTML = '';
      stateEl.className = 'state state--error';
      stateEl.innerHTML = '작품을 불러오지 못했습니다.<br/><button class="btn btn--small" id="retryBtn">다시 시도</button>';
      stateEl.classList.remove('hidden');
      $('retryBtn').addEventListener('click', loadGallery);
      return;
    }

    state.artworks = data || [];
    renderGallery();
  }

  /** 현재 정렬 기준으로 작품 배열 정렬 */
  function sortedArtworks() {
    const list = state.artworks;
    if (state.sort === 'popular') {
      return list.slice().sort((a, b) => b.like_count - a.like_count || b.comment_count - a.comment_count);
    }
    if (state.sort === 'newest') {
      return list.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    return shuffled(list, state.seed); // 기본: 랜덤 (순서 효과 방지)
  }

  function renderGallery() {
    const grid = $('gallery');
    const stateEl = $('galleryState');
    const list = sortedArtworks();

    $('artworkCount').textContent = list.length ? `작품 ${list.length}개` : '';

    if (list.length === 0) {
      grid.innerHTML = '';
      stateEl.className = 'state';
      stateEl.textContent = '아직 등록된 작품이 없습니다.';
      stateEl.classList.remove('hidden');
      return;
    }
    stateEl.classList.add('hidden');

    grid.innerHTML = list.map(cardHtml).join('');
  }

  /** 작품 카드 1개의 HTML */
  function cardHtml(a) {
    const liked = a.liked_by_me ? 'is-liked' : '';
    return `
      <article class="card" data-id="${a.id}">
        <button class="card__image-btn" data-action="open" aria-label="${escapeHtml(a.title)} 크게 보기">
          <img src="${imageUrl(a.image_path)}" alt="${escapeHtml(a.title)}" loading="lazy" />
        </button>
        <div class="card__body">
          <button class="card__title" data-action="open">${escapeHtml(a.title)}</button>
          ${a.author_name ? `<div class="card__author">${escapeHtml(a.author_name)}</div>` : ''}
          ${a.description ? `<p class="card__desc">${escapeHtml(a.description)}</p>` : ''}
          <div class="card__actions">
            <button class="heart ${liked}" data-action="like" aria-pressed="${!!a.liked_by_me}" aria-label="좋아요">
              ${HEART_SVG}<span class="like-count">${a.like_count}</span>
            </button>
            <button class="comment-count" data-action="open" aria-label="댓글 보기">
              💬 <span class="comment-num">${a.comment_count}</span>
            </button>
          </div>
        </div>
      </article>`;
  }

  /** 좋아요 수/상태가 바뀌면 카드와 상세 모달을 함께 갱신 */
  function updateArtworkUi(a) {
    const card = document.querySelector(`.card[data-id="${a.id}"]`);
    if (card) {
      const heart = card.querySelector('.heart');
      heart.classList.toggle('is-liked', !!a.liked_by_me);
      heart.setAttribute('aria-pressed', String(!!a.liked_by_me));
      card.querySelector('.like-count').textContent = a.like_count;
      card.querySelector('.comment-num').textContent = a.comment_count;
    }
    if (state.currentId === a.id) {
      const heart = $('detailHeart');
      heart.classList.toggle('is-liked', !!a.liked_by_me);
      heart.setAttribute('aria-pressed', String(!!a.liked_by_me));
      $('detailLikeCount').textContent = a.like_count;
      $('detailCommentCount').textContent = a.comment_count;
    }
  }

  // -------------------------------------------------------------------
  // 5. 좋아요 (하트)
  // -------------------------------------------------------------------
  async function onHeart(artworkId, buttonEl) {
    const a = state.artworks.find((x) => x.id === artworkId);
    if (!a) return;

    // 로그인 안 했으면 로그인 모달로
    if (!state.profile) {
      openModal('loginModal');
      toast('로그인하면 하트를 누를 수 있어요.');
      return;
    }
    if (!state.settings.voting_open) {
      toast('지금은 투표 기간이 아닙니다.', true);
      return;
    }
    if (state.busyLikes.has(artworkId)) return; // 연타 방지
    state.busyLikes.add(artworkId);

    // 애니메이션
    if (buttonEl) {
      buttonEl.classList.remove('pop');
      void buttonEl.offsetWidth;        // 애니메이션 재시작 트릭
      buttonEl.classList.add('pop');
    }

    // 먼저 화면을 바꿔 두고(낙관적 업데이트), 서버 응답으로 맞춰 줍니다.
    const before = { liked_by_me: a.liked_by_me, like_count: a.like_count };
    a.liked_by_me = !a.liked_by_me;
    a.like_count = Number(a.like_count) + (a.liked_by_me ? 1 : -1);
    updateArtworkUi(a);

    const { data, error } = await sb.rpc('toggle_like', { p_artwork_id: artworkId });
    state.busyLikes.delete(artworkId);

    if (error) {
      Object.assign(a, before);         // 실패하면 원래대로
      updateArtworkUi(a);
      toast(error.message || '좋아요 처리에 실패했습니다.', true);
      // 세션이 끊긴 경우(다른 기기에서 로그인 등)는 로그인 상태를 다시 확인
      if (/로그인/.test(error.message || '')) { await restoreSession(); renderUser(); }
      return;
    }

    // toggle_like 는 행 1개를 돌려줍니다: { liked, like_count }
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      a.liked_by_me = row.liked;
      a.like_count = Number(row.like_count);
      updateArtworkUi(a);
    }
  }

  // -------------------------------------------------------------------
  // 6. 작품 상세 모달 + 댓글
  // -------------------------------------------------------------------
  function openDetail(artworkId) {
    const a = state.artworks.find((x) => x.id === artworkId);
    if (!a) return;
    state.currentId = artworkId;

    const img = $('detailImage');
    img.src = imageUrl(a.image_path);
    img.alt = a.title;
    $('detailTitle').textContent = a.title;
    $('detailAuthor').textContent = a.author_name || '';
    $('detailDesc').textContent = a.description || '';
    updateArtworkUi(a);
    renderCommentFormState();

    $('commentList').innerHTML = '<li class="state">댓글을 불러오는 중…</li>';
    openModal('detailModal');
    loadComments(artworkId);
  }

  /** 로그인/투표 상태에 따라 댓글 입력창 안내 문구를 바꿈 */
  function renderCommentFormState() {
    const textarea = $('commentBody');
    const submit = $('commentSubmit');
    const hint = $('detailHint');

    if (!state.profile) {
      textarea.disabled = true;
      textarea.placeholder = '로그인하면 댓글을 남길 수 있어요.';
      submit.textContent = '로그인';
      submit.disabled = false;
      hint.textContent = '하트를 누르려면 로그인하세요.';
    } else if (!state.settings.voting_open) {
      textarea.disabled = true;
      textarea.placeholder = '투표가 마감되어 댓글을 남길 수 없습니다.';
      submit.textContent = '마감';
      submit.disabled = true;
      hint.textContent = '투표가 마감되었습니다.';
    } else {
      textarea.disabled = false;
      textarea.placeholder = '작품에 대한 응원이나 감상을 남겨 주세요 (200자)';
      submit.textContent = '댓글 남기기';
      submit.disabled = false;
      hint.textContent = '하트는 한 번만, 다시 누르면 취소돼요.';
    }
  }

  async function loadComments(artworkId) {
    const { data, error } = await sb
      .from('comments')
      .select('id, author_masked, body, created_at, student_id')
      .eq('artwork_id', artworkId)
      .order('created_at', { ascending: true });

    // 사용자가 다른 작품으로 넘어갔으면 결과를 버립니다.
    if (state.currentId !== artworkId) return;

    const list = $('commentList');
    if (error) {
      list.innerHTML = '<li class="state state--error">댓글을 불러오지 못했습니다.</li>';
      return;
    }
    renderComments(data || []);

    // 댓글 수를 최신으로 맞춤
    const a = state.artworks.find((x) => x.id === artworkId);
    if (a) { a.comment_count = (data || []).length; updateArtworkUi(a); }
  }

  function renderComments(comments) {
    const list = $('commentList');
    if (comments.length === 0) {
      list.innerHTML = '<li class="state" style="padding:20px">첫 댓글을 남겨 보세요!</li>';
      return;
    }
    const myId = state.profile ? state.profile.id : null;
    list.innerHTML = comments.map((c) => {
      const mine = myId && c.student_id === myId;
      return `
        <li class="comment ${mine ? 'comment--mine' : ''}" data-comment-id="${c.id}">
          <div class="comment__head">
            <span class="comment__author">${escapeHtml(c.author_masked)}${mine ? ' (나)' : ''}</span>
            <span>
              ${formatDate(c.created_at)}
              ${mine ? `<button class="comment__delete" data-action="delete-comment">삭제</button>` : ''}
            </span>
          </div>
          <p class="comment__body">${escapeHtml(c.body)}</p>
        </li>`;
    }).join('');
  }

  async function onSubmitComment(e) {
    e.preventDefault();
    if (!state.profile) { openModal('loginModal'); return; }
    if (!state.settings.voting_open) { toast('지금은 투표 기간이 아닙니다.', true); return; }

    const textarea = $('commentBody');
    const body = textarea.value.trim();
    if (!body) { toast('댓글 내용을 입력해 주세요.', true); return; }
    if (body.length > 200) { toast('댓글은 200자까지 쓸 수 있어요.', true); return; }

    const submit = $('commentSubmit');
    submit.disabled = true;
    submit.textContent = '저장 중…';

    const artworkId = state.currentId;
    const { error } = await sb.rpc('add_comment', { p_artwork_id: artworkId, p_body: body });

    submit.disabled = false;
    submit.textContent = '댓글 남기기';

    if (error) {
      toast(error.message || '댓글 저장에 실패했습니다.', true);
      return;
    }
    textarea.value = '';
    updateCharCount();
    toast('댓글을 남겼어요 ✨');
    await loadComments(artworkId);
  }

  async function onDeleteComment(commentId) {
    if (!confirm('이 댓글을 삭제할까요?')) return;
    const { data, error } = await sb.rpc('delete_my_comment', { p_comment_id: commentId });
    if (error || data === false) {
      toast((error && error.message) || '내 댓글만 삭제할 수 있어요.', true);
      return;
    }
    toast('댓글을 삭제했어요.');
    await loadComments(state.currentId);
  }

  function updateCharCount() {
    const len = $('commentBody').value.length;
    const el = $('charCount');
    el.textContent = `${len} / 200`;
    el.classList.toggle('is-over', len > 200);
  }

  // -------------------------------------------------------------------
  // 7. 로그인 / 로그아웃
  // -------------------------------------------------------------------
  async function onLogin(e) {
    e.preventDefault();
    const errEl = $('loginError');
    errEl.textContent = '';

    const school = $('school').value.trim();
    const studentNo = $('studentNo').value.trim();
    const name = $('studentName').value.trim();
    const consent = $('consent').checked;

    if (!school) { errEl.textContent = '학교 이름을 입력해 주세요.'; return; }
    if (!studentNo) { errEl.textContent = '학번을 입력해 주세요.'; return; }
    if (!name) { errEl.textContent = '이름을 입력해 주세요.'; return; }
    if (!consent) { errEl.textContent = '개인정보 수집·이용에 동의해야 참여할 수 있어요.'; return; }

    const submit = $('loginSubmit');
    submit.disabled = true;
    submit.textContent = '확인 중…';

    try {
      // (1) 세션이 없으면 익명 로그인으로 브라우저 전용 계정을 만듭니다.
      let { data: { session } } = await sb.auth.getSession();
      if (!session) {
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw mapAuthError(error);
        session = data.session;
      }

      // (2) 명단 확인 + 프로필 연결 (DB 함수가 모든 검증을 담당)
      const { data: profile, error } = await sb.rpc('claim_student', {
        p_school: school,
        p_student_no: studentNo,
        p_name: name,
        p_consent: consent,
      });
      if (error) throw error;

      state.profile = profile;
      renderUser();
      closeModal('loginModal');
      toast(`${profile.name}님, 환영해요! 🎉`);

      // 내 좋아요 표시를 반영하기 위해 갤러리를 다시 불러옵니다.
      await loadGallery();
      if (state.currentId) { renderCommentFormState(); loadComments(state.currentId); }
    } catch (err) {
      console.error('로그인 실패', err);
      errEl.textContent = err.message || '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    } finally {
      submit.disabled = false;
      submit.textContent = '참여하기';
    }
  }

  /** Supabase Auth 오류를 학생이 이해할 수 있는 말로 */
  function mapAuthError(error) {
    const msg = (error && error.message) || '';
    if (/anonymous.*disabled/i.test(msg)) {
      return new Error('관리자 설정 오류: Supabase 에서 Anonymous sign-ins 가 꺼져 있습니다. 선생님께 알려 주세요.');
    }
    if (/rate limit|too many/i.test(msg)) {
      return new Error('지금 로그인하는 사람이 많아요. 1~2분 뒤 다시 시도해 주세요.');
    }
    return new Error(msg || '로그인에 실패했습니다.');
  }

  async function onLogout() {
    await sb.auth.signOut();
    state.profile = null;
    renderUser();
    toast('로그아웃했어요.');
    await loadGallery();
    if (state.currentId) { renderCommentFormState(); loadComments(state.currentId); }
  }

  // -------------------------------------------------------------------
  // 8. 모달 열기/닫기
  // -------------------------------------------------------------------
  function openModal(id) {
    $(id).classList.remove('hidden');
    document.body.classList.add('modal-open');
    if (id === 'loginModal') {
      setTimeout(() => $('school').focus(), 50);
    }
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
    if (id === 'detailModal') {
      state.currentId = null;
      $('detailImage').src = '';
      // 다른 학생들의 하트/댓글 수가 바뀌었을 수 있어 조용히 갱신
      loadGallery();
    }
    // 열린 모달이 없을 때만 스크롤 잠금 해제
    if (document.querySelectorAll('.modal:not(.hidden)').length === 0) {
      document.body.classList.remove('modal-open');
    }
  }

  // -------------------------------------------------------------------
  // 9. 이벤트 연결
  // -------------------------------------------------------------------
  function bindEvents() {
    $('loginBtn').addEventListener('click', () => openModal('loginModal'));
    $('logoutBtn').addEventListener('click', onLogout);
    $('loginForm').addEventListener('submit', onLogin);
    $('commentForm').addEventListener('submit', onSubmitComment);
    $('commentBody').addEventListener('input', updateCharCount);

    // 정렬 탭
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        state.sort = tab.dataset.sort;
        renderGallery();
      });
    });

    // 갤러리 카드 안의 버튼들 (이벤트 위임: 카드가 많아도 리스너는 1개)
    $('gallery').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const card = btn.closest('.card');
      const id = card && card.dataset.id;
      if (!id) return;
      if (btn.dataset.action === 'like') onHeart(id, btn);
      else if (btn.dataset.action === 'open') openDetail(id);
    });

    // 상세 모달의 큰 하트
    $('detailHeart').addEventListener('click', (e) => {
      if (state.currentId) onHeart(state.currentId, e.currentTarget);
    });

    // 댓글 삭제 (이벤트 위임)
    $('commentList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="delete-comment"]');
      if (!btn) return;
      const li = btn.closest('[data-comment-id]');
      if (li) onDeleteComment(li.dataset.commentId);
    });

    // 모달 닫기: X 버튼, 바깥 클릭, Esc
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll('.modal').forEach((modal) => {
      modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal.id); });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal:not(.hidden)').forEach((m) => closeModal(m.id));
      }
    });

    // 다른 탭에서 로그아웃/로그인하면 이 탭도 따라가도록
    sb.auth.onAuthStateChange(async (event) => {
      if (event === 'SIGNED_OUT') {
        state.profile = null;
        renderUser();
        renderGallery();
      }
    });
  }

  // 시작!
  init().catch((err) => {
    console.error(err);
    showFatal('초기화 중 오류가 발생했습니다. 새로고침해 주세요.<br/>' + escapeHtml(err.message || ''));
  });
})();
