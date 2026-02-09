# 밸브재 구매 AI Agent PoC

## 프로젝트 개요

PR(구매요청) 자재별 최적 단가를 제안하고, 협력사 견적단가를 검증하며, 원재료 시황을 반영한 가격 적정성을 분석하는 AI Agent 기반 구매 의사결정 지원 시스템입니다.

### 핵심 기능

| 화면 | 기능 | 설명 |
|------|------|------|
| **화면 1** | PR 최적 단가 제안 | 단가테이블 + 발주실적 기반 추천 단가 산출 |
| **화면 2** | 협력사 견적 검증 | 발주×90% 기준 적정성 판정 (우수/보통/부적절) |
| **화면 3** | 시황 분석 | LME Cu/Sn 가격 vs 발주단가 트렌드 비교 |

### Agentic UI

- 좌측 40%: Agent 활동 로그 (실시간 스트리밍)
- 우측 60%: 분석 결과 및 차트
- 단계별 진행: 데이터 수집 → Rule 적용 → LLM 분석 → 판정

## 기술 스택

- **Backend**: Node.js + Express + TypeScript
- **Frontend**: HTML + Tailwind CSS + Chart.js
- **AI**: Claude API (claude-sonnet-4-20250514)
- **배포**: Railway

## 데이터 구조

| 데이터 | 건수 | 설명 |
|--------|------|------|
| 단가테이블 | 482건 | 밸브타입별 BODY2 단가 + 옵션 단가 |
| 협력사 견적 | 159건 | 검증 대상 견적 |
| 발주 실적 | 35,722건 | 과거 발주 이력 |
| BC밸브 (VGBARR240AT) | 654건 | 시황 분석 대상 |
| LME 시황 | 12건 | 2025년 Cu/Sn 월별 가격 |

## 단가 산출 로직

```
1. Rule 1: 밸브타입 매핑 (끝자리 제거)
   - VGBASW350AT → VGBASW350A (단가테이블 키)

2. Rule 2: 계약단가 = BODY2 + 옵션단가
   - 옵션: I/O-P, LOCK, IND, DISC-SCS16 등

3. Rule 3: 추천단가 = min(계약단가, 최근발주단가)

4. 적정성 판정:
   - 우수: 발주×90% ≥ 견적가
   - 보통: 발주/계약 ≥ 견적가
   - 부적절: 그 외
```

## API 엔드포인트

### 기본 API
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/health` | 서버 상태 확인 |
| GET | `/api/price-table` | 단가테이블 전체 조회 |
| GET | `/api/quotes` | 견적 전체 조회 |

### 프론트엔드 분석 API
| Method | Endpoint | 파라미터 | 설명 |
|--------|----------|----------|------|
| POST | `/api/analyze/price-recommendation` | `{valveType, quantity}` | 화면1: 최적 단가 제안 |
| POST | `/api/analyze/quote-verification` | `{quoteIndex}` | 화면2: 견적 적정성 검증 |
| POST | `/api/analyze/market-trend` | `{valveType}` | 화면3: 시황 트렌드 분석 |

### 백엔드 일괄 분석 API
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/api/screen1/analyze` | PR 단가 일괄 분석 |
| POST | `/api/screen1/llm-analyze` | PR LLM 분석 |
| POST | `/api/screen2/verify` | 견적 일괄 검증 |
| POST | `/api/screen2/llm-analyze` | 견적 LLM 분석 |
| GET | `/api/screen3/trend` | 시황 트렌드 |
| POST | `/api/screen3/llm-analyze` | 시황 LLM 분석 |

## 로컬 개발

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev

# 빌드
npm run build

# 프로덕션 실행
npm start
```

## 환경 변수

```env
PORT=3000
ANTHROPIC_API_KEY=your-api-key
```

## Railway 배포

1. GitHub 연동
2. 환경변수 설정: `ANTHROPIC_API_KEY`
3. 자동 빌드 & 배포

## 프로젝트 구조

```
webapp/
├── src/
│   └── server.ts          # Express 서버 + API
├── public/
│   └── index.html         # Agentic UI 프론트엔드
├── data/
│   ├── price_table.json   # 단가테이블
│   ├── quote_sample.json  # 협력사 견적
│   ├── order_history_*.json # 발주실적
│   └── lme_data.json      # LME 시황
├── dist/                   # 빌드 결과
├── package.json
├── tsconfig.json
└── README.md
```

## 샌드박스 URL

- **개발 서버**: https://3000-ih3ml8qs487oelbx58ppv-2e77fc33.sandbox.novita.ai

## 현재 완료된 기능

✅ **화면 1: PR 최적 단가 제안**
- 밸브타입 선택 드롭다운 (482개 타입)
- BODY2 기본단가 + 옵션단가 계산
- 최근 발주실적 기반 추천 단가 산출
- Agentic UI 단계별 로그 표시

✅ **화면 2: 협력사 견적 검증**
- 견적 항목 선택 (159건)
- 자재번호 → 밸브타입 매핑
- 적정성 판정 (우수/보통/부적절)
- 괴리율 계산 및 협상 전략 제시

✅ **화면 3: 시황 분석**
- VGBARR240AT 타입 654건 분석 (LOCK 제외, TR 포함 → 431건)
- LME Cu/Sn 월별 시황 지수 (Cu 88% + Sn 12%)
- 발주단가 지수 트렌드 Chart.js 시각화
- 월별 적정성 판정 (Good/Normal/Bad)

## 미완료 기능

❌ Claude API 실제 연동 (API Key 필요)
❌ Railway 배포 설정
❌ 데모 모드 자동 실행

---

**버전**: v1.1.0  
**최종 수정**: 2026-02-09
