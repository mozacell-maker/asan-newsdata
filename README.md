# 지역 홍보 사업 성과 분석 시스템

네이버 뉴스에서 지역 관련 기사를 매일 모아 **보도량 · 이슈 확산 · 매체별 현황 · 확인 조회수**를 보여 주는 대시보드와 통계 보고서입니다.

## 바로 실행 (샘플 데이터)
```bash
pip install -r requirements.txt
python run.py sample          # 가상 데이터로 data.js 생성
python server.py              # http://localhost:8000
```
`index.html` 을 브라우저로 바로 열어도 됩니다. 서버 없이도 동작합니다.

## 실제 데이터 수집
1. https://developers.naver.com 에서 애플리케이션을 등록하고 **검색 API**의 Client ID/Secret을 발급받습니다.
2. 실행합니다:
```bash
export NAVER_CLIENT_ID=...  NAVER_CLIENT_SECRET=...
export GEMINI_API_KEY=...     # 선택: 보고서 AI 해석
python run.py all             # collect → build → report
```
> 처음에는 `rm data/articles.jsonl` 로 샘플 기사를 지운 뒤 수집하세요.

## 구성
| 파일 | 역할 |
|---|---|
| `config.json` | 지역명, 검색어, 제외어, 주제 키워드, 기관명, 조회수 수집 여부 |
| `run.py` | 수집(collect) · 이슈 통합/주제 분류(build) · 통계 분석(report) · 샘플(sample) |
| `data/articles.jsonl` | 누적 기사 저장소 (네이버 API는 검색어당 최신 1,000건만 주므로 매일 누적) |
| `data/budget.json` | (선택) 월별 홍보비 `{"2026-01": 12000000}` → 보고서 Ⅷ 분석 |
| `data.js` | 화면이 읽는 결과 파일 |
| `index.html` / `report.html` | 대시보드 / 통계 보고서 |
| `server.py` | 정적 서버 + 관리자 로그인(`/admin`) + '최신 데이터로 갱신' 버튼 |
| `.github/workflows/daily.yml` | 매일 08:00(KST) 자동 수집 후 커밋 |

## 관리자 모드
```bash
ADMIN_ID=admin ADMIN_PASSWORD='강한비밀번호' NAVER_CLIENT_ID=... NAVER_CLIENT_SECRET=... python server.py
```
`/admin` 에서 로그인하면 수집을 직접 실행할 수 있습니다.

## 배포 (예: Render)
Web Service → Build `pip install -r requirements.txt`, Start `python server.py`, 환경변수에 위 키를 등록합니다.
정적 호스팅(GitHub Pages 등)만 쓴다면 GitHub Actions 워크플로가 매일 `data.js` 를 갱신합니다.
