# 밸브재 구매 AI Agent PoC (Python 버전)

## 프로젝트 개요

PR(구매요청) 자재별 최적 단가를 제안하고, 협력사 견적단가를 검증하며, 원재료 시황을 반영한 가격 적정성을 분석하는 AI Agent 기반 구매 의사결정 지원 시스템입니다.

**Python 원본 코드(`valve_agent_poc_final.py`)를 Flask 웹 서버로 변환하여 브라우저에서 실행 가능하도록 구현했습니다.**

### 핵심 기능

| 화면 | 기능 | 설명 |
|------|------|------|
| **화면 1** | PR 최적 단가 제안 | Rule1(BODY2) + Rule2(옵션) + Rule3(수량환산) → 계약단가 |
| **화면 2** | 협력사 견적 검증 | 발주×90% 기준 적정성 판정 (우수/보통/부적절) |
| **화면 3** | 시황 분석 | LME Cu/Sn 가격 vs 발주단가 트렌드 비교 |

### Agentic UI (Python 스타일 로그)

- 좌측 35%: Python 콘솔 스타일 Agent 로그 (실시간)
- 우측 65%: PRD 테이블 형식 결과 + Chart.js 차트
- 단계별 진행: 데이터 수집 → Rule 적용 → LLM 분석 → 판정

## 기술 스택

- **Backend**: Python + Flask + Pandas
- **Frontend**: HTML + Tailwind CSS + Chart.js
- **AI**: Claude API (claude-sonnet-4-20250514)
- **배포**: Railway / Docker

## 데이터 구조

| 데이터 | 건수 | 설명 |
|--------|------|------|
| 단가테이블 | 482건 | 밸브타입별 BODY2 단가 + 옵션 단가 |
| 협력사 견적 | 159건 (매핑 126건) | 검증 대상 견적 |
| 발주 실적 | 36,960건 | 과거 발주 이력 |
| BC밸브 (VGBARR240AT) | 431건 | 시황 분석 대상 (LOCK 제외, TR 포함) |
| LME 시황 | 12건 | 2025년 Cu/Sn 월별 가격 |

## 단가 산출 로직 (PRD 기준)

```
1. Rule 1 (BODY2 기본단가):
   - 밸브타입 끝자리 제거 후 단가테이블 매핑
   - 예: VGBASW350AT → VGBASW350A → BODY2 단가

2. Rule 2 (옵션단가):
   - 자재내역 키워드 기반 옵션 추출
   - I/O-P, LOCK, IND, L/SW, EXT, DISC-SCS13/14/16 등

3. Rule 3 (계약단가):
   - 계약단가 = BODY2 + 옵션단가
   - 수량환산 적용 (단가표 수량 ÷ PR 수량)

4. 과거 발주실적 기준:
   - 1순위: 밸브타입 + 자재내역 100% 일치
   - 2순위: 밸브타입만 일치
   - → P열(발주금액) 기준 최근 발주단가

5. 추천단가:
   - min(계약단가, 최근발주단가) 또는 발주×90%

6. 적정성 판정:
   - 우수: 발주×90% ≥ 견적가
   - 보통: 발주/계약 ≥ 견적가
   - 부적절: 그 외
```

## API 엔드포인트

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/health` | 서버 상태 + 데이터 건수 |
| POST | `/api/screen1/analyze` | 화면1: PR 단가 분석 (매핑 7건 + 미매핑 3건 자동 선택) |
| POST | `/api/screen2/analyze` | 화면2: 협력사 견적 전체 검증 |
| POST | `/api/screen3/analyze` | 화면3: 시황 트렌드 분석 |

## 로컬 개발

```bash
# Python 의존성 설치
pip install -r requirements.txt

# 데이터 디렉토리 설정
export DATA_DIR=/path/to/data

# 서버 실행
python app.py

# 또는 gunicorn으로 실행
gunicorn -b 0.0.0.0:3000 app:app
```

## 환경 변수

```env
PORT=3000
DATA_DIR=/home/user/uploaded_files
ANTHROPIC_API_KEY=your-api-key  # 선택사항
```

## 데이터 파일 (uploaded_files/)

- `#2_일반_General_단가_테이블.xlsx` - 단가테이블
- `#3_협력사_견적_샘플.xlsx` - 협력사 견적
- `#4_일반_General_실적.xlsx` - 발주 실적
- `LME_CuSn_Monthly_2025.xlsx` - LME 시황

## Railway 배포

1. GitHub 연동
2. 환경변수 설정:
   - `DATA_DIR`: 데이터 경로
   - `ANTHROPIC_API_KEY`: Claude API 키 (선택)
3. Start Command: `python app.py`

## 프로젝트 구조

```
webapp/
├── app.py                 # Flask 서버 (Python)
├── requirements.txt       # Python 의존성
├── public/
│   └── index.html         # Agentic UI (PRD 테이블 형식)
├── src/
│   └── server.ts          # (레거시 TypeScript 버전)
├── data/
│   └── *.json             # 전처리된 JSON 데이터
└── README.md
```

## 샌드박스 URL

- **개발 서버**: https://3000-ih3ml8qs487oelbx58ppv-2e77fc33.sandbox.novita.ai

## 현재 완료된 기능

✅ **Python Flask 서버 구현**
- `valve_agent_poc_final.py` 로직 완전 이식
- Excel 파일 직접 로드 (pandas)
- Python 스타일 콘솔 로그

✅ **화면 1: PR 최적 단가 제안 (PRD 형식)**
- Rule 1/2/3 각각 결과 표시
- 단가테이블 매핑 기준: BODY2 + 옵션단가 + 합계
- 과거 발주실적: 1순위(타입+내역) / 2순위(타입) 구분
- 자동 PR 샘플 선택 (매핑 7건 + 미매핑 3건)

✅ **화면 2: 협력사 견적 검증**
- 전체 126건 일괄 검증
- 적정성 분포: 우수 1건, 보통 123건, 부적절 2건
- 괴리율 계산 및 판정 라벨

✅ **화면 3: 시황 분석**
- BC밸브 431건 분석
- Cu +31%, Sn +40% 연간 상승
- 월별 적정성 판정: Good 6, Normal 4, Bad 1
- Chart.js 트렌드 차트

## 미완료 기능

❌ Claude API 실제 연동 (API Key 필요)
❌ Railway 배포 설정

---

**버전**: v2.0.0 (Python)  
**최종 수정**: 2026-02-09
