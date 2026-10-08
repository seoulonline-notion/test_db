-- =====================================================================
--  학교 캐릭터 공모전 투표 사이트 - Supabase 스키마
-- =====================================================================
--  사용 방법
--    1) 아래 "8. 교사 계정 이메일 등록" 부분(파일 맨 끝)을 본인 이메일로 수정합니다.
--    2) Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run.
--    3) 여러 번 실행해도 안전하도록(idempotent) 작성되어 있습니다.
--
--  전체 구조 한눈에 보기
--    settings          : 투표 시작/마감 스위치 등 사이트 설정(행 1개만 존재)
--    admins            : 교사(관리자) 이메일 목록
--    secrets           : 관리자 가입 코드 (클라이언트는 읽을 수 없음, 함수 안에서만 사용)
--    student_profiles  : 로그인한 학생(학교·학번·이름). 익명 로그인 계정(auth.users)과 연결
--    artworks          : 공모전 작품(이미지 경로 + 제목 + 설명)
--    likes             : 좋아요. (작품, 학생) 조합 1개만 허용 → 1인 1회
--    comments          : 댓글. 작성자명은 저장 시점에 마스킹(강*욱)
--
--  보안 원칙
--    - 모든 테이블 RLS(행 수준 보안) 활성화
--    - 학생의 "쓰기"는 전부 RPC 함수(toggle_like, add_comment ...)로만 가능
--      → 함수 내부에서 투표 기간, 본인 여부, 글자 수를 다시 검사
--    - 테이블 직접 쓰기 정책은 교사(is_admin)에게만 부여
--    - 프런트엔드는 anon(publishable) key만 사용. service_role key는 절대 사용 금지
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 확장 기능
-- ---------------------------------------------------------------------
-- gen_random_uuid() 는 pgcrypto 확장에 포함되어 있습니다(Supabase는 기본 활성화).
create extension if not exists pgcrypto;


-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------

-- 1-1. 사이트 설정 (행이 딱 1개만 존재하도록 id = 1 로 고정)
create table if not exists public.settings (
  id            integer primary key check (id = 1),  -- 항상 1
  site_title    text        not null default '캐릭터 공모전 투표',
  notice        text        not null default '',     -- 상단 안내문(선택)
  voting_open   boolean     not null default false,  -- true: 투표 중 / false: 마감(또는 시작 전)
  updated_at    timestamptz not null default now()
);

-- 설정 행이 없으면 기본값으로 1개 생성
insert into public.settings (id) values (1)
on conflict (id) do nothing;


-- 1-2. 관리자(교사) 이메일 목록
--   Supabase Authentication → Users 에서 만든 교사 계정의 이메일을 여기에 넣습니다.
--   이메일이 이 표에 있으면 is_admin() 이 true 가 되어 관리자 기능이 열립니다.
create table if not exists public.admins (
  email       text primary key,
  created_at  timestamptz not null default now()
);


-- 1-3. 비밀 값 저장소 (관리자 가입 코드)
--   이 표에는 어떤 RLS 정책도 두지 않으므로 클라이언트에서는 절대 읽을 수 없고,
--   SECURITY DEFINER 함수(check_admin_code, register_admin) 안에서만 읽습니다.
create table if not exists public.secrets (
  key    text primary key,
  value  text not null
);
-- 관리자 가입 코드 기본값. 바꾸려면 SQL Editor 에서:
--   update public.secrets set value = '새코드' where key = 'admin_signup_code';
-- (이미 값이 있으면 이 파일을 다시 실행해도 덮어쓰지 않습니다)
insert into public.secrets (key, value) values ('admin_signup_code', 'sonline')
on conflict (key) do nothing;

-- 예전 버전에서 쓰던 "참가 명단" 표와 함수는 더 이상 사용하지 않으므로 제거
drop function if exists public.list_schools();
drop table if exists public.allowed_students;


