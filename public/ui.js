import { state } from './state.js';
import { satsToBTC } from './utils.js';
import { mempoolGetAddress, mempoolGetUTXOs, mempoolGetTxs, mempoolGetTx, mempoolGetTxProjection } from './api.js';
import { getAnnotation, setAnnotation, COLOR_PALETTE } from './annotations.js';

// stub helpers in case graph.js isn't loaded first
window.updateExpandBtn = window.updateExpandBtn || function() { /* fallback no-op */ };

export function showEntityView(nodeId) {
    // track selected node for toolbar button (shared globally)
    window.selectedNodeId = nodeId;
    if (window.updateExpandBtn) window.updateExpandBtn();

    if (!state.fullGraphData || !state.fullGraphData.nodes[nodeId]) return;
    const nodeData = state.fullGraphData.nodes[nodeId];
    
    // Access D3 data from state.link if available, otherwise fallback to graphData
    const allLinks = state.link ? state.link.data() : state.fullGraphData.edges;
    const getID = (n) => (typeof n === 'object' && n.id) ? n.id : n;

    const degree = allLinks.filter(l => getID(l.source) === nodeId || getID(l.target) === nodeId).length;

    let totalReceived = 0, totalSent = 0, incomingTx = 0, outgoingTx = 0;
    const txEvents = [];

    allLinks.forEach(l => {
        const srcId = getID(l.source);
        const tgtId = getID(l.target);
        const amt = l.amount || 0;
        const ts = l.timestamp;

        if (tgtId === nodeId) {
            totalReceived += amt; incomingTx++;
            if (ts > 0)
                txEvents.push({ dir: 'in', amount: amt, ts: ts, peer: srcId });
        } else if (srcId === nodeId) {
            totalSent += amt; outgoingTx++;
            if (ts > 0)
                txEvents.push({ dir: 'out', amount: amt, ts: ts, peer: tgtId });
        }
    });
    txEvents.sort((a, b) => b.ts - a.ts);

    const neighbors = new Set();
    allLinks.forEach(l => {
        const srcId = getID(l.source);
        const tgtId = getID(l.target);
        if (srcId === nodeId) neighbors.add(tgtId);
        if (tgtId === nodeId) neighbors.add(srcId);
    });
    const balance = totalReceived - totalSent;
    const isAddress = nodeData.type === 'Address';

    // ── Risk banner ──────────────────────────────────────────────────────────
    const risk       = nodeData.risk || 0;
    const rd         = nodeData.risk_data;
    const hasReports = rd && rd.report_count > 0;
    const hasError   = rd && rd.error;

    // "Direct risk" = risk score derived from actual ChainAbuse reports.
    // "Taint risk"  = risk score propagated from nearby high-risk nodes; no
    //                 reports exist for this specific address.
    // We distinguish them so we never show "NO RISK REPORTS ✅" alongside a
    // non-zero risk score — that combination is actively misleading.
    const hasTaintOnly = !hasReports && !hasError && risk > 0;

    // Resolve risk card accent colour as a concrete CSS colour value (not a
    // dynamic Tailwind class) so text is always readable regardless of theme.
    let accentColor, accentBg, accentLabel, accentIcon, accentGlow;
    if (hasError) {
        accentColor='#c2410c'; accentBg='#fff7ed'; accentLabel='API LIMIT REACHED'; accentIcon='⏳'; accentGlow='';
    } else if (hasTaintOnly) {
        if (risk >= 70) {
            accentColor='#b45309'; accentBg='#fffbeb'; accentLabel='HIGH TAINT RISK'; accentIcon='⚠️';
            accentGlow='box-shadow:0 0 20px rgba(245,158,11,0.2)';
        } else if (risk >= 40) {
            accentColor='#92400e'; accentBg='#fefce8'; accentLabel='ELEVATED TAINT RISK'; accentIcon='⚠️'; accentGlow='';
        } else {
            accentColor='#374151'; accentBg='#f8fafc'; accentLabel='LOW TAINT RISK'; accentIcon='🔗'; accentGlow='';
        }
    } else if (!hasReports && risk === 0) {
        accentColor='#065f46'; accentBg='#f0fdf4'; accentLabel='NO RISK REPORTS'; accentIcon='✅'; accentGlow='';
    } else if (risk >= 70) {
        accentColor='#b91c1c'; accentBg='#fef2f2'; accentLabel='CRITICAL RISK'; accentIcon='🚨';
        accentGlow='box-shadow:0 0 30px rgba(239,68,68,0.35)';
    } else if (risk >= 40) {
        accentColor='#c2410c'; accentBg='#fff7ed'; accentLabel='HIGH RISK'; accentIcon='⚠️';
        accentGlow='box-shadow:0 0 25px rgba(249,115,22,0.25)';
    } else if (risk >= 20) {
        accentColor='#92400e'; accentBg='#fefce8'; accentLabel='MEDIUM RISK'; accentIcon='⚠️'; accentGlow='';
    } else {
        accentColor='#065f46'; accentBg='#f0fdf4'; accentLabel='LOW RISK'; accentIcon='✅'; accentGlow='';
    }

    // Inject a scoped <style> that beats the parent dark theme's !important rules.
    // We use #entityContent as a high-specificity anchor so our rules win even
    // if the parent also uses !important on lower-specificity selectors.
    let html = `
    <style id="ep-theme">
      #entityContent { color: #1e293b !important; background: transparent !important; }
      #entityContent .ep-wrap { display:flex; flex-direction:column; gap:12px; }
      #entityContent .ep-card {
        background: #f8fafc !important;
        border: 1px solid #e2e8f0 !important;
        border-radius: 8px !important;
        padding: 12px !important;
        color: #1e293b !important;
      }
      #entityContent .ep-card-accent-amber { border-left: 4px solid #b45309 !important; }
      #entityContent .ep-card-accent-orange { border-left: 4px solid #c2410c !important; }
      #entityContent .ep-card-accent-red    { border-left: 4px solid #b91c1c !important; }
      #entityContent .ep-card-accent-green  { border-left: 4px solid #065f46 !important; }
      #entityContent .ep-card-accent-slate  { border-left: 4px solid #475569 !important; }
      #entityContent .ep-card-accent-indigo { border-left: 4px solid #6366f1 !important; }
      #entityContent .ep-card-accent-sky    { border-left: 4px solid #0ea5e9 !important; }
      #entityContent .ep-card-accent-violet { border-left: 4px solid #8b5cf6 !important; }
      #entityContent .ep-card-accent-amber2 { border-left: 4px solid #f59e0b !important; }
      #entityContent .ep-label {
        font-size: 8px !important; color: #475569 !important;
        font-weight: 600 !important; text-transform: uppercase !important;
        letter-spacing: 0.05em !important; margin-bottom: 2px !important;
        display: block !important;
      }
      #entityContent .ep-value {
        font-size: 10px !important; color: #0f172a !important;
        font-weight: 700 !important;
      }
      #entityContent .ep-value-lg {
        font-size: 22px !important; font-weight: 800 !important; line-height: 1 !important;
      }
      #entityContent .ep-body {
        font-size: 9px !important; color: #334155 !important; line-height: 1.5 !important;
      }
      #entityContent .ep-body-sm {
        font-size: 8px !important; color: #475569 !important; line-height: 1.4 !important;
      }
      #entityContent .ep-heading {
        font-size: 10px !important; color: #334155 !important;
        font-weight: 700 !important; text-transform: uppercase !important;
        letter-spacing: 0.06em !important;
      }
      #entityContent .ep-accent { color: inherit !important; }
      #entityContent .ep-grid2 {
        display: grid !important; grid-template-columns: 1fr 1fr !important; gap: 6px !important;
      }
      #entityContent .ep-grid2-span { grid-column: span 2 !important; }
      #entityContent .ep-bar-track {
        background: #e2e8f0 !important; border-radius: 9999px !important;
        height: 6px !important; margin: 8px 0 !important;
      }
      #entityContent .ep-bar-fill {
        height: 6px !important; border-radius: 9999px !important;
        transition: width 0.4s !important;
      }
      #entityContent .ep-divider {
        border-top: 1px solid #e2e8f0 !important; padding-top: 14px !important;
      }
      #entityContent .ep-row {
        display: flex !important; align-items: center !important;
        justify-content: space-between !important;
      }
      #entityContent .ep-badge {
        display: inline-block !important; padding: 3px 8px !important;
        border-radius: 4px !important; font-size: 9px !important;
        font-weight: 700 !important; margin: 2px !important;
      }
      #entityContent .ep-footer {
        font-size: 8px !important; font-weight: 600 !important;
        border-radius: 4px !important; padding: 5px 8px !important;
        margin-top: 8px !important;
      }
      #entityContent .ep-breakdown-row {
        display: flex !important; align-items: center !important;
        justify-content: space-between !important;
        font-size: 8px !important; margin-top: 5px !important;
      }
      #entityContent .ep-breakdown-label { color: #334155 !important; font-weight: 500 !important; }
      #entityContent .ep-breakdown-pct   { font-family: monospace !important; font-weight: 700 !important; color: #1e293b !important; }
      #entityContent .ep-minibar-track {
        width: 60px !important; height: 4px !important;
        background: #e2e8f0 !important; border-radius: 9999px !important;
        margin-right: 4px !important; display: inline-block !important; vertical-align: middle !important;
      }
      #entityContent .ep-minibar-fill {
        height: 4px !important; border-radius: 9999px !important; display: block !important;
      }
      #entityContent a.ep-link {
        color: #0e7490 !important; text-decoration: none !important; font-size: 9px !important;
      }
      #entityContent input.ep-input, #entityContent textarea.ep-input {
        background: #ffffff !important; color: #0f172a !important;
        border: 1px solid #cbd5e1 !important; border-radius: 6px !important;
        font-size: 9px !important; font-family: monospace !important;
        padding: 7px 8px !important; width: 100% !important;
        box-sizing: border-box !important; outline: none !important;
      }
      #entityContent textarea.ep-input { height: 72px !important; resize: none !important; }
      #entityContent button.ep-btn-primary {
        width: 100% !important; padding: 9px !important;
        border-radius: 6px !important; border: none !important;
        background: #0891b2 !important; color: #ffffff !important;
        font-size: 9px !important; font-weight: 700 !important;
        text-transform: uppercase !important; letter-spacing: 0.05em !important;
        cursor: pointer !important;
      }
      #entityContent button.ep-btn-expand {
        width: 100% !important; padding: 10px !important;
        border-radius: 8px !important; border: none !important;
        background: #0891b2 !important; color: #ffffff !important;
        font-size: 11px !important; font-weight: 700 !important;
        text-transform: uppercase !important; cursor: pointer !important;
      }
      #entityContent button.ep-btn-disabled {
        background: #f1f5f9 !important; color: #94a3b8 !important;
        border: 1px solid #e2e8f0 !important; cursor: not-allowed !important;
      }
      #entityContent .ep-tx-row {
        display: flex !important; align-items: flex-start !important;
        gap: 8px !important; padding: 8px !important;
        border-radius: 6px !important; background: #f8fafc !important;
        border: 1px solid #e2e8f0 !important; margin-bottom: 5px !important;
      }
      #entityContent .ep-green { color: #14532d !important; }
      #entityContent .ep-red   { color: #7c2d12 !important; }
      #entityContent .ep-mono  { font-family: monospace !important; color: #334155 !important; font-size: 11px !important; word-break: break-all !important; }
    </style>
    <div class="ep-wrap">`;


    const barWidth = (hasReports || hasTaintOnly) ? Math.max(risk, 4) : 100;

    // White card with a coloured left-border accent. All body text is slate-900
    // so it is legible on any background colour.
    // Pick accent class from risk level
    let accentClass;
    if (hasError)                                        accentClass = 'ep-card-accent-orange';
    else if (hasTaintOnly && risk >= 70)                 accentClass = 'ep-card-accent-orange';
    else if (hasTaintOnly && risk >= 40)                 accentClass = 'ep-card-accent-amber';
    else if (hasTaintOnly)                               accentClass = 'ep-card-accent-slate';
    else if (!hasReports && risk === 0)                  accentClass = 'ep-card-accent-green';
    else if (risk >= 70)                                 accentClass = 'ep-card-accent-red';
    else if (risk >= 40)                                 accentClass = 'ep-card-accent-orange';
    else if (risk >= 20)                                 accentClass = 'ep-card-accent-amber';
    else                                                 accentClass = 'ep-card-accent-green';

    html += `
    <div class="ep-card ${accentClass}">
        <div class="ep-row" style="margin-bottom:8px">
            <span class="ep-heading" style="color:${accentColor}!important">${accentIcon} ${accentLabel}</span>
            <span class="ep-value-lg" style="color:${accentColor}!important">${hasError ? '?' : risk}</span>
        </div>
        <div class="ep-bar-track">
            <div class="ep-bar-fill" style="width:${barWidth}%;background:${accentColor}"></div>
        </div>`;

    if (hasError) {
        html += `<div class="ep-body" style="font-weight:700!important">${rd.error}</div>
                 <div class="ep-body" style="margin-top:4px!important">Risk data temporarily unavailable.</div>`;
    } else if (hasTaintOnly) {
        html += `
        <div class="ep-body" style="font-weight:700!important;margin-bottom:4px!important">No direct abuse reports for this address.</div>
        <div class="ep-body">
            Risk score of <strong>${risk}</strong> is inherited from graph proximity —
            this address is within a few hops of a flagged entity. It does not indicate confirmed involvement.
        </div>`;
    } else if (hasReports) {
        html += `<div class="ep-grid2">
            <div><span class="ep-label">Reports</span><span class="ep-value">${rd.report_count}</span></div>
            <div><span class="ep-label">Verified</span><span class="ep-value">${rd.has_verified_reports ? '✓ Yes' : 'No'}</span></div>
            <div><span class="ep-label">Confidence</span><span class="ep-value">${(rd.avg_confidence_score * 100).toFixed(0)}%</span></div>
            <div><span class="ep-label">Lost</span><span class="ep-value">${rd.total_amount.toFixed(2)} BTC</span></div>
        </div>`;
    } else {
        html += `<div class="ep-body" style="font-weight:500!important">No abuse reports found. Address appears clean.</div>`;
    }
    html += `</div>`;

    if (hasReports && rd.categories && Object.keys(rd.categories).length > 0) {
        html += `<div class="ep-card">
            <div class="ep-heading" style="color:#b91c1c!important;margin-bottom:8px">⚠️ Reported Activities</div>
            <div>`;
        Object.entries(rd.categories).sort((a, b) => b[1] - a[1]).forEach(([cat, cnt]) => {
            html += `<div class="ep-row" style="margin-bottom:5px">
                <span class="ep-body" style="text-transform:capitalize!important;font-weight:500!important">${cat}</span>
                <span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-weight:700;font-size:9px">${cnt}</span></div>`;
        });
        html += `</div></div>`;
    }

    if (hasReports && rd.reports?.length > 0) {
        html += `<div class="ep-card" style="max-height:240px;overflow-y:auto">
            <div class="ep-heading" style="margin-bottom:8px">📋 Recent Reports</div>
            <div>`;
        rd.reports.slice(0, 5).forEach(r => {
            html += `<div class="ep-card" style="margin-bottom:6px;padding:8px!important">
                <div class="ep-row" style="margin-bottom:4px">
                    <span class="ep-body" style="color:#b91c1c!important;font-weight:700!important;text-transform:uppercase!important">${r.category}</span>
                    ${r.is_verified ? '<span class="ep-body-sm" style="color:#15803d!important;font-weight:600!important">✓ VERIFIED</span>' : '<span class="ep-body-sm">UNVERIFIED</span>'}
                </div>
                ${r.description ? `<p class="ep-body" style="margin-bottom:4px">${r.description.substring(0, 150)}${r.description.length > 150 ? '...' : ''}</p>` : ''}
                <div class="ep-row">
                    <span class="ep-body-sm">${r.blockchain || 'Bitcoin'}</span>
                    ${r.amount > 0 ? `<span class="ep-body-sm" style="color:#dc2626!important;font-weight:600!important">${r.amount} BTC lost</span>` : ''}
                </div></div>`;
        });
        if (rd.reports.length > 5)
            html += `<div class="ep-body-sm" style="text-align:center;padding-top:4px">+ ${rd.reports.length - 5} more reports</div>`;
        html += `</div></div>`;
    }

    // ── Expand Node action button ──────────────────────────────────────────
    if (isAddress) {
        const alreadyExpanded = window._expandedNodes && window._expandedNodes.has(nodeId);
        html += alreadyExpanded
            ? `<button disabled class="ep-btn-expand ep-btn-disabled">✓ Already Expanded</button>`
            : `<button onclick="window.expandNode('${nodeId}')" class="ep-btn-expand">🔍 Expand Node</button>`;
    }

    // Entity info + mempool link
    html += `
    <div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:8px">
            <span class="ep-badge" style="background:${isAddress ? '#dbeafe' : '#ede9fe'};color:${isAddress ? '#1e40af' : '#5b21b6'};border:1px solid ${isAddress ? '#bfdbfe' : '#ddd6fe'}">${nodeData.type}</span>
            ${hasReports && risk >= 70 ? `<span class="ep-badge" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5">🚨 CRITICAL RISK</span>` : ''}
            ${hasReports && risk >= 40 && risk < 70 ? `<span class="ep-badge" style="background:#ffedd5;color:#9a3412;border:1px solid #fdba74">⚠️ HIGH RISK</span>` : ''}
            ${nodeData.mixer_info?.is_mixer ? `<span class="ep-badge" style="background:#2e1065;color:#c4b5fd;border:1px solid #7c3aed">🌀 ${nodeData.mixer_info.raw?.mixer_type||'MIXER'} (${nodeData.mixer_info.confidence||0}%)</span>` : ''}
            ${nodeData.entity_type === 'exchange' || nodeData.exchange_info?.flagged ? `<span class="ep-badge" style="background:#e0f2fe;color:#075985;border:1px solid #bae6fd">🏦 EXCHANGE</span>` : ''}
            ${nodeData.entity_type === 'gambling' || nodeData.gambling_info?.flagged ? `<span class="ep-badge" style="background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe">🎰 GAMBLING</span>` : ''}
            ${nodeData.entity_type === 'mining' || nodeData.mining_info?.flagged ? `<span class="ep-badge" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a">⛏️ MINING POOL</span>` : ''}
            ${hasTaintOnly && risk >= 40 ? `<span class="ep-badge" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a">🔗 TAINT ${risk}</span>` : ''}
            <a href="https://mempool.space/${isAddress ? 'address' : 'tx'}/${encodeURIComponent(nodeData.label)}" target="_blank" rel="noopener"
               class="ep-badge ep-link" style="background:#ecfeff;border:1px solid #a5f3fc">🔍 mempool.space ↗</a>
        </div>
        <div>
            <span class="ep-label">Entity ID</span>
            <div class="ep-mono">${nodeData.label}</div>
        </div>
    </div>

    <div class="ep-divider">
        <div class="ep-heading" style="margin-bottom:10px">Network Metrics</div>
        <div class="ep-grid2">
            <div class="ep-card"><span class="ep-label">Connections</span><span class="ep-value" style="font-size:18px!important">${degree}</span></div>
            <div class="ep-card"><span class="ep-label">Neighbors</span><span class="ep-value" style="font-size:18px!important">${neighbors.size}</span></div>
            <div class="ep-card" style="background:#dcfce7!important;border-color:#bbf7d0!important">
                <span class="ep-label" style="color:#14532d!important">Received</span>
                <span class="ep-value" style="color:#14532d!important;font-size:13px!important">${totalReceived.toFixed(4)} BTC</span>
                <span class="ep-body-sm" style="color:#166534!important;display:block">${incomingTx} tx</span>
            </div>
            <div class="ep-card" style="background:#ffedd5!important;border-color:#fed7aa!important">
                <span class="ep-label" style="color:#7c2d12!important">Sent</span>
                <span class="ep-value" style="color:#7c2d12!important;font-size:13px!important">${totalSent.toFixed(4)} BTC</span>
                <span class="ep-body-sm" style="color:#9a3412!important;display:block">${outgoingTx} tx</span>
            </div>
        </div>
        <div class="ep-card" style="margin-top:8px;background:${balance >= 0 ? '#cffafe' : '#f1f5f9'}!important;border-color:${balance >= 0 ? '#a5f3fc' : '#e2e8f0'}!important">
            <span class="ep-label">Graph Balance</span>
            <span class="ep-value" style="font-size:18px!important;color:${balance >= 0 ? '#0e7490' : '#334155'}!important">${balance.toFixed(4)} BTC</span>
        </div>
    </div>`;

    // ── Detection panels (mixer / exchange / gambling / mining) ─────────────
    function mkBreakdown(entries, barColor) {
        return Object.entries(entries).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([k,v])=>{
            const pct=Math.round(v*100);
            const lbl=k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
            return `<div class="ep-breakdown-row"><span class="ep-breakdown-label">${lbl}</span><div style="display:flex;align-items:center;gap:4px"><span class="ep-minibar-track"><span class="ep-minibar-fill" style="width:${Math.min(pct*2,100)}%;background:${barColor}"></span></span><span class="ep-breakdown-pct">${pct}%</span></div></div>`;
        }).join('');
    }

    if (nodeData.mixer_info) {
        const conf=nodeData.mixer_info.confidence||0;
        const expl=nodeData.mixer_info.explanation?.length>0?nodeData.mixer_info.explanation:(nodeData.mixer_info.raw?.notes?nodeData.mixer_info.raw.notes.join('; '):'No explanation available');
        const mixerType=nodeData.mixer_info.raw?.mixer_type||'';
        const rows=mkBreakdown(nodeData.mixer_info.raw?.breakdown||{},'#6366f1');
        // Mixer-type specific accent colours and detection method source
        // Schnoering & Vazirgiannis (2023); Shojaeinasab et al. (2023)
        const MIXER_PANEL = {
            'Wasabi Wallet 1.x (CoinJoin)': { bg:'#2e1065', border:'#7c3aed', bar:'#8b5cf6', text:'#c4b5fd', method:'ZeroLink/Chaumian CoinJoin \u2014 Schnoering & Vazirgiannis (2023) \u00a72.2\u20132.3' },
            'Wasabi Wallet 2.0 (WabiSabi)': { bg:'#2e1065', border:'#6d28d9', bar:'#7c3aed', text:'#c4b5fd', method:'WabiSabi protocol, variable denominations \u2014 Schnoering & Vazirgiannis (2023) \u00a72.4' },
            'JoinMarket':                    { bg:'#083344', border:'#0891b2', bar:'#06b6d4', text:'#67e8f9', method:'Peer-coordinated CoinJoin, equal denominations, n\u22653 \u2014 Schnoering & Vazirgiannis (2023) \u00a72.1' },
            'Whirlpool (Samourai)':          { bg:'#042f2e', border:'#0e7490', bar:'#0891b2', text:'#67e8f9', method:'Fixed pool denomination, exactly 5\u00d75 structure \u2014 Schnoering & Vazirgiannis (2023) \u00a72.5' },
            'Centralized Mixer':             { bg:'#451a03', border:'#b45309', bar:'#d97706', text:'#fcd34d', method:'1-in 2-out, P2SH, >5\u00d7 output ratio, input >1 BTC \u2014 Shojaeinasab et al. (2023) \u00a73.3' },
            'Generic CoinJoin':              { bg:'#1e1b4b', border:'#4f46e5', bar:'#6366f1', text:'#a5b4fc', method:'Equal denominations, multiple participants \u2014 heuristic pattern match' },
        };
        const mp = MIXER_PANEL[mixerType] || { bg:'#1e1b4b', border:'#6366f1', bar:'#6366f1', text:'#a5b4fc', method:'Heuristic pattern match' };
        html+=`<div class="ep-card" style="background:${mp.bg};border:1px solid ${mp.border}">
            <div class="ep-row" style="margin-bottom:6px">
                <span class="ep-heading" style="color:${mp.text}!important">🌀 Coin Mixer / CoinJoin</span>
                <span class="ep-body-sm">Conf: <strong style="color:${mp.text}">${conf}%</strong></span>
            </div>
            ${mixerType?`<div class="ep-body" style="font-weight:700!important;color:${mp.text}!important;margin-bottom:2px">${mixerType}</div>`:''}
            ${mixerType?`<div class="ep-body" style="font-size:9px;color:#94a3b8;margin-bottom:6px;font-style:italic">${mp.method}</div>`:''}
            <div class="ep-bar-track"><div class="ep-bar-fill" style="width:${conf}%;background:${mp.bar}"></div></div>
            <div class="ep-body" style="margin-bottom:6px">${expl}</div>
            ${rows?`<div style="border-top:1px solid ${mp.border};padding-top:6px">${rows}</div>`:''}
            <div class="ep-footer" style="background:${mp.bg};color:${mp.text};border-top:1px solid ${mp.border}">⚠️ Mixer transactions deliberately obscure the origin of funds. Tracing beyond this point is unreliable.</div>
        </div>`;
    }
    if (nodeData.exchange_info?.flagged||nodeData.entity_type==='exchange') {
        const ei=nodeData.exchange_info||{};
        const ec=Math.round((ei.score||0)*100);
        const en2=(ei.notes||[]).join('; ')||'Exchange / custodial service pattern detected.';
        const ename=nodeData.label&&nodeData.label!==nodeId?nodeData.label:null;
        const rows=mkBreakdown(ei.breakdown||{},'#0ea5e9');
        html+=`<div class="ep-card ep-card-accent-sky">
            <div class="ep-row" style="margin-bottom:6px"><span class="ep-heading" style="color:#075985!important">🏦 Exchange / Custodial Service</span><span class="ep-body-sm">Conf: <strong style="color:#075985">${ec}%</strong></span></div>
            ${ename?`<div class="ep-body" style="font-weight:700!important;color:#0c4a6e!important;margin-bottom:4px">${ename}</div>`:''}
            <div class="ep-bar-track"><div class="ep-bar-fill" style="width:${ec}%;background:#0ea5e9"></div></div>
            <div class="ep-body" style="margin-bottom:6px">${en2}</div>
            ${rows?`<div style="border-top:1px solid #e2e8f0;padding-top:6px">${rows}</div>`:''}
            <div class="ep-footer" style="background:#e0f2fe;color:#075985">ℹ️ Funds entering an exchange may be harder to trace. Exchanges apply KYC and may respond to legal requests.</div>
        </div>`;
    }
    if (nodeData.gambling_info?.flagged||nodeData.entity_type==='gambling') {
        const gi=nodeData.gambling_info||{};
        const gc=Math.round((gi.score||0)*100);
        const gn=(gi.notes||[]).join('; ')||'Gambling / gaming service pattern detected.';
        const rows=mkBreakdown(gi.breakdown||{},'#8b5cf6');
        html+=`<div class="ep-card ep-card-accent-violet">
            <div class="ep-row" style="margin-bottom:6px"><span class="ep-heading" style="color:#5b21b6!important">🎰 Gambling / Gaming Service</span><span class="ep-body-sm">Conf: <strong style="color:#5b21b6">${gc}%</strong></span></div>
            <div class="ep-bar-track"><div class="ep-bar-fill" style="width:${gc}%;background:#8b5cf6"></div></div>
            <div class="ep-body" style="margin-bottom:6px">${gn}</div>
            ${rows?`<div style="border-top:1px solid #e2e8f0;padding-top:6px">${rows}</div>`:''}
            <div class="ep-footer" style="background:#ede9fe;color:#5b21b6">ℹ️ Gambling services are often unlicensed. Funds may be commingled and hard to attribute.</div>
        </div>`;
    }
    if (nodeData.mining_info?.flagged||nodeData.entity_type==='mining') {
        const mi=nodeData.mining_info||{};
        const mc=Math.round((mi.score||0)*100);
        const mn=(mi.notes||[]).join('; ')||'Mining pool pattern detected.';
        const rows=mkBreakdown(mi.breakdown||{},'#f59e0b');
        html+=`<div class="ep-card ep-card-accent-amber2">
            <div class="ep-row" style="margin-bottom:6px"><span class="ep-heading" style="color:#92400e!important">⛏️ Mining Pool</span><span class="ep-body-sm">Conf: <strong style="color:#92400e">${mc}%</strong></span></div>
            <div class="ep-bar-track"><div class="ep-bar-fill" style="width:${mc}%;background:#f59e0b"></div></div>
            <div class="ep-body" style="margin-bottom:6px">${mn}</div>
            ${rows?`<div style="border-top:1px solid #e2e8f0;padding-top:6px">${rows}</div>`:''}
            <div class="ep-footer" style="background:#fef3c7;color:#92400e">ℹ️ Coinbase flows through mining pools — generally benign unless co-mingled with flagged funds.</div>
        </div>`;
    }

    // Tx history
    html += `<div class="ep-divider">
        <div class="ep-heading" style="margin-bottom:10px">🕒 Transaction History</div>`;
    if (txEvents.length > 0) {
        html += `<div style="display:flex;flex-direction:column;gap:5px;max-height:210px;overflow-y:auto">`;
        txEvents.forEach(tx => {
            const dt  = new Date(tx.ts * 1000);
            const d8  = dt.toISOString().split('T')[0];
            const t8  = dt.toISOString().split('T')[1].substring(0, 8) + ' UTC';
            const p   = (tx.peer || '').toString();
            const dp  = p.length > 18 ? p.substring(0, 18) + '…' : p;
            const isIn = tx.dir === 'in';
            html += `<div class="ep-tx-row">
                <span class="${isIn ? 'ep-green' : 'ep-red'}" style="font-size:11px;font-weight:700;margin-top:1px">${isIn ? '▼' : '▲'}</span>
                <div style="flex:1;min-width:0">
                    <div class="ep-row">
                        <span class="ep-body" style="font-weight:700!important;color:${isIn?'#14532d':'#7c2d12'}!important">${isIn?'+':'-'}${tx.amount.toFixed(4)} BTC</span>
                        <span class="ep-body-sm" style="font-family:monospace;white-space:nowrap">${t8}</span>
                    </div>
                    <div class="ep-body-sm" style="font-family:monospace;margin-top:2px">${d8}</div>
                    <div class="ep-body-sm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isIn?'from':'to'}: <span style="font-family:monospace;color:#334155">${dp}</span></div>
                </div></div>`;
        });
        html += `</div>`;
    } else {
        html += `<div class="ep-body-sm" style="font-style:italic">No timestamp data on connected edges.</div>`;
    }
    html += `</div>`;

    // ── Annotations (notes + color) ──────────────────────────────────────────
    const annot = getAnnotation(nodeId) || {};
    const customName = annot.name || '';
    const customColor = annot.color || '';
    const customNotes = annot.notes || '';

    html += `
    <div class="ep-divider">
        <div class="ep-heading" style="margin-bottom:10px">📝 Your Annotations</div>
        <div style="margin-bottom:10px">
            <span class="ep-label">Display Name</span>
            <input type="text" id="nodeName" placeholder="Custom display name..." class="ep-input" value="${customName}">
        </div>
        <div style="margin-bottom:10px">
            <span class="ep-label">Notes</span>
            <textarea id="nodeNotes" placeholder="Add personal notes about this node..." class="ep-input">${customNotes}</textarea>
        </div>
        <div style="margin-bottom:10px">
            <span class="ep-label">Node Color</span>
            <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:6px">
                ${COLOR_PALETTE.map(col => `<button onclick="window.setNodeColor('${nodeId}','${col.hex}')"
                    style="width:30px;height:30px;border-radius:5px;border:2px solid ${customColor===col.hex?'#1e293b':'#cbd5e1'};background:${col.hex};cursor:pointer" title="${col.name}"></button>`).join('')}
                <button onclick="window.clearNodeColor('${nodeId}')"
                    style="width:30px;height:30px;border-radius:5px;border:2px solid ${!customColor?'#1e293b':'#cbd5e1'};background:#f1f5f9;font-size:10px;font-weight:700;cursor:pointer;color:#334155" title="Default">✓</button>
            </div>
        </div>
        <button onclick="window.saveNodeAnnotation('${nodeId}')" class="ep-btn-primary">💾 Save Annotations</button>
    </div>`;

    // ── Live mempool enrichment block ────────────────────────────────────────
    const enrichFn = isAddress
        ? `window.enrichFromMempool('${nodeId}', '${nodeData.label}')`
        : `window.enrichTxFromMempool('${nodeData.label}')`;

    html += `
    <div class="ep-divider">
        <div class="ep-row" style="margin-bottom:10px">
            <div class="ep-heading">🌐 Live On-Chain Data</div>
            <button id="btnFetchMempool" onclick="${enrichFn}" class="ep-btn-primary" style="width:auto!important;padding:5px 12px!important">⬇ Fetch</button>
        </div>
        <div id="mempoolEnrichContent" class="ep-body-sm" style="font-style:italic">
            Click "Fetch" to pull live data from mempool.space.
        </div>
    </div>`;

    // ── Intelligence Sources + Cross-Validation ─────────────────────────────
    // Source definitions — what each provider contributes and its limitations.
    const SRC_DEF = {
        'ChainAbuse':    {
            icon:'🚨', label:'ChainAbuse',
            url:(id,isA)=>`https://www.chainabuse.com/address/${id}`,
            provides:'Community abuse reports: scams, ransomware, phishing, darknet.',
            caveat:'Crowdsourced — absence of a report ≠ clean address.',
            keyNeeded: true,   // needs caKey
            forTx: false,
        },
        'WalletExplorer': {
            icon:'🏷️', label:'WalletExplorer',
            url:(id,isA)=>`https://www.walletexplorer.com/address/${id}`,
            provides:'Deterministic attribution labels for known exchanges, pools & mixers.',
            caveat:'Label database frozen since 2016 — post-2016 services are unlisted.',
            keyNeeded: false,
            forTx: false,
        },
        'Esplora API':   {
            icon:'🔗', label:'Blockstream',
            url:(id,isA)=>isA?`https://blockstream.info/address/${id}`:`https://blockstream.info/tx/${id}`,
            provides:'Ground-truth on-chain data: confirmed TXs, UTXOs, balance, script types.',
            caveat:'Only 50 most-recent TXs returned. Cannot identify the entity behind an address.',
            keyNeeded: false,
            forTx: true,
        },
        'Bitquery':      {
            icon:'📡', label:'Bitquery',
            url:(id,isA)=>isA?`https://explorer.bitquery.io/bitcoin/address/${id}`:`https://explorer.bitquery.io/bitcoin/tx/${id}`,
            provides:'Extended historical flow graph: inflows & outflows beyond Blockstream\'s 50-TX window.',
            caveat:'Requires a paid API key. May lag a few blocks on high-traffic periods.',
            keyNeeded: true,   // needs bqKey
            forTx: true,
        },
        'mempool.space': {
            icon:'⛓️', label:'Mempool.space',
            url:(id,isA)=>isA?`https://mempool.space/address/${id}`:`https://mempool.space/tx/${id}`,
            provides:'Real-time mempool state: pending TXs, UTXO set, live balance & fee rates.',
            caveat:'Public rate limits apply. Unconfirmed TX data may change before confirmation.',
            keyNeeded: false,
            forTx: true,
        },
        'Local DB':      {
            icon:'🗄️', label:'Local Neo4j DB', url:null,
            provides:'Cached graph data from previous investigations stored locally.',
            caveat:'Data may be stale. Re-investigate to refresh against live sources.',
            keyNeeded: false, forTx: true,
        },
        'Initial Query': {
            icon:'🎯', label:'Initial Query', url:null,
            provides:'The seed address entered by the investigator to start this investigation.',
            caveat:'No external data — this is the investigation starting point.',
            keyNeeded: false, forTx: false,
        },
    };

    const VERIFIABLE = new Set(['ChainAbuse','WalletExplorer','Esplora API','Bitquery']);

    // ── Always-show source list ───────────────────────────────────────────────
    // Build the list of sources that should ALWAYS appear for this node,
    // regardless of what the backend returned in node.sources.
    // This ensures newly-discovered nodes always show all applicable source cards
    // even before enrichment completes.
    //
    // hasCaKey / hasBqKey are read from the DOM config status indicators.
    const hasCaKey = document.querySelector('[data-ca-key]')?.dataset?.caKey === 'true'
        || (nodeData.risk_data != null)                // key was used — has risk data
        || (nodeData.sources || []).includes('ChainAbuse'); // backend confirmed it
    const hasBqKey = (nodeData.sources || []).includes('Bitquery');

    // All sources that are relevant for this node type
    const alwaysShowSources = [];
    if ((nodeData.sources||[]).includes('Initial Query')) alwaysShowSources.push('Initial Query');
    alwaysShowSources.push('Esplora API');         // always — every node has on-chain data
    if (isAddress) alwaysShowSources.push('WalletExplorer'); // always for addresses
    if (isAddress && hasCaKey) alwaysShowSources.push('ChainAbuse');
    if (hasBqKey) alwaysShowSources.push('Bitquery');
    if ((nodeData.sources||[]).includes('mempool.space')) alwaysShowSources.push('mempool.space');
    if ((nodeData.sources||[]).includes('Local DB')) alwaysShowSources.push('Local DB');

    // Merge: union of what backend reported AND what we always want to show
    const mergedSources = [...new Set([
        ...(nodeData.sources || []),
        ...alwaysShowSources,
    ])];

    // Status of each source: 'queried' | 'not_queried' | 'no_key'
    const activeSrcSet = new Set(nodeData.sources || []);
    const srcStatus = (s) => {
        if (activeSrcSet.has(s)) return 'queried';
        const d = SRC_DEF[s];
        if (d?.keyNeeded) return 'no_key';
        return 'not_queried';
    };

    {
        // ── 1. Source cards ───────────────────────────────────────────────────
        const sourceCards = mergedSources.map(s => {
            const d = SRC_DEF[s] || {icon:'📄',label:s,url:null,provides:'Unknown source.',caveat:'',keyNeeded:false,forTx:true};
            const rawUrl  = d.url ? d.url(nodeId, isAddress) : null;
            const safeUrl = rawUrl ? rawUrl.replace(/'/g,'%27') : null;
            const canVerify = VERIFIABLE.has(s);
            const status    = srcStatus(s);
            const cardId    = `src-card-${s.replace(/[^a-z0-9]/gi,'-')}`;
            const resultId  = `src-result-${s.replace(/[^a-z0-9]/gi,'-')}`;

            // Status badge
            let statusBadge = '';
            if (status === 'queried') {
                statusBadge = `<span style="font-size:7px;font-weight:700;color:#065f46;background:#dcfce7;border:1px solid #86efac;border-radius:3px;padding:1px 5px">✓ Queried</span>`;
            } else if (status === 'no_key') {
                statusBadge = `<span style="font-size:7px;font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:3px;padding:1px 5px">Key needed</span>`;
            } else {
                statusBadge = `<span style="font-size:7px;font-weight:700;color:#1d4ed8;background:#dbeafe;border:1px solid #bfdbfe;border-radius:3px;padding:1px 5px">Not yet checked</span>`;
            }

            const openBtn = safeUrl
                ? `<button onclick="window.open('${safeUrl}','_blank','noopener,noreferrer')"
                      title="Open ${nodeId} on ${d.label}"
                      style="padding:3px 8px;border-radius:4px;border:1px solid #bae6fd;
                             background:#f0f9ff;color:#0e7490;font-size:8px;font-weight:700;
                             cursor:pointer;white-space:nowrap">Open ↗</button>`
                : '';

            const verifyBtn = (canVerify && status !== 'no_key')
                ? `<button id="vbtn-${cardId}"
                      onclick="window.verifySource('${nodeId}','${s}',${isAddress})"
                      title="Live-query this source right now"
                      style="padding:3px 8px;border-radius:4px;border:1px solid #d1fae5;
                             background:#f0fdf4;color:#065f46;font-size:8px;font-weight:700;
                             cursor:pointer;white-space:nowrap">Verify ↻</button>`
                : '';

            const dimmed = status !== 'queried' ? 'opacity:0.75' : '';

            return `<div id="${cardId}"
                style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:9px 10px;${dimmed}">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
                    <span style="font-size:13px;flex-shrink:0">${d.icon}</span>
                    <span class="ep-body" style="font-weight:700!important;color:#0f172a!important;flex:1">${d.label}</span>
                    ${statusBadge}
                    <div style="display:flex;gap:4px;flex-shrink:0;margin-left:auto">${verifyBtn}${openBtn}</div>
                </div>
                <div class="ep-body-sm" style="color:#334155!important;padding-left:21px;margin-bottom:2px">${d.provides}</div>
                <div class="ep-body-sm" style="color:#94a3b8!important;padding-left:21px;font-style:italic">⚠ ${d.caveat}</div>
                <div id="${resultId}" style="margin-top:0"></div>
            </div>`;
        }).join('');

        // ── 2. Cross-validation engine ────────────────────────────────────────
        const findings = [];
        const hasCA    = activeSrcSet.has('ChainAbuse');
        const hasWE    = activeSrcSet.has('WalletExplorer');
        const hasBS    = activeSrcSet.has('Esplora API');
        const hasBQ    = activeSrcSet.has('Bitquery');
        const risk      = nodeData.risk || 0;
        const rd        = nodeData.risk_data;
        const hasReports = rd && rd.report_count > 0;
        const label      = nodeData.label && nodeData.label !== nodeId ? nodeData.label : '';
        const eType      = nodeData.entity_type || 'unknown';
        const mixerFlagged  = nodeData.mixer_info?.is_mixer;
        const exchFlagged   = nodeData.exchange_info?.flagged || eType === 'exchange';
        const gambleFlagged = nodeData.gambling_info?.flagged || eType === 'gambling';
        const mineFlagged   = nodeData.mining_info?.flagged   || eType === 'mining';
        const clusterSize   = nodeData.cluster_size || 1;

        if (mixerFlagged && hasCA && rd?.categories?.['mixer'] > 0)
            findings.push({type:'agree',icon:'✅',weight:3,text:`<strong>Mixing confirmed by 2 independent sources.</strong> On-chain heuristics (${nodeData.mixer_info.raw?.mixer_type||'CoinJoin'}) and ChainAbuse community reports both flag mixer activity.`});
        else if (mixerFlagged && hasCA && !hasReports)
            findings.push({type:'info',icon:'🔍',weight:1,text:`Behavioral analysis flags mixing patterns but ChainAbuse has no reports. Heuristic detection only.`});
        if (label && exchFlagged && hasWE)
            findings.push({type:'agree',icon:'✅',weight:3,text:`<strong>Exchange identity corroborated.</strong> WalletExplorer label "<em>${label}</em>" and behavioral analysis both classify this as a custodial service.`});
        else if (label && !exchFlagged && hasWE && hasBS)
            findings.push({type:'agree',icon:'✅',weight:2,text:`<strong>WalletExplorer and on-chain data agree:</strong> Label "<em>${label}</em>" assigned with no conflicting behavioral flags.`});
        if (mineFlagged && hasBS)
            findings.push({type:'agree',icon:'✅',weight:2,text:`<strong>Mining pool corroborated.</strong> Blockstream coinbase inputs and behavioral heuristics both confirm mining pool activity.`});
        if (gambleFlagged && hasCA && hasReports)
            findings.push({type:'agree',icon:'✅',weight:2,text:`<strong>Gambling confirmed by 2 sources.</strong> Behavioral heuristics and ChainAbuse reports align on gambling classification.`});
        if (hasReports && risk >= 70 && (mixerFlagged || exchFlagged || gambleFlagged))
            findings.push({type:'agree',icon:'✅',weight:3,text:`<strong>High-risk classification corroborated.</strong> ChainAbuse (score ${risk}/100) aligns with behavioral pattern detection — multiple signals converge.`});
        if (!hasReports && !mixerFlagged && !exchFlagged && !gambleFlagged && !mineFlagged && risk === 0 && activeSrcSet.size >= 2)
            findings.push({type:'agree',icon:'✅',weight:2,text:`<strong>${activeSrcSet.size} sources cross-checked — no risk signals found.</strong> No abuse reports, no behavioral flags, no known-entity label.`});
        if (clusterSize > 1 && hasBS)
            findings.push({type:'agree',icon:'✅',weight:2,text:`<strong>Co-spend cluster corroborated.</strong> Blockstream inputs link this address to <strong>${clusterSize}</strong> addresses in the same wallet cluster.`});
        if (hasBQ && hasBS)
            findings.push({type:'agree',icon:'✅',weight:1,text:`Bitquery historical flows and Blockstream on-chain data both active. Cross-referencing improves tracing confidence.`});
        if (label && hasWE && hasReports && risk >= 40)
            findings.push({type:'conflict',icon:'⚠️',weight:4,text:`<strong>Attribution conflict.</strong> WalletExplorer labels this "<em>${label}</em>" (known service), yet ChainAbuse holds <strong>${rd.report_count} report(s)</strong> for: ${Object.keys(rd?.categories||{}).join(', ')||'unknown'}. May indicate a compromised account or mislabeled address.`});
        if (mixerFlagged && exchFlagged)
            findings.push({type:'conflict',icon:'⚠️',weight:3,text:`<strong>Behavioural conflict.</strong> TX patterns match both a <em>coin mixer</em> and an <em>exchange</em>. Could indicate a mixer operating through exchange infrastructure.`});
        if (hasReports && risk >= 50 && label && hasWE && !exchFlagged)
            findings.push({type:'conflict',icon:'⚠️',weight:3,text:`<strong>Source disagreement on risk.</strong> WalletExplorer identifies "<em>${label}</em>" as a known entity, but ChainAbuse risk score is <strong>${risk}/100</strong>. Investigate whether the label is outdated.`});
        if (risk > 0 && !hasReports && !label && activeSrcSet.size >= 2)
            findings.push({type:'conflict',icon:'⚠️',weight:2,text:`<strong>Taint risk not independently confirmed.</strong> Risk score <strong>${risk}</strong> is inherited via graph proximity — no direct abuse reports or attribution exist for this address.`});
        if (hasCA && !hasReports && risk === 0)
            findings.push({type:'gap',icon:'ℹ️',weight:0,text:`ChainAbuse queried — zero reports found. Coverage depends on community submissions; may miss recent or obscure schemes.`});
        if (hasWE && !label)
            findings.push({type:'gap',icon:'ℹ️',weight:0,text:`WalletExplorer returned no label. The address may be an individual wallet, an unlisted service, or active after the 2016 label freeze.`});
        if (!hasBQ)
            findings.push({type:'gap',icon:'ℹ️',weight:0,text:`Bitquery not configured — only Blockstream's 50 most-recent TXs are available. Add a Bitquery API key in Settings for full historical flow coverage.`});
        if (!hasCA && isAddress)
            findings.push({type:'gap',icon:'ℹ️',weight:0,text:`ChainAbuse key not set — automated risk scoring disabled. Use the <strong>Open ↗</strong> button on the ChainAbuse card above to manually check this address, or add your key in Settings.`});

        findings.sort((a,b)=>b.weight-a.weight);
        const FSTYLE = {
            agree:   {bg:'#f0fdf4',border:'#86efac',ic:'#15803d',tx:'#14532d'},
            conflict:{bg:'#fff7ed',border:'#fdba74',ic:'#c2410c',tx:'#7c2d12'},
            gap:     {bg:'#f8fafc',border:'#e2e8f0',ic:'#64748b',tx:'#475569'},
            info:    {bg:'#eff6ff',border:'#bfdbfe',ic:'#1d4ed8',tx:'#1e3a8a'},
        };
        const findingRows = findings.map(f=>{
            const st=FSTYLE[f.type]||FSTYLE.info;
            return `<div style="display:flex;gap:8px;align-items:flex-start;background:${st.bg};border:1px solid ${st.border};border-radius:6px;padding:8px 10px">
                <span style="font-size:11px;flex-shrink:0;margin-top:1px;color:${st.ic}">${f.icon}</span>
                <div class="ep-body-sm" style="color:${st.tx}!important;line-height:1.5!important">${f.text}</div>
            </div>`;
        }).join('');
        const agreeCount   = findings.filter(f=>f.type==='agree').length;
        const conflictCount= findings.filter(f=>f.type==='conflict').length;
        const summaryColor = conflictCount>0?'#c2410c':agreeCount>0?'#15803d':'#475569';
        const summaryBg    = conflictCount>0?'#fff7ed':agreeCount>0?'#f0fdf4':'#f8fafc';
        const summaryBorder= conflictCount>0?'#fdba74':agreeCount>0?'#86efac':'#e2e8f0';
        const summaryText  = conflictCount>0
            ? `${conflictCount} conflict${conflictCount>1?'s':''} detected — review carefully`
            : agreeCount>0 ? `${agreeCount} agreement${agreeCount>1?'s':''} — findings corroborated`
            : 'Insufficient data for cross-validation';

        html += `<div class="ep-divider">
            <div class="ep-heading" style="margin-bottom:8px">🔍 Intelligence Sources</div>
            <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:12px">${sourceCards}</div>
            <div style="display:flex;align-items:center;gap:6px;background:${summaryBg};border:1px solid ${summaryBorder};border-radius:6px;padding:7px 10px;margin-bottom:8px">
                <span style="font-size:11px;color:${summaryColor}">${conflictCount>0?'⚠️':agreeCount>0?'✅':'ℹ️'}</span>
                <span class="ep-body" style="font-weight:700!important;color:${summaryColor}!important">Cross-validation: ${summaryText}</span>
            </div>
            ${findingRows?`<div style="display:flex;flex-direction:column;gap:5px">${findingRows}</div>`:''}
        </div>`;
    }
    html += `</div>`; // close ep-wrap
    document.getElementById('entityContent').innerHTML = html;
    document.getElementById('liveView').classList.add('hidden');
    document.getElementById('entityView').classList.remove('hidden');
}

