# 학교 캐릭터 공모전 투표 사이트

학생들이 제출한 캐릭터 작품을 갤러리로 보고, 로그인한 학생이 **하트(좋아요)** 와 **댓글**로 투표하는 사이트입니다.
빌드 도구 없이 HTML + CSS + JavaScript 로만 만들어졌고, 데이터는 Supabase 에 저장하며, GitHub Pages 에 무료로 올릴 수 있습니다.

| 화면 | 파일 | 누가 쓰나 |
|---|---|---|
| 투표 화면 | `index.html` | 학생 |
| 관리자 화면 | `admin.html` | 교사 |

```
📁 프로젝트
├─ index.html          학생 투표 화면
├─ admin.html          교사 관리 화면
├─ css/
│   ├─ style.css       공통 스타일
│   └─ admin.css       관리자 화면 전용 스타일
├─ js/
│   ├─ config.js       ★ Supabase URL · key 입력하는 곳
│   ├─ app.js          학생 화면 로직
│   └─ admin.js        관리자 화면 로직
├─ supabase/
│   └─ schema.sql      ★ DB 테이블 · 보안 정책 · 함수 · Storage 를 한 번에 만드는 SQL
└─ README.md           이 문서
```

전체 과정은 **① Supabase 설정 → ② 내 컴퓨터에서 테스트 → ③ GitHub Pages 배포** 세 단계입니다. 처음이라면 1시간 정도 잡으세요.

---

## ① Supabase 설정 (약 20분)

> Supabase 프로젝트는 이미 만들어져 있다고 가정합니다. (예: `db_hyunuk`)
> 없다면 https://supabase.com 에서 가입 → **New project** 로 하나 만드세요. 무료 요금제로 충분합니다.

### 1-1. 익명 로그인 켜기 (학생 로그인용)

학생은 이메일 없이 **학교·학번·이름**만으로 참여합니다. 내부적으로 Supabase 의 "익명 로그인" 기능을 쓰므로 반드시 켜야 합니다.

1. Supabase 대시보드 → 왼쪽 메뉴 **Authentication** → **Sign In / Providers** (또는 **Providers**)
2. **Anonymous sign-ins** 스위치를 **켜기(Enabled)** → Save

### 1-2. 로그인 횟수 제한 올리기 (중요!)

Supabase 는 기본적으로 **같은 IP 에서 1시간에 익명 로그인 30회**까지만 허용합니다.
학교 와이파이는 모든 학생이 같은 IP 를 쓰기 때문에 **31번째 학생부터 로그인이 막힙니다.**

1. **Authentication** → **Rate Limits**
2. **Rate limit for anonymous users** 값을 학생 수보다 넉넉하게 (예: `500`) → Save

### 1-3. 이메일 확인 설정 (선택이지만 추천)

교사 계정을 만들 때 확인 메일 절차를 생략하려면:

1. **Authentication** → **Sign In / Providers** → **Email**
2. **Confirm email** 을 **끄기** → Save

켜 둔 채로도 쓸 수 있지만, 새 교사는 받은 확인 메일의 링크를 눌러야 로그인됩니다.

### 1-4. schema.sql 실행하기

1. 이 프로젝트의 `supabase/schema.sql` 을 메모장이나 VS Code 로 엽니다.
2. 파일 내용 **전체를 복사**합니다 (Ctrl+A → Ctrl+C).
3. Supabase 대시보드 → 왼쪽 메뉴 **SQL Editor** → **New query**
4. 붙여넣기(Ctrl+V) → 오른쪽 아래 **Run** (또는 Ctrl+Enter)
5. 아래에 `Success. No rows returned` 가 나오면 성공입니다.

이 한 번의 실행으로 테이블 7개, 보안 정책(RLS), 함수, 이미지 저장소(Storage 버킷 `artworks`)가 모두 만들어집니다.
**여러 번 실행해도 안전**하게 작성되어 있습니다.

### 1-5. 첫 관리자 계정 만들기