-- 1-4. 로그인한 학생 프로필
--   익명 로그인으로 생긴 auth.users 계정(user_id)과 학생 정보를 연결합니다.
--   (학교, 학번) 조합이 유일해야 함 → 같은 학생이 여러 계정을 만들어 중복 투표하는 것을 DB에서 차단
--   (학교 이름은 norm_school() 로 정규화해 비교: 유일 인덱스는 2-4 아래에서 만듦)
create table if not exists public.student_profiles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users (id) on delete set null, -- 현재 연결된 로그인 계정
  school        text not null,
  student_no    text not null,
  name          text not null,
  consented_at  timestamptz,                         -- 개인정보 수집·이용 동의 시각
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);
create index if not exists student_profiles_user_id_idx on public.student_profiles (user_id);
-- 예전 버전의 단순 unique(school, student_no) 제약은 제거 (아래 정규화 인덱스로 대체)
alter table public.student_profiles drop constraint if exists student_profiles_school_student_no_key;


-- 1-5. 작품
create table if not exists public.artworks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text not null default '',
  author_name  text not null default '',   -- 출품자 이름(공개하고 싶지 않으면 비워 두기)
  image_path   text not null,              -- Storage 버킷 'artworks' 안의 파일 경로
  sort_order   integer not null default 0, -- 관리자용 정렬값(학생 화면 기본은 랜덤)
  is_hidden    boolean not null default false, -- true 면 학생 화면에서 숨김
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);


-- 1-6. 좋아요
create table if not exists public.likes (
  id          uuid primary key default gen_random_uuid(),
  artwork_id  uuid not null references public.artworks (id) on delete cascade,
  student_id  uuid not null references public.student_profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (artwork_id, student_id)   -- ★ 작품당 1인 1회 핵심 제약
);
create index if not exists likes_artwork_id_idx on public.likes (artwork_id);
create index if not exists likes_student_id_idx on public.likes (student_id);


-- 1-7. 댓글
create table if not exists public.comments (
  id             uuid primary key default gen_random_uuid(),
  artwork_id     uuid not null references public.artworks (id) on delete cascade,
  student_id     uuid not null references public.student_profiles (id) on delete cascade,
  author_masked  text not null,     -- 저장 시점에 마스킹된 이름 (예: 강*욱)
  body           text not null check (char_length(body) between 1 and 200), -- 200자 제한
  is_hidden      boolean not null default false,  -- 교사가 숨김 처리
  created_at     timestamptz not null default now()
);
create index if not exists comments_artwork_id_idx on public.comments (artwork_id, created_at);


-- ---------------------------------------------------------------------
-- 2. 도우미 함수
-- ---------------------------------------------------------------------
--  SECURITY DEFINER : 함수를 "만든 사람(postgres)" 권한으로 실행 → RLS를 넘어 필요한 표를 읽음
--  set search_path  : 보안을 위해 함수 안에서 참조하는 스키마를 고정
-- ---------------------------------------------------------------------

-- 2-1. 현재 로그인한 사용자가 관리자(교사)인가?
--   JWT 안의 email 이 admins 표에 있고, 익명 사용자가 아니면 true
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from public.admins a
      where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;


-- 2-2. 현재 로그인한 학생의 프로필 id (없으면 null)
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.student_profiles p
  where p.user_id = auth.uid()
  limit 1;
$$;


-- 2-3. 지금 투표 기간인가?
create or replace function public.voting_is_open()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select voting_open from public.settings where id = 1), false);
$$;


-- 2-4. 학교 이름 정규화 (표기가 조금 달라도 같은 학교로 보기 위함)
--   띄어쓰기 제거 + 소문자 + 끝의 "등학교"/"학교" 제거
--   예) "경인고등학교", "경인 고등학교", "경인고" → 모두 "경인고"
create or replace function public.norm_school(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           lower(regexp_replace(coalesce(p, ''), '\s+', '', 'g')),
           '(등학교|학교)$', '');
