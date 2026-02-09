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
  const item = priceIndexBase[valveTypeBase];
  if (!item) return null;
  const tableQty = item.quantity || 1;
  const unitPrice = tableQty > 0 ? item.bodyPrice / tableQty : item.bodyPrice;
  return { unitPrice, totalPrice: item.bodyPrice, tableQty };
}

function getOptions(valveTypeBase: string, description: string, innerPaint?: string, outerPaint?: string, spec?: string): { total: number; details: string[] } {
  const item = priceIndexBase[valveTypeBase];
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

function getRecentOrder(valveType: string, description?: string): { rank: string; vendor: string; date: string; amount: number } | null {
  const orders = orderHistoryAll.filter(o => o.valveType === valveType);
  if (orders.length === 0) return null;
  
  orders.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
  
  if (description) {
    const descTrim = description.trim();
    const match = orders.find(o => o.description.trim() === descTrim);
    if (match) {
      return { rank: '1순위(타입+내역)', vendor: match.vendor, date: match.orderDate, amount: match.orderAmount };
    }
  }
  
  const latest = orders[0];
  return { rank: '2순위(타입)', vendor: latest.vendor, date: latest.orderDate, amount: latest.orderAmount };
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

app.get('/api/data/quotes', (req, res) => {
  res.json(quoteData);
});

app.get('/api/data/lme', (req, res) => {
  res.json(lmeData);
});

app.get('/api/data/bc-orders', (req, res) => {
  res.json(orderHistoryBC);
});

// ========== 화면 1: PR 최적 단가 제안 ==========
app.post('/api/screen1/analyze', async (req, res) => {
  try {
    const { items } = req.body;
    
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
