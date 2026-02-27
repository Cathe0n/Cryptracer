// tracer.js — Forward path tracer for Cryptracker
// Calls /api/trace-path/:address, merges hops into the live D3 graph,
// and highlights the traced chain with orange edges + final destination node.

import { state } from './state.js';
import { mergePathIntoGraph, clearPathHighlight } from './graph.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shortId(id) {
    if (!id || id.length <= 20) return id;
    return id.substring(0, 10) + '\u2026' + id.slice(-8);
}

function fmtDate(ts) {
    if (!ts) return '\u2014';
    return new Date(ts * 1000).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

function riskBadge(risk) {
    if (risk >= 70) return '<span style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5" class="px-1.5 py-0.5 rounded text-[8px] font-bold">\u26a0 ' + risk + ' CRITICAL</span>';
    if (risk >= 40) return '<span style="background:#ffedd5;color:#c2410c;border:1px solid #fdba74" class="px-1.5 py-0.5 rounded text-[8px] font-bold">\u26a0 ' + risk + ' HIGH</span>';
    if (risk >= 20) return '<span style="background:#fef9c3;color:#854d0e;border:1px solid #fde047" class="px-1.5 py-0.5 rounded text-[8px] font-bold">\u26a0 ' + risk + '</span>';
    if (risk > 0)   return '<span style="background:#f0fdf4;color:#15803d;border:1px solid #86efac" class="px-1.5 py-0.5 rounded text-[8px]">' + risk + '</span>';
    return '<span style="color:#64748b" class="text-[8px]">clean</span>';
}

function confBadge(conf) {
    const map = {
        high:   { bg: '#f0fdf4', color: '#15803d', border: '#86efac', label: '\u2713 High confidence'   },
        medium: { bg: '#fefce8', color: '#854d0e', border: '#fde047', label: '\u007e Medium confidence' },
        low:    { bg: '#fef2f2', color: '#b91c1c', border: '#fca5a5', label: '? Low confidence'         },
    };
    const s = map[conf] || map.low;
    return '<span style="background:' + s.bg + ';color:' + s.color + ';border:1px solid ' + s.border + '" class="px-1.5 py-0.5 rounded text-[8px] font-mono">' + s.label + '</span>';
}

const STOP_LABELS = {
    utxo:           { icon: '\uD83C\uDFC1', text: 'Unspent output \u2014 likely final destination', color: '#059669' },
    high_risk:      { icon: '\uD83D\uDEA8', text: 'Stopped at flagged high-risk address',           color: '#dc2626' },
    known_service:  { icon: '\uD83C\uDFE6', text: 'Reached identified exchange / service',           color: '#0284c7' },
    cycle:          { icon: '\uD83D\uDD04', text: 'Cycle detected \u2014 address loops back',        color: '#7c3aed' },
    max_hops:       { icon: '\uD83D\uDD22', text: 'Maximum tracing depth reached',                   color: '#d97706' },
    no_outgoing_tx: { icon: '\u26D3',       text: 'No outgoing transactions found',                  color: '#059669' },
    no_destination: { icon: '\u2753',       text: 'Could not determine destination output',           color: '#64748b' },
    timeout:        { icon: '\u23F1',       text: 'Request timed out',                               color: '#64748b' },
};

// ─── Panel rendering ──────────────────────────────────────────────────────────
function renderTracePanel(path) {
    const panel   = document.getElementById('traceView');
    const content = document.getElementById('traceContent');
    if (!panel || !content) return;

    document.getElementById('liveView')?.classList.add('hidden');
    document.getElementById('entityView')?.classList.add('hidden');
    panel.classList.remove('hidden');

    const stop = STOP_LABELS[path.stop_reason] || { icon: '\u23F9', text: path.stop_reason, color: '#64748b' };

    let html = '';

    // Origin
    html += '<div class="flex items-center gap-2 p-3 rounded-lg" style="background:#083344;border:1px solid #164e63">'
        + '<div class="w-3 h-3 rounded-full shrink-0" style="background:#fbbf24;box-shadow:0 0 8px #fbbf24"></div>'
        + '<div class="min-w-0">'
        + '<div class="text-[8px] uppercase tracking-wider" style="color:#67e8f9">Origin</div>'
        + '<div class="font-mono text-[9px] truncate" style="color:#e0f2fe" title="' + path.start + '">' + shortId(path.start) + '</div>'
        + '</div>'
        + '<button onclick="window.investigateNode(\'' + path.start + '\')" class="ml-auto shrink-0 text-[8px] font-bold uppercase transition px-2 py-1 rounded" style="color:#06b6d4;border:1px solid #0e7490">\u2192 Graph</button>'
        + '</div>';

    // Hops
    path.hops.forEach(function(hop, idx) {
        var isFinal     = idx === path.hops.length - 1;
        var nodeColor   = isFinal ? '#f97316' : '#0ea5e9';
        var borderColor = isFinal ? '#c2410c' : '#0e7490';
        var bgColor     = isFinal ? '#431407' : '#0c1a2e';
        var labelColor  = isFinal ? '#fb923c' : '#38bdf8';
        var hopTitle    = isFinal ? '\uD83C\uDFC1 Final Destination' : ('Hop ' + hop.hop_index);
        var labelSpan   = hop.label
            ? '<span class="px-1.5 py-0.5 rounded text-[8px] font-bold" style="background:#1e1b4b;color:#a5b4fc;border:1px solid #4338ca">\uD83C\uDFF7 ' + hop.label + '</span>'
            : '';

        html += '<div class="flex flex-col items-center py-0.5">'
            + '<div style="width:1px;height:8px;background:#334155"></div>'
            + '<div class="flex items-center gap-2 text-[8px]" style="color:#475569">'
            + '<span style="color:#f97316">TX</span>'
            + '<span class="font-mono truncate max-w-[140px]" title="' + hop.tx_hash + '">' + shortId(hop.tx_hash) + '</span>'
            + '<span style="color:#64748b">\u00b7</span>'
            + '<span>' + hop.amount.toFixed(6) + ' BTC</span>'
            + '</div>'
            + '<div style="color:#f97316;font-size:10px">\u25bc</div>'
            + '</div>';

        html += '<div class="p-3 rounded-lg" style="background:' + bgColor + ';border:1px solid ' + borderColor + '">'
            + '<div class="flex items-center gap-2 mb-2">'
            + '<div class="w-2.5 h-2.5 rounded-full shrink-0" style="background:' + nodeColor + ';' + (isFinal ? 'box-shadow:0 0 8px #f97316' : '') + '"></div>'
            + '<div class="text-[8px] uppercase tracking-wider font-bold" style="color:' + labelColor + '">' + hopTitle + '</div>'
            + '</div>'
            + '<div class="font-mono text-[9px] break-all mb-2" style="color:#e2e8f0" title="' + hop.to_addr + '">' + hop.to_addr + '</div>'
            + '<div class="flex flex-wrap gap-1 mb-2">'
            + confBadge(hop.dest_confidence)
            + riskBadge(hop.risk)
            + labelSpan
            + '</div>'
            + '<div class="flex items-center justify-between text-[8px]" style="color:#64748b">'
            + '<span>' + fmtDate(hop.timestamp) + '</span>'
            + '<button onclick="window.investigateNode(\'' + hop.to_addr + '\')" class="font-bold uppercase transition px-2 py-1 rounded" style="color:#06b6d4;border:1px solid #0e7490">\u2192 Graph</button>'
            + '</div>'
            + '</div>';
    });

    // Stop reason
    html += '<div class="mt-2 p-3 rounded-lg text-[9px]" style="background:#1e293b;border:1px solid #334155;color:' + stop.color + '">'
        + '<span class="font-bold">' + stop.icon + ' Trace ended:</span> ' + stop.text
        + '</div>';

    // Actions
    html += '<div class="flex gap-2 pt-2">'
        + '<button onclick="window.investigateNode(\'' + path.final_addr + '\')" class="flex-1 py-2 rounded text-[9px] font-bold uppercase tracking-wider transition" style="background:#0e7490;color:#e0f2fe">'
        + '\uD83D\uDD0E Investigate Final'
        + '</button>'
        + '<button onclick="window.clearTrace()" class="px-3 py-2 rounded text-[9px] font-bold uppercase" style="background:#1e293b;color:#94a3b8;border:1px solid #334155">'
        + '\u2715 Clear'
        + '</button>'
        + '</div>';

    content.innerHTML = html;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
export async function runTracePath(address) {
    if (!address) address = document.getElementById('targetId') && document.getElementById('targetId').value.trim();
    if (!address) return;

    var panel   = document.getElementById('traceView');
    var content = document.getElementById('traceContent');
    if (!panel || !content) return;

    document.getElementById('liveView') && document.getElementById('liveView').classList.add('hidden');
    document.getElementById('entityView') && document.getElementById('entityView').classList.add('hidden');
    panel.classList.remove('hidden');

    content.innerHTML = '<div class="flex flex-col items-center justify-center gap-3 py-12 text-center">'
        + '<div class="w-8 h-8 rounded-full border-2 border-t-cyan-400 border-slate-700 animate-spin"></div>'
        + '<div class="text-[10px] font-bold uppercase tracking-widest" style="color:#22d3ee">Tracing Forward\u2026</div>'
        + '<div class="text-[9px]" style="color:#475569">Applying change detection heuristics</div>'
        + '<div class="font-mono text-[8px] max-w-[200px] truncate" style="color:#334155">' + address + '</div>'
        + '</div>';

    try {
        var res = await fetch('/api/trace-path/' + encodeURIComponent(address) + '?hops=10');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();

        if (!data.path || data.path.total_hops === 0) {
            content.innerHTML = '<div class="text-center py-10 text-[9px]" style="color:#64748b">'
                + '<div class="text-2xl mb-3">\u26D3</div>'
                + 'No outgoing transactions found \u2014 this address may hold unspent outputs.'
                + '</div>';
            return;
        }

        // 1. Render sidebar hop-chain panel
        renderTracePanel(data.path);

        // 2. Merge hops into live D3 graph one-by-one + apply orange path highlight
        await mergePathIntoGraph(data.path);

    } catch (err) {
        content.innerHTML = '<div class="text-center py-8 text-[9px]" style="color:#ef4444">'
            + '<div class="text-xl mb-2">\u26a0</div>'
            + '<div class="font-bold">Trace failed</div>'
            + '<div style="color:#64748b;margin-top:4px">' + err.message + '</div>'
            + '</div>';
    }
}

// ─── Clear / close ────────────────────────────────────────────────────────────
export function closeTraceView() {
    clearPathHighlight();
    document.getElementById('traceView') && document.getElementById('traceView').classList.add('hidden');
    document.getElementById('liveView') && document.getElementById('liveView').classList.remove('hidden');
}

// Expose globally for inline onclick handlers
window.clearTrace   = closeTraceView;
window.runTracePath = runTracePath;