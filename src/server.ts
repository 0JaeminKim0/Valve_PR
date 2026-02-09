import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ========== 데이터 로드 ==========
const dataDir = path.join(__dirname, '../data');

interface PriceTableItem {
  valveType: string;
  valveTypeBase: string;
  bodyPrice: number;
  quantity: number;
  optionOP: number;
  optionIP: number;
  optionNP: number;
  optionLock: number;
  optionInd: number;
  optionLSW: number;
  optionExt: number;
  optionDiscSCS13: number;
  optionDiscSCS14: number;
  optionDiscSCS16: number;
  optionDiscNBC: number;
  description: string;
  spec: string;
  vendor: string;
}

interface QuoteItem {
  no: number;
  materialNo: string;
  materialCore: string;
  description: string;
  project: string;
  quantity: number;
  innerPaint: string;
  outerPaint: string;
  spec: string;
  quotePrice: number;
  unitPrice: number;
  weight: number;
  reviewComment: string;
}

interface OrderHistoryItem {
  materialNo: string;
  materialCore: string;
  description: string;
  vendor: string;
  orderDate: string;
  orderAmount: number;
  quantity: number;
  valveType: string;
}

interface BCOrderItem {
  prNo: string;
  materialNo: string;
  description: string;
  vendor: string;
  orderDate: string;
  orderAmount: number;
  quantity: number;
  valveType: string;
}

interface LMEDataItem {
  month: number;
  monthLabel: string;
  cuPricePerTon: number;
  snPricePerTon: number;
}

let priceTable: PriceTableItem[] = [];
let quoteData: QuoteItem[] = [];
let orderHistoryAll: OrderHistoryItem[] = [];
let orderHistoryBC: BCOrderItem[] = [];
let materialValveMap: Record<string, string> = {};
let lmeData: LMEDataItem[] = [];

function loadData() {
  try {
    priceTable = JSON.parse(fs.readFileSync(path.join(dataDir, 'price_table.json'), 'utf-8'));
    quoteData = JSON.parse(fs.readFileSync(path.join(dataDir, 'quote_sample.json'), 'utf-8'));
    orderHistoryAll = JSON.parse(fs.readFileSync(path.join(dataDir, 'order_history_all.json'), 'utf-8'));
    orderHistoryBC = JSON.parse(fs.readFileSync(path.join(dataDir, 'order_history_bc.json'), 'utf-8'));
    materialValveMap = JSON.parse(fs.readFileSync(path.join(dataDir, 'material_valve_map.json'), 'utf-8'));
    lmeData = JSON.parse(fs.readFileSync(path.join(dataDir, 'lme_data.json'), 'utf-8'));
    console.log(`✅ 데이터 로드 완료: 단가테이블 ${priceTable.length}건, 견적 ${quoteData.length}건, 실적 ${orderHistoryAll.length}건`);
  } catch (err) {
    console.error('❌ 데이터 로드 실패:', err);
  }
}

loadData();

// ========== 단가 계산 핵심 로직 ==========
const priceIndex: Record<string, PriceTableItem> = {};
priceTable.forEach(item => {
  if (!priceIndex[item.valveType]) {
    priceIndex[item.valveType] = item;
  }
});

const priceIndexBase: Record<string, PriceTableItem> = {};
priceTable.forEach(item => {
  if (!priceIndexBase[item.valveTypeBase]) {
    priceIndexBase[item.valveTypeBase] = item;
  }
});

function getBodyPrice(valveTypeBase: string, qty: number = 1): { unitPrice: number; totalPrice: number; tableQty: number } | null {
  // 먼저 정확한 키로 찾기
  let item = priceIndexBase[valveTypeBase];
  
  // 없으면 한 글자 더 제거해서 찾기 (VGBASW3A0A → VGBASW3A0)
  if (!item && valveTypeBase.length > 0) {
    item = priceIndexBase[valveTypeBase.slice(0, -1)];
  }
  
  // 그래도 없으면 priceIndex에서 찾기
  if (!item) {
    item = priceIndex[valveTypeBase];
  }
  
  if (!item) return null;
  const tableQty = item.quantity || 1;
  const unitPrice = tableQty > 0 ? item.bodyPrice / tableQty : item.bodyPrice;
  return { unitPrice, totalPrice: item.bodyPrice, tableQty };
}