$$;

-- ★ 중복 투표 차단의 핵심: (정규화한 학교, 학번) 조합은 프로필 1개만 허용
create unique index if not exists student_profiles_school_no_key
  on public.student_profiles (public.norm_school(school), student_no);


-- 2-5. 이름 마스킹  (강현욱 → 강*욱, 김철 → 김*, 남궁민수 → 남**수)
create or replace function public.mask_name(p_name text)
returns text
language sql
immutable
as $$
  select case
    when p_name is null or length(trim(p_name)) = 0 then '익명'
    when length(trim(p_name)) = 1 then trim(p_name)
    when length(trim(p_name)) = 2 then left(trim(p_name), 1) || '*'
    else left(trim(p_name), 1)
         || repeat('*', length(trim(p_name)) - 2)
         || right(trim(p_name), 1)
  end;
$$;


-- ---------------------------------------------------------------------
-- 3. 학생용 RPC 함수  (프런트엔드에서 supabase.rpc('함수명', {...}) 로 호출)
-- ---------------------------------------------------------------------

-- 3-1. 학생 로그인(프로필 연결)
--   흐름: 프런트에서 익명 로그인 → 이 함수 호출 → 프로필 생성/재연결
--   별도의 참가 명단은 없습니다. 학교·학번·이름을 입력하면 누구나 참여할 수 있고,
--   같은 (학교, 학번)은 프로필 1개만 만들어지므로 1인 1표가 유지됩니다.
--   같은 학생이 다른 기기에서 다시 로그인하면 기존 프로필을 새 계정에 재연결하고,
--   이전 기기의 계정은 프로필이 끊겨 더 이상 투표할 수 없게 됩니다(중복 투표 방지).
create or replace function public.claim_student(
  p_school     text,
  p_student_no text,
  p_name       text,
  p_consent    boolean
)
returns public.student_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_school  text := trim(coalesce(p_school, ''));
  v_no      text := trim(coalesce(p_student_no, ''));
  v_name    text := regexp_replace(coalesce(p_name, ''), '\s+', '', 'g'); -- 공백 제거 후 비교
  v_profile public.student_profiles;
begin
  if v_uid is null then
    raise exception '로그인 세션이 없습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.';
  end if;

  if not coalesce(p_consent, false) then
    raise exception '개인정보 수집·이용에 동의해야 참여할 수 있습니다.';
  end if;

  if v_school = '' or v_no = '' or v_name = '' then
    raise exception '학교, 학번, 이름을 모두 입력해 주세요.';
  end if;

  if public.norm_school(v_school) = '' then
    raise exception '학교 이름을 정확히 입력해 주세요.';
  end if;

  -- 같은 브라우저 계정이 다른 학생 프로필에 연결돼 있다면 먼저 끊어 둡니다.
  -- (예: 한 기기에서 A 학생이 로그아웃 없이 B 학생으로 다시 로그인하는 경우)
  update public.student_profiles
     set user_id = null
   where user_id = v_uid
     and not (public.norm_school(school) = public.norm_school(v_school) and student_no = v_no);

  -- 프로필 생성, 이미 있으면(같은 학교·학번) 현재 계정으로 재연결
  --   이름이 다르면 재연결하지 않음 → 남의 학번으로 로그인해 표를 가로채는 것을 막음
  if exists (
    select 1 from public.student_profiles p
    where public.norm_school(p.school) = public.norm_school(v_school)
      and p.student_no = v_no
      and p.name <> v_name
  ) then
    raise exception '같은 학교·학번으로 이미 다른 이름이 등록되어 있습니다. 선생님께 문의해 주세요.';
  end if;

  insert into public.student_profiles
         (user_id, school, student_no, name, consented_at, last_login_at)
  values (v_uid, v_school, v_no, v_name, now(), now())
  on conflict ((public.norm_school(school)), student_no) do update
     set user_id       = excluded.user_id,
         consented_at  = coalesce(public.student_profiles.consented_at, now()),
         last_login_at = now()
  returning * into v_profile;

  return v_profile;
