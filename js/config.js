// =====================================================================
//  Supabase 연결 설정
// =====================================================================
//  Supabase 대시보드 → Project Settings → API 에서 아래 두 값을 복사해 넣습니다.
//
//    SUPABASE_URL      : Project URL        (예: https://abcdefghijk.supabase.co)
//    SUPABASE_ANON_KEY : anon public key    (publishable key, "eyJ..." 또는 "sb_publishable_..." 로 시작)
//
//  ★ 주의 ★
//    - service_role / secret key 는 절대로 여기에 넣지 마세요.
//      GitHub Pages 는 코드가 전부 공개되므로, secret key 가 들어가면 누구나 DB를 통째로 조작할 수 있습니다.
//    - anon key 는 공개되어도 괜찮습니다. 실제 권한은 DB의 RLS 정책이 결정합니다.
// =====================================================================

window.APP_CONFIG = {
  SUPABASE_URL: 'https://sexleyqiilcoonpywthz.supabase.co/rest/v1/',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNleGxleXFpaWxjb29ucHl3dGh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzOTY2ODMsImV4cCI6MjEwNjk3MjY4M30.vpGqeHLQEAwWuoF7xFTRmldQG4UsAOSCh2zgmj0wj60',

  // 작품 이미지가 들어 있는 Storage 버킷 이름 (schema.sql 과 같아야 함)
  STORAGE_BUCKET: 'artworks',
};
