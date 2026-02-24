# 통합접속 - 업무 서비스 통합 관리 대시보드

북마크, 서버, 구글 앱스 등 업무에 필요한 모든 서비스를 한 곳에서 관리하고 접속할 수 있는 대시보드입니다.

## 기능

- 북마크/서비스 관리 (추가, 수정, 삭제, 드래그앤드롭 정렬)
- 카테고리별 분류
- 서비스 상태 모니터링 (온라인/오프라인)
- 사용자별 개인 북마크 + 공용 북마크
- 인증PC 자동 로그인
- 화면 잠금 (PIN, 타이머 조절, ON/OFF)
- 관리자 계정/사용자 관리

## 기술 스택

- **Backend**: Python FastAPI (Vercel Serverless)
- **Frontend**: HTML + CSS + Vanilla JS
- **Database**: Supabase (PostgreSQL)
- **배포**: Vercel

## 배포 방법

1. GitHub에 이 저장소를 push
2. [Vercel](https://vercel.com)에서 프로젝트 import
3. Environment Variables 설정:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `JWT_SECRET`
4. Deploy

## 최초 설정

1. 배포된 사이트 접속
2. 로그인 화면에서 로고를 5번 클릭하면 관리자 생성 폼 표시
3. 관리자 계정 생성 후 로그인