end;
$$;


-- 3-3. 갤러리 조회 (숨김 아닌 작품 + 좋아요 수 + 댓글 수 + 내가 좋아요 했는지)
--   likes 표는 학생이 "자기 것만" 읽을 수 있으므로, 전체 개수는 이 함수로만 제공합니다.
create or replace function public.get_gallery()
returns table (
  id            uuid,
  title         text,
  description   text,
  author_name   text,
  image_path    text,
  created_at    timestamptz,
  like_count    bigint,
  comment_count bigint,
  liked_by_me   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.title,
    a.description,
    a.author_name,
    a.image_path,
    a.created_at,
    (select count(*) from public.likes l where l.artwork_id = a.id)                        as like_count,
    (select count(*) from public.comments c where c.artwork_id = a.id and not c.is_hidden) as comment_count,
    exists (
      select 1 from public.likes l
      where l.artwork_id = a.id and l.student_id = public.current_student_id()
    ) as liked_by_me
  from public.artworks a
  where not a.is_hidden
  order by a.sort_order, a.created_at;
$$;


-- 3-4. 좋아요 토글 (이미 눌렀으면 취소, 아니면 추가)
create or replace function public.toggle_like(p_artwork_id uuid)
returns table (liked boolean, like_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid   uuid := public.current_student_id();
  v_liked boolean;
begin
  if v_sid is null then
    raise exception '로그인 후 좋아요를 누를 수 있습니다.';
  end if;

  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;

  if not exists (select 1 from public.artworks a where a.id = p_artwork_id and not a.is_hidden) then
    raise exception '작품을 찾을 수 없습니다.';
  end if;

  -- 이미 좋아요가 있으면 삭제(취소)
  delete from public.likes l
   where l.artwork_id = p_artwork_id and l.student_id = v_sid;

  if found then
    v_liked := false;
  else
    insert into public.likes (artwork_id, student_id)
    values (p_artwork_id, v_sid)
    on conflict (artwork_id, student_id) do nothing;  -- 동시 클릭 대비
    v_liked := true;
  end if;

  return query
    select v_liked, count(*)
    from public.likes l
    where l.artwork_id = p_artwork_id;
end;
$$;


-- 3-5. 댓글 작성 (200자 제한, 작성자명 마스킹 저장)
create or replace function public.add_comment(p_artwork_id uuid, p_body text)
returns public.comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid   uuid := public.current_student_id();
  v_body  text := trim(coalesce(p_body, ''));
  v_name  text;
  v_row   public.comments;
begin
  if v_sid is null then
    raise exception '로그인 후 댓글을 남길 수 있습니다.';
  end if;

  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;

  if char_length(v_body) = 0 then
    raise exception '댓글 내용을 입력해 주세요.';
  end if;

  if char_length(v_body) > 200 then
    raise exception '댓글은 200자까지 쓸 수 있습니다.';
  end if;

  if not exists (select 1 from public.artworks a where a.id = p_artwork_id and not a.is_hidden) then
    raise exception '작품을 찾을 수 없습니다.';
  end if;

  select p.name into v_name from public.student_profiles p where p.id = v_sid;

  insert into public.comments (artwork_id, student_id, author_masked, body)
  values (p_artwork_id, v_sid, public.mask_name(v_name), v_body)
  returning * into v_row;

  return v_row;
end;
$$;


-- 3-6. 내 댓글 삭제 (본인 댓글만)
create or replace function public.delete_my_comment(p_comment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sid uuid := public.current_student_id();
begin
  if v_sid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  delete from public.comments c
   where c.id = p_comment_id and c.student_id = v_sid;

  return found;  -- 삭제됐으면 true, 내 댓글이 아니거나 없으면 false
end;
$$;


-- ---------------------------------------------------------------------
-- 4. 교사용 RPC 함수
-- ---------------------------------------------------------------------

-- 4-1. 투표 결과 집계 (숨김 작품 포함, 좋아요 많은 순)
create or replace function public.admin_results()
returns table (
  id            uuid,
  title         text,
  author_name   text,
  is_hidden     boolean,
  like_count    bigint,
  comment_count bigint,
  created_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  return query
    select
      a.id, a.title, a.author_name, a.is_hidden,
      (select count(*) from public.likes l where l.artwork_id = a.id)      as like_count,
      (select count(*) from public.comments c where c.artwork_id = a.id)   as comment_count,
      a.created_at
    from public.artworks a
    order by like_count desc, a.created_at;
end;
$$;


-- 4-2. 참여 현황 요약 (로그인 인원, 좋아요/댓글 총수, 작품 수)
drop function if exists public.admin_summary();   -- 반환 열이 바뀌어 다시 만듦
create function public.admin_summary()
returns table (
  login_count    bigint,
  like_total     bigint,
  comment_total  bigint,
  artwork_count  bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  return query
    select
      (select count(*) from public.student_profiles),
      (select count(*) from public.likes),
      (select count(*) from public.comments),
      (select count(*) from public.artworks);
end;
$$;


-- 4-3. 관리자 가입 코드 확인 (admin.html 에서 계정을 만들기 전에 호출)
--   코드는 secrets 표에만 있고 클라이언트는 읽을 수 없으므로, 맞는지 여부만 돌려줍니다.
create or replace function public.check_admin_code(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.secrets s
    where s.key = 'admin_signup_code' and s.value = coalesce(p_code, '')
  );
$$;


-- 4-4. 관리자 등록 (가입 코드 필요)
--   흐름: admin.html 에서 회원가입(signUp) → 이 함수 호출
--   1) 가입 코드 확인  2) 그 이메일의 로그인 계정이 있는지 확인
--   3) 이메일 확인 절차를 생략하도록 바로 활성화  4) admins 표에 등록
--   로그인 전(anon)에도 호출할 수 있지만, 코드를 모르면 아무것도 할 수 없습니다.
create or replace function public.register_admin(p_email text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not public.check_admin_code(p_code) then
    raise exception '관리자 가입 코드가 올바르지 않습니다.';
  end if;

  if v_email = '' then
    raise exception '이메일을 입력해 주세요.';
  end if;

  if not exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception '해당 이메일의 로그인 계정이 아직 없습니다.';
  end if;

  -- 확인 메일 절차 없이 바로 로그인할 수 있도록 활성화
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now())
   where lower(email) = v_email;

  insert into public.admins (email) values (v_email)
  on conflict (email) do nothing;
  return true;
end;
$$;

-- 예전 버전의 함수들은 제거
drop function if exists public.bootstrap_admin();
drop function if exists public.bootstrap_admin_confirm(text);
drop function if exists public.confirm_admin_email(text);
drop function if exists public.has_active_admin();


-- ---------------------------------------------------------------------
-- 5. 함수 실행 권한
-- ---------------------------------------------------------------------
--  Supabase 는 기본적으로 public 스키마 함수를 anon/authenticated 모두 실행 가능하게 둡니다.
--  쓰기 함수는 로그인(authenticated) 사용자만 실행할 수 있게 좁힙니다.
--  (익명 로그인 사용자도 역할은 authenticated 입니다.)
-- ---------------------------------------------------------------------
revoke execute on function public.claim_student(text, text, text, boolean) from public, anon;
revoke execute on function public.toggle_like(uuid)                        from public, anon;
revoke execute on function public.add_comment(uuid, text)                  from public, anon;
revoke execute on function public.delete_my_comment(uuid)                  from public, anon;
revoke execute on function public.admin_results()                          from public, anon;
revoke execute on function public.admin_summary()                          from public, anon;

grant execute on function public.claim_student(text, text, text, boolean) to authenticated;
grant execute on function public.toggle_like(uuid)                        to authenticated;
grant execute on function public.add_comment(uuid, text)                  to authenticated;
grant execute on function public.delete_my_comment(uuid)                  to authenticated;
grant execute on function public.admin_results()                          to authenticated;
grant execute on function public.admin_summary()                          to authenticated;

-- 읽기 전용 함수는 로그인 전에도 호출 가능 (갤러리 미리보기)
grant execute on function public.get_gallery()  to anon, authenticated;
grant execute on function public.is_admin()     to anon, authenticated;

-- 관리자 등록은 로그인 전(회원가입 직후)에 호출되므로 anon 에게도 허용. 가입 코드가 있어야만 동작.
grant execute on function public.check_admin_code(text)        to anon, authenticated;
grant execute on function public.register_admin(text, text)    to anon, authenticated;

-- secrets 표는 함수 안에서만 읽으므로 클라이언트 역할의 모든 권한을 제거
revoke all on table public.secrets from anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. RLS (행 수준 보안) 활성화 + 정책
-- ---------------------------------------------------------------------
--  정책이 하나도 없으면 "아무도 못 읽고 못 쓴다"가 기본값입니다.
--  필요한 최소 권한만 아래에서 열어 줍니다.
-- ---------------------------------------------------------------------
alter table public.settings         enable row level security;
alter table public.admins           enable row level security;
alter table public.secrets          enable row level security;
alter table public.student_profiles enable row level security;
alter table public.artworks         enable row level security;
alter table public.likes            enable row level security;
alter table public.comments         enable row level security;

-- 6-1. settings : 누구나 읽기(투표 중인지 표시용), 교사만 수정
drop policy if exists "settings_read_all"    on public.settings;
drop policy if exists "settings_admin_write" on public.settings;
create policy "settings_read_all"    on public.settings for select using (true);
create policy "settings_admin_write" on public.settings for update
  using (public.is_admin()) with check (public.is_admin());

-- 6-2. admins : 교사만 목록 조회·삭제 (추가는 register_admin 함수로만, 가입 코드 필요)
--      자기 자신은 삭제할 수 없게 하여 관리자가 0명이 되는 사고를 막습니다.
drop policy if exists "admins_admin_read"   on public.admins;
drop policy if exists "admins_admin_insert" on public.admins;
drop policy if exists "admins_admin_delete" on public.admins;
create policy "admins_admin_read"   on public.admins for select using (public.is_admin());
create policy "admins_admin_delete" on public.admins for delete
  using (public.is_admin() and lower(email) <> lower(coalesce(auth.jwt() ->> 'email', '')));

-- 6-3. secrets : ★ 어떤 정책도 두지 않음 → 누구도 직접 읽거나 쓸 수 없음 (함수 안에서만 사용)

-- 6-4. student_profiles : 학생은 자기 행만 읽기, 교사는 전체 읽기/수정/삭제
--      (생성은 claim_student 함수로만)
drop policy if exists "profiles_read_own_or_admin" on public.student_profiles;
drop policy if exists "profiles_admin_update"      on public.student_profiles;
drop policy if exists "profiles_admin_delete"      on public.student_profiles;
create policy "profiles_read_own_or_admin" on public.student_profiles for select
  using (user_id = auth.uid() or public.is_admin());
create policy "profiles_admin_update" on public.student_profiles for update
  using (public.is_admin()) with check (public.is_admin());
create policy "profiles_admin_delete" on public.student_profiles for delete
  using (public.is_admin());

-- 6-5. artworks : 숨김 아닌 작품은 누구나 읽기, 교사는 전체 + 쓰기
drop policy if exists "artworks_read_visible_or_admin" on public.artworks;
drop policy if exists "artworks_admin_insert"          on public.artworks;
drop policy if exists "artworks_admin_update"          on public.artworks;
drop policy if exists "artworks_admin_delete"          on public.artworks;
create policy "artworks_read_visible_or_admin" on public.artworks for select
  using (not is_hidden or public.is_admin());
create policy "artworks_admin_insert" on public.artworks for insert
  with check (public.is_admin());
create policy "artworks_admin_update" on public.artworks for update
  using (public.is_admin()) with check (public.is_admin());
create policy "artworks_admin_delete" on public.artworks for delete
  using (public.is_admin());

-- 6-6. likes : 학생은 자기 좋아요만 읽기(전체 개수는 get_gallery 로), 교사는 전체 읽기/삭제
--      (추가/취소는 toggle_like 함수로만)
drop policy if exists "likes_read_own_or_admin" on public.likes;
drop policy if exists "likes_admin_delete"      on public.likes;
create policy "likes_read_own_or_admin" on public.likes for select
  using (student_id = public.current_student_id() or public.is_admin());
create policy "likes_admin_delete" on public.likes for delete
  using (public.is_admin());

-- 6-7. comments : 숨김 아닌 댓글은 누구나 읽기, 교사는 전체 + 숨김/삭제
--      (작성은 add_comment, 본인 삭제는 delete_my_comment 함수로만)
drop policy if exists "comments_read_visible_or_admin" on public.comments;
drop policy if exists "comments_admin_update"          on public.comments;
drop policy if exists "comments_admin_delete"          on public.comments;
create policy "comments_read_visible_or_admin" on public.comments for select
  using (not is_hidden or public.is_admin());
create policy "comments_admin_update" on public.comments for update
  using (public.is_admin()) with check (public.is_admin());
create policy "comments_admin_delete" on public.comments for delete
  using (public.is_admin());


-- ---------------------------------------------------------------------
-- 7. Storage 버킷 (작품 이미지)
-- ---------------------------------------------------------------------
--  버킷 이름: artworks / 공개(public) 버킷 → 이미지 URL 로 누구나 볼 수 있음
--  업로드·수정·삭제는 교사만 가능
--  파일 크기 제한 10MB, 이미지 형식만 허용
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'artworks', 'artworks', true, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "artworks_bucket_public_read"  on storage.objects;
drop policy if exists "artworks_bucket_admin_insert" on storage.objects;
drop policy if exists "artworks_bucket_admin_update" on storage.objects;
drop policy if exists "artworks_bucket_admin_delete" on storage.objects;

create policy "artworks_bucket_public_read" on storage.objects for select
  using (bucket_id = 'artworks');
create policy "artworks_bucket_admin_insert" on storage.objects for insert
  with check (bucket_id = 'artworks' and public.is_admin());
create policy "artworks_bucket_admin_update" on storage.objects for update
  using (bucket_id = 'artworks' and public.is_admin())
  with check (bucket_id = 'artworks' and public.is_admin());
create policy "artworks_bucket_admin_delete" on storage.objects for delete
  using (bucket_id = 'artworks' and public.is_admin());


-- ---------------------------------------------------------------------
-- 8. 관리자 계정 만들기 (SQL 불필요)
-- ---------------------------------------------------------------------
--  admin.html 로그인 화면의 "관리자 계정 만들기"에서
--  이메일 + 비밀번호 + 관리자 가입 코드(기본값 sonline)를 입력하면 바로 관리자가 됩니다.
--  예전 버전에서 남은 예시 이메일은 정리합니다.
-- ---------------------------------------------------------------------
delete from public.admins where email = 'teacher@example.com';


-- =====================================================================
--  끝. 다음 할 일:
--    - Authentication → Sign In / Providers → "Anonymous sign-ins" 켜기 (학생 로그인용)
--    - Authentication → Rate Limits → 익명 로그인 제한을 학생 수에 맞게 올리기
--      (기본값은 IP당 시간당 30회. 학교 와이파이는 IP가 하나라 반드시 조정 필요)
--    - js/config.js 에 Project URL 과 anon(publishable) key 입력
-- =====================================================================
