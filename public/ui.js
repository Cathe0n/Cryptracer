import { state } from './state.js';
import { satsToBTC } from './utils.js';
import { mempoolGetAddress, mempoolGetUTXOs, mempoolGetTxs, mempoolGetTx, mempoolGetTxProjection } from './api.js';

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

    let rc, rl, rbg, rbrd, rglow, ri;
    if (hasError) {
        rc='orange'; rl='API LIMIT REACHED';
        rbg='bg-orange-50'; rbrd='border-orange-300'; rglow=''; ri='⏳';
    } else if (hasTaintOnly) {
        // Risk is graph-proximity taint, NOT direct reports — use a neutral amber tone
        if (risk >= 70) {
            rc='orange'; rl='HIGH TAINT RISK';
            rbg='bg-amber-50'; rbrd='border-amber-300'; rglow='shadow-[0_0_20px_rgba(245,158,11,0.2)]'; ri='⚠️';
        } else if (risk >= 40) {
            rc='yellow'; rl='ELEVATED TAINT RISK';
            rbg='bg-yellow-50'; rbrd='border-yellow-300'; rglow=''; ri='⚠️';
        } else {
            rc='slate'; rl='LOW TAINT RISK';
            rbg='bg-slate-50'; rbrd='border-slate-300'; rglow=''; ri='🔗';
        }
    } else if (!hasReports && risk === 0) {
        rc='emerald'; rl='NO RISK REPORTS';
        rbg='bg-emerald-50'; rbrd='border-emerald-300'; rglow=''; ri='✅';
    } else if (risk >= 70) {
        rc='red'; rl='CRITICAL RISK';
        rbg='bg-red-100'; rbrd='border-red-300'; rglow='shadow-[0_0_30px_rgba(239,68,68,0.4)]'; ri='🚨';
    } else if (risk >= 40) {
        rc='orange'; rl='HIGH RISK';
        rbg='bg-orange-100'; rbrd='border-orange-300'; rglow='shadow-[0_0_25px_rgba(249,115,22,0.3)]'; ri='⚠️';
    } else if (risk >= 20) {
        rc='yellow'; rl='MEDIUM RISK';
        rbg='bg-yellow-100'; rbrd='border-yellow-300'; rglow='shadow-[0_0_20px_rgba(234,179,8,0.2)]'; ri='⚠️';
    } else {
        rc='green'; rl='LOW RISK';
        rbg='bg-green-100'; rbrd='border-green-300'; rglow=''; ri='✅';
    }

    let html = `<div class="space-y-4">`;

    // Risk block
    // Progress bar width:
    //   - Direct reports: fill proportionally to risk score (min 4% for visibility)
    //   - Taint only:     fill proportionally to taint score
    //   - Clean (score=0): fill 100% in green to signal "all clear"
    const barWidth = (hasReports || hasTaintOnly) ? Math.max(risk, 4) : 100;

    html += `
    <div class="${rbg} ${rbrd} ${rglow} border rounded-lg p-4">
        <div class="flex items-center justify-between mb-2">
            <span class="text-${rc}-700 font-bold text-xs uppercase tracking-wider">${ri} ${rl}</span>
            <span class="text-${rc}-700 text-2xl font-bold">${hasError ? '?' : risk}</span>
        </div>
        <div class="bg-white/60 rounded-full h-2 mb-3">
            <div class="bg-${rc}-500 h-2 rounded-full transition-all duration-500"
                 style="width: ${barWidth}%"></div>
        </div>`;

    if (hasError) {
        html += `<div class="text-[9px] text-orange-800 font-bold">${rd.error}</div>
                 <div class="text-[9px] text-orange-700 mt-1">Risk data temporarily unavailable.</div>`;
    } else if (hasTaintOnly) {
        // Explain taint clearly — do NOT claim the address is clean
        html += `
        <div class="text-[9px] text-amber-800 font-bold mb-1">No direct abuse reports for this address.</div>
        <div class="text-[9px] text-amber-700 leading-relaxed">
            Risk score of <strong>${risk}</strong> is inherited from graph proximity —
            this address is within a few hops of a flagged entity. It does not indicate
            confirmed involvement.
        </div>`;
    } else if (hasReports) {
        html += `<div class="grid grid-cols-2 gap-2 text-[9px]">
            <div><div class="text-slate-500 uppercase">Reports</div><div class="font-bold text-slate-800">${rd.report_count}</div></div>
            <div><div class="text-slate-500 uppercase">Verified</div><div class="font-bold text-slate-800">${rd.has_verified_reports ? '✓ Yes' : 'No'}</div></div>
            <div><div class="text-slate-500 uppercase">Confidence</div><div class="font-bold text-slate-800">${(rd.avg_confidence_score * 100).toFixed(0)}%</div></div>
            <div><div class="text-slate-500 uppercase">Lost</div><div class="font-bold text-slate-800">${rd.total_amount.toFixed(2)} BTC</div></div>
        </div>`;
    } else {
        html += `<div class="text-[9px] text-emerald-700">No abuse reports found. Address appears clean.</div>`;
    }
    html += `</div>`;

    if (hasReports && rd.categories && Object.keys(rd.categories).length > 0) {
        html += `<div class="border border-slate-200 rounded-lg p-3 bg-slate-50">
            <h4 class="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-3">⚠️ Reported Activities</h4>
            <div class="space-y-2">`;
        Object.entries(rd.categories).sort((a, b) => b[1] - a[1]).forEach(([cat, cnt]) => {
            html += `<div class="flex items-center justify-between text-[9px]">
                <span class="text-slate-600 capitalize">${cat}</span>
                <span class="bg-red-100 text-red-600 px-2 py-1 rounded font-bold">${cnt}</span></div>`;
        });
        html += `</div></div>`;
    }

    if (hasReports && rd.reports?.length > 0) {
        html += `<div class="border border-slate-200 rounded-lg p-3 bg-slate-50 max-h-60 overflow-y-auto custom-scrollbar">
            <h4 class="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-3">📋 Recent Reports</h4>
            <div class="space-y-3">`;
        rd.reports.slice(0, 5).forEach(r => {
            html += `<div class="bg-slate-100 p-2 rounded border border-slate-200">
                <div class="flex items-center justify-between mb-2">
                    <span class="text-red-600 font-bold text-[9px] uppercase">${r.category}</span>
                    ${r.is_verified ? '<span class="text-green-600 text-[8px]">✓ VERIFIED</span>' : '<span class="text-slate-500 text-[8px]">UNVERIFIED</span>'}
                </div>
                ${r.description ? `<p class="text-slate-600 text-[9px] leading-relaxed mb-2">${r.description.substring(0, 150)}${r.description.length > 150 ? '...' : ''}</p>` : ''}
                <div class="flex items-center justify-between text-[8px] text-slate-500">
                    <span>${r.blockchain || 'Bitcoin'}</span>
                    ${r.amount > 0 ? `<span class="text-red-500">${r.amount} BTC lost</span>` : ''}
                </div></div>`;
        });
        if (rd.reports.length > 5)
            html += `<div class="text-center text-[9px] text-slate-500">+ ${rd.reports.length - 5} more reports</div>`;
        html += `</div></div>`;
    }

    // Entity info + mempool link
    html += `
    <div class="space-y-3">
        <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-1 rounded text-[9px] font-bold ${isAddress ? 'bg-blue-100 text-blue-600 border border-blue-200' : 'bg-purple-100 text-purple-600 border border-purple-200'}">${nodeData.type}</span>
            ${hasReports && risk >= 70 ? '<span class="px-2 py-1 rounded text-[9px] font-bold bg-red-100 text-red-600 border border-red-200">🚨 CRITICAL RISK</span>' : ''}
            ${hasReports && risk >= 40 && risk < 70 ? '<span class="px-2 py-1 rounded text-[9px] font-bold bg-orange-100 text-orange-600 border border-orange-200">⚠️ HIGH RISK</span>' : ''}
            ${nodeData.mixer_info && nodeData.mixer_info.is_mixer ? ('<span class="px-2 py-1 rounded text-[9px] font-bold bg-indigo-100 text-indigo-600 border border-indigo-200" title="Mixer detection — confidence: '+(nodeData.mixer_info.confidence||0)+'%">🌀 MIXER (Conf: '+(nodeData.mixer_info.confidence||0)+'%)</span>') : ''}
            ${hasTaintOnly && risk >= 40 ? '<span class="px-2 py-1 rounded text-[9px] font-bold bg-amber-100 text-amber-700 border border-amber-300" title="Score inherited from proximity to flagged nodes — no direct reports">🔗 TAINT ' + risk + '</span>' : ''}
            <a href="https://mempool.space/${isAddress ? 'address' : 'tx'}/${encodeURIComponent(nodeData.label)}"
               target="_blank" rel="noopener"
               class="px-2 py-1 rounded text-[9px] font-bold bg-cyan-50 text-cyan-600 border border-cyan-200 hover:bg-cyan-100 transition">
               🔍 mempool.space ↗
            </a>
        </div>
        <div>
            <label class="text-[9px] text-slate-500 font-bold uppercase">Entity ID</label>
            <div class="text-xs font-mono text-cyan-600 break-all mt-1">${nodeData.label}</div>
        </div>
    </div>

    <div class="border-t border-slate-200 pt-4">
        <h4 class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Network Metrics</h4>
        <div class="grid grid-cols-2 gap-3">
            <div class="bg-slate-100 p-3 rounded border border-slate-200">
                <div class="text-[9px] text-slate-500 uppercase">Connections</div>
                <div class="text-lg font-bold text-slate-900">${degree}</div>
            </div>
            <div class="bg-slate-100 p-3 rounded border border-slate-200">
                <div class="text-[9px] text-slate-500 uppercase">Neighbors</div>
                <div class="text-lg font-bold text-slate-900">${neighbors.size}</div>
            </div>
            <div class="bg-green-100 p-3 rounded border border-green-200">
                <div class="text-[9px] text-green-600 uppercase">Received</div>
                <div class="text-sm font-bold text-green-700">${totalReceived.toFixed(4)} BTC</div>
                <div class="text-[9px] text-slate-500 mt-1">${incomingTx} tx</div>
            </div>
            <div class="bg-orange-100 p-3 rounded border border-orange-200">
                <div class="text-[9px] text-orange-600 uppercase">Sent</div>
                <div class="text-sm font-bold text-orange-700">${totalSent.toFixed(4)} BTC</div>
                <div class="text-[9px] text-slate-500 mt-1">${outgoingTx} tx</div>
            </div>
        </div>
        <div class="mt-3 p-3 rounded ${balance >= 0 ? 'bg-cyan-100 border border-cyan-200' : 'bg-slate-100 border border-slate-200'}">
            <div class="text-[9px] text-slate-500 uppercase">Graph Balance</div>
            <div class="text-lg font-bold ${balance >= 0 ? 'text-cyan-600' : 'text-slate-500'}">${balance.toFixed(4)} BTC</div>
        </div>
    </div>`;

    // Mixer detection explanation (if available)
    if (nodeData.mixer_info) {
        const conf = nodeData.mixer_info.confidence || 0;
        const expl = nodeData.mixer_info.explanation && nodeData.mixer_info.explanation.length > 0
            ? nodeData.mixer_info.explanation
            : (nodeData.mixer_info.raw && nodeData.mixer_info.raw.notes ? nodeData.mixer_info.raw.notes.join('; ') : 'No explanation available');
        html += `
        <div class="mt-4 p-3 rounded border border-indigo-200 bg-indigo-50">
            <div class="flex items-center justify-between">
                <div class="text-[10px] font-bold text-indigo-700">🌀 Mixer detection</div>
                <div class="text-[10px] text-slate-500">Confidence: <span class="font-bold text-indigo-700">${conf}%</span></div>
            </div>
            <div class="text-[9px] text-slate-600 mt-2">${expl}</div>
        </div>`;
    }

    // Tx history
    html += `<div class="border-t border-slate-200 pt-4">
        <h4 class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">🕒 Transaction History</h4>`;
    if (txEvents.length > 0) {
        html += `<div class="space-y-2 max-h-52 overflow-y-auto custom-scrollbar">`;
        txEvents.forEach(tx => {
            const dt  = new Date(tx.ts * 1000);
            const d8  = dt.toISOString().split('T')[0];
            const t8  = dt.toISOString().split('T')[1].substring(0, 8) + ' UTC';
            const p   = (tx.peer || '').toString();
            const dp  = p.length > 18 ? p.substring(0, 18) + '…' : p;
            const isIn = tx.dir === 'in';
            html += `<div class="flex items-start gap-2 p-2 rounded bg-slate-50 border border-slate-200">
                <span class="mt-0.5 text-[11px] font-bold ${isIn ? 'text-green-600' : 'text-orange-600'}">${isIn ? '▼' : '▲'}</span>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between gap-1">
                        <span class="text-[9px] font-bold ${isIn ? 'text-green-700' : 'text-orange-700'}">${isIn ? '+' : '-'}${tx.amount.toFixed(4)} BTC</span>
                        <span class="text-[8px] text-slate-400 font-mono shrink-0">${t8}</span>
                    </div>
                    <div class="text-[8px] text-slate-400 font-mono mt-0.5">${d8}</div>
                    <div class="text-[8px] text-slate-400 truncate">${isIn ? 'from' : 'to'}: <span class="font-mono text-slate-500">${dp}</span></div>
                </div></div>`;
        });
        html += `</div>`;
    } else {
        html += `<div class="text-[9px] text-slate-400 italic">No timestamp data on connected edges.</div>`;
    }
    html += `</div>`;

    // ── Live mempool enrichment block ────────────────────────────────────────
    const enrichFn = isAddress
        ? `window.enrichFromMempool('${nodeId}', '${nodeData.label}')`
        : `window.enrichTxFromMempool('${nodeData.label}')`;

    html += `
    <div class="border-t border-slate-200 pt-4">
        <div class="flex items-center justify-between mb-3">
            <h4 class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">🌐 Live On-Chain Data</h4>
            <button id="btnFetchMempool" onclick="${enrichFn}"
                class="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-[9px] font-bold rounded uppercase tracking-wider transition">
                ⬇ Fetch
            </button>
        </div>
        <div id="mempoolEnrichContent" class="text-[9px] text-slate-400 italic">
            Click "Fetch" to pull live data from mempool.space.
        </div>
    </div>`;

    if (nodeData.sources?.length > 0) {
        html += `<div class="border-t border-slate-200 pt-4">
            <h4 class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Intelligence Sources</h4>
            <div class="space-y-1">
                ${nodeData.sources.map(s => `<div class="text-[9px] font-mono text-slate-600 bg-slate-100 px-2 py-1 rounded">${s}</div>`).join('')}
            </div></div>`;
    }

    html += `</div>`;
    document.getElementById('entityContent').innerHTML = html;
    document.getElementById('liveView').classList.add('hidden');
    document.getElementById('entityView').classList.remove('hidden');
}