function getOptions(valveTypeBase: string, description: string, innerPaint?: string, outerPaint?: string, spec?: string): { total: number; details: string[] } {
  // 먼저 정확한 키로 찾기
  let item = priceIndexBase[valveTypeBase];
  
  // 없으면 한 글자 더 제거해서 찾기
  if (!item && valveTypeBase.length > 0) {
    item = priceIndexBase[valveTypeBase.slice(0, -1)];
  }
  
  // 그래도 없으면 priceIndex에서 찾기
  if (!item) {
    item = priceIndex[valveTypeBase];
  }
  
  if (!item) return { total: 0, details: [] };
  
  let total = 0;
  const details: string[] = [];
  const used = new Set<string>();
  const desc = (description || '').toUpperCase();
  
  const keywordMap: [string, string[]][] = [
    ['I/O-P', ['optionIP', 'optionOP']],
    ['I/O-T', ['optionIP', 'optionOP']],
    ['LOCK', ['optionLock']],
    ['I-T', ['optionIP']],
    ['O-T', ['optionOP']],
    ['IND', ['optionInd']],
    ['L/SW', ['optionLSW']],
    ['EXT', ['optionExt']],
  ];
  
  for (const [keyword, cols] of keywordMap) {
    if (desc.includes(keyword)) {
      for (const col of cols) {
        const val = (item as any)[col] || 0;
        if (val > 0 && !used.has(col)) {
          details.push(`${keyword}=${val.toLocaleString()}`);
          total += val;
          used.add(col);
        }
      }
    }
  }
  
  if (innerPaint && !['N0', 'NO', ''].includes(innerPaint.trim().toUpperCase())) {
    const val = item.optionIP || 0;
    if (val > 0 && !used.has('optionIP')) {
      details.push(`내부도장=${val.toLocaleString()}`);
      total += val;
      used.add('optionIP');
    }
  }
  
  if (outerPaint && !['N0', 'NO', ''].includes(outerPaint.trim().toUpperCase())) {
    const val = item.optionOP || 0;
    if (val > 0 && !used.has('optionOP')) {
      details.push(`외부도장=${val.toLocaleString()}`);
      total += val;
      used.add('optionOP');
    }
  }
  
  if (spec) {
    const s = spec.toUpperCase();
    const discMap: [string, string][] = [
      ['SCS13', 'optionDiscSCS13'],
      ['SUS316', 'optionDiscSCS16'],
      ['SUS304', 'optionDiscSCS13'],
    ];
    for (const [keyword, col] of discMap) {
      if (s.includes(keyword)) {
        const val = (item as any)[col] || 0;
        if (val > 0 && !used.has(col)) {
          details.push(`DISC(${keyword})=${val.toLocaleString()}`);
          total += val;
          used.add(col);
        }
      }
    }
  }
  
  return { total, details };
}

// 과거 발주실적 검색 (1순위: 밸브타입+자재내역 100% 일치, 2순위: 밸브타입만 일치)
function getRecentOrders(valveType: string, description?: string): {
  rank1: { vendor: string; date: string; amount: number; quantity: number; materialNo: string } | null;
  rank2: { vendor: string; date: string; amount: number; quantity: number; materialNo: string } | null;
  matchCount: { total: number; rank1: number; rank2: number };
} {
  // 밸브타입 매핑 (끝자리 T/L 등 제외)
  const vtBase = valveType.slice(0, -1);  // VGBASW3A0AT → VGBASW3A0A
  
  // 1순위: 밸브타입(끝자리 제외) + 자재내역 100% 일치
  const descTrim = (description || '').trim().toUpperCase();
  const rank1Orders = orderHistoryAll.filter(o => {
    const ovt = o.valveType?.slice(0, -1) || '';
    const odesc = (o.description || '').trim().toUpperCase();
    return ovt === vtBase && odesc === descTrim;
  });
  
  // 2순위: 밸브타입(끝자리 제외)만 일치
  const rank2Orders = orderHistoryAll.filter(o => {
    const ovt = o.valveType?.slice(0, -1) || '';
    return ovt === vtBase;
  });
  
  // 최근 발주일 기준 정렬
  rank1Orders.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
  rank2Orders.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
  
  const rank1 = rank1Orders[0] ? {
    vendor: rank1Orders[0].vendor,
    date: rank1Orders[0].orderDate,
    amount: rank1Orders[0].orderAmount,
    quantity: rank1Orders[0].quantity || 1,
    materialNo: rank1Orders[0].materialNo,
  } : null;
  
  // 2순위는 1순위와 다른 건 중에서 선택 (중복 제거)
  const rank2Filtered = rank2Orders.filter(o => 
    !rank1 || o.materialNo !== rank1.materialNo || o.orderDate !== rank1.date
  );
  const rank2 = rank2Filtered[0] ? {
    vendor: rank2Filtered[0].vendor,
    date: rank2Filtered[0].orderDate,
    amount: rank2Filtered[0].orderAmount,
    quantity: rank2Filtered[0].quantity || 1,
    materialNo: rank2Filtered[0].materialNo,
  } : null;
  
  return {
    rank1,
    rank2,
    matchCount: {
      total: rank2Orders.length,
      rank1: rank1Orders.length,
      rank2: rank2Filtered.length,
    }
  };
}