export function closeEntityView() {
    document.getElementById('entityView').classList.add('hidden');
    document.getElementById('liveView').classList.remove('hidden');
}

// =============================================================================
// LIVE SOURCE VERIFICATION
// =============================================================================
// Called when the user clicks "Verify ↻" on a source card.
// Hits GET /api/verify/:address?source=X and renders the result inline.
window.verifySource = async function(nodeId, sourceName, isAddress) {
    const cardId   = `src-card-${sourceName.replace(/[^a-z0-9]/gi,'-')}`;
    const resultId = `src-result-${sourceName.replace(/[^a-z0-9]/gi,'-')}`;
    const btnId    = `vbtn-${cardId}`;

    const resultEl = document.getElementById(resultId);
    const btnEl    = document.getElementById(btnId);
    if (!resultEl) return;

    // Map source names to backend keys
    const SOURCE_KEY = {
        'ChainAbuse':  'chainabuse',
        'WalletExplorer': 'walletexplorer',
        'Esplora API': 'blockstream',
        'Bitquery':    'bitquery',
    };
    const key = SOURCE_KEY[sourceName];
    if (!key) return;

    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⟳…'; }
    resultEl.style.marginTop = '8px';
    resultEl.innerHTML = `<div style="font-size:8px;color:#475569;font-style:italic;padding:4px 0 0 21px">Querying ${sourceName}…</div>`;

    try {
        const url = `/api/verify/${encodeURIComponent(nodeId)}?source=${key}&is_address=${isAddress}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();

        let bg, border, icon, textColor, body;

        if (!data.ok) {
            // API key missing or request failed
            bg='#fff7ed'; border='#fdba74'; icon='⚠️'; textColor='#7c2d12';
            body = `<strong>${data.error || 'Verification failed'}</strong>`;
        } else if (!data.found) {
            // Source responded but found nothing
            bg='#f0fdf4'; border='#86efac'; icon='✅'; textColor='#14532d';
            body = data.summary || 'No data found — address appears clean on this source.';
        } else {
            // Source returned positive data
            bg='#eff6ff'; border='#bfdbfe'; icon='🔍'; textColor='#1e3a8a';
            body = data.summary || 'Data found.';

            // Source-specific detail rows
            const rows = [];
            if (key === 'chainabuse') {
                rows.push(`Reports: <strong>${data.report_count}</strong>`);
                rows.push(`Risk score: <strong>${data.risk_score}/100</strong>`);
                if (data.highest_risk) rows.push(`Highest category: <strong>${data.highest_risk}</strong>`);
                if (data.verified)     rows.push(`✓ Verified reports`);
                if (data.risk_score >= 70) { bg='#fef2f2'; border='#fca5a5'; icon='🚨'; textColor='#7f1d1d'; }
                else if (data.risk_score >= 40) { bg='#fff7ed'; border='#fdba74'; icon='⚠️'; textColor='#7c2d12'; }
            }
            if (key === 'walletexplorer' && data.label) {
                rows.push(`Label: <strong>${data.label}</strong>`);
            }
            if (key === 'blockstream') {
                if (data.tx_count !== undefined) rows.push(`Confirmed TXs: <strong>${data.tx_count}</strong>`);
                if (data.balance  !== undefined) rows.push(`Balance: <strong>${(data.balance/1e8).toFixed(8)} BTC</strong>`);
            }
            if (key === 'bitquery') {
                rows.push(`Total flow edges: <strong>${data.total}</strong>`);
                rows.push(`Inflows: <strong>${data.inflows}</strong> · Outflows: <strong>${data.outflows}</strong>`);
                rows.push(`Total in: <strong>${(data.total_in||0).toFixed(6)} BTC</strong> · out: <strong>${(data.total_out||0).toFixed(6)} BTC</strong>`);
            }
            if (rows.length > 0) {
                body += `<div style="margin-top:4px;display:flex;flex-direction:column;gap:2px">
                    ${rows.map(r=>`<div class="ep-body-sm" style="color:${textColor}!important">${r}</div>`).join('')}
                </div>`;
            }

            // Update node source list in live graph data so cross-validation picks it up
            if (window.state?.fullGraphData?.nodes?.[nodeId]) {
                const n = window.state.fullGraphData.nodes[nodeId];
                if (!n.sources) n.sources = [];
                if (!n.sources.includes(sourceName)) n.sources.push(sourceName);
            }
        }

        resultEl.innerHTML = `
            <div style="display:flex;gap:6px;align-items:flex-start;background:${bg};
                        border:1px solid ${border};border-radius:5px;
                        padding:7px 8px;margin-top:6px;margin-left:0">
                <span style="font-size:10px;flex-shrink:0;margin-top:1px">${icon}</span>
                <div class="ep-body-sm" style="color:${textColor}!important;line-height:1.5!important">${body}</div>
            </div>`;

    } catch (err) {
        resultEl.innerHTML = `
            <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:5px;padding:6px 8px;margin-top:6px">
                <div class="ep-body-sm" style="color:#7f1d1d!important">⚠ ${err.name === 'TimeoutError' ? 'Request timed out' : err.message}</div>
            </div>`;
    } finally {
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Verify ↻'; }
    }
};

export async function enrichFromMempool(nodeId, address) {
    const el  = document.getElementById('mempoolEnrichContent');
    const btn = document.getElementById('btnFetchMempool');
    if (!el) return;

    btn.disabled = true;
    btn.innerHTML = '⟳ Loading…';
    el.innerHTML = `<div style="font-size:9px;color:#475569;font-style:italic">Querying mempool.space…</div>`;

    try {
        const [addrData, utxos, txs] = await Promise.all([
            mempoolGetAddress(address), mempoolGetUTXOs(address), mempoolGetTxs(address)
        ]);

        const cs = addrData.chain_stats   || {};
        const ms = addrData.mempool_stats || {};
        const confirmedBal = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
        const mempoolBal   = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);

        const C  = 'class="ep-card"';
        const C2 = 'class="ep-card ep-grid2-span"';

        const recentTxRows = (txs || []).slice(0, 5).map(tx => {
            const confirmed = tx.status?.confirmed;
            const sizeVb    = tx.weight ? Math.ceil(tx.weight / 4) : (tx.size || 0);
            const feeRate   = sizeVb ? (tx.fee / sizeVb).toFixed(1) : '?';
            const time      = tx.status?.block_time
                ? new Date(tx.status.block_time * 1000).toISOString().split('T')[0]
                : 'Unconfirmed';
            return `<div class="ep-row" style="padding:5px 0;border-bottom:1px solid #f1f5f9">
                <div>
                    <a href="https://mempool.space/tx/${tx.txid}" target="_blank" class="ep-link" style="font-family:monospace">${tx.txid.substring(0, 14)}…</a>
                    <div class="ep-body-sm">${time} ${confirmed ? `· Block #${tx.status.block_height}` : '· ⏳ Mempool'}</div>
                </div>
                <div style="text-align:right;margin-left:8px">
                    <div class="ep-body" style="font-weight:700!important">${(tx.fee || 0).toLocaleString()} sat</div>
                    <div class="ep-body-sm">${feeRate} sat/vB</div>
                </div></div>`;
        }).join('');

        const utxoRows = (utxos || []).slice(0, 5).map(u => `
            <div class="ep-row" style="padding:5px 0;border-bottom:1px solid #f1f5f9">
                <div>
                    <a href="https://mempool.space/tx/${u.txid}" target="_blank" class="ep-link" style="font-family:monospace">${u.txid.substring(0, 14)}…:${u.vout}</a>
                    <div class="ep-body-sm">${u.status?.confirmed ? '✅ Confirmed' : '⏳ Unconfirmed'}</div>
                </div>
                <div class="ep-body" style="font-weight:700!important;color:#14532d!important;margin-left:8px">${satsToBTC(u.value)} BTC</div>
            </div>`).join('');

        el.innerHTML = `
        <div class="ep-grid2" style="margin-bottom:10px">
            <div class="ep-card"><span class="ep-label">Confirmed Balance</span><span class="ep-value">${satsToBTC(confirmedBal)} BTC</span></div>
            <div class="ep-card"><span class="ep-label">Mempool Δ</span><span class="ep-value" style="color:${mempoolBal >= 0 ? '#14532d' : '#991b1b'}!important">${mempoolBal >= 0 ? '+' : ''}${satsToBTC(mempoolBal)} BTC</span></div>
            <div class="ep-card"><span class="ep-label">Total TXs</span><span class="ep-value">${(cs.tx_count || 0).toLocaleString()}</span></div>
            <div class="ep-card"><span class="ep-label">Pending TXs</span><span class="ep-value" style="color:${ms.tx_count > 0 ? '#92400e' : '#475569'}!important">${ms.tx_count > 0 ? ms.tx_count + ' pending' : 'None'}</span></div>
            <div class="ep-card"><span class="ep-label">UTXOs</span><span class="ep-value">${(utxos || []).length}</span></div>
            <div class="ep-card"><span class="ep-label">Total Received</span><span class="ep-value">${satsToBTC(cs.funded_txo_sum || 0)} BTC</span></div>
        </div>
        ${recentTxRows ? `
        <div style="margin-bottom:10px">
            <div class="ep-heading" style="margin-bottom:6px">Recent Transactions</div>
            <div class="ep-card">${recentTxRows}</div>
        </div>` : ''}
        ${utxoRows ? `
        <div style="margin-bottom:6px">
            <div class="ep-heading" style="margin-bottom:6px">UTXOs (Unspent Outputs)</div>
            <div class="ep-card">${utxoRows}</div>
            ${(utxos || []).length > 5 ? `<div class="ep-body-sm" style="text-align:center;margin-top:4px">+ ${utxos.length - 5} more UTXOs</div>` : ''}
        </div>` : `<div class="ep-body-sm" style="font-style:italic">No UTXOs — fully spent address.</div>`}
        <div style="margin-top:8px;text-align:right">
            <a href="https://mempool.space/address/${encodeURIComponent(address)}" target="_blank" class="ep-link">Full history on mempool.space ↗</a>
        </div>`;

    } catch (err) {
        el.innerHTML = `<div class="ep-body" style="color:#dc2626!important;font-weight:700!important">⚠️ ${err.message}</div>
            <div class="ep-body-sm" style="margin-top:4px">mempool.space may be unreachable or rate-limited.</div>`;
    }

    btn.disabled = false;
    btn.innerHTML = '⟳ Refresh';
}

// =============================================================================
// LIVE MEMPOOL ENRICHMENT — TRANSACTION
// =============================================================================
export async function enrichTxFromMempool(txid) {
    const el  = document.getElementById('mempoolEnrichContent');
    const btn = document.getElementById('btnFetchMempool');
    if (!el) return;

    btn.disabled = true;
    btn.innerHTML = '⟳ Loading…';
    el.innerHTML = `<div style="font-size:9px;color:#475569;font-style:italic">Querying mempool.space…</div>`;

    try {
        const tx = await mempoolGetTx(txid);
        const confirmed = tx.status?.confirmed;
        const sizeVb    = tx.weight ? Math.ceil(tx.weight / 4) : (tx.size || 0);
        const feeRate   = sizeVb ? (tx.fee / sizeVb).toFixed(2) : '?';
        const totalOut  = (tx.vout || []).reduce((s, v) => s + (v.value || 0), 0);
        const blockTime = tx.status?.block_time
            ? new Date(tx.status.block_time * 1000).toLocaleString() : '—';

        const C  = 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px';
        const C2 = 'background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;grid-column:span 2';
        const L  = 'font-size:8px;color:#475569;font-weight:600;text-transform:uppercase;margin-bottom:2px';
        const V  = 'font-size:10px;font-weight:700;color:#0f172a';

        let projectionHTML = '';
        if (!confirmed) {
            try {
                const projections = await mempoolGetTxProjection(txid);
                if (projections && projections.length > 0) {
                    const p = projections[0];
                    projectionHTML = `
                    <div class="ep-card ep-grid2-span" style="background:#fefce8!important;border-color:#fde68a!important;margin-bottom:8px">
                        <span class="ep-label" style="color:#92400e!important">🔮 Mempool Projection</span>
                        <div class="ep-value" style="color:#78350f!important">
                            Projected for Block <span style="font-family:monospace">~#${p.blockHeight.toLocaleString()}</span>
                        </div>
                        <div class="ep-body-sm" style="margin-top:2px">Position: <span style="font-family:monospace">${p.positionInBlock}%</span> · Fee Rate: <span style="font-family:monospace">${p.feerate.toFixed(1)} sat/vB</span></div>
                    </div>`;
                }
            } catch (projErr) {
                console.warn('Could not fetch mempool projection:', projErr);
            }
        }

        const inputRows = (tx.vin || []).slice(0, 5).map(inp => {
            const addr = inp.prevout?.scriptpubkey_address || 'Coinbase';
            const val  = inp.prevout?.value || 0;
            return `<div class="ep-row" style="padding:4px 0;border-bottom:1px solid #f1f5f9">
                <span class="ep-body" style="font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px">${addr}</span>
                <span class="ep-body" style="color:#9a3412!important;font-weight:700!important;margin-left:8px;white-space:nowrap">${satsToBTC(val)} BTC</span></div>`;
        }).join('');

        const outputRows = (tx.vout || []).slice(0, 5).map(out => {
            const addr = out.scriptpubkey_address || out.scriptpubkey_type || 'Unknown';
            return `<div class="ep-row" style="padding:4px 0;border-bottom:1px solid #f1f5f9">
                <span class="ep-body" style="font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px">${addr}</span>
                <span class="ep-body" style="color:#14532d!important;font-weight:700!important;margin-left:8px;white-space:nowrap">${satsToBTC(out.value)} BTC</span></div>`;
        }).join('');

        el.innerHTML = `
        <div class="ep-grid2" style="margin-bottom:10px">
            <div class="ep-card ep-grid2-span">
                <span class="ep-label">Status</span>
                <span class="ep-value" style="color:${confirmed ? '#14532d' : '#92400e'}!important">
                    ${confirmed ? `✅ Confirmed · Block #${tx.status.block_height}` : '⏳ Unconfirmed (Mempool)'}
                </span>
            </div>
            <div class="ep-card"><span class="ep-label">Fee</span><span class="ep-value">${(tx.fee || 0).toLocaleString()} sat</span></div>
            <div class="ep-card"><span class="ep-label">Fee Rate</span><span class="ep-value">${feeRate} sat/vB</span></div>
            <div class="ep-card"><span class="ep-label">Size</span><span class="ep-value">${sizeVb} vBytes</span></div>
            <div class="ep-card"><span class="ep-label">Total Output</span><span class="ep-value">${satsToBTC(totalOut)} BTC</span></div>
            <div class="ep-card ep-grid2-span"><span class="ep-label">Inputs / Outputs</span><span class="ep-value">${(tx.vin||[]).length} in / ${(tx.vout||[]).length} out</span></div>
            ${confirmed ? `<div class="ep-card ep-grid2-span"><span class="ep-label">Block Time</span><span class="ep-value">${blockTime}</span></div>` : ''}
        </div>
        ${projectionHTML}
        ${inputRows ? `<div style="margin-bottom:8px">
            <div class="ep-heading" style="margin-bottom:6px">Inputs${(tx.vin||[]).length > 5 ? ` (5 of ${tx.vin.length})` : ''}</div>
            <div class="ep-card">${inputRows}</div>
        </div>` : ''}
        ${outputRows ? `<div style="margin-bottom:8px">
            <div class="ep-heading" style="margin-bottom:6px">Outputs${(tx.vout||[]).length > 5 ? ` (5 of ${tx.vout.length})` : ''}</div>
            <div class="ep-card">${outputRows}</div>
        </div>` : ''}
        <div style="margin-top:6px;text-align:right">
            <a href="https://mempool.space/tx/${encodeURIComponent(txid)}" target="_blank" class="ep-link">Full TX on mempool.space ↗</a>
        </div>`;

    } catch (err) {
        let errorMessage = "An unknown error occurred.";
        let detailMessage = "Please try again later.";

        if (err.status) { // This is an HTTP error from mempoolFetch
            if (err.status === 400) {
                errorMessage = `⚠️ Bad Request (${err.status})`;
                detailMessage = "The transaction ID might be invalid or malformed. Please check your input.";
            } else if (err.status === 429) {
                errorMessage = `⚠️ Rate Limit Exceeded (${err.status})`;
                detailMessage = "You've sent too many requests. Please wait a moment and try again.";
            } else if (err.status >= 500) {
                errorMessage = `⚠️ Server Error (${err.status})`;
                detailMessage = "mempool.space is experiencing issues. Please try again later.";
            } else {
                errorMessage = `⚠️ HTTP Error (${err.status})`;
                detailMessage = "mempool.space returned an unexpected error. It might be temporarily unavailable.";
            }
        } else { // This is a network error or other JS error
            errorMessage = `⚠️ Network Error`;
            detailMessage = "Could not connect to mempool.space. It might be unreachable or your internet connection is down.";
            if (err.message) {
                if (err.name === 'AbortError') {
                    detailMessage = "Request to mempool.space timed out. It might be slow or unreachable.";
                } else {
                    detailMessage = err.message;
                }
            }
        }

        el.innerHTML = `<div class="ep-body" style="color:#dc2626!important;font-weight:700!important">${errorMessage}</div>
            <div class="ep-body-sm" style="margin-top:4px">${detailMessage}</div>`;
    }

    btn.disabled = false;
    btn.innerHTML = '⟳ Refresh';
}

// =============================================================================
// ANNOTATION MANAGEMENT (for global onclick handlers)
// =============================================================================

/**
 * Save node annotation (notes + color)
 */
window.saveNodeAnnotation = function(nodeId) {
    const nameEl = document.getElementById('nodeName');
    const notesEl = document.getElementById('nodeNotes');
    const name = nameEl ? nameEl.value : '';
    const notes = notesEl ? notesEl.value : '';
    
    // Get the currently selected color
    const annot = getAnnotation(nodeId) || {};
    const selectedColor = annot.color || '';
    
    // Save the annotation with name, notes, and color
    setAnnotation(nodeId, name, notes, selectedColor);
    
    // Update the graph display if available
    if (window.updateGraphNodeColor) {
        window.updateGraphNodeColor(nodeId, selectedColor);
    }
    if (window.updateGraphNodeLabel) {
        window.updateGraphNodeLabel(nodeId, name);
    }
    
    // Show feedback
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = '✓ Saved!';
    btn.style.background = '#047857';
    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '#0891b2';
    }, 1500);
};

/**
 * Set node custom color and update the graph
 */
window.setNodeColor = function(nodeId, hexColor) {
    const annot = getAnnotation(nodeId) || {};
    const name = annot.name || '';
    const notes = annot.notes || '';
    
    // Save the annotation with new color, preserving name and notes
    setAnnotation(nodeId, name, notes, hexColor);
    
    // Update the graph display if available
    if (window.updateGraphNodeColor) {
        window.updateGraphNodeColor(nodeId, hexColor);
    }
    
    // Refresh the entity view to show updated color selection
    if (window.showEntityView) {
        window.showEntityView(nodeId);
    }
};

/**
 * Clear node custom color
 */
window.clearNodeColor = function(nodeId) {
    const annot = getAnnotation(nodeId) || {};
    const name = annot.name || '';
    const notes = annot.notes || '';
    
    // Save the annotation with null color, preserving name and notes
    setAnnotation(nodeId, name, notes, null);
    
    // Update the graph display if available
    if (window.updateGraphNodeColor) {
        window.updateGraphNodeColor(nodeId, null);
    }
    
    // Refresh the entity view
    if (window.showEntityView) {
        window.showEntityView(nodeId);
    }
};