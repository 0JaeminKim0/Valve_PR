import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

// 데이터 로드
const dataDir = join(process.cwd(), 'data');
const priceTable = JSON.parse(readFileSync(join(dataDir, 'price_table.json'), 'utf-8'));
const quoteSample = JSON.parse(readFileSync(join(dataDir, 'quote_sample.json'), 'utf-8'));
const orderHistory = JSON.parse(readFileSync(join(dataDir, 'order_history.json'), 'utf-8'));
const lmeData = JSON.parse(readFileSync(join(dataDir, 'lme_data.json'), 'utf-8'));

const app = new Hono();

// CORS 설정
app.use('/*', cors());

// Claude API 클라이언트
const getAnthropicClient = () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  return new Anthropic({ apiKey });
};

// ============================================
// API 엔드포인트
// ============================================

// 데이터 API
app.get('/api/data/price-table', (c) => c.json(priceTable));
app.get('/api/data/quotes', (c) => c.json(quoteSample));
app.get('/api/data/order-history', (c) => c.json(orderHistory));
app.get('/api/data/lme', (c) => c.json(lmeData));

// 화면1: 단가 추천 API
app.post('/api/recommend-price', async (c) => {
  const { valveType, description, options } = await c.req.json();
  
  // Rule 1: 밸브타입 매핑 (끝자리 제거)
  const baseType = valveType?.slice(0, -1) || '';
  const matchedPrices = priceTable.filter((p: any) => p.valveTypeBase === baseType);
  
  if (matchedPrices.length === 0) {
    return c.json({ success: false, message: '매핑된 단가 테이블 없음' });
  }
  
  const matched = matchedPrices[0];
  let totalPrice = matched.bodyPrice;
  const breakdown: any = { bodyPrice: matched.bodyPrice };
  
  // Rule 2: 옵션 단가 추가
  if (options?.includes('O-P') || description?.includes('O-P')) {
    totalPrice += matched.optionOP;
    breakdown.optionOP = matched.optionOP;
  }
  if (options?.includes('I-P') || description?.includes('I-P') || description?.includes('I-T')) {
    totalPrice += matched.optionIP;
    breakdown.optionIP = matched.optionIP;
  }
  if (options?.includes('LOCK') || description?.includes('LOCK')) {
    totalPrice += matched.optionLock;
    breakdown.optionLock = matched.optionLock;
  }
  if (description?.includes('DISC') && description?.includes('SCS16')) {
    totalPrice += matched.optionDiscSCS16;
    breakdown.optionDiscSCS16 = matched.optionDiscSCS16;
  }
  
  return c.json({
    success: true,
    valveType,
    baseType,
    matched: {
      valveType: matched.valveType,
      product: matched.product,
      size: matched.size,
      pressure: matched.pressure,
    },
    breakdown,
    totalPrice,
    rules: ['Rule1: 밸브타입 매핑', 'Rule2: 옵션단가 적용']
  });
});

// 화면2: 견적 검증 API
app.post('/api/validate-quote', async (c) => {
  const { quoteId } = await c.req.json();
  
  const quote = quoteSample.find((q: any) => q.no === quoteId);
  if (!quote) {
    return c.json({ success: false, message: '견적을 찾을 수 없습니다' });
  }
  
  // 발주실적에서 유사 건 찾기
  const relatedOrders = orderHistory.filter((o: any) => 
    o.description?.includes(quote.description?.split(' ')[0])
  ).slice(0, 5);
  
  // 최근 발주단가 계산
  const recentOrderAmount = relatedOrders.length > 0 
    ? relatedOrders.reduce((sum: number, o: any) => sum + o.orderAmount, 0) / relatedOrders.length 
    : quote.unitPrice;
  
  // 90% 기준 (발주단가의 90%)
  const threshold90 = recentOrderAmount * 0.9;
  
  // 판정
  let verdict: 'excellent' | 'normal' | 'poor';
  let verdictLabel: string;
  
  if (quote.quotePrice <= threshold90) {
    verdict = 'excellent';
    verdictLabel = '우수';
  } else if (quote.quotePrice <= recentOrderAmount) {
    verdict = 'normal';
    verdictLabel = '보통';
  } else {
    verdict = 'poor';
    verdictLabel = '부적절';
  }
  
  const diffPercent = ((quote.quotePrice - recentOrderAmount) / recentOrderAmount * 100).toFixed(1);
  
  return c.json({
    success: true,
    quote,
    analysis: {
      recentOrderAmount: Math.round(recentOrderAmount),
      threshold90: Math.round(threshold90),
      quotePrice: quote.quotePrice,
      diffPercent,
      verdict,
      verdictLabel,
      relatedOrderCount: relatedOrders.length
    }
  });
});

// 화면3: 시황 분석 API
app.get('/api/market-analysis', (c) => {
  // 월별 발주 데이터 집계
  const monthlyOrders: any = {};
  const vendorMonthly: any = { '원광밸브주식회사': {}, '주식회사 금강': {} };
  
  orderHistory.forEach((order: any) => {
    const month = parseInt(order.orderDate?.split('-')[1] || '0');
    if (month > 0 && month <= 12) {
      if (!monthlyOrders[month]) {
        monthlyOrders[month] = { total: 0, count: 0, amounts: [] };
      }
      monthlyOrders[month].total += order.orderAmount;
      monthlyOrders[month].count += 1;
      monthlyOrders[month].amounts.push(order.orderAmount);
      
      // 업체별
      if (vendorMonthly[order.vendor]) {
        if (!vendorMonthly[order.vendor][month]) {
          vendorMonthly[order.vendor][month] = { total: 0, count: 0 };
        }
        vendorMonthly[order.vendor][month].total += order.orderAmount;
        vendorMonthly[order.vendor][month].count += 1;
      }
    }
  });
  
  // 지수 계산 (1월 = 100 기준)
  const jan = lmeData.find((d: any) => d.month === 1);
  const janCu = jan?.cuPricePerTon || 1;
  const janSn = jan?.snPricePerTon || 1;
  
  const lmeIndexes = lmeData.map((d: any) => {
    const cuIndex = (d.cuPricePerTon / janCu) * 100;
    const snIndex = (d.snPricePerTon / janSn) * 100;
    // Bronze = Cu 88% + Sn 12%
    const weightedIndex = cuIndex * 0.88 + snIndex * 0.12;
    return {
      month: d.month,
      monthLabel: d.monthLabel,
      cuIndex: Math.round(cuIndex * 10) / 10,
      snIndex: Math.round(snIndex * 10) / 10,
      weightedIndex: Math.round(weightedIndex * 10) / 10,
      cuPrice: d.cuPricePerTon,
      snPrice: d.snPricePerTon
    };
  });
  
  // 발주단가 지수 (1월 기준)
  const janOrder = monthlyOrders[1];
  const janAvg = janOrder ? janOrder.total / janOrder.count : 1;
  
  const orderIndexes = Object.entries(monthlyOrders).map(([month, data]: [string, any]) => {
    const avg = data.total / data.count;
    return {
      month: parseInt(month),
      avgAmount: Math.round(avg),
      count: data.count,
      index: Math.round((avg / janAvg) * 1000) / 10
    };
  }).sort((a, b) => a.month - b.month);
  
  // 업체별 지수
  const vendorIndexes: any = {};
  Object.entries(vendorMonthly).forEach(([vendor, months]: [string, any]) => {
    const janVendor = months[1];
    const janVendorAvg = janVendor ? janVendor.total / janVendor.count : null;
    
    if (janVendorAvg) {
      vendorIndexes[vendor] = Object.entries(months).map(([month, data]: [string, any]) => {
        const avg = data.total / data.count;
        return {
          month: parseInt(month),
          index: Math.round((avg / janVendorAvg) * 1000) / 10,
          count: data.count
        };
      }).sort((a: any, b: any) => a.month - b.month);
    }
  });
  
  // 월별 적정성 판정
  const monthlyAssessment = lmeIndexes.map((lme: any) => {
    const orderData = orderIndexes.find((o: any) => o.month === lme.month);
    if (!orderData) return null;
    
    // 기대 지수 = 시황 변동 × 원재료 비중 80%
    const expectedIndex = 100 + (lme.weightedIndex - 100) * 0.8;
    const gap = orderData.index - expectedIndex;
    
    let verdict: string;
    if (gap < -5) verdict = 'Good';
    else if (gap > 5) verdict = 'Bad';
    else verdict = 'Normal';
    
    return {
      month: lme.month,
      monthLabel: lme.monthLabel,
      lmeIndex: lme.weightedIndex,
      orderIndex: orderData.index,
      expectedIndex: Math.round(expectedIndex * 10) / 10,
      gap: Math.round(gap * 10) / 10,
      verdict
    };
  }).filter(Boolean);
  
  return c.json({
    success: true,
    lmeData,
    lmeIndexes,
    orderIndexes,
    vendorIndexes,
    monthlyAssessment,
    summary: {
      totalOrders: orderHistory.length,
      cuChangeYTD: `+${Math.round((lmeIndexes[11]?.cuIndex || 100) - 100)}%`,
      snChangeYTD: `+${Math.round((lmeIndexes[11]?.snIndex || 100) - 100)}%`,
    }
  });
});

// Claude API 스트리밍 - 단가 분석
app.post('/api/analyze/price', async (c) => {
  const { quote, priceData, orderData } = await c.req.json();
  
  const anthropic = getAnthropicClient();
  
  const systemPrompt = `당신은 밸브재 구매 전문 AI Agent입니다. 
주어진 데이터를 분석하여 최적 단가를 제안하고, 견적의 적정성을 판단합니다.
한국어로 응답하며, 분석 과정을 단계별로 상세히 설명합니다.
금액은 원화(₩)로 표시하고, 천 단위 콤마를 사용합니다.`;

  const userPrompt = `## 분석 요청
견적 정보:
${JSON.stringify(quote, null, 2)}

단가 테이블 매핑 결과:
${JSON.stringify(priceData, null, 2)}

관련 발주 실적:
${JSON.stringify(orderData?.slice(0, 5), null, 2)}

## 요청사항
1. 위 데이터를 분석하여 견적가의 적정성을 판단해주세요.
2. 협상 전략이 필요하다면 제안해주세요.
3. 최종 권고사항을 제시해주세요.`;

  return streamSSE(c, async (stream) => {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        stream: true,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });
      
      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'text', content: event.delta.text })
          });
        }
      }
      
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
    } catch (error: any) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: error.message })
      });
    }
  });
});

// Claude API 스트리밍 - 시황 분석
app.post('/api/analyze/market', async (c) => {
  const { lmeData, orderData, monthlyAssessment } = await c.req.json();
  
  const anthropic = getAnthropicClient();
  
  const systemPrompt = `당신은 원자재 시황 분석 전문 AI Agent입니다.
Bronze Casting 밸브의 원재료(Cu 88% + Sn 12%)와 발주단가 트렌드를 분석합니다.
한국어로 응답하며, 시황 대비 구매 효율성을 판단합니다.`;

  const userPrompt = `## LME 시황 데이터 (2025년)
${JSON.stringify(lmeData, null, 2)}

## 월별 발주단가 vs 시황 적정성 판정
${JSON.stringify(monthlyAssessment, null, 2)}

## 요청사항
1. 2025년 원재료(Cu, Sn) 시황 트렌드를 분석해주세요.
2. 발주단가와 시황의 괴리를 분석해주세요.
3. 구매 전략 및 협상 포인트를 제안해주세요.`;

  return streamSSE(c, async (stream) => {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        stream: true,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });
      
      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'text', content: event.delta.text })
          });
        }
      }
      
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
    } catch (error: any) {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: error.message })
      });
    }
  });
});

// ============================================
// HTML 페이지 라우트
// ============================================

app.get('/', (c) => c.html(getMainHTML()));
app.get('/screen1', (c) => c.html(getScreen1HTML()));
app.get('/screen2', (c) => c.html(getScreen2HTML()));
app.get('/screen3', (c) => c.html(getScreen3HTML()));

// ============================================
// HTML 템플릿
// ============================================

function getMainHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>밸브재 구매 AI Agent PoC</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    body { font-family: 'Noto Sans KR', sans-serif; }
    .gradient-bg { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); }
    .card-hover:hover { transform: translateY(-4px); box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3); }
  </style>
</head>
<body class="gradient-bg min-h-screen text-white">
  <div class="container mx-auto px-6 py-12">
    <header class="text-center mb-16">
      <div class="inline-flex items-center gap-3 mb-4">
        <div class="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
          <i class="fas fa-robot text-2xl"></i>
        </div>
        <h1 class="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
          밸브재 구매 AI Agent
        </h1>
      </div>
      <p class="text-gray-400 text-lg">PR 자재별 최적 단가 제안 및 견적단가 검증 시스템</p>
      <div class="flex justify-center gap-4 mt-4">
        <span class="px-3 py-1 bg-blue-500/20 text-blue-400 rounded-full text-sm">PoC Demo</span>
        <span class="px-3 py-1 bg-purple-500/20 text-purple-400 rounded-full text-sm">Agentic UI</span>
        <span class="px-3 py-1 bg-green-500/20 text-green-400 rounded-full text-sm">Claude API</span>
      </div>
    </header>
    <div class="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
      <a href="/screen1" class="card-hover block bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-8 transition-all duration-300">
        <div class="w-14 h-14 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-xl flex items-center justify-center mb-6">
          <i class="fas fa-calculator text-2xl"></i>
        </div>
        <h2 class="text-xl font-bold mb-3">화면 1</h2>
        <h3 class="text-lg text-emerald-400 mb-4">PR 최적 추천 단가 제안</h3>
        <p class="text-gray-400 text-sm leading-relaxed">단가 테이블과 과거 발주실적을 분석하여 PR 건별 최적 단가를 추천합니다.</p>
        <div class="mt-6 flex items-center text-emerald-400 text-sm"><span>시작하기</span><i class="fas fa-arrow-right ml-2"></i></div>
      </a>
      <a href="/screen2" class="card-hover block bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-8 transition-all duration-300">
        <div class="w-14 h-14 bg-gradient-to-br from-amber-500 to-orange-600 rounded-xl flex items-center justify-center mb-6">
          <i class="fas fa-file-invoice-dollar text-2xl"></i>
        </div>
        <h2 class="text-xl font-bold mb-3">화면 2</h2>
        <h3 class="text-lg text-amber-400 mb-4">협력사 견적 적정성 검증</h3>
        <p class="text-gray-400 text-sm leading-relaxed">협력사 제출 견적가를 발주실적 및 계약단가와 비교하여 적정성을 판정합니다.</p>
        <div class="mt-6 flex items-center text-amber-400 text-sm"><span>시작하기</span><i class="fas fa-arrow-right ml-2"></i></div>
      </a>
      <a href="/screen3" class="card-hover block bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-8 transition-all duration-300">
        <div class="w-14 h-14 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl flex items-center justify-center mb-6">
          <i class="fas fa-chart-line text-2xl"></i>
        </div>
        <h2 class="text-xl font-bold mb-3">화면 3</h2>
        <h3 class="text-lg text-violet-400 mb-4">원재료 시황 × 발주단가 분석</h3>
        <p class="text-gray-400 text-sm leading-relaxed">LME 원재료(Cu, Sn) 시황과 발주단가 트렌드를 비교 분석합니다.</p>
        <div class="mt-6 flex items-center text-violet-400 text-sm"><span>시작하기</span><i class="fas fa-arrow-right ml-2"></i></div>
      </a>
    </div>
    <footer class="mt-16 text-center text-gray-500 text-sm">
      <p>데이터: 단가테이블 482건 | 견적 159건 | 발주실적(BC밸브) 654건 | LME 시황 12개월</p>
    </footer>
  </div>
</body>
</html>`;
}

function getScreen1HTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>화면1: PR 최적 추천 단가 제안</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    body { font-family: 'Noto Sans KR', sans-serif; background: #0a0f1a; color: #e0e6f0; }
    .agent-card { animation: slideIn 0.3s ease-out; }
    @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
  </style>
</head>
<body class="min-h-screen">
  <header class="border-b border-white/10 px-6 py-4">
    <div class="flex items-center justify-between max-w-[1800px] mx-auto">
      <div class="flex items-center gap-4">
        <a href="/" class="text-gray-400 hover:text-white transition"><i class="fas fa-arrow-left"></i></a>
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-lg flex items-center justify-center"><i class="fas fa-calculator"></i></div>
          <div><h1 class="text-lg font-bold">PR 최적 추천 단가 제안</h1><p class="text-xs text-gray-400">단가테이블 × 발주실적 기반 분석</p></div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="px-3 py-1 bg-emerald-500/20 text-emerald-400 rounded-full text-xs">화면 1</span>
        <span class="px-3 py-1 bg-blue-500/20 text-blue-400 rounded-full text-xs">단가테이블 482건</span>
      </div>
    </div>
  </header>
  <div class="flex h-[calc(100vh-73px)]">
    <div class="w-[40%] border-r border-white/10 flex flex-col">
      <div class="p-4 border-b border-white/10 bg-white/5"><h2 class="text-sm font-semibold text-gray-300"><i class="fas fa-robot mr-2 text-emerald-400"></i>AI Agent 분석 로그</h2></div>
      <div id="agentLog" class="flex-1 overflow-y-auto p-4 space-y-3">
        <div class="text-center text-gray-500 py-8"><i class="fas fa-search text-4xl mb-4 opacity-50"></i><p>PR 건을 선택하면 분석을 시작합니다</p></div>
      </div>
    </div>
    <div class="w-[60%] flex flex-col">
      <div class="p-4 border-b border-white/10 bg-white/5"><h2 class="text-sm font-semibold text-gray-300"><i class="fas fa-table mr-2 text-blue-400"></i>PR 대상 건 목록</h2></div>
      <div class="flex-1 overflow-y-auto p-4">
        <div class="bg-white/5 rounded-lg border border-white/10 overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-white/5"><tr class="text-left text-gray-400"><th class="px-4 py-3">No</th><th class="px-4 py-3">자재번호</th><th class="px-4 py-3">자재내역</th><th class="px-4 py-3">수량</th><th class="px-4 py-3 text-right">견적가</th><th class="px-4 py-3 text-center">분석</th></tr></thead>
            <tbody id="prTable" class="divide-y divide-white/5"></tbody>
          </table>
        </div>
        <div id="resultPanel" class="mt-6 hidden">
          <div class="bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/30 rounded-xl p-6">
            <h3 class="text-lg font-bold text-emerald-400 mb-4"><i class="fas fa-check-circle mr-2"></i>분석 결과</h3>
            <div id="resultContent"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    let quotesData = [];
    async function loadData() {
      const res = await fetch('/api/data/quotes');
      quotesData = await res.json();
      renderTable();
    }
    function renderTable() {
      document.getElementById('prTable').innerHTML = quotesData.slice(0, 20).map((q, i) => 
        '<tr class="hover:bg-white/5 cursor-pointer" data-idx="'+i+'" onclick="analyzeQuote('+i+')"><td class="px-4 py-3 text-gray-400">'+q.no+'</td><td class="px-4 py-3 font-mono text-xs">'+q.materialNo+'</td><td class="px-4 py-3">'+(q.description?.substring(0, 40) || '')+'</td><td class="px-4 py-3">'+q.quantity+'</td><td class="px-4 py-3 text-right text-emerald-400">₩'+(q.quotePrice?.toLocaleString() || 0)+'</td><td class="px-4 py-3 text-center"><button class="px-3 py-1 bg-emerald-500/20 text-emerald-400 rounded text-xs hover:bg-emerald-500/30"><i class="fas fa-play mr-1"></i>분석</button></td></tr>'
      ).join('');
    }
    async function analyzeQuote(idx) {
      const quote = quotesData[idx];
      const agentLog = document.getElementById('agentLog');
      agentLog.innerHTML = '';
      document.getElementById('resultPanel').classList.add('hidden');
      
      addAgentCard('data', '데이터 수집 중...', '📊 PR 정보 로드');
      await delay(500);
      updateAgentCard('data', 'PR No.'+quote.no+' 로드 완료\\n자재번호: '+quote.materialNo);
      
      await delay(400);
      addAgentCard('rule1', 'Rule 적용 중...', '🔍 밸브타입 매핑');
      await delay(600);
      
      const priceRes = await fetch('/api/recommend-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ valveType: quote.materialNo?.substring(4) || '', description: quote.description, options: [] })
      });
      const priceData = await priceRes.json();
      
      if (priceData.success) {
        updateAgentCard('rule1', '밸브타입 매핑 완료\\n기준타입: '+priceData.baseType);
      } else {
        updateAgentCard('rule1', '매핑 실패: '+priceData.message);
      }
      
      await delay(400);
      addAgentCard('rule2', '옵션 분석 중...', '⚙️ 옵션단가 적용');
      await delay(500);
      
      const opts = [];
      if (priceData.breakdown?.bodyPrice) opts.push('BODY: ₩'+priceData.breakdown.bodyPrice.toLocaleString());
      if (priceData.breakdown?.optionOP) opts.push('O-P: ₩'+priceData.breakdown.optionOP.toLocaleString());
      if (priceData.breakdown?.optionLock) opts.push('LOCK: ₩'+priceData.breakdown.optionLock.toLocaleString());
      updateAgentCard('rule2', opts.length > 0 ? opts.join('\\n') : '추가 옵션 없음');
      
      await delay(400);
      addAgentCard('result', '분석 완료', '✅ 최종 판정');
      
      const recommendedPrice = priceData.totalPrice || quote.unitPrice;
      const diff = quote.quotePrice - recommendedPrice;
      const diffPercent = ((diff / recommendedPrice) * 100).toFixed(1);
      updateAgentCard('result', '추천단가: ₩'+recommendedPrice.toLocaleString()+'\\n견적가: ₩'+quote.quotePrice?.toLocaleString()+'\\n차이: '+(diff > 0 ? '+' : '')+diffPercent+'%');
      
      document.getElementById('resultPanel').classList.remove('hidden');
      document.getElementById('resultContent').innerHTML = '<div class="grid grid-cols-3 gap-4"><div class="bg-black/20 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-white">₩'+recommendedPrice.toLocaleString()+'</div><div class="text-xs text-gray-400 mt-1">추천 단가</div></div><div class="bg-black/20 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-amber-400">₩'+quote.quotePrice?.toLocaleString()+'</div><div class="text-xs text-gray-400 mt-1">견적가</div></div><div class="bg-black/20 rounded-lg p-4 text-center"><div class="text-2xl font-bold '+(diff > 0 ? 'text-red-400' : 'text-emerald-400')+'">'+(diff > 0 ? '+' : '')+diffPercent+'%</div><div class="text-xs text-gray-400 mt-1">차이</div></div></div>';
    }
    function addAgentCard(id, content, title) {
      const card = document.createElement('div');
      card.id = 'card-' + id;
      card.className = 'agent-card bg-white/5 border border-white/10 rounded-lg p-4';
      card.innerHTML = '<div class="flex items-center gap-2 mb-2 text-xs text-gray-400"><i class="fas fa-spinner fa-spin"></i><span>'+title+'</span></div><div class="text-sm whitespace-pre-wrap">'+content+'</div>';
      document.getElementById('agentLog').appendChild(card);
    }
    function updateAgentCard(id, content) {
      const card = document.getElementById('card-' + id);
      if (card) {
        card.querySelector('i').className = 'fas fa-check text-emerald-400';
        card.querySelector('.text-sm').textContent = content;
      }
    }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    loadData();
  </script>
</body>
</html>`;
}

function getScreen2HTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>화면2: 협력사 견적 적정성 검증</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    body { font-family: 'Noto Sans KR', sans-serif; background: #0a0f1a; color: #e0e6f0; }
    .agent-card { animation: slideIn 0.3s ease-out; }
    @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
  </style>
</head>
<body class="min-h-screen">
  <header class="border-b border-white/10 px-6 py-4">
    <div class="flex items-center justify-between max-w-[1800px] mx-auto">
      <div class="flex items-center gap-4">
        <a href="/" class="text-gray-400 hover:text-white transition"><i class="fas fa-arrow-left"></i></a>
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-gradient-to-br from-amber-500 to-orange-600 rounded-lg flex items-center justify-center"><i class="fas fa-file-invoice-dollar"></i></div>
          <div><h1 class="text-lg font-bold">협력사 견적 적정성 검증</h1><p class="text-xs text-gray-400">견적가 vs 발주실적(90%) 비교</p></div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="px-3 py-1 bg-amber-500/20 text-amber-400 rounded-full text-xs">화면 2</span>
        <span class="px-3 py-1 bg-blue-500/20 text-blue-400 rounded-full text-xs">견적 159건</span>
      </div>
    </div>
  </header>
  <div class="flex h-[calc(100vh-73px)]">
    <div class="w-[40%] border-r border-white/10 flex flex-col">
      <div class="p-4 border-b border-white/10 bg-white/5"><h2 class="text-sm font-semibold text-gray-300"><i class="fas fa-robot mr-2 text-amber-400"></i>AI Agent 분석 로그</h2></div>
      <div id="agentLog" class="flex-1 overflow-y-auto p-4 space-y-3">
        <div class="text-center text-gray-500 py-8"><i class="fas fa-clipboard-check text-4xl mb-4 opacity-50"></i><p>견적 건을 선택하면 검증을 시작합니다</p></div>
      </div>
    </div>
    <div class="w-[60%] flex flex-col">
      <div class="p-4 border-b border-white/10 bg-white/5 flex justify-between items-center">
        <h2 class="text-sm font-semibold text-gray-300"><i class="fas fa-table mr-2 text-blue-400"></i>협력사 견적 목록</h2>
        <div class="flex gap-2">
          <button onclick="filterByVerdict('all')" class="px-3 py-1 bg-white/10 rounded text-xs hover:bg-white/20">전체</button>
          <button onclick="filterByVerdict('excellent')" class="px-3 py-1 bg-emerald-500/20 text-emerald-400 rounded text-xs">우수</button>
          <button onclick="filterByVerdict('normal')" class="px-3 py-1 bg-amber-500/20 text-amber-400 rounded text-xs">보통</button>
          <button onclick="filterByVerdict('poor')" class="px-3 py-1 bg-red-500/20 text-red-400 rounded text-xs">부적절</button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-4">
        <div class="bg-white/5 rounded-lg border border-white/10 overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-white/5"><tr class="text-left text-gray-400"><th class="px-4 py-3">No</th><th class="px-4 py-3">자재내역</th><th class="px-4 py-3 text-right">견적가</th><th class="px-4 py-3 text-right">계산단가</th><th class="px-4 py-3 text-center">판정</th><th class="px-4 py-3 text-center">검증</th></tr></thead>
            <tbody id="quoteTable" class="divide-y divide-white/5"></tbody>
          </table>
        </div>
        <div id="summaryStats" class="mt-6 grid grid-cols-4 gap-4">
          <div class="bg-white/5 border border-white/10 rounded-lg p-4 text-center"><div class="text-2xl font-bold" id="totalCount">0</div><div class="text-xs text-gray-400">전체</div></div>
          <div class="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-emerald-400" id="excellentCount">0</div><div class="text-xs text-gray-400">우수</div></div>
          <div class="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-amber-400" id="normalCount">0</div><div class="text-xs text-gray-400">보통</div></div>
          <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-red-400" id="poorCount">0</div><div class="text-xs text-gray-400">부적절</div></div>
        </div>
      </div>
    </div>
  </div>
  <script>
    let quotesData = [], validationResults = {}, currentFilter = 'all';
    async function loadData() {
      const res = await fetch('/api/data/quotes');
      quotesData = await res.json();
      for (const q of quotesData.slice(0, 50)) {
        const vRes = await fetch('/api/validate-quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteId: q.no }) });
        const vData = await vRes.json();
        if (vData.success) validationResults[q.no] = vData.analysis;
      }
      renderTable();
      updateStats();
    }
    function renderTable() {
      const filtered = quotesData.slice(0, 50).filter(q => currentFilter === 'all' || validationResults[q.no]?.verdict === currentFilter);
      document.getElementById('quoteTable').innerHTML = filtered.map(q => {
        const v = validationResults[q.no] || {};
        const cls = v.verdict === 'excellent' ? 'text-emerald-400 bg-emerald-500/20' : v.verdict === 'normal' ? 'text-amber-400 bg-amber-500/20' : v.verdict === 'poor' ? 'text-red-400 bg-red-500/20' : 'text-gray-400 bg-white/10';
        const emoji = v.verdict === 'excellent' ? '🟢' : v.verdict === 'normal' ? '🟡' : v.verdict === 'poor' ? '🔴' : '⚪';
        return '<tr class="hover:bg-white/5 cursor-pointer" onclick="validateQuote('+q.no+')"><td class="px-4 py-3 text-gray-400">'+q.no+'</td><td class="px-4 py-3 text-xs">'+(q.description?.substring(0,35)||'')+'</td><td class="px-4 py-3 text-right">₩'+(q.quotePrice?.toLocaleString()||0)+'</td><td class="px-4 py-3 text-right text-gray-400">₩'+(q.unitPrice?.toLocaleString()||0)+'</td><td class="px-4 py-3 text-center"><span class="px-2 py-1 rounded text-xs '+cls+'">'+emoji+' '+(v.verdictLabel||'-')+'</span></td><td class="px-4 py-3 text-center"><button class="px-3 py-1 bg-amber-500/20 text-amber-400 rounded text-xs"><i class="fas fa-search mr-1"></i>검증</button></td></tr>';
      }).join('');
    }
    function filterByVerdict(v) { currentFilter = v; renderTable(); }
    function updateStats() {
      const r = Object.values(validationResults);
      document.getElementById('totalCount').textContent = r.length;
      document.getElementById('excellentCount').textContent = r.filter(x => x.verdict === 'excellent').length;
      document.getElementById('normalCount').textContent = r.filter(x => x.verdict === 'normal').length;
      document.getElementById('poorCount').textContent = r.filter(x => x.verdict === 'poor').length;
    }
    async function validateQuote(id) {
      const q = quotesData.find(x => x.no === id);
      const log = document.getElementById('agentLog');
      log.innerHTML = '';
      
      addAgentCard('load', '견적 로드 중...', '📋 견적 데이터');
      await delay(400);
      updateAgentCard('load', '견적번호: '+q.quoteNo+'\\n자재번호: '+q.materialNo);
      
      await delay(300);
      addAgentCard('history', '발주실적 조회 중...', '📊 과거 데이터');
      await delay(500);
      
      const v = validationResults[id] || {};
      updateAgentCard('history', '관련실적: '+(v.relatedOrderCount||0)+'건\\n평균단가: ₩'+(v.recentOrderAmount?.toLocaleString()||0)+'\\n90%기준: ₩'+(v.threshold90?.toLocaleString()||0));
      
      await delay(300);
      addAgentCard('compare', '비교 분석 중...', '🔍 가격 비교');
      await delay(400);
      updateAgentCard('compare', '견적가: ₩'+q.quotePrice?.toLocaleString()+'\\n기준 대비: '+(v.diffPercent>0?'+':'')+v.diffPercent+'%');
      
      await delay(300);
      const emoji = v.verdict === 'excellent' ? '🟢' : v.verdict === 'normal' ? '🟡' : '🔴';
      addAgentCard('verdict', emoji+' 판정: '+(v.verdictLabel||'-'), '✅ 최종 판정');
      
      if (v.verdict === 'poor') {
        await delay(300);
        addAgentCard('strategy', '협상 전략 생성...', '💡 AI 협상 제안');
        await delay(600);
        updateAgentCard('strategy', '권장 전략:\\n1. 90% 기준가(₩'+v.threshold90?.toLocaleString()+') 제시\\n2. 실적 '+v.relatedOrderCount+'건 근거 활용');
      }
    }
    function addAgentCard(id, content, title) {
      const card = document.createElement('div');
      card.id = 'card-' + id;
      card.className = 'agent-card bg-white/5 border border-white/10 rounded-lg p-4';
      card.innerHTML = '<div class="flex items-center gap-2 mb-2 text-xs text-gray-400"><i class="fas fa-spinner fa-spin"></i><span>'+title+'</span></div><div class="text-sm whitespace-pre-wrap">'+content+'</div>';
      document.getElementById('agentLog').appendChild(card);
    }
    function updateAgentCard(id, content) {
      const card = document.getElementById('card-' + id);
      if (card) { card.querySelector('i').className = 'fas fa-check text-amber-400'; card.querySelector('.text-sm').textContent = content; }
    }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    loadData();
  </script>
</body>
</html>`;
}

function getScreen3HTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>화면3: 원재료 시황 × 발주단가 분석</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
    body { font-family: 'Noto Sans KR', sans-serif; background: #0a0f1a; color: #e0e6f0; }
    .agent-card { animation: slideIn 0.3s ease-out; }
    @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
  </style>
</head>
<body class="min-h-screen">
  <header class="border-b border-white/10 px-6 py-4">
    <div class="flex items-center justify-between max-w-[1800px] mx-auto">
      <div class="flex items-center gap-4">
        <a href="/" class="text-gray-400 hover:text-white transition"><i class="fas fa-arrow-left"></i></a>
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-gradient-to-br from-violet-500 to-purple-600 rounded-lg flex items-center justify-center"><i class="fas fa-chart-line"></i></div>
          <div><h1 class="text-lg font-bold">원재료 시황 × 발주단가 분석</h1><p class="text-xs text-gray-400">VGBARR240AT · Bronze Casting (Cu 88% + Sn 12%)</p></div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span class="px-3 py-1 bg-violet-500/20 text-violet-400 rounded-full text-xs">화면 3</span>
        <span class="px-3 py-1 bg-blue-500/20 text-blue-400 rounded-full text-xs">발주실적 654건</span>
        <button onclick="startAnalysis()" class="px-4 py-2 bg-violet-500 hover:bg-violet-600 rounded-lg text-sm font-medium transition"><i class="fas fa-play mr-2"></i>분석 시작</button>
      </div>
    </div>
  </header>
  <div class="flex h-[calc(100vh-73px)]">
    <div class="w-[40%] border-r border-white/10 flex flex-col">
      <div class="p-4 border-b border-white/10 bg-white/5"><h2 class="text-sm font-semibold text-gray-300"><i class="fas fa-robot mr-2 text-violet-400"></i>AI Agent 분석 로그</h2></div>
      <div id="agentLog" class="flex-1 overflow-y-auto p-4 space-y-3">
        <div class="text-center text-gray-500 py-8"><i class="fas fa-chart-area text-4xl mb-4 opacity-50"></i><p>"분석 시작" 버튼을 클릭하세요</p></div>
      </div>
    </div>
    <div class="w-[60%] flex flex-col overflow-y-auto">
      <div class="p-6 space-y-6">
        <div class="bg-white/5 border border-white/10 rounded-xl p-6">
          <h3 class="text-sm font-semibold text-gray-300 mb-4">📈 월별 지수 트렌드 (1월 = 100)</h3>
          <canvas id="trendChart" height="200"></canvas>
        </div>
        <div class="grid grid-cols-4 gap-4">
          <div class="bg-gradient-to-br from-amber-500/10 to-orange-500/10 border border-amber-500/30 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-amber-400" id="cuChange">-</div><div class="text-xs text-gray-400">Cu 연간</div></div>
          <div class="bg-gradient-to-br from-yellow-500/10 to-amber-500/10 border border-yellow-500/30 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-yellow-400" id="snChange">-</div><div class="text-xs text-gray-400">Sn 연간</div></div>
          <div class="bg-gradient-to-br from-blue-500/10 to-cyan-500/10 border border-blue-500/30 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-blue-400" id="orderChange">-</div><div class="text-xs text-gray-400">발주단가</div></div>
          <div class="bg-gradient-to-br from-emerald-500/10 to-teal-500/10 border border-emerald-500/30 rounded-lg p-4 text-center"><div class="text-2xl font-bold text-emerald-400" id="goodCount">-</div><div class="text-xs text-gray-400">Good 판정</div></div>
        </div>
        <div class="bg-white/5 border border-white/10 rounded-xl p-6">
          <h3 class="text-sm font-semibold text-gray-300 mb-4">📊 월별 적정성 판정</h3>
          <div id="assessmentGrid" class="grid grid-cols-6 gap-2"></div>
        </div>
        <div id="insightsPanel" class="hidden bg-gradient-to-br from-violet-500/10 to-purple-500/10 border border-violet-500/30 rounded-xl p-6">
          <h3 class="text-sm font-semibold text-violet-400 mb-4"><i class="fas fa-lightbulb mr-2"></i>AI 인사이트</h3>
          <div id="insightsContent" class="text-sm text-gray-300 whitespace-pre-wrap"></div>
        </div>
      </div>
    </div>
  </div>
  <script>
    let chartInstance = null, marketData = null;
    async function loadData() {
      const res = await fetch('/api/market-analysis');
      marketData = await res.json();
      renderChart();
      renderStats();
      renderAssessment();
    }
    function renderChart() {
      const ctx = document.getElementById('trendChart').getContext('2d');
      if (chartInstance) chartInstance.destroy();
      const labels = marketData.lmeIndexes.map(d => d.monthLabel);
      chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Cu+Sn 가중지수', data: marketData.lmeIndexes.map(d => d.weightedIndex), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', borderWidth: 2.5, fill: true, tension: 0.3, pointRadius: 4 },
            { label: 'Cu 지수', data: marketData.lmeIndexes.map(d => d.cuIndex), borderColor: 'rgba(251,191,36,0.5)', borderWidth: 1.5, borderDash: [4,4], tension: 0.3, pointRadius: 0 },
            { label: 'Sn 지수', data: marketData.lmeIndexes.map(d => d.snIndex), borderColor: 'rgba(253,224,71,0.5)', borderWidth: 1.5, borderDash: [4,4], tension: 0.3, pointRadius: 0 },
            { label: '발주단가 지수', data: marketData.orderIndexes.map(d => d.index), borderColor: '#3b82f6', borderWidth: 2.5, tension: 0.3, pointRadius: 4 },
            { label: '기준선', data: Array(12).fill(100), borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderDash: [2,4], pointRadius: 0 }
          ]
        },
        options: {
          responsive: true,
          plugins: { legend: { labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true } } },
          scales: { x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' }, min: 80, max: 150 } }
        }
      });
    }
    function renderStats() {
      const lme = marketData.lmeIndexes, orders = marketData.orderIndexes, assess = marketData.monthlyAssessment;
      document.getElementById('cuChange').textContent = '+' + Math.round((lme[11]?.cuIndex||100)-100) + '%';
      document.getElementById('snChange').textContent = '+' + Math.round((lme[11]?.snIndex||100)-100) + '%';
      document.getElementById('orderChange').textContent = (orders[orders.length-1]?.index-100 > 0 ? '+' : '') + Math.round((orders[orders.length-1]?.index||100)-100) + '%';
      document.getElementById('goodCount').textContent = assess.filter(a => a.verdict === 'Good').length + '/12';
    }
    function renderAssessment() {
      document.getElementById('assessmentGrid').innerHTML = marketData.monthlyAssessment.map(a => {
        const cls = a.verdict === 'Good' ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : a.verdict === 'Bad' ? 'bg-red-500/20 border-red-500/50 text-red-400' : 'bg-amber-500/20 border-amber-500/50 text-amber-400';
        const emoji = a.verdict === 'Good' ? '🟢' : a.verdict === 'Bad' ? '🔴' : '🟡';
        return '<div class="border rounded-lg p-3 text-center '+cls+'"><div class="text-lg">'+emoji+'</div><div class="text-xs font-medium">'+a.monthLabel+'</div><div class="text-xs opacity-70">'+a.verdict+'</div></div>';
      }).join('');
    }
    async function startAnalysis() {
      const log = document.getElementById('agentLog');
      log.innerHTML = '';
      
      addAgentCard('load', 'LME 시황 및 발주 데이터 로드 중...', '📊 데이터 수집');
      await delay(500);
      updateAgentCard('load', 'LME 시황: 12개월\\n발주실적: '+marketData.summary.totalOrders+'건');
      
      await delay(400);
      addAgentCard('index', '지수 계산 중...', '📈 지수화 처리');
      await delay(600);
      updateAgentCard('index', 'Cu 연간: '+marketData.summary.cuChangeYTD+'\\nSn 연간: '+marketData.summary.snChangeYTD);
      
      await delay(400);
      addAgentCard('gap', '괴리 분석 중...', '🔍 괴리 분석');
      await delay(500);
      const good = marketData.monthlyAssessment.filter(a => a.verdict === 'Good').length;
      const bad = marketData.monthlyAssessment.filter(a => a.verdict === 'Bad').length;
      updateAgentCard('gap', 'Good: '+good+'개월\\nNormal: '+(12-good-bad)+'개월\\nBad: '+bad+'개월');
      
      await delay(400);
      addAgentCard('ai', 'AI 분석 중...', '🤖 AI 인사이트');
      
      document.getElementById('insightsPanel').classList.remove('hidden');
      const insightsContent = document.getElementById('insightsContent');
      insightsContent.textContent = '';
      
      try {
        const response = await fetch('/api/analyze/market', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lmeData: marketData.lmeData, orderData: marketData.orderIndexes, monthlyAssessment: marketData.monthlyAssessment }) });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiContent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          for (const line of chunk.split('\\n')) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'text') { aiContent += data.content; insightsContent.textContent = aiContent; updateAgentCard('ai', aiContent.substring(0,150)+'...'); }
              } catch (e) {}
            }
          }
        }
      } catch (e) {
        insightsContent.textContent = '📊 2025년 시황 분석\\n\\n• Cu: 연초 대비 +31% 상승\\n• Sn: 연초 대비 +40% 상승\\n• 발주단가: 시황 상승에도 안정 유지\\n• 대부분 월에서 유리한 구매 실현';
        updateAgentCard('ai', '분석 완료 (데모 모드)');
      }
      
      await delay(300);
      addAgentCard('done', '분석 완료', '✅ 완료');
    }
    function addAgentCard(id, content, title) {
      const card = document.createElement('div');
      card.id = 'card-' + id;
      card.className = 'agent-card bg-white/5 border border-white/10 rounded-lg p-4';
      card.innerHTML = '<div class="flex items-center gap-2 mb-2 text-xs text-gray-400"><i class="fas fa-spinner fa-spin"></i><span>'+title+'</span></div><div class="text-sm whitespace-pre-wrap">'+content+'</div>';
      document.getElementById('agentLog').appendChild(card);
    }
    function updateAgentCard(id, content) {
      const card = document.getElementById('card-' + id);
      if (card) { card.querySelector('i').className = 'fas fa-check text-violet-400'; card.querySelector('.text-sm').textContent = content; }
    }
    function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    loadData();
  </script>
</body>
</html>`;
}

// 서버 시작
const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 Valve Agent PoC Server starting on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`✅ Server running at http://localhost:${port}`);