// 레거시 함수 (호환성 유지)
function getRecentOrder(valveType: string, description?: string): { rank: string; vendor: string; date: string; amount: number } | null {
  const result = getRecentOrders(valveType, description);
  if (result.rank1) {
    return { rank: '1순위(타입+내역)', vendor: result.rank1.vendor, date: result.rank1.date, amount: result.rank1.amount };
  }
  if (result.rank2) {
    return { rank: '2순위(타입)', vendor: result.rank2.vendor, date: result.rank2.date, amount: result.rank2.amount };
  }
  return null;
}

// ========== Claude API ==========
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

async function callClaude(prompt: string, system?: string): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return '[API 키 미설정 - Railway 환경변수에 ANTHROPIC_API_KEY를 설정하세요]';
  }
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: system || '조선/해양 밸브 구매 분석 전문가입니다. 한국어로 간결하게 답변합니다.',
      messages: [{ role: 'user', content: prompt }],
    });
    
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text : '';
  } catch (err) {
    console.error('Claude API 오류:', err);
    return '[API 오류]';
  }
}

// ========== API 엔드포인트 ==========

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    data: {
      priceTable: priceTable.length,
      quotes: quoteData.length,
      orders: orderHistoryAll.length,
      bcOrders: orderHistoryBC.length,
      lme: lmeData.length
    }
  });
});

app.get('/api/data/price-table', (req, res) => {
  res.json(priceTable.slice(0, 100));
});

app.get('/api/price-table', (req, res) => {
  res.json({ success: true, data: priceTable });
});

app.get('/api/data/quotes', (req, res) => {
  res.json(quoteData);
});

app.get('/api/quotes', (req, res) => {
  res.json({ success: true, data: quoteData });
});

app.get('/api/data/lme', (req, res) => {
  res.json(lmeData);
});

app.get('/api/data/bc-orders', (req, res) => {
  res.json(orderHistoryBC);
});

// ========== 프론트엔드 호환 API ==========