1. 아래 ② 로컬 테스트처럼 `admin.html` 을 엽니다 (또는 ③ 배포 후 교사용 주소).
2. 로그인 칸 아래 **"처음 설정: 첫 관리자 계정 만들기"** 를 펼칩니다.
3. 교사 이메일과 비밀번호(8자 이상)를 입력 → **계정 만들고 관리자로 등록**
4. 1-3 에서 Confirm email 을 껐다면 바로 관리자 화면이 열립니다. 켜져 있다면 확인 메일 링크를 누른 뒤 로그인 칸으로 로그인하세요.

이 메뉴는 **관리자가 아무도 없을 때 한 번만** 동작하고, 그 뒤에는 자동으로 닫힙니다.
두 번째 교사부터는 관리자 화면 → **대시보드 → 교사 계정 → 교사 추가**에서 만듭니다.

> 대시보드에서 직접 만들고 싶다면: **Authentication → Users → Add user** (Auto Confirm 체크)로 계정을 만든 뒤,
> `schema.sql` 맨 아래 insert 문의 이메일을 맞춰 다시 실행하면 됩니다.

> 교사를 더 추가할 때는 SQL 이 필요 없습니다. 첫 교사가 `admin.html` 에 로그인한 뒤
> **대시보드 → 교사 계정 → 교사 추가**에서 이메일과 비밀번호를 넣으면 계정 생성과 관리자 등록이 한 번에 됩니다.
> Supabase 의 **Confirm email** 설정이 켜져 있으면 새 교사는 확인 메일의 링크를 눌러야 로그인할 수 있습니다.
> (Authentication → Sign In / Providers → Email → Confirm email 을 끄면 바로 로그인 가능)

### 1-6. URL 과 key 를 config.js 에 넣기

1. Supabase 대시보드 → 왼쪽 아래 **Project Settings**(톱니바퀴) → **API** (또는 **API Keys**)
2. 두 값을 복사합니다.
   - **Project URL** : `https://xxxxxxxx.supabase.co` 형태
   - **anon public** key (새 대시보드에서는 **Publishable key**, `sb_publishable_...` 형태). 둘 중 어느 것이든 됩니다.
3. `js/config.js` 를 열어 붙여넣습니다.
   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
     SUPABASE_ANON_KEY: 'sb_publishable_xxxxxxxxxxxxxxxx',
     STORAGE_BUCKET: 'artworks',
   };
   ```

> ⚠️ **service_role / secret key 는 절대 넣지 마세요.**
> GitHub Pages 에 올라간 코드는 누구나 볼 수 있습니다. anon(publishable) key 는 공개되어도 괜찮게 설계된 키이고,
> 실제 권한은 DB 의 보안 정책(RLS)이 결정합니다. secret key 가 들어가면 누구나 DB 전체를 조작할 수 있습니다.

---

## ② 내 컴퓨터에서 테스트 (약 15분)

브라우저에서 파일을 더블클릭해 여는 방식(`file://`)은 동작하지 않습니다. 간단한 로컬 서버가 필요합니다.

### 방법 A. VS Code + Live Server (추천)

1. VS Code 로 프로젝트 폴더를 엽니다.
2. 확장 프로그램에서 **Live Server** 설치
3. `index.html` 에서 마우스 오른쪽 → **Open with Live Server**

### 방법 B. Python

Python 이 설치되어 있다면 프로젝트 폴더에서:

```bash
python -m http.server 8765
```

브라우저에서 `http://localhost:8765/index.html` 을 엽니다.

### 테스트 순서

**교사 화면 먼저** (`http://localhost:8765/admin.html`)

1. 교사 이메일·비밀번호로 로그인
   - "관리자로 등록되어 있지 않습니다" 가 뜨면 1-5 의 첫 관리자 만들기를 아직 안 한 것입니다.
2. **참가 명단** 탭 → **예시 CSV 내려받기** → 엑셀에서 열어 실제 학생으로 채우기 → **CSV UTF-8** 로 저장 → **CSV 파일 선택** → 미리보기 확인 → **이대로 등록**
   - 열 순서: `학교, 학번, 이름`. 첫 줄 제목은 자동으로 건너뜁니다.
   - 학번은 `10203` 처럼 학년·반·번호를 붙인 형태를 추천합니다 (학교 안에서 겹치지만 않으면 됩니다).