export function closeEntityView() {
    document.getElementById('entityView').classList.add('hidden');
    document.getElementById('liveView').classList.remove('hidden');
}

export async function enrichFromMempool(nodeId, address) {
    const el  = document.getElementById('mempoolEnrichContent');
    const btn = document.getElementById('btnFetchMempool');
    if (!el) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="inline-block animate-spin">⟳</span> Loading…';
    el.innerHTML = `<div class="text-[9px] text-slate-400 animate-pulse">Querying mempool.space…</div>`;

    try {
        const [addrData, utxos, txs] = await Promise.all([
            mempoolGetAddress(address), mempoolGetUTXOs(address), mempoolGetTxs(address)
        ]);

        const cs = addrData.chain_stats   || {};
        const ms = addrData.mempool_stats || {};
        const confirmedBal = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
        const mempoolBal   = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);

        const recentTxRows = (txs || []).slice(0, 5).map(tx => {
            const confirmed = tx.status?.confirmed;
            const sizeVb    = tx.weight ? Math.ceil(tx.weight / 4) : (tx.size || 0);
            const feeRate   = sizeVb ? (tx.fee / sizeVb).toFixed(1) : '?';
            const time      = tx.status?.block_time
                ? new Date(tx.status.block_time * 1000).toISOString().split('T')[0]
                : 'Unconfirmed';
            return `<div class="flex items-center justify-between py-1 border-b border-slate-100 last:border-0">
                <div>
                    <a href="https://mempool.space/tx/${tx.txid}" target="_blank"
                       class="text-cyan-600 hover:underline font-mono text-[8px]">${tx.txid.substring(0, 14)}…</a>
                    <div class="text-[8px] text-slate-400">${time} ${confirmed ? `· Block #${tx.status.block_height}` : '· ⏳ Mempool'}</div>
                </div>
                <div class="text-right shrink-0 ml-2">
                    <div class="text-[8px] text-slate-600 font-bold">${(tx.fee || 0).toLocaleString()} sat</div>
                    <div class="text-[8px] text-slate-400">${feeRate} sat/vB</div>
                </div></div>`;
        }).join('');

        const utxoRows = (utxos || []).slice(0, 5).map(u => `
            <div class="flex items-center justify-between py-1 border-b border-slate-100 last:border-0">
                <div>
                    <a href="https://mempool.space/tx/${u.txid}" target="_blank"
                       class="text-cyan-600 hover:underline font-mono text-[8px]">${u.txid.substring(0, 14)}…:${u.vout}</a>
                    <div class="text-[8px] text-slate-400">${u.status?.confirmed ? '✅ Confirmed' : '⏳ Unconfirmed'}</div>
                </div>
                <div class="text-[8px] font-bold text-green-700 shrink-0 ml-2">${satsToBTC(u.value)} BTC</div>
            </div>`).join('');

        el.innerHTML = `
        <div class="grid grid-cols-2 gap-2 mb-3">
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Confirmed Balance</div>
                <div class="font-bold text-slate-800 text-[10px]">${satsToBTC(confirmedBal)} BTC</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Mempool Δ</div>
                <div class="font-bold text-[10px] ${mempoolBal >= 0 ? 'text-green-700' : 'text-red-700'}">${mempoolBal >= 0 ? '+' : ''}${satsToBTC(mempoolBal)} BTC</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Total TXs</div>
                <div class="font-bold text-slate-800 text-[10px]">${(cs.tx_count || 0).toLocaleString()}</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Pending TXs</div>
                <div class="font-bold text-[10px] ${ms.tx_count > 0 ? 'text-yellow-700' : 'text-slate-400'}">${ms.tx_count > 0 ? ms.tx_count + ' pending' : 'None'}</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">UTXOs</div>
                <div class="font-bold text-slate-800 text-[10px]">${(utxos || []).length}</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Total Received</div>
                <div class="font-bold text-slate-800 text-[10px]">${satsToBTC(cs.funded_txo_sum || 0)} BTC</div>
            </div>
        </div>
        ${recentTxRows ? `
        <div class="mb-3">
            <div class="text-[9px] font-bold text-slate-500 uppercase mb-2">Recent Transactions</div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">${recentTxRows}</div>
        </div>` : ''}
        ${utxoRows ? `
        <div class="mb-2">
            <div class="text-[9px] font-bold text-slate-500 uppercase mb-2">UTXOs (Unspent Outputs)</div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">${utxoRows}</div>
            ${(utxos || []).length > 5 ? `<div class="text-[8px] text-slate-400 mt-1 text-center">+ ${utxos.length - 5} more UTXOs</div>` : ''}
        </div>` : `<div class="text-[9px] text-slate-400 italic">No UTXOs — fully spent address.</div>`}
        <div class="mt-2 text-right">
            <a href="https://mempool.space/address/${encodeURIComponent(address)}" target="_blank"
               class="text-[9px] text-cyan-600 hover:underline">Full history on mempool.space ↗</a>
        </div>`;

    } catch (err) {
        el.innerHTML = `<div class="text-[9px] text-red-500">⚠️ ${err.message}</div>
            <div class="text-[8px] text-slate-400 mt-1">mempool.space may be unreachable or rate-limited.</div>`;
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
    btn.innerHTML = '<span class="inline-block animate-spin">⟳</span> Loading…';
    el.innerHTML = `<div class="text-[9px] text-slate-400 animate-pulse">Querying mempool.space…</div>`;

    try {
        const tx = await mempoolGetTx(txid);
        const confirmed = tx.status?.confirmed;
        const sizeVb    = tx.weight ? Math.ceil(tx.weight / 4) : (tx.size || 0);
        const feeRate   = sizeVb ? (tx.fee / sizeVb).toFixed(2) : '?';
        const totalOut  = (tx.vout || []).reduce((s, v) => s + (v.value || 0), 0);
        const blockTime = tx.status?.block_time
            ? new Date(tx.status.block_time * 1000).toLocaleString() : '—';

        let projectionHTML = '';
        if (!confirmed) {
            try {
                const projections = await mempoolGetTxProjection(txid);
                if (projections && projections.length > 0) {
                    const p = projections[0];
                    projectionHTML = `
                    <div class="bg-yellow-50 border border-yellow-200 rounded p-2 col-span-2">
                        <div class="text-[8px] text-yellow-600 uppercase mb-1 font-bold">🔮 Mempool Projection</div>
                        <div class="font-bold text-yellow-800 text-[10px]">
                            Projected for Block <span class="font-mono">~#${p.blockHeight.toLocaleString()}</span>
                        </div>
                        <div class="text-[8px] text-slate-500 mt-0.5">Position in block: <span class="font-mono">${p.positionInBlock}%</span> | Fee Rate: <span class="font-mono">${p.feerate.toFixed(1)} sat/vB</span></div>
                    </div>`;
                }
            } catch (projErr) {
                console.warn('Could not fetch mempool projection:', projErr);
            }
        }

        const inputRows = (tx.vin || []).slice(0, 5).map(inp => {
            const addr = inp.prevout?.scriptpubkey_address || 'Coinbase';
            const val  = inp.prevout?.value || 0;
            return `<div class="flex justify-between text-[8px] py-0.5 border-b border-slate-100 last:border-0">
                <span class="font-mono text-slate-600 truncate max-w-[130px]">${addr}</span>
                <span class="text-orange-600 font-bold shrink-0 ml-2">${satsToBTC(val)} BTC</span></div>`;
        }).join('');

        const outputRows = (tx.vout || []).slice(0, 5).map(out => {
            const addr = out.scriptpubkey_address || out.scriptpubkey_type || 'Unknown';
            return `<div class="flex justify-between text-[8px] py-0.5 border-b border-slate-100 last:border-0">
                <span class="font-mono text-slate-600 truncate max-w-[130px]">${addr}</span>
                <span class="text-green-600 font-bold shrink-0 ml-2">${satsToBTC(out.value)} BTC</span></div>`;
        }).join('');

        el.innerHTML = `
        <div class="grid grid-cols-2 gap-2 mb-3">
            <div class="bg-slate-50 border border-slate-200 rounded p-2 col-span-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Status</div>
                <div class="font-bold text-[10px] ${confirmed ? 'text-green-700' : 'text-yellow-700'}">
                    ${confirmed ? `✅ Confirmed · Block #${tx.status.block_height}` : '⏳ Unconfirmed (Mempool)'}
                </div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Fee</div>
                <div class="font-bold text-slate-800 text-[10px]">${(tx.fee || 0).toLocaleString()} sat</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Fee Rate</div>
                <div class="font-bold text-slate-800 text-[10px]">${feeRate} sat/vB</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Size</div>
                <div class="font-bold text-slate-800 text-[10px]">${sizeVb} vBytes</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Total Output</div>
                <div class="font-bold text-slate-800 text-[10px]">${satsToBTC(totalOut)} BTC</div>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Inputs / Outputs</div>
                <div class="font-bold text-slate-800 text-[10px]">${(tx.vin||[]).length} in / ${(tx.vout||[]).length} out</div>
            </div>
            ${confirmed ? `<div class="bg-slate-50 border border-slate-200 rounded p-2 col-span-2">
                <div class="text-[8px] text-slate-400 uppercase mb-0.5">Block Time</div>
                <div class="font-bold text-slate-800 text-[10px]">${blockTime}</div>
            </div>` : ''}
        </div>
        ${projectionHTML}
        ${inputRows ? `<div class="mb-2">
            <div class="text-[9px] font-bold text-slate-500 uppercase mb-1">
                Inputs${(tx.vin||[]).length > 5 ? ` (5 of ${tx.vin.length})` : ''}</div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">${inputRows}</div>
        </div>` : ''}
        ${outputRows ? `<div class="mb-2">
            <div class="text-[9px] font-bold text-slate-500 uppercase mb-1">
                Outputs${(tx.vout||[]).length > 5 ? ` (5 of ${tx.vout.length})` : ''}</div>
            <div class="bg-slate-50 border border-slate-200 rounded p-2">${outputRows}</div>
        </div>` : ''}
        <div class="mt-2 text-right">
            <a href="https://mempool.space/tx/${encodeURIComponent(txid)}" target="_blank"
               class="text-[9px] text-cyan-600 hover:underline">Full TX on mempool.space ↗</a>
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

        el.innerHTML = `<div class="text-[9px] text-red-500">${errorMessage}</div>
            <div class="text-[8px] text-slate-400 mt-1">${detailMessage}</div>`;
    }

    btn.disabled = false;
    btn.innerHTML = '⟳ Refresh';
}