#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════
  밸브재 구매 AI Agent PoC (Flask 웹 서버)
═══════════════════════════════════════════════════════════════
  화면1: PR 건 최적 추천 단가 제안  (#4 실적 기반)
  화면2: 협력사 견적 적정성 검증     (#2, #3, #4)
  화면3: 원재료 시황 × 발주단가 분석 (LME + #4)
"""
import pandas as pd
import numpy as np
import json
import requests
import os
import warnings
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS

warnings.filterwarnings('ignore')

app = Flask(__name__, static_folder='public', template_folder='public')
CORS(app)

# ═══════════════════════════════════════════════════════
# 설정
# ═══════════════════════════════════════════════════════
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(__file__), 'data'))
API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-4-20250514"
API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

# ═══════════════════════════════════════════════════════
# 유틸리티 함수
# ═══════════════════════════════════════════════════════
def fmt(n):
    if pd.isna(n) or n is None:
        return "-"
    return f"{int(n):,}"

def pct(a, b):
    if not a or not b or b == 0:
        return None
    return (a - b) / b * 100

# ═══════════════════════════════════════════════════════
# Claude API
# ═══════════════════════════════════════════════════════
def call_claude(messages, tools=None, system=None, mt=3000):
    if not API_KEY:
        return None
    h = {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01"
    }
    b = {"model": MODEL, "max_tokens": mt, "messages": messages}
    if system:
        b["system"] = system
    if tools:
        b["tools"] = tools
    try:
        r = requests.post(API_URL, headers=h, json=b, timeout=60)
        return r.json() if r.status_code == 200 else None
    except:
        return None

def llm_simple(prompt, system=None, mt=2000):
    res = call_claude([{"role": "user", "content": prompt}], system=system, mt=mt)
    if res:
        return "\n".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text")
    return None

# ═══════════════════════════════════════════════════════
# 데이터 로드 & 전처리
# ═══════════════════════════════════════════════════════
print("📂 데이터 로드 중...")

def find_file(pattern):
    """파일 이름 패턴으로 파일 찾기 (인코딩 문제 해결)"""
    import unicodedata
    files = os.listdir(DATA_DIR)
    for f in files:
        # NFC/NFD 정규화 후 비교
        normalized = unicodedata.normalize('NFC', f)
        if pattern in normalized or pattern in f:
            return os.path.join(DATA_DIR, f)
    return None

try:
    # 파일 경로 찾기
    f2 = find_file('#2_') or find_file('price_table')
    f3 = find_file('#3_') or find_file('quote_sample')
    f4 = find_file('#4_') or find_file('order_history')
    f_lme = find_file('LME_')
    
    df2 = pd.read_excel(f2) if f2 else pd.DataFrame()
    df3 = pd.read_excel(f3) if f3 else pd.DataFrame()
    df4 = pd.read_excel(f4) if f4 else pd.DataFrame()
    df_lme = pd.read_excel(f_lme) if f_lme else pd.DataFrame()
    print(f"✅ 단가테이블 {len(df2)}건 | 협력사견적 {len(df3)}건 | 실적 {len(df4)}건")
except Exception as e:
    print(f"❌ 데이터 로드 실패: {e}")
    import traceback
    traceback.print_exc()
    df2, df3, df4, df_lme = pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), pd.DataFrame()

# 전처리
if not df4.empty:
    df4['mat_core'] = df4['자재번호'].str[4:]
    mat2vt = df4.dropna(subset=['Valve Type']).drop_duplicates('mat_core').set_index('mat_core')['Valve Type'].to_dict()
else:
    mat2vt = {}

p_idx = {}
for _, r in df2.iterrows():
    p_idx.setdefault(r['밸브타입'], []).append(r)

h_idx = {}
if not df4.empty:
    for _, r in df4[df4['Valve Type'].notna()].iterrows():
        h_idx.setdefault(r['Valve Type'], []).append(r)

if not df3.empty:
    df3['mat_core'] = df3['자재번호'].str[4:]
    df3['VType'] = df3['mat_core'].map(mat2vt)

# LME 데이터
lme_monthly = {}
if not df_lme.empty:
    lme = df_lme[df_lme['월'].str.contains('월', na=False)].copy()
    lme['M'] = lme['월'].str.replace('월', '').astype(int)
    lme = lme.sort_values('M')
    lme_monthly = {int(r['M']): {'Cu': r['구리 (USD/톤)'], 'Sn': r['주석 (USD/톤)']} for _, r in lme.iterrows()}

print(f"✅ 전처리 완료 | 매핑: {len(mat2vt)}건")

# ═══════════════════════════════════════════════════════
# 핵심 함수
# ═══════════════════════════════════════════════════════
def get_body2(vt, qty=1):
    """BODY2 기본단가 조회 (Rule 1)"""
    if vt not in p_idx:
        return None, None, None
    r = p_idx[vt][0]
    b2 = r.get('BODY2-변환') or 0
    tq = r.get('수량') or 1
    return b2 / tq if tq > 0 else b2, b2, tq

def get_opts(vt, desc, ip=None, ep=None, spec=None):
    """옵션단가 계산 (Rule 2)"""
    if vt not in p_idx:
        return 0, []
    r = p_idx[vt][0]
    tot, det, used = 0, [], set()
    d = str(desc).upper()
    
    for kw, cols in [
        ('I/O-P', ['I-P-변환', 'O-P-변환']),
        ('I/O-T', ['I-P-변환', 'O-P-변환']),
        ('LOCK', ['LOCK-변환']),
        ('I-T', ['I-P-변환']),
        ('O-T', ['O-P-변환']),
        ('IND', ['IND-변환']),
        ('L/SW', ['L/SW-변환']),
        ('EXT', ['EXT-변환'])
    ]:
        if kw in d:
            for c in cols:
                v = r.get(c, 0) or 0
                if v > 0 and c not in used:
                    det.append(f"{kw}={fmt(v)}")
                    tot += v
                    used.add(c)
    
    if ip and str(ip).strip() not in ('N0', 'NO', ''):
        v = r.get('I-P-변환', 0) or 0
        if v > 0 and 'I-P-변환' not in used:
            det.append(f"내부도장={fmt(v)}")
            tot += v
            used.add('I-P-변환')
    
    if ep and str(ep).strip() not in ('N0', 'NO', ''):
        v = r.get('O-P-변환', 0) or 0
        if v > 0 and 'O-P-변환' not in used:
            det.append(f"외부도장={fmt(v)}")
            tot += v
            used.add('O-P-변환')
    
    if spec:
        s = str(spec).upper()
        for k, c in [('SCS13', 'DISC-SCS13-변환'), ('SUS316', 'DISC-SCS16-변환'), ('SUS304', 'DISC-SCS13-변환')]:
            if k in s:
                v = r.get(c, 0) or 0
                if v > 0 and c not in used:
                    det.append(f"DISC({k})={fmt(v)}")
                    tot += v
                    used.add(c)
    
    return tot, det

def recent_order(vf, desc=None):
    """최근 발주 조회 (1순위: 타입+내역, 2순위: 타입만)"""
    if vf not in h_idx:
        return None, None
    rows = sorted(h_idx[vf], key=lambda x: x.get('발주일', pd.NaT) or pd.NaT, reverse=True)
    
    p1 = None
    if desc:
        dc = str(desc).strip()
        for rx in rows:
            if str(rx.get('내역', '')).strip() == dc:
                p1 = {
                    '순위': '1순위(타입+내역)',
                    '업체': rx['발주업체'],
                    '일자': str(rx['발주일'])[:10],
                    '금액': rx['발주금액(KRW)-변환']
                }
                break
    
    rx = rows[0]
    p2 = {
        '순위': '2순위(타입)',
        '업체': rx['발주업체'],
        '일자': str(rx['발주일'])[:10],
        '금액': rx['발주금액(KRW)-변환']
    }
    return (p1 or p2), p1

# ═══════════════════════════════════════════════════════
# API 라우트
# ═══════════════════════════════════════════════════════
@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/api/health')
def health():
    return jsonify({
        'status': 'ok',
        'data': {
            'priceTable': len(df2),
            'quotes': len(df3),
            'orders': len(df4),
            'lme': len(lme_monthly),
            'apiKey': bool(API_KEY)
        }
    })

@app.route('/api/screen1/analyze', methods=['POST'])
def screen1_analyze():
    """화면 1: PR 건 최적 추천 단가 제안"""
    logs = []
    results = []
    
    logs.append({'type': 'header', 'text': '📋 화면 1: PR 건 최적 추천 단가 제안'})
    logs.append({'type': 'info', 'text': '본가(BODY2) + 옵션단가 + 수량환산 → 계약단가'})
    logs.append({'type': 'info', 'text': '과거 실적 최근 발주단가 (1순위: 타입+내역일치, 2순위: 타입만)'})
    
    # PR 전체 데이터 선택 (시황 분석 대상 전체)
    logs.append({'type': 'subheader', 'text': 'Step 1: PR 데이터 추출'})
    
    # Valve Type이 있는 모든 데이터를 대상으로 함
    pr_all = df4[df4['Valve Type'].notna()].drop_duplicates('Valve Type').sort_values('발주일', ascending=False).copy()
    
    # 매핑 가능 여부 분류
    pr_all['mappable'] = pr_all['Valve Type'].apply(lambda x: str(x)[:-1] in p_idx if pd.notna(x) else False)
    mapped_count = int(pr_all['mappable'].sum())
    unmapped_count = int(len(pr_all) - mapped_count)
    
    logs.append({'type': 'success', 'text': f'전체 {len(pr_all)}건 (매핑 가능 {mapped_count}건 + 미매핑 {unmapped_count}건)'})
    
    logs.append({'type': 'subheader', 'text': 'Step 2: PR 건별 단가 분석'})
    
    for seq, (_, pr) in enumerate(pr_all.iterrows(), 1):
        vf = pr['Valve Type']
        vt = vf[:-1]  # 끝자리 제거 (매핑)
        desc = pr['내역']
        qty = pr['발주수량'] if pd.notna(pr['발주수량']) else 1
        
        # 추가 정보 추출
        uom = pr.get('UOM', 'EA')
        valve_no = pr.get('Valve No', '')
        total_weight = pr.get('발주총중량(TN)', None)
        unit_weight = pr.get('단중(kg)', None)
        
        # 본가 (BODY2)
        ub, b2t, tq = get_body2(vt, qty)
        
        # 옵션단가
        op, od = get_opts(vt, desc)
        
        # 계약단가 (본가 + 옵션)
        ct = (ub + op) if ub else None
        
        # 과거 발주 실적
        best, p1 = recent_order(vf, desc)
        rp = best['금액'] if best else None
        r90 = rp * 0.9 if rp else None
        
        # 로그 생성 (처음 10건만 상세 로그)
        if seq <= 10:
            box_lines = [
                f'밸브타입: {vf} → 매핑키: {vt}',
                f'내역: {str(desc)[:65]}',
                f'수량: {qty} {uom}' + (f' (단가표 {tq}개 기준 환산)' if tq and tq != 1 else '')
            ]
            
            if ub:
                box_lines.append(f'✅ 본가 BODY2: {fmt(ub)}')
                box_lines.append(f'✅ 옵션: {", ".join(od) if od else "없음"} → {fmt(op)}')
                box_lines.append(f'★ 계약단가: {fmt(ct)}')
            else:
                box_lines.append('⚠️ 단가테이블 미매핑')
            
            if best:
                box_lines.append(f'📈 최근발주: {fmt(rp)} ({best["업체"]}, {best["일자"]}) [{best["순위"]}]')
                box_lines.append(f'📈 발주×90%: {fmt(r90)}')
            else:
                box_lines.append('⚠️ 발주실적 없음')
            
            logs.append({'type': 'box', 'seq': seq, 'lines': box_lines})
        
        # 결과 저장
        results.append({
            'no': seq,
            'valveType': vf,
            'valveTypeBase': vt,
            'description': str(desc)[:80] if desc else '',
            'quantity': int(qty) if pd.notna(qty) else 1,
            'uom': str(uom) if pd.notna(uom) else 'EA',
            'valveNo': str(valve_no) if pd.notna(valve_no) else '',
            'totalWeight': float(total_weight) if pd.notna(total_weight) else None,
            'unitWeight': float(unit_weight) if pd.notna(unit_weight) else None,
            'weightUnit': 'TN' if total_weight else ('kg' if unit_weight else ''),
            'tableQty': int(tq) if tq else None,
            'mapped': bool(ub),
            # 본가/옵션/계약단가
            'body2Price': ub,
            'optionPrice': op,
            'optionDetails': od,
            'contractPrice': ct,
            # 과거 발주 실적
            'recentOrder': {
                'rank': best['순위'] if best else None,
                'vendor': best['업체'] if best else None,
                'date': best['일자'] if best else None,
                'amount': rp
            } if best else None,
            'recentPrice': rp,
            'recent90': r90
        })
    
    if len(pr_all) > 10:
        logs.append({'type': 'info', 'text': f'... 외 {len(pr_all) - 10}건 (상세 로그 생략)'})
    
    logs.append({'type': 'success', 'text': f'분석 완료 - 총 {len(results)}건'})
    
    return jsonify({
        'success': True,
        'logs': logs,
        'results': results,
        'summary': {
            'total': len(results),
            'mapped': mapped_count,
            'unmapped': unmapped_count
        }
    })

@app.route('/api/screen2/analyze', methods=['POST'])
def screen2_analyze():
    """화면 2: 협력사 견적 적정성 검증"""
    logs = []
    results = []
    cnt = {'우수': 0, '보통': 0, '부적절': 0}
    
    logs.append({'type': 'header', 'text': '📋 화면 2: 협력사 견적 적정성 검증'})
    logs.append({'type': 'info', 'text': '발주×90% ≥ 견적 → 우수 | 발주/계약 ≥ 견적 → 보통 | 그 외 → 부적절'})
    
    mq = df3[df3['VType'].notna()].copy()
    logs.append({'type': 'success', 'text': f'검증 대상: {len(mq)}건'})
    
    logs.append({'type': 'subheader', 'text': 'Step 1: 견적 건별 검증'})
    
    for idx, (_, q) in enumerate(mq.iterrows(), 1):
        vf = q['VType']
        vt = vf[:-1]
        desc = q['자재내역']
        qp = q['견적가-변환']
        
        ub, _, _ = get_body2(vt)
        op, od = get_opts(vt, desc, q.get('내부도장'), q.get('외부도장'), q.get('상세사양'))
        ct = (ub + op) if ub else None
        
        best, _ = recent_order(vf, desc)
        rp = best['금액'] if best else None
        r90 = rp * 0.9 if rp else None
        
        # 판정
        if r90 and r90 >= qp:
            a = '우수'
            a_label = '✅ 우수'
        elif (rp and rp >= qp) or (ct and ct >= qp):
            a = '보통'
            a_label = '🔶 보통'
        elif rp or ct:
            a = '부적절'
            a_label = '❌ 부적절'
        else:
            a = '보통'
            a_label = '🔶 보통 (기준없음)'
        
        cnt[a] = cnt.get(a, 0) + 1
        
        gap_pct = pct(qp, rp) if rp else None
        
        results.append({
            'no': idx,
            'materialNo': q['자재번호'],
            'valveType': vf,
            'description': str(desc)[:50],
            'quotePrice': qp,
            'contractPrice': ct,
            'recentPrice': rp,
            'recent90': r90,
            'optionDetails': od,
            'assessment': a,
            'assessmentLabel': a_label,
            'gapPercent': gap_pct,
            'vendor': best['업체'] if best else None
        })
        
        # 상위 15건만 로그
        if idx <= 15:
            d_str = f" ({gap_pct:+.1f}%)" if gap_pct else ""
            box_lines = [
                f'{q["자재번호"]} → {vf}',
                f'🏷️ 견적: {fmt(qp)}{d_str} | 계약: {fmt(ct)} | 발주: {fmt(rp)}',
            ]
            if od:
                box_lines.append(f'옵션: {", ".join(od)}')
            logs.append({'type': 'box', 'seq': idx, 'label': a_label, 'lines': box_lines})
    
    logs.append({'type': 'subheader', 'text': 'Step 2: 적정성 요약'})
    logs.append({'type': 'highlight', 'text': f'📊 {len(results)}건: ✅우수:{cnt["우수"]} 🔶보통:{cnt["보통"]} ❌부적절:{cnt["부적절"]}'})
    
    # AI 분석
    logs.append({'type': 'subheader', 'text': 'Step 3: 🤖 AI Agent 분석'})
    
    bad_items = [r for r in results if r['assessment'] == '부적절']
    fb_lines = []
    if bad_items:
        fb_lines.append(f"[부적절 {len(bad_items)}건]")
        for r in bad_items[:5]:
            g = r['gapPercent']
            if g:
                fb_lines.append(f"  • {r['materialNo']}: 견적{fmt(r['quotePrice'])} vs 발주{fmt(r['recentPrice'])} ({g:+.1f}%초과)")
            else:
                fb_lines.append(f"  • {r['materialNo']}: 비교기준 부족")
    fb_lines.append(f"[종합] {len(results)}건 중 부적절 {cnt['부적절']}건({cnt['부적절']/max(len(results),1)*100:.0f}%) → {'양호' if cnt['부적절']<len(results)*0.2 else '개선필요'}")
    
    ai_analysis = '\n'.join(fb_lines)
    logs.append({'type': 'agent', 'isApi': False, 'text': ai_analysis})
    
    return jsonify({
        'success': True,
        'logs': logs,
        'results': results,
        'counts': cnt,
        'total': len(results),
        'aiAnalysis': ai_analysis
    })

@app.route('/api/screen3/analyze', methods=['POST'])
def screen3_analyze():
    """화면 3: 원재료 시황 × 발주단가 분석 (4개월 시차 적용)"""
    logs = []
    
    logs.append({'type': 'header', 'text': '📋 화면 3: 원재료 시황 × 발주단가 종합 분석'})
    logs.append({'type': 'info', 'text': '🌐 LME 시황 vs 업체별 발주단가 트렌드 (4개월 시차 적용)'})
    
    # BC밸브 필터링
    bc = df4[df4['Valve Type'].str.startswith('VGBARR240A', na=False)].copy()
    bc['dc'] = bc['내역'].str.strip()
    bc = bc[~bc['dc'].str.contains('LOCK', na=False)]
    bc = bc[bc['dc'].str.endswith('TR', na=False)]
    bc['M'] = pd.to_datetime(bc['발주일']).dt.month
    bc['단가'] = bc['발주금액(KRW)-변환'] / bc['발주수량'].replace(0, np.nan)
    mv = bc.groupby(['발주업체', 'M']).agg(avg=('단가', 'mean'), n=('단가', 'count')).reset_index()
    
    vendors = list(mv['발주업체'].unique())
    logs.append({'type': 'success', 'text': f'BC밸브: {len(bc)}건 | 업체: {", ".join([v[:6] for v in vendors])}'})
    
    logs.append({'type': 'subheader', 'text': 'Step 1: 시황 vs 업체별 단가 트렌드 (4개월 시차)'})
    logs.append({'type': 'info', 'text': '📌 원재료 시황 4개월 → 업체 단가 반영 (예: 1월 원재료 → 5월 업체단가)'})
    
    # 기준값 (1월 데이터)
    cu_base = lme_monthly.get(1, {}).get('Cu', 1)
    sn_base = lme_monthly.get(1, {}).get('Sn', 1)
    
    # 업체별 기준 단가 (1월)
    v_base = {}
    for v in vendors:
        vd = mv[(mv['발주업체'] == v) & (mv['M'] == 1)]
        if not vd.empty:
            v_base[v] = vd.iloc[0]['avg']
        else:
            vd = mv[mv['발주업체'] == v].sort_values('M')
            if not vd.empty:
                v_base[v] = vd.iloc[0]['avg']
    
    trend_data = []
    main_v = mv.groupby('발주업체')['n'].sum().idxmax() if not mv.empty else None
    
    # Cu+Sn 가중 가격 계산 (USD/톤 → 가중평균)
    def calc_cusn_price(m):
        if m not in lme_monthly:
            return None
        cu = lme_monthly[m]['Cu']
        sn = lme_monthly[m]['Sn']
        return cu * 0.88 + sn * 0.12
    
    LAG_MONTHS = 4  # 4개월 시차
    
    for m in range(1, 13):
        if m not in lme_monthly:
            continue
        
        cu_price = lme_monthly[m]['Cu']
        sn_price = lme_monthly[m]['Sn']
        cusn_price = cu_price * 0.88 + sn_price * 0.12  # 가중 평균 단가 (USD/톤)
        
        # 업체별 실제 단가 (KRW)
        vendor_prices = {}
        main_price = None
        for v in vendors:
            vd = mv[(mv['발주업체'] == v) & (mv['M'] == m)]
            if not vd.empty:
                price = vd.iloc[0]['avg']
                vendor_prices[v[:6]] = round(price)
                if v == main_v:
                    main_price = price
            else:
                vendor_prices[v[:6]] = None
        
        # 4개월 전 원재료 시황과 비교 (m월 업체단가 vs m-4월 원재료)
        lag_month = m - LAG_MONTHS
        lag_cusn_price = calc_cusn_price(lag_month) if lag_month >= 1 else None
        
        # 괴리율 계산 (4개월 시차 기준)
        gap_pct = None
        if main_price and lag_cusn_price and v_base.get(main_v):
            # 4개월 전 원재료 변화율
            base_cusn = calc_cusn_price(1)
            if base_cusn:
                market_change_pct = (lag_cusn_price / base_cusn - 1) * 100
                price_change_pct = (main_price / v_base[main_v] - 1) * 100
                # 괴리: 업체단가 변화율 - 예상 변화율(원재료 80% 반영)
                expected_change = market_change_pct * 0.8
                gap_pct = price_change_pct - expected_change
        
        trend_data.append({
            'month': m,
            'monthLabel': f'{m}월',
            'cuPrice': round(cu_price),
            'snPrice': round(sn_price),
            'cuSnPrice': round(cusn_price),
            'vendorPrices': vendor_prices,
            'mainVendorPrice': round(main_price) if main_price else None,
            'lagMonth': lag_month if lag_month >= 1 else None,
            'lagCuSnPrice': round(lag_cusn_price) if lag_cusn_price else None,
            'gapPct': round(gap_pct, 1) if gap_pct else None,
            # 지수 데이터도 유지 (호환성)
            'cuIndex': round(cu_price / cu_base * 100, 1),
            'snIndex': round(sn_price / sn_base * 100, 1),
            'cuSnIndex': round(cusn_price / (cu_base * 0.88 + sn_base * 0.12) * 100, 1),
            'mainVendorIndex': round(main_price / v_base[main_v] * 100, 1) if main_price and v_base.get(main_v) else None
        })
        
        # 로그
        lag_str = f'(vs {lag_month}월 시황)' if lag_month and lag_month >= 1 else '(시차 미적용)'
        emoji = '🟢' if gap_pct and gap_pct < -2 else ('🔴' if gap_pct and gap_pct > 2 else '🟡')
        gap_str = f'{emoji}{gap_pct:+.1f}%' if gap_pct else '·'
        main_str = f'{main_price:,.0f}' if main_price else '·'
        logs.append({'type': 'info', 'text': f'  {m:2d}월 │ Cu+Sn: ${cusn_price:,.0f} │ {main_v[:4] if main_v else "업체"}: ₩{main_str} │ 괴리: {gap_str} {lag_str}'})
    
    # 적정성 판정 (4개월 시차 기준)
    logs.append({'type': 'subheader', 'text': 'Step 2: 월별 적정성 판정 (4개월 시차 기준)'})
    
    def trend(c, th=2.0):
        if abs(c) <= th:
            return "유지"
        return "상승" if c > 0 else "하락"
    
    AM = {
        ("유지", "유지"): ("Normal", "🟡"), ("유지", "하락"): ("Bad", "🔴"), ("유지", "상승"): ("Good", "🟢"),
        ("상승", "유지"): ("Bad", "🔴"), ("상승", "하락"): ("Bad", "🔴"), ("상승", "상승"): ("Normal", "🟡"),
        ("하락", "유지"): ("Good", "🟢"), ("하락", "하락"): ("Bad", "🔴"), ("하락", "상승"): ("Good", "🟢")
    }
    
    md2 = mv[mv['발주업체'] == main_v].sort_values('M') if main_v else pd.DataFrame()
    assessments = {}
    prev_p, prev_lag_cusn = None, None
    
    for _, row in md2.iterrows():
        m = int(row['M'])
        p = row['avg']
        lag_m = m - LAG_MONTHS
        
        if lag_m < 1 or lag_m not in lme_monthly:
            prev_p = p
            if lag_m >= 1 and lag_m in lme_monthly:
                prev_lag_cusn = calc_cusn_price(lag_m)
            continue
        
        lag_cusn = calc_cusn_price(lag_m)
        
        if prev_p and prev_lag_cusn and lag_cusn:
            pchg = (p - prev_p) / prev_p * 100
            cchg = (lag_cusn - prev_lag_cusn) / prev_lag_cusn * 100
            pt, mt = trend(pchg), trend(cchg)
            label, emoji = AM.get((pt, mt), ("N/A", "⚪"))
            assessments[m] = {
                'label': label, 
                'emoji': emoji, 
                'priceChange': round(pchg, 1), 
                'marketChange': round(cchg, 1),
                'lagMonth': lag_m,
                'comparison': f'{lag_m}월 시황 → {m}월 단가'
            }
        
        prev_p = p
        prev_lag_cusn = lag_cusn
    
    # 판정 요약
    assess_counts = {'Good': 0, 'Normal': 0, 'Bad': 0}
    for a in assessments.values():
        assess_counts[a['label']] = assess_counts.get(a['label'], 0) + 1
    
    logs.append({'type': 'highlight', 'text': f'🟢Good:{assess_counts["Good"]} 🟡Normal:{assess_counts["Normal"]} 🔴Bad:{assess_counts["Bad"]}'})
    
    # AI 분석
    logs.append({'type': 'subheader', 'text': 'Step 3: 🤖 AI Agent 분석 (4개월 시차 기준)'})
    
    good3 = assess_counts.get('Good', 0)
    bad3 = assess_counts.get('Bad', 0)
    bad_months = [str(m) for m, a in assessments.items() if a['label'] == 'Bad']
    bad_details = [(m, a) for m, a in assessments.items() if a['label'] == 'Bad']
    
    fb_lines = [
        f"[분석 기준] 원재료 시황 → 4개월 후 업체 단가 반영 가정",
        f"[정합성] {len(assessments)}개월 중 Good {good3}, Bad {bad3} → 시황 대비 발주 {'유리' if good3 >= bad3 else '불리'}",
        f"[업체 패턴]",
        f"  • 원광: 시황 상승에도 단가 안정 → 보수적 가격 전략",
    ]
    
    if bad_details:
        fb_lines.append(f"  • Bad 월 상세:")
        for m, a in bad_details[:3]:
            fb_lines.append(f"    - {m}월: {a['lagMonth']}월 시황 {a['marketChange']:+.1f}% → 단가 {a['priceChange']:+.1f}%")
    
    fb_lines.append(f"[전략] 단기: Bad월 소급인하 / 중기: LME연동 조항(4개월 시차) / 장기: 복수업체 발굴")
    
    ai_analysis = '\n'.join(fb_lines)
    logs.append({'type': 'agent', 'isApi': False, 'text': ai_analysis})
    
    # 차트 데이터
    cu_year_change = round((lme_monthly.get(12, {}).get('Cu', cu_base) / cu_base - 1) * 100)
    sn_year_change = round((lme_monthly.get(12, {}).get('Sn', sn_base) / sn_base - 1) * 100)
    
    return jsonify({
        'success': True,
        'logs': logs,
        'trendData': trend_data,
        'assessments': {str(k): v for k, v in assessments.items()},
        'assessmentCounts': assess_counts,
        'summary': {
            'cuYearChange': cu_year_change,
            'snYearChange': sn_year_change,
            'totalOrders': len(bc),
            'vendors': vendors,
            'mainVendor': main_v
        },
        'lmeData': [{'month': m, **d} for m, d in lme_monthly.items()],
        'aiAnalysis': ai_analysis
    })

# ═══════════════════════════════════════════════════════
# 메인
# ═══════════════════════════════════════════════════════
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 3000))
    print(f"🚀 Valve Agent PoC 서버 시작: http://localhost:{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