3. **작품** 탭 → 이미지 여러 장 선택 → 제목·설명 입력 → **전부 업로드**
   - 제목·출품자·설명을 미리 적은 `작품정보.csv`(열: 제목, 출품자, 설명, 파일명키워드)가 있으면 **📋 작품 정보 CSV 불러오기**로 읽어 두세요. 이미지 파일명에 키워드(예: `서라`)가 들어 있으면 자동으로 채워지고, 아니면 작품마다 드롭다운에서 고르면 됩니다.
4. **대시보드** 탭 → **투표 상태** 스위치 켜기

**학생 화면** (`http://localhost:8765/index.html`)

5. 작품이 보이는지 확인 → **로그인** → 명단에 있는 학교·학번·이름 입력 + 동의 체크 → **참여하기**
6. 하트 누르기 / 다시 눌러 취소 / 작품 클릭해 크게 보기 / 댓글 작성·삭제
7. 교사 화면 **결과** 탭에서 숫자가 반영되는지 확인

> 시크릿 창(Ctrl+Shift+N)을 열면 "다른 학생의 기기"처럼 테스트할 수 있습니다.

---

## ③ GitHub Pages 배포 (약 15분)

### 3-1. 저장소 만들기

1. https://github.com 로그인 → 오른쪽 위 **+** → **New repository**
2. Repository name: 예) `character-vote`
3. **Public** 선택 (GitHub Pages 무료 사용은 Public 저장소여야 합니다)
4. **Create repository**

### 3-2. 파일 올리기

**git 을 모르는 경우 (웹에서 드래그)**

1. 방금 만든 저장소 페이지에서 **uploading an existing file** 링크 클릭
2. 프로젝트 폴더 안의 파일·폴더를 **모두** 끌어다 놓습니다 (`index.html`, `admin.html`, `css`, `js`, `supabase`, `README.md`)
3. 아래 **Commit changes**

**git 을 아는 경우**

```bash
git init
git add .
git commit -m "캐릭터 공모전 투표 사이트"
git branch -M main
git remote add origin https://github.com/내아이디/character-vote.git
git push -u origin main
```

### 3-3. Pages 켜기

1. 저장소 → **Settings** → 왼쪽 **Pages**
2. **Source**: Deploy from a branch
3. **Branch**: `main` / 폴더 `/ (root)` → **Save**
4. 1~2분 뒤 위쪽에 주소가 나타납니다: `https://내아이디.github.io/character-vote/`

### 3-4. 주소 안내

- 학생용: `https://내아이디.github.io/character-vote/`
- 교사용: `https://내아이디.github.io/character-vote/admin.html`

학생들에게는 학생용 주소만 알려 주세요. (교사용 주소를 알아도 교사 계정이 없으면 아무것도 할 수 없지만, 굳이 알릴 필요는 없습니다.)

> 파일을 수정한 뒤에는 다시 올리기만 하면 1~2분 안에 자동 반영됩니다.

---

## 운영 가이드

### 투표 기간 운영

| 하고 싶은 일 | 위치 |
|---|---|
| 투표 시작 / 마감 | 관리자 → 대시보드 → 투표 상태 스위치 |
| 상단 안내문 바꾸기 | 관리자 → 대시보드 → 사이트 제목·안내문 |
| 작품 숨기기 / 수정 / 삭제 | 관리자 → 작품 |
| 부적절한 댓글 숨기기 | 관리자 → 댓글 |
| 결과 확인 · 엑셀로 받기 | 관리자 → 결과 → 결과 CSV |

### 중복 투표 · 공정성

