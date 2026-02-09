# 밸브재 구매 AI Agent PoC

## 프로젝트 개요
- **목적**: PR 자재별 최적 단가 제안 및 협력사 견적단가 검증 시스템
- **특징**: Agentic UI - AI Agent의 분석 과정을 실시간 스트리밍으로 시각화

## 화면 구성

### 화면 1: PR 최적 추천 단가 제안
- 단가테이블 × 발주실적 기반 분석
- Rule 1: 밸브타입 매핑 (끝자리 제거)
- Rule 2: 옵션단가 적용 (O-P, I-P, LOCK, DISC 등)

### 화면 2: 협력사 견적 적정성 검증
- 견적가 vs 발주실적(90%) 비교
- 판정: 우수(🟢) / 보통(🟡) / 부적절(🔴)

### 화면 3: 원재료 시황 × 발주단가 분석
- VGBARR240AT (Bronze Casting: Cu 88% + Sn 12%)
- LME 시황 지수 vs 발주단가 지수 비교

## 데이터
- 단가테이블: 482건
- 협력사 견적: 159건
- 발주실적 (BC밸브): 654건
- LME 시황: 12개월

## 기술 스택
- Backend: Hono + TypeScript
- Frontend: Tailwind CSS, Chart.js
- AI: Claude API (Anthropic)

## 실행 방법

### 로컬 개발
```bash
npm install
npm run dev
```

### Railway 배포
1. Railway 프로젝트 생성
2. GitHub 연동 또는 코드 배포
3. 환경변수 설정:
   - `ANTHROPIC_API_KEY`: Claude API 키
   - `PORT`: 3000 (자동 설정됨)

## API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/data/price-table` | GET | 단가테이블 조회 |
| `/api/data/quotes` | GET | 견적 목록 조회 |
| `/api/data/order-history` | GET | 발주실적 조회 |
| `/api/data/lme` | GET | LME 시황 조회 |
| `/api/recommend-price` | POST | 단가 추천 |
| `/api/validate-quote` | POST | 견적 검증 |
| `/api/market-analysis` | GET | 시황 분석 |
| `/api/analyze/price` | POST | AI 단가 분석 (SSE) |
| `/api/analyze/market` | POST | AI 시황 분석 (SSE) |

## 환경변수

| 변수명 | 설명 | 필수 |
|--------|------|------|
| `ANTHROPIC_API_KEY` | Claude API 키 | ✅ |
| `PORT` | 서버 포트 (기본: 3000) | ❌ |