// 화면 1: 최적 단가 추천 (프론트엔드용)
app.post('/api/analyze/price-recommendation', async (req, res) => {
  try {
    const { valveType, quantity = 10 } = req.body;
    
    if (!valveType) {
      return res.status(400).json({ success: false, error: '밸브타입이 필요합니다' });
    }
    
    const valveTypeBase = valveType.slice(0, -1);
    const bodyResult = getBodyPrice(valveTypeBase, quantity);
    const optionResult = getOptions(valveTypeBase, '', '', '', '');
    const contractPrice = bodyResult ? bodyResult.unitPrice + optionResult.total : null;
    
    const recentOrder = getRecentOrder(valveType);
    const recentPrice = recentOrder?.amount || null;
    const recent90 = recentPrice ? recentPrice * 0.9 : null;
    
    let recommendedPrice = null;
    if (contractPrice && recentPrice) {
      recommendedPrice = Math.min(contractPrice, recentPrice);
    } else if (recent90) {
      recommendedPrice = recent90;
    } else if (contractPrice) {
      recommendedPrice = contractPrice;
    }
    
    // 최근 발주 평균 계산
    const relatedOrders = orderHistoryAll.filter(o => o.valveType === valveType);
    const recentOrderAvg = relatedOrders.length > 0 
      ? relatedOrders.reduce((sum, o) => sum + (o.orderAmount || 0), 0) / relatedOrders.length
      : null;
    
    const pricePerKg = bodyResult?.tableQty ? (recommendedPrice || 0) / bodyResult.tableQty * quantity : null;
    
    // AI 분석
    let aiAnalysis = '';
    if (process.env.ANTHROPIC_API_KEY) {
      const prompt = `밸브타입 ${valveType} 분석:\n- 계약단가: ${contractPrice?.toLocaleString() || '없음'}원\n- 최근발주: ${recentPrice?.toLocaleString() || '없음'}원\n- 추천단가: ${recommendedPrice?.toLocaleString() || '없음'}원\n\n구매 담당자에게 이 단가의 적정성과 협상 전략을 1-2문장으로 조언해주세요.`;
      aiAnalysis = await callClaude(prompt);
    } else {
      aiAnalysis = `${valveType} 타입의 추천 단가는 ${recommendedPrice?.toLocaleString() || '미정'}원입니다. ${contractPrice && recentPrice ? (contractPrice <= recentPrice ? '계약단가 기준이 유리합니다.' : '과거 발주실적 기준이 유리합니다.') : '데이터 기준 추천입니다.'}`;
    }
    
    res.json({
      success: true,
      data: {
        valveType,
        valveTypeBase,
        quantity,
        bodyPrice: bodyResult?.unitPrice || null,
        optionPrice: optionResult.total,
        optionDetails: optionResult.details,
        contractPrice,
        recentOrderInfo: recentOrder,
        recentOrderAvg,
        recommendedPrice,
        pricePerKg,
        aiAnalysis,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// 화면 2: 견적 검증 (프론트엔드용)
app.post('/api/analyze/quote-verification', async (req, res) => {
  try {
    const { quoteIndex } = req.body;
    
    if (quoteIndex === undefined || quoteIndex < 0 || quoteIndex >= quoteData.length) {
      return res.status(400).json({ success: false, error: '유효하지 않은 견적 인덱스' });
    }
    
    const quote = quoteData[quoteIndex];
    const valveType = materialValveMap[quote.materialCore] || '';
    const valveTypeBase = valveType.slice(0, -1);
    
    const bodyResult = getBodyPrice(valveTypeBase);
    const optionResult = getOptions(valveTypeBase, quote.description, quote.innerPaint, quote.outerPaint, quote.spec);
    const systemPrice = bodyResult ? bodyResult.unitPrice + optionResult.total : null;
    
    const recentOrder = getRecentOrder(valveType, quote.description);
    const recentOrderPrice = recentOrder?.amount || null;
    const targetPrice = recentOrderPrice ? recentOrderPrice * 0.9 : null;
    
    // 관련 발주 건수
    const relatedOrders = orderHistoryAll.filter(o => o.valveType === valveType).length;
    
    // 판정
    let verdict = '보통';
    if (targetPrice && targetPrice >= quote.quotePrice) {
      verdict = '우수';
    } else if ((recentOrderPrice && recentOrderPrice >= quote.quotePrice) || (systemPrice && systemPrice >= quote.quotePrice)) {
      verdict = '보통';
    } else if (recentOrderPrice || systemPrice) {
      verdict = '부적절';
    }
    
    // 괴리율 계산
    const diffRate = recentOrderPrice ? ((quote.quotePrice - recentOrderPrice) / recentOrderPrice) * 100 : null;
    
    // AI 분석
    let aiAnalysis = '';
    if (process.env.ANTHROPIC_API_KEY) {
      const prompt = `견적 검증 결과:\n- 자재번호: ${quote.materialNo}\n- 협력사 견적: ${quote.quotePrice?.toLocaleString()}원\n- 시스템 추천: ${systemPrice?.toLocaleString() || '없음'}원\n- 최근 발주: ${recentOrderPrice?.toLocaleString() || '없음'}원\n- 판정: ${verdict}\n- 괴리율: ${diffRate?.toFixed(1) || '-'}%\n\n${verdict === '부적절' ? '협상 전략을' : '검토 의견을'} 1-2문장으로 제시해주세요.`;
      aiAnalysis = await callClaude(prompt);
    } else {
      aiAnalysis = verdict === '우수' 
        ? '견적가가 발주단가×90% 이하로 우수합니다. 즉시 발주를 권장합니다.'
        : verdict === '부적절'
          ? `견적가가 기준 대비 ${diffRate?.toFixed(1)}% 높습니다. 단가 재협상이 필요합니다.`
          : '견적가가 적정 범위 내입니다. 추가 검토 후 진행 권장합니다.';
    }
    
    res.json({
      success: true,
      data: {
        materialNo: quote.materialNo,
        valveType,
        description: quote.description,
        quotePrice: quote.quotePrice,
        systemPrice,
        recentOrderPrice,
        targetPrice,
        relatedOrders,
        verdict,
        diffRate,
        aiAnalysis,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// 화면 3: 시황 분석 (프론트엔드용)
app.post('/api/analyze/market-trend', async (req, res) => {
  try {
    const { valveType = 'VGBARR240AT' } = req.body;
    
    // BC 밸브 필터링 (LOCK 제외, TR 포함)
    const bcFiltered = orderHistoryBC.filter(o => {
      const desc = o.description || '';
      return !desc.includes('LOCK') && desc.trim().endsWith('TR');
    });
    
    // 월별 집계
    const monthlyData: Record<number, { sum: number; count: number; orders: number }> = {};
    for (const order of bcFiltered) {
      const month = parseInt(order.orderDate?.split('-')[1] || '0');
      if (month === 0) continue;
      
      const unitPrice = order.quantity > 0 ? order.orderAmount / order.quantity : 0;
      if (!monthlyData[month]) monthlyData[month] = { sum: 0, count: 0, orders: 0 };
      monthlyData[month].sum += unitPrice;
      monthlyData[month].count++;
      monthlyData[month].orders++;
    }
    
    // 기준값 (1월)
    const baseMonth = lmeData.find(d => d.month === 1);
    const cuBase = baseMonth?.cuPricePerTon || 1;
    const snBase = baseMonth?.snPricePerTon || 1;
    const orderBase = monthlyData[1]?.count > 0 ? monthlyData[1].sum / monthlyData[1].count : 1;
    
    // 월별 데이터 구성
    const chartData = [];
    let prevCuSn: number | null = null;
    let prevOrder: number | null = null;
    const assessments: Record<number, string> = {};
    
    for (let month = 1; month <= 12; month++) {
      const lme = lmeData.find(d => d.month === month);
      if (!lme) continue;
      
      const cuIndex = (lme.cuPricePerTon / cuBase) * 100;
      const snIndex = (lme.snPricePerTon / snBase) * 100;
      const cuSnIndex = cuIndex * 0.88 + snIndex * 0.12;
      
      let orderIndex: number | null = null;
      if (monthlyData[month]?.count > 0) {
        const avg = monthlyData[month].sum / monthlyData[month].count;
        orderIndex = (avg / orderBase) * 100;
      }
      
      // 적정성 판정
      if (prevCuSn !== null && prevOrder !== null && orderIndex !== null) {
        const priceChange = orderIndex - prevOrder;
        const marketChange = cuSnIndex - prevCuSn;
        
        const priceTrend = Math.abs(priceChange) <= 2 ? '유지' : priceChange > 0 ? '상승' : '하락';
        const marketTrend = Math.abs(marketChange) <= 2 ? '유지' : marketChange > 0 ? '상승' : '하락';
        
        const matrix: Record<string, Record<string, string>> = {
          '유지': { '유지': 'Normal', '하락': 'Bad', '상승': 'Good' },
          '상승': { '유지': 'Bad', '하락': 'Bad', '상승': 'Normal' },
          '하락': { '유지': 'Good', '하락': 'Bad', '상승': 'Good' },
        };
        assessments[month] = matrix[priceTrend]?.[marketTrend] || 'Normal';
      }
      
      prevCuSn = cuSnIndex;
      prevOrder = orderIndex;
      
      chartData.push({
        month: `${month}월`,
        cuSnIndex: Math.round(cuSnIndex * 10) / 10,
        orderIndex: orderIndex ? Math.round(orderIndex * 10) / 10 : null,
        orders: monthlyData[month]?.orders || 0,
      });
    }
    
    // 전체 적정성
    const assessCounts = { Good: 0, Normal: 0, Bad: 0 };
    Object.values(assessments).forEach(a => assessCounts[a as keyof typeof assessCounts]++);
    const overallAssessment = assessCounts.Good >= assessCounts.Bad ? (assessCounts.Good > assessCounts.Normal ? 'Good' : 'Normal') : 'Bad';
    
    // AI 분석
    let aiAnalysis = '';
    if (process.env.ANTHROPIC_API_KEY) {
      const badMonths = Object.entries(assessments).filter(([_, v]) => v === 'Bad').map(([k]) => `${k}월`);
      const prompt = `BC밸브 ${valveType} 시황 분석:\n- 분석 건수: ${bcFiltered.length}건\n- 적정성 판정: Good ${assessCounts.Good}, Normal ${assessCounts.Normal}, Bad ${assessCounts.Bad}\n- Bad 월: ${badMonths.join(', ') || '없음'}\n\n시황 대비 단가 트렌드 분석과 향후 구매 전략을 2-3문장으로 제시해주세요.`;
      aiAnalysis = await callClaude(prompt);
    } else {
      aiAnalysis = `${valveType} 타입 ${bcFiltered.length}건 분석 결과, ${overallAssessment === 'Good' ? '시황 대비 단가가 적정하게 관리되고 있습니다.' : overallAssessment === 'Bad' ? '시황 대비 단가 상승이 과다합니다. 협상이 필요합니다.' : '전반적으로 적정 수준입니다.'}`;
    }
    
    res.json({
      success: true,
      data: {
        valveType,
        totalOrders: bcFiltered.length,
        monthlyData: chartData,
        assessments,
        overallAssessment,
        aiAnalysis,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

// ========== 화면 1: PR 최적 단가 제안 ==========
app.post('/api/screen1/analyze', async (req, res) => {
  try {
    let { items } = req.body;
    
    // items가 없으면 Python 코드처럼 자동으로 PR 샘플 선택
    // 매핑되는 것 7건 + 미매핑 3건 = 총 10건
    if (!items || items.length === 0) {
      // 단가테이블에 매핑되는 밸브타입 찾기
      // 발주실적 밸브타입(예: VGBASW3A0AT)에서 끝 2자리 제거 → 단가테이블 베이스(VGBASW3A0)
      const mappedBases = new Set(priceTable.map(p => p.valveTypeBase));
      const mappedTypes = new Set(priceTable.map(p => p.valveType));
      
      // 매핑 체크 함수 (끝 1~2자리 제거해서 확인)
      const isMapped = (vt: string) => {
        if (!vt) return false;
        const base1 = vt.slice(0, -1);  // VGBASW3A0A
        const base2 = vt.slice(0, -2);  // VGBASW3A0
        return mappedTypes.has(base1) || mappedBases.has(base1) || mappedBases.has(base2);
      };
      
      // 매핑되는 PR 샘플 (최근 발주일 기준 정렬)
      const mappedOrders = orderHistoryAll
        .filter(o => o.valveType && isMapped(o.valveType))
        .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
      
      // 중복 제거 (밸브타입 기준)
      const seenTypes = new Set<string>();
      const uniqueMapped: typeof mappedOrders = [];
      for (const o of mappedOrders) {
        if (!seenTypes.has(o.valveType)) {
          seenTypes.add(o.valveType);
          uniqueMapped.push(o);
          if (uniqueMapped.length >= 7) break;
        }
      }
      
      // 미매핑되는 PR 샘플
      const unmappedOrders = orderHistoryAll
        .filter(o => o.valveType && !isMapped(o.valveType))
        .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
      
      const seenUnmapped = new Set<string>();
      const uniqueUnmapped: typeof unmappedOrders = [];
      for (const o of unmappedOrders) {
        if (!seenUnmapped.has(o.valveType)) {
          seenUnmapped.add(o.valveType);
          uniqueUnmapped.push(o);
          if (uniqueUnmapped.length >= 3) break;
        }
      }
      
      items = [...uniqueMapped, ...uniqueUnmapped].map(o => ({
        valveType: o.valveType,
        description: o.description,
        quantity: o.quantity || 1,
        materialCore: o.materialCore,
      }));
    }
    
    const results = [];
    for (const pr of items || []) {
      const valveType = pr.valveType || materialValveMap[pr.materialCore] || '';
      const valveTypeBase = valveType.slice(0, -1);
      const description = pr.description || '';
      
      const bodyResult = getBodyPrice(valveTypeBase);
      const optionResult = getOptions(valveTypeBase, description, pr.innerPaint, pr.outerPaint, pr.spec);
      const contractPrice = bodyResult ? bodyResult.unitPrice + optionResult.total : null;
      
      const recentOrder = getRecentOrder(valveType, description);
      const recentPrice = recentOrder?.amount || null;
      const recent90 = recentPrice ? recentPrice * 0.9 : null;
      
      let recommendedPrice = null;
      let recommendReason = '';
      if (contractPrice && recentPrice) {
        recommendedPrice = Math.min(contractPrice, recentPrice);
        recommendReason = contractPrice <= recentPrice ? '계약단가 기준' : '발주실적 기준';
      } else if (recentPrice) {
        recommendedPrice = recent90;
        recommendReason = '발주×90% (단가테이블 미매핑)';
      } else if (contractPrice) {
        recommendedPrice = contractPrice;
        recommendReason = '계약단가 (실적 없음)';
      }
      
      results.push({
        valveType,
        valveTypeBase,
        description: description.slice(0, 60),
        quantity: pr.quantity || 1,
        tableQty: bodyResult?.tableQty || null,
        bodyPrice: bodyResult?.unitPrice || null,
        optionPrice: optionResult.total,
        optionDetails: optionResult.details,
        contractPrice,
        recentOrder,
        recentPrice,
        recent90,
        recommendedPrice,
        recommendReason,
        mapped: !!bodyResult,
      });
    }
    
    res.json({ success: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/screen1/llm-analyze', async (req, res) => {
  const { results } = req.body;
  
  const summary = results.map((r: any) => 
    `${r.valveType}: 계약=${r.contractPrice?.toLocaleString() || '없음'}, 발주=${r.recentPrice?.toLocaleString() || '없음'}, 추천=${r.recommendedPrice?.toLocaleString() || '없음'}`
  ).join('\n');
  
  const prompt = `PR 건별 단가 분석 결과입니다. 각 건별로 추천 단가와 근거를 1줄로 요약해주세요.\n\n${summary}`;
  
  const analysis = await callClaude(prompt);
  res.json({ success: true, analysis });
});

// ========== 화면 2: 협력사 견적 적정성 검증 ==========
app.post('/api/screen2/verify', async (req, res) => {
  try {
    const results = [];
    let counts = { excellent: 0, normal: 0, inadequate: 0 };
    
    for (const quote of quoteData) {
      const valveType = materialValveMap[quote.materialCore] || '';
      const valveTypeBase = valveType.slice(0, -1);
      
      const bodyResult = getBodyPrice(valveTypeBase);
      const optionResult = getOptions(valveTypeBase, quote.description, quote.innerPaint, quote.outerPaint, quote.spec);
      const contractPrice = bodyResult ? bodyResult.unitPrice + optionResult.total : null;
      
      const recentOrder = getRecentOrder(valveType, quote.description);
      const recentPrice = recentOrder?.amount || null;
      const recent90 = recentPrice ? recentPrice * 0.9 : null;
      
      let assessment: 'excellent' | 'normal' | 'inadequate';
      let assessmentLabel: string;
      
      if (recent90 && recent90 >= quote.quotePrice) {
        assessment = 'excellent';
        assessmentLabel = '✅ 우수';
        counts.excellent++;
      } else if ((recentPrice && recentPrice >= quote.quotePrice) || (contractPrice && contractPrice >= quote.quotePrice)) {
        assessment = 'normal';
        assessmentLabel = '🔶 보통';
        counts.normal++;
      } else if (recentPrice || contractPrice) {
        assessment = 'inadequate';
        assessmentLabel = '❌ 부적절';
        counts.inadequate++;
      } else {
        assessment = 'normal';
        assessmentLabel = '🔶 보통 (기준 없음)';
        counts.normal++;
      }
      
      const gapPercent = recentPrice ? ((quote.quotePrice - recentPrice) / recentPrice * 100) : null;
      
      results.push({
        no: quote.no,
        materialNo: quote.materialNo,
        valveType,
        description: quote.description.slice(0, 50),
        quotePrice: quote.quotePrice,
        contractPrice,
        recentPrice,
        recent90,
        optionDetails: optionResult.details,
        assessment,
        assessmentLabel,
        gapPercent,
        reviewComment: quote.reviewComment,
      });
    }
    
    res.json({ success: true, results, counts, total: quoteData.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/screen2/llm-analyze', async (req, res) => {
  const { counts, inadequateItems } = req.body;
  
  const badSummary = inadequateItems?.map((r: any) => 
    `${r.materialNo}: 견적=${r.quotePrice?.toLocaleString()}, 발주=${r.recentPrice?.toLocaleString()}, 괴리=${r.gapPercent?.toFixed(1)}%`
  ).join('\n') || '없음';
  
  const prompt = `협력사 견적 적정성 검증 결과입니다.
분포: 우수 ${counts.excellent}건, 보통 ${counts.normal}건, 부적절 ${counts.inadequate}건

부적절 항목:
${badSummary}

부적절 원인과 협상 전략을 제시해주세요.`;
  
  const analysis = await callClaude(prompt);
  res.json({ success: true, analysis });
});

// ========== 화면 3: 시황 분석 ==========
app.get('/api/screen3/trend', async (req, res) => {
  try {
    const bcFiltered = orderHistoryBC.filter(o => {
      const desc = o.description || '';
      return !desc.includes('LOCK') && desc.trim().endsWith('TR');
    });
    
    const monthlyData: Record<string, Record<string, { sum: number; count: number }>> = {};
    
    for (const order of bcFiltered) {
      const month = parseInt(order.orderDate.split('-')[1]) || 0;
      if (month === 0) continue;
      
      const vendor = order.vendor;
      const unitPrice = order.quantity > 0 ? order.orderAmount / order.quantity : 0;
      
      if (!monthlyData[month]) monthlyData[month] = {};
      if (!monthlyData[month][vendor]) monthlyData[month][vendor] = { sum: 0, count: 0 };
      
      monthlyData[month][vendor].sum += unitPrice;
      monthlyData[month][vendor].count++;
    }
    
    const baseMonth = lmeData.find(d => d.month === 1);
    const cuBase = baseMonth?.cuPricePerTon || 1;
    const snBase = baseMonth?.snPricePerTon || 1;
    
    const vendorBase: Record<string, number> = {};
    const vendors = [...new Set(bcFiltered.map(o => o.vendor))];
    
    for (const vendor of vendors) {
      if (monthlyData[1]?.[vendor]) {
        vendorBase[vendor] = monthlyData[1][vendor].sum / monthlyData[1][vendor].count;
      } else {
        for (let m = 1; m <= 12; m++) {
          if (monthlyData[m]?.[vendor]) {
            vendorBase[vendor] = monthlyData[m][vendor].sum / monthlyData[m][vendor].count;
            break;
          }
        }
      }
    }
    
    const trendData = [];
    const assessments: Record<number, string> = {};
    
    let prevCuSn: number | null = null;
    let prevMainVendor: number | null = null;
    const mainVendor = '원광밸브주식회사';
    
    for (let month = 1; month <= 12; month++) {
      const lme = lmeData.find(d => d.month === month);
      if (!lme) continue;
      
      const cuIndex = (lme.cuPricePerTon / cuBase) * 100;
      const snIndex = (lme.snPricePerTon / snBase) * 100;
      const cuSnIndex = cuIndex * 0.88 + snIndex * 0.12;
      
      const vendorIndices: Record<string, number | null> = {};
      for (const vendor of vendors) {
        if (monthlyData[month]?.[vendor] && vendorBase[vendor]) {
          const avg = monthlyData[month][vendor].sum / monthlyData[month][vendor].count;
          vendorIndices[vendor] = (avg / vendorBase[vendor]) * 100;
        } else {
          vendorIndices[vendor] = null;
        }
      }
      
      const mainIndex = vendorIndices[mainVendor];
      let gap: number | null = null;
      if (mainIndex !== null) {
        const expected = 100 + (cuSnIndex - 100) * 0.8;
        gap = mainIndex - expected;
      }
      
      if (prevCuSn !== null && prevMainVendor !== null && mainIndex !== null) {
        const priceChange = mainIndex - prevMainVendor;
        const marketChange = cuSnIndex - prevCuSn;
        
        const priceTrend = Math.abs(priceChange) <= 2 ? '유지' : priceChange > 0 ? '상승' : '하락';
        const marketTrend = Math.abs(marketChange) <= 2 ? '유지' : marketChange > 0 ? '상승' : '하락';
        
        const matrix: Record<string, Record<string, string>> = {
          '유지': { '유지': 'Normal', '하락': 'Bad', '상승': 'Good' },
          '상승': { '유지': 'Bad', '하락': 'Bad', '상승': 'Normal' },
          '하락': { '유지': 'Good', '하락': 'Bad', '상승': 'Good' },
        };
        
        assessments[month] = matrix[priceTrend]?.[marketTrend] || 'Normal';
      }
      
      prevCuSn = cuSnIndex;
      prevMainVendor = mainIndex;
      
      trendData.push({
        month,
        monthLabel: `${month}월`,
        cuIndex: Math.round(cuIndex * 10) / 10,
        snIndex: Math.round(snIndex * 10) / 10,
        cuSnIndex: Math.round(cuSnIndex * 10) / 10,
        vendorIndices,
        gap: gap !== null ? Math.round(gap * 10) / 10 : null,
      });
    }
    
    const yearEnd = lmeData.find(d => d.month === 12);
    const cuYearChange = yearEnd ? ((yearEnd.cuPricePerTon / cuBase) - 1) * 100 : 0;
    const snYearChange = yearEnd ? ((yearEnd.snPricePerTon / snBase) - 1) * 100 : 0;
    
    const assessmentCounts = { Good: 0, Normal: 0, Bad: 0 };
    Object.values(assessments).forEach(a => {
      assessmentCounts[a as keyof typeof assessmentCounts]++;
    });
    
    res.json({
      success: true,
      trendData,
      assessments,
      assessmentCounts,
      summary: {
        cuYearChange: Math.round(cuYearChange),
        snYearChange: Math.round(snYearChange),
        totalOrders: bcFiltered.length,
        vendors,
      },
      lmeData,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post('/api/screen3/llm-analyze', async (req, res) => {
  const { summary, assessmentCounts, assessments } = req.body;
  
  const badMonths = Object.entries(assessments || {})
    .filter(([_, v]) => v === 'Bad')
    .map(([k, _]) => `${k}월`);
  
  const prompt = `BC밸브 시황 분석 결과입니다.
- Cu 연간: +${summary.cuYearChange}%, Sn 연간: +${summary.snYearChange}%
- 판정: Good ${assessmentCounts.Good}, Normal ${assessmentCounts.Normal}, Bad ${assessmentCounts.Bad}
- Bad 월: ${badMonths.join(', ') || '없음'}

업체 행동 패턴과 구매 전략을 제시해주세요.`;
  
  const analysis = await callClaude(prompt);
  res.json({ success: true, analysis });
});

// SPA 폴백
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Valve Agent PoC 서버 시작: http://localhost:${PORT}`);
});