- 하트는 **작품당 학생 1명에 1번**만 가능하며, DB 의 unique 제약으로 강제됩니다.
- 같은 학생이 다른 기기에서 다시 로그인하면 **새 기기로 넘어가고 이전 기기에서는 더 이상 투표할 수 없습니다.** 하트·댓글 기록은 유지됩니다.
- 학생 화면의 기본 정렬은 **랜덤**이라 앞쪽 작품이 유리해지는 효과를 줄입니다.
- 의심스러운 경우 관리자 → 결과 → **하트 상세 CSV** 로 누가 어떤 작품에 하트를 눌렀는지 확인할 수 있습니다. (개인정보이므로 외부 공유 금지)

### 공모전이 끝난 뒤: 개인정보 파기

동의서에 "결과 발표 후 지체 없이 파기" 라고 안내했으므로, 결과 정리가 끝나면 SQL Editor 에서 실행하세요.

```sql
-- 학생 개인정보 삭제 (하트·댓글도 함께 삭제됨)
delete from public.student_profiles;
delete from public.allowed_students;
-- 익명 로그인 계정 삭제
delete from auth.users where is_anonymous = true;
```

작품 이미지까지 지우려면 **Storage** → `artworks` 버킷에서 파일을 삭제하고, `delete from public.artworks;` 를 실행합니다.

---

## 자주 생기는 문제

| 증상 | 원인 · 해결 |
|---|---|
| 화면 위에 "Supabase 설정이 비어 있습니다" | `js/config.js` 에 URL/key 를 넣지 않았습니다. 1-6 참고 |
| 로그인 시 "Anonymous sign-ins 가 꺼져 있습니다" | 1-1 에서 익명 로그인을 켜지 않았습니다 |
| 어느 순간부터 학생 로그인이 안 됨 | 1-2 의 Rate Limit(기본 30회/시간/IP)에 걸렸습니다. 값을 올리세요 |
| "참가 명단에서 찾을 수 없습니다" | 학교 이름·학번·이름이 CSV 와 한 글자라도 다릅니다. 관리자 → 참가 명단에서 검색해 확인. 이름의 공백은 무시됩니다 |
| 교사 로그인 후 "관리자로 등록되어 있지 않습니다" | 이미 다른 관리자가 있는 상태입니다. 그 관리자에게 대시보드 → 교사 계정에서 등록을 요청하세요 |
| 이미지가 안 보임 | Storage → `artworks` 버킷이 **Public** 인지 확인. schema.sql 을 다시 실행하면 복구됩니다 |
| 업로드 시 "new row violates row-level security policy" | 로그인한 계정이 admins 표에 없습니다 |
| CSV 를 올렸는데 한글이 깨짐 | 엑셀에서 **CSV UTF-8** 형식으로 다시 저장하세요. (일반 CSV 도 자동 감지하지만 드물게 실패합니다) |
| 하트를 눌렀는데 "지금은 투표 기간이 아닙니다" | 관리자 → 대시보드에서 투표 스위치를 켜세요 |

---

## 보안 구조 (교사·동료에게 설명할 때)

- **공개되는 키는 anon(publishable) key 뿐**이고, 이 키로 할 수 있는 일은 DB 의 **RLS(행 수준 보안) 정책**이 정합니다.
- 학생이 할 수 있는 쓰기 작업은 **DB 함수 4개**(`claim_student`, `toggle_like`, `add_comment`, `delete_my_comment`)뿐이며, 함수 안에서 투표 기간·본인 여부·글자 수를 다시 검사합니다.
- **참가 명단은 교사만 읽을 수 있고**, 학생 로그인 함수가 내부에서만 대조합니다. 학교 이름 목록만 드롭다운용으로 공개됩니다.
- 댓글 작성자 이름은 **저장할 때 이미 마스킹**(강*욱)되어 들어가므로, 학생에게는 실제 이름이 전달될 경로가 없습니다. 교사는 별도 조인으로 실제 이름을 봅니다.
- 작품 업로드·명단·설정 변경은 전부 `is_admin()` (admins 표의 이메일과 일치하고 익명 계정이 아님) 조건이 붙어 있습니다.
- 모든 사용자 입력은 화면에 넣기 전에 HTML 이스케이프 처리하여 스크립트 삽입(XSS)을 막습니다.
