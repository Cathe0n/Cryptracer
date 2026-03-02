import { state } from './state.js';
// D3.js Graph Renderer — Cryptracker
// Mempool.space API integrated for live on-chain enrichment
console.log('Cryptracker: D3 Renderer Loaded');

import { MEMPOOL_API } from './state.js';
// ─── Constants ────────────────────────────────────────────────────────────────

// ─── D3 / simulation state ───────────────────────────────────────────────────
let simulation;
let svg;
let zoom;
let container, g;
let link, node, label;
let edgeLabel;
let edgeTooltipDiv;
let currentEdgeHover = null;

// ─── Data state ───────────────────────────────────────────────────────────────
let currentTargetId = null;
let fullGraphData = null;
let labelsVisible = true;
let timestampsVisible = true;
let edgeTooltipsVisible = false; // show amount+timestamp tooltips on hover when true
let isFrozen = false;
let currentLayout = 'force';  // 'force' | 'tree'
let rawNodes = [];
let rawLinks = [];
let calendarTxDates = {};
let calendarViewDate = new Date();
let expandedNodes   = new Set(); // tracks which address nodes have been expanded
let selectedNodeId  = null;   // currently-selected node (used by toolbar button)

// ── Trace-path state (kept at module level so ticked() can use it) ──────────
let traceFinalAddr    = null;  // final destination address of current trace
let tracePathNodeIds  = null;  // Set<id> of nodes in active trace path
let tracePathEdgeKeys = null;  // Set<"s|t"> of edges in active trace path

// update state/text of the toolbar expand button
function updateExpandBtn() {
    const btn = document.getElementById('expandSelectedBtn');
    if (!btn) return;
    // determine if the currently selected node is eligible for expansion
    if (!selectedNodeId) {
        btn.disabled = true;
        btn.textContent = 'Expand node';
        btn.title = 'Select an address node to expand its neighbors';
        btn.classList.remove('text-xs');
        btn.classList.add('px-3', 'py-1', 'text-sm');
        return;
    }
    const n = fullGraphData?.nodes[selectedNodeId];
    const isAddress = n && n.type === 'Address';
    if (!isAddress) {
        btn.disabled = true;
        btn.textContent = 'Expand (addresses only)';
        btn.title = 'Only address nodes can be expanded';
        btn.classList.remove('text-sm');
        btn.classList.add('px-3', 'py-1');
        return;
    }
    if (expandedNodes.has(selectedNodeId)) {
        btn.disabled = true;
        btn.textContent = 'Expanded';
        btn.title = 'Node already expanded';
    } else {
        btn.disabled = false;
        btn.textContent = 'Expand neighbors';
        btn.title = 'Load and show connected addresses (neighbors)';
    }
}

// called by the toolbar when the user clicks the expand button
function expandSelected() {
    if (selectedNodeId) expandNode(selectedNodeId);
}

// ─── Search history ───────────────────────────────────────────────────────────
// Each entry: { id, label, risk, nodeCount, edgeCount, ts }
let searchHistory = [];

// ─── Loader ───────────────────────────────────────────────────────────────────
const loader = document.getElementById('loader');
const setBusy = (isBusy, title = 'RECONSTRUCTING TIMELINE...', details = '') => {
    loader.style.display = isBusy ? 'flex' : 'none';
    if (isBusy) {
        document.getElementById('loaderTitle').textContent = title;
        document.getElementById('loaderDetails').textContent = details;
    }
};

// =============================================================================
// MEMPOOL.SPACE API HELPERS
// =============================================================================

/** Fetch with 8s timeout */
async function mempoolFetch(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${MEMPOOL_API}${path}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

const mempoolGetAddress    = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}`);
const mempoolGetUTXOs      = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}/utxo`);
const mempoolGetTxs        = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}/txs`);
const mempoolGetTx         = txid  => mempoolFetch(`/tx/${encodeURIComponent(txid)}`);
const mempoolGetFees       = ()    => mempoolFetch('/v1/fees/recommended');
const mempoolGetBlockHeight= ()    => mempoolFetch('/blocks/tip/height');

/** Format satoshis → BTC string */
function satsToBTC(sats) {
    return (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

// =============================================================================
// NETWORK STATS TICKER (shown in header)
// =============================================================================
let feeRefreshInterval = null;

async function initNetworkStats() {
    const el = document.getElementById('networkStats');
    if (!el) return;
    async function refresh() {
        try {
            const [fees, height] = await Promise.all([mempoolGetFees(), mempoolGetBlockHeight()]);
            el.innerHTML = `
                <div class="flex items-center gap-4 text-[10px] font-mono">
                    <span class="text-slate-400 uppercase tracking-wider">Block</span>
                    <span class="text-cyan-400 font-bold">#${height.toLocaleString()}</span>
                    <span class="text-slate-600">|</span>
                    <span class="text-slate-400 uppercase">Fees (sat/vB)</span>
                    <span title="~10 min" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>
                        <span class="text-green-400 font-bold">${fees.fastestFee}</span>
                    </span>
                    <span title="~30 min" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-yellow-400"></span>
                        <span class="text-yellow-400 font-bold">${fees.halfHourFee}</span>
                    </span>
                    <span title="~1 hr" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-orange-400"></span>
                        <span class="text-orange-400 font-bold">${fees.hourFee}</span>
                    </span>
                    <span title="Economy" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                        <span class="text-slate-400 font-bold">${fees.economyFee}</span>
                    </span>
                    <a href="https://mempool.space" target="_blank"
                       class="text-cyan-600 hover:text-cyan-400 transition underline underline-offset-2 ml-1 text-[9px]">
                       mempool.space ↗
                    </a>
                </div>`;
        } catch {
            el.innerHTML = `<span class="text-[10px] text-slate-600 italic">Network stats unavailable</span>`;
        }
    }
    await refresh();
    if (feeRefreshInterval) clearInterval(feeRefreshInterval);
    feeRefreshInterval = setInterval(refresh, 60_000);
}

// =============================================================================
// SEARCH HISTORY
// =============================================================================
function renderSearchHistory() {
    const list = document.getElementById('searchHistoryList');
    if (!list) return;
    if (searchHistory.length === 0) {
        list.innerHTML = `<div class="text-[9px] text-slate-600 italic">No searches yet.</div>`;
        return;
    }
    list.innerHTML = searchHistory.map((entry, i) => {
        const isActive = entry.id === currentTargetId;
        const short = entry.id.length > 20 ? entry.id.substring(0, 10) + '…' + entry.id.slice(-6) : entry.id;
        const time  = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const riskColor = entry.risk >= 70 ? 'text-red-500' : entry.risk >= 20 ? 'text-yellow-500' : 'text-emerald-500';
        return `
        <div class="rounded-lg border ${isActive ? 'border-cyan-500 bg-cyan-950/60' : 'border-slate-700 bg-slate-800/40'} p-2.5 group">
            <div class="flex items-center justify-between gap-2 mb-1.5">
                <span class="text-[8px] font-mono ${isActive ? 'text-cyan-400' : 'text-slate-400'} truncate">${short}</span>
                <span class="text-[8px] text-slate-600 shrink-0">${time}</span>
            </div>
            <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 text-[8px]">
                    <span class="text-slate-500">${entry.nodeCount}N / ${entry.edgeCount}E</span>
                    ${entry.risk > 0 ? `<span class="font-bold ${riskColor}">⚠ ${entry.risk}</span>` : '<span class="text-emerald-600">✓ clean</span>'}
                </div>
                ${!isActive ? `<button onclick="window.investigateNode('${entry.id}')"
                    class="text-[8px] font-bold text-cyan-500 hover:text-cyan-300 uppercase tracking-wider opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    Re-run →
                </button>` : `<span class="text-[8px] text-cyan-500 font-bold uppercase">Active</span>`}
            </div>
            ${entry.label && entry.label !== entry.id ? `<div class="text-[8px] text-slate-500 mt-1 truncate">${entry.label}</div>` : ''}
        </div>`;
    }).join('');
}

function addToHistory(id, graphData) {
    const nodeData = graphData.nodes[id] || {};
    const entry = {
        id,
        label:     nodeData.label || id,
        risk:      nodeData.risk  || 0,
        nodeCount: Object.keys(graphData.nodes).length,
        edgeCount: (graphData.edges || []).length,
        ts:        Date.now()
    };
    // Remove any existing entry for this id (dedup), then prepend
    searchHistory = searchHistory.filter(e => e.id !== id);
    searchHistory.unshift(entry);
    // Keep last 20 entries
    if (searchHistory.length > 20) searchHistory = searchHistory.slice(0, 20);
    renderSearchHistory();
}

// =============================================================================
// MAIN SEARCH
// =============================================================================

// investigateNode: called from entity panel "Investigate" button and history re-run.
// Sets the input field and kicks off a full search.
window.investigateNode = function(address) {
    document.getElementById('targetId').value = address;
    // Close entity panel if open so the user sees the graph update
    const ev = document.getElementById('entityView');
    const lv = document.getElementById('liveView');
    if (ev && !ev.classList.contains('hidden')) {
        ev.classList.add('hidden');
        lv && lv.classList.remove('hidden');
    }
    runSleuth(address);
};

export async function runSleuth(forcedId) {
    const id = forcedId || document.getElementById('targetId').value.trim();
    if (!id) return;
    if (typeof d3 === 'undefined') { alert('D3.js library not loaded.'); return; }

    // Keep the input in sync when called programmatically
    if (forcedId) document.getElementById('targetId').value = forcedId;
    state.currentTargetId = id;

    currentTargetId = id;
    setBusy(true, 'INITIATING INVESTIGATION...', `Target: ${id.substring(0, 20)}...`);

    try {
        setBusy(true, 'FETCHING NETWORK DATA...', 'Querying blockchain graph database...');
        const res  = await fetch(`/api/trace/${id}`);
        const data = await res.json();

        if (!data.graph || !data.graph.nodes) {
            setBusy(false); alert('No graph data returned.'); return;
        }

        const nodeCount = Object.keys(data.graph.nodes || {}).length;
        const edgeCount = (data.graph.edges || []).length;
        console.log(`Received ${nodeCount} nodes, ${edgeCount} edges`);

        setBusy(true, 'PROCESSING GRAPH DATA...', `Found ${nodeCount} entities and ${edgeCount} transactions`);
        document.getElementById('intelBox').classList.remove('hidden');
        document.getElementById('riskCount').innerText     = data.graph.nodes[id]?.risk  || 0;
        document.getElementById('identityLabel').innerText = data.graph.nodes[id]?.label || id;

        // Record this search in history before rendering
        addToHistory(id, data.graph);

        setBusy(true, 'LOADING TRANSACTION HISTORY...', 'Retrieving activity logs...');
        const hRes = await fetch(`/api/history/${id}`);
        const txs  = await hRes.json();

        document.getElementById('historyList').innerHTML = (txs || []).slice(0, 10).map(tx => `
            <div class="p-3 rounded-md bg-slate-800/60 border border-slate-700">
                <div class="text-[9px] text-slate-500 truncate mb-1">${tx.txid || 'Unknown'}</div>
                <div class="text-cyan-400 font-bold text-[10px]">
                    ${tx.vout?.[0] ? (tx.vout[0].value / 1e8).toFixed(4) : '0.0000'} BTC
                </div>
            </div>`).join('') || '<div class="text-[10px] text-slate-500 italic">No history found.</div>';

        setBusy(true, 'CONSTRUCTING GRAPH...', `Preparing ${nodeCount} nodes for D3.js rendering`);
        renderGraph(data.graph, id);
    } catch (err) {
        console.error('runSleuth error:', err);
        setBusy(false);
        alert('Error loading data: ' + err.message);
    }
}

// =============================================================================
// GRAPH RENDERING
// =============================================================================
export function renderGraph(graphData, targetId) {
    return _renderGraphImpl(graphData, targetId);
}

function _renderGraphImpl(graphData, targetId) {
    try {
        fullGraphData = graphData;
        state.fullGraphData = graphData;
        currentLayout = 'force';
        rawNodes = [];
        rawLinks = [];
        expandedNodes.clear();  // fresh search resets expansion state
        // clear any node selection when the graph is reset
        selectedNodeId = null;
        updateExpandBtn();
        const nodes = Object.entries(graphData.nodes).map(([id, n]) => ({
            id, ...n, label: n.label || id, isTarget: id === targetId
        }));
        const links = graphData.edges.map(e => ({ ...e, source: e.source, target: e.target }));
        rawNodes = nodes;
        rawLinks = links;

        setBusy(true, 'INITIALIZING SVG...', 'Setting up D3 rendering context');
        const containerEl = document.getElementById('graph-container');
        containerEl.innerHTML = '';
        const width = containerEl.clientWidth, height = containerEl.clientHeight;

        svg = d3.select(containerEl).append("svg")
            .attr("width", width).attr("height", height)
            .style("background", "#ffffff")
            .attr("viewBox", [-width / 2, -height / 2, width, height])
            .on("click", ev => {
                if (ev.target.tagName === 'svg') { 
                    closeEntityView();
                    unhighlightAll();
                    selectedNodeId = null;
                    updateExpandBtn();
                }
            });

        const defs = svg.append("defs");
        const mkArrow = (id, color) => defs.append("marker")
            .attr("id", id).attr("viewBox", "0 -5 10 10")
            .attr("refX", 20).attr("refY", 0)
            .attr("markerWidth", 7).attr("markerHeight", 7)
            .attr("orient", "auto")
            .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", color);

        mkArrow("arrowhead-default",   "#64748b");
        mkArrow("arrowhead-highlight", "#0ea5e9");
        mkArrow("arrowhead-risk",      "#ef4444");
        mkArrow("arrowhead-trace",     "#f97316");

        g = svg.append("g");

        simulation = d3.forceSimulation(nodes)
            .force("link", d3.forceLink(links).id(d => d.id).distance(d => d.amount > 1 ? 100 : 50))
            .force("charge", d3.forceManyBody().strength(-100))
            .force("center", d3.forceCenter(0, 0))
            .on("tick", ticked);

        const edgeColor = d => {
              const tn = fullGraphData?.nodes[d.target?.id];
              const r = tn && tn.risk ? tn.risk : 0;
              return r >= 70 ? "#ef4444" : r >= 40 ? "#f97316" : r >= 10 ? "#f59e0b" : "#64748b";
        };
        const edgeArrow = d => {
              const tn = fullGraphData?.nodes[d.target?.id];
              const r = tn && tn.risk ? tn.risk : 0;
              return r >= 70 ? "url(#arrowhead-risk)" : "url(#arrowhead-default)";
        };

        link = g.append("g").attr("class", "links")
            .selectAll("line").data(links).enter().append("line")
            .attr("class", "link")
            .attr("stroke", edgeColor)
            .attr("stroke-opacity", 0.85)
            .attr("stroke-width", d => Math.max(2.5, Math.min(Math.sqrt((d.amount || 0) + 1) * 2, 8)))
            .attr("marker-end", edgeArrow);
        state.link = link;

        const riskColor = r => {
            if (!r) return null;
            if (r >= 70) return '#ef4444'; // high risk: red
            if (r >= 40) return '#f97316'; // med-high: orange
            if (r >= 10) return '#f59e0b'; // low-med: amber
            return '#06b6d4'; // minimal: teal
        };

        node = g.append("g").attr("class", "nodes")
            .selectAll("circle").data(nodes).enter().append("circle")
            .attr("class", "node")
            .attr("r", d => d.isTarget ? 18 : (d.type === 'Transaction' ? 4 : (d.risk ? 12 : 7)))
            .attr("fill", d => d.isTarget ? '#fbbf24' : (d.risk ? riskColor(d.risk) : (d.type === 'Transaction' ? '#6366f1' : '#0ea5e9')))
            .on("click", (ev, d) => { ev.stopPropagation(); showEntityView(d.id); highlightNode(d.id); })
            .on("mouseover", (ev, d) => highlightNeighbors(d, true))
            .on("mouseout",  (ev, d) => highlightNeighbors(d, false))
            .call(drag());
        state.node = node;

        label = g.append("g").attr("class", "labels")
            .selectAll("text").data(nodes).enter().append("text")
            .attr("class", "node-label")
            .text(d => d.label)
            .attr("dx", 12).attr("dy", ".35em")
            .attr("fill", "#1e293b").attr("font-size", "11px").attr("font-weight", "500");

        // Edge labels (timestamp + amount)
        edgeLabel = g.append("g").attr("class", "edge-labels")
            .selectAll("text").data(links).enter().append("text")
            .attr("class", "edge-label")
            .attr("text-anchor", "middle")
            .attr("fill", "#0f172a").attr("font-size", "10px").attr("font-weight", "500");

        zoom = d3.zoom().scaleExtent([0.1, 8])
            .on("zoom", ev => {
                g.attr("transform", ev.transform);
                // Keep expand rings visually in sync when user zooms/pans
                updateExpandRings();
                // If an edge tooltip is visible, reposition it to follow the edge
                if (currentEdgeHover && edgeTooltipDiv) {
                    try {
                        const d = currentEdgeHover;
                        const midx = (d.source.x + d.target.x) / 2;
                        const midy = (d.source.y + d.target.y) / 2;
                        const pos = screenPosFromGraph(midx, midy);
                        edgeTooltipDiv.style.left = (pos.left + 8) + 'px';
                        edgeTooltipDiv.style.top  = (pos.top - 18) + 'px';
                    } catch (e) { /* ignore transient state during layout */ }
                }
            });
        svg.call(zoom);
        state.svg = svg;

        document.getElementById('nodeCount').textContent = nodes.length.toLocaleString();
        document.getElementById('edgeCount').textContent = links.length.toLocaleString();

        initTimeline(links);
        setBusy(true, 'CALCULATING LAYOUT...', 'Running D3 force simulation');
        setTimeout(() => { simulation.stop(); recenterGraph(); updateExpandRings(); setBusy(false); }, 3000);

    } catch (err) {
        console.error('renderGraph error:', err);
        setBusy(false);
        alert('Failed to render graph: ' + err.message);
    }
}

function ticked() {
    link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    node.attr("cx", d => d.x).attr("cy", d => d.y);
    label.attr("x", d => d.x).attr("y", d => d.y);
    // Expand-rings share the same data objects as rawNodes, so d.x/d.y are always current
    g.select(".expand-rings").selectAll("circle").attr("cx", d => d.x).attr("cy", d => d.y);
    // Keep the destination-ring centred on the final trace node as it moves
    if (traceFinalAddr) {
        const fn = rawNodes.find(n => n.id === traceFinalAddr);
        if (fn) {
            g.select('.dest-ring').selectAll('circle')
                .attr('cx', fn.x || 0).attr('cy', fn.y || 0);
        }
    }
    // Update edge label positions and text
    if (edgeLabel && edgeLabel.size && link) {
        edgeLabel.attr('x', d => (d.source.x + d.target.x) / 2)
                 .attr('y', d => (d.source.y + d.target.y) / 2 - 6)
                .text(d => {
                    const amt = typeof d.amount !== 'undefined' ? (satsToBTC(d.amount) + ' BTC') : '';
                    const ts = d.timestamp || d.ts || 0;
                    let tsText = '';
                    if (ts && Number(ts) > 0) {
                        try {
                            const dt = new Date(Number(ts) * 1000);
                            tsText = dt.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
                        } catch (e) { tsText = ''; }
                    }
                    // Only include timestamp in the label text; visibility is still
                    // controlled by hover/selection/toggle so we don't clutter view.
                    if (edgeTooltipsVisible) {
                        // When tooltips are enabled we still hide labels by default
                        // and show them on hover/selection; text contains amt+ts if available.
                        return tsText ? `${amt} • ${tsText}` : amt;
                    }
                    return (amt && tsText && timestampsVisible && (selectedNodeId && (d.source.id === selectedNodeId || d.target.id === selectedNodeId)))
                        ? `${amt} • ${tsText}`
                        : amt;
                });
    }
    // If an edge tooltip is visible while the simulation/tick runs, keep it positioned
    if (currentEdgeHover && edgeTooltipDiv && edgeTooltipDiv.style.display === 'block') {
        try {
            const d = currentEdgeHover;
            const midx = (d.source.x + d.target.x) / 2;
            const midy = (d.source.y + d.target.y) / 2;
            const pos = screenPosFromGraph(midx, midy);
            edgeTooltipDiv.style.left = (pos.left + 8) + 'px';
            edgeTooltipDiv.style.top  = (pos.top - 18) + 'px';
        } catch (e) { /* ignore transient state */ }
    }
}

// Convert graph-space coordinates (x,y) to screen coordinates for tooltip placement
function screenPosFromGraph(x, y) {
    if (!svg) return { left: 0, top: 0 };
    const rect = svg.node().getBoundingClientRect();
    const t = d3.zoomTransform(svg.node());
    // SVG viewBox centers at (0,0) so map graph x/y using zoom transform
    const cx = rect.left + rect.width / 2 + (x * t.k + t.x);
    const cy = rect.top  + rect.height / 2 + (y * t.k + t.y);
    return { left: cx, top: cy };
}

function createEdgeTooltip() {
    const containerEl = document.getElementById('graph-container');
    if (!containerEl) return;
    edgeTooltipDiv = document.getElementById('edge-tooltip');
    if (!edgeTooltipDiv) {
        edgeTooltipDiv = document.createElement('div');
        edgeTooltipDiv.id = 'edge-tooltip';
        edgeTooltipDiv.style.position = 'absolute';
        edgeTooltipDiv.style.pointerEvents = 'none';
        edgeTooltipDiv.style.padding = '6px 8px';
        edgeTooltipDiv.style.background = 'rgba(15,23,42,0.95)';
        edgeTooltipDiv.style.color = '#e6eef6';
        edgeTooltipDiv.style.fontFamily = 'JetBrains Mono, monospace';
        edgeTooltipDiv.style.fontSize = '12px';
        edgeTooltipDiv.style.borderRadius = '6px';
        edgeTooltipDiv.style.zIndex = 9999;
        edgeTooltipDiv.style.display = 'none';
        containerEl.appendChild(edgeTooltipDiv);
    }
}

function drag() {
    return d3.drag()
        .on("start", (ev, d) => {
            if (edgeTooltipDiv) edgeTooltipDiv.style.display = 'none';
            if (!isFrozen && !ev.active && simulation) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
        })
        .on("drag", (ev, d) => {
            d.fx = ev.x; d.fy = ev.y;
            if (isFrozen) ticked();
        })
        .on("end", (ev, d) => {
            if (!isFrozen && !ev.active && simulation) simulation.alphaTarget(0);
            // Persist the node position so the user's layout is preserved during this session
            d.fx = d.x; d.fy = d.y;
            try {
                if (fullGraphData && fullGraphData.nodes && fullGraphData.nodes[d.id]) {
                    fullGraphData.nodes[d.id].x = d.x;
                    fullGraphData.nodes[d.id].y = d.y;
                }
            } catch (e) { /* ignore */ }
        });
}

// =============================================================================
// EXPAND NODE — fetch a node's subgraph and merge it into the live graph
// =============================================================================

/**
 * Re-bind D3 selections after rawNodes/rawLinks have been mutated.
 * Uses D3's keyed join so existing elements are preserved and only new
 * ones are entered. The simulation is NOT rebuilt here — callers do that.
 */
function rebindGraphSelections() {
    const edgeColor = d => {
        const tid = d.target?.id || d.target;
        const tn  = fullGraphData?.nodes[tid];
        const r = tn && tn.risk ? tn.risk : 0;
        return r >= 70 ? "#ef4444" : r >= 40 ? "#f97316" : r >= 10 ? "#f59e0b" : "#64748b";
    };
    const edgeArrow = d => {
        const tid = d.target?.id || d.target;
        const tn  = fullGraphData?.nodes[tid];
        const r = tn && tn.risk ? tn.risk : 0;
        return r >= 70 ? "url(#arrowhead-risk)" : "url(#arrowhead-default)";
    };

    // ── Links ────────────────────────────────────────────────────────────────
    g.select(".links").selectAll("line")
        .data(rawLinks, l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return `${s}|${t}`;
        })
        .join(
            enter => enter.append("line")
                .attr("class", "link")
                .attr("stroke", edgeColor)
                .attr("stroke-opacity", 0.85)
                .attr("stroke-width", d => Math.max(2.5, Math.min(Math.sqrt((d.amount||0)+1)*2, 8)))
                .attr("marker-end", edgeArrow),
            update => update,
            exit   => exit.remove()
        );
    link = g.select(".links").selectAll("line");
    state.link = link;

    // ── Nodes ────────────────────────────────────────────────────────────────
    const riskColor = r => {
        if (r >= 70) return '#ef4444'; // high risk: red
        if (r >= 40) return '#f97316'; // med-high: orange
        if (r >= 10) return '#f59e0b'; // low-med: amber
        return '#06b6d4'; // minimal: teal
    };
    g.select(".nodes").selectAll("circle")
        .data(rawNodes, d => d.id)
        .join(
            enter => enter.append("circle")
                .attr("class", "node")
                .attr("r",    d => d.isTarget ? 18 : (d.type === 'Transaction' ? 4 : (d.risk ? 12 : 7)))
                .attr("fill", d => d.isTarget ? '#fbbf24' : (d.risk ? riskColor(d.risk) : (d.type === 'Transaction' ? '#6366f1' : '#0ea5e9')))
                .on("click",     (ev, d) => { ev.stopPropagation(); showEntityView(d.id); highlightNode(d.id); })
                .on("mouseover", (ev, d) => highlightNeighbors(d, true))
                .on("mouseout",  (ev, d) => highlightNeighbors(d, false))
                .call(drag()),
            update => update,
            exit   => exit.remove()
        );
    node = g.select(".nodes").selectAll("circle");
    state.node = node;

    // ── Labels ───────────────────────────────────────────────────────────────
    g.select(".labels").selectAll("text")
        .data(rawNodes, d => d.id)
        .join(
            enter => enter.append("text")
                .attr("class", "node-label")
                .text(d => d.label)
                .attr("dx", 12).attr("dy", ".35em")
                .attr("fill", "#1e293b").attr("font-size", "11px").attr("font-weight", "500"),
            update => update,
            exit   => exit.remove()
        );
    label = g.select(".labels").selectAll("text");
    // Rebind edge labels so they follow rawLinks and update on expansions
    const _edgeKey = l => {
        const s = l.source?.id || l.source;
        const t = l.target?.id || l.target;
        return `${s}|${t}`;
    };
    g.select('.edge-labels').remove();
    edgeLabel = g.insert('g', '.nodes').attr('class', 'edge-labels')
        .selectAll('text').data(rawLinks, _edgeKey)
        .join(
            enter => enter.append('text')
                .attr('class', 'edge-label')
                .attr('text-anchor', 'middle')
                .attr('fill', '#0f172a').attr('font-size', '10px').attr('font-weight', '500')
                .style('display', 'none'),
            update => update,
            exit => exit.remove()
        );
    // Rebind edge labels so they follow rawLinks and update on expansions
    const edgeKey = l => {
        const s = l.source?.id || l.source;
        const t = l.target?.id || l.target;
        return `${s}|${t}`;
    };
    // Remove any stale edge-labels group and recreate keyed join so labels align with edges
    g.select('.edge-labels').remove();
    edgeLabel = g.insert('g', '.nodes').attr('class', 'edge-labels')
        .selectAll('text').data(rawLinks, edgeKey)
        .join(
            enter => enter.append('text')
                .attr('class', 'edge-label')
                .attr('text-anchor', 'middle')
                .attr('fill', '#0f172a').attr('font-size', '10px').attr('font-weight', '500'),
            update => update,
            exit => exit.remove()
        );

    // Add hover listeners on links to show per-edge tooltip when enabled
    g.select('.links').selectAll('line')
        .on('mouseover', function(ev, d) {
            if (!edgeTooltipsVisible) return;
            if (!edgeTooltipDiv) createEdgeTooltip();
            currentEdgeHover = d;
            // position tooltip at the midpoint of the edge using current zoom transform
            const midx = (d.source.x + d.target.x) / 2;
            const midy = (d.source.y + d.target.y) / 2;
            const pos = screenPosFromGraph(midx, midy);
            const amt = typeof d.amount !== 'undefined' ? (satsToBTC(d.amount) + ' • ') : '';
            const ts = d.timestamp || d.ts || 0;
            let tsText = '';
            if (ts && Number(ts) > 0) {
                try { tsText = new Date(Number(ts) * 1000).toISOString().replace('T', ' ').split('.')[0] + ' UTC'; } catch (e) { tsText = ''; }
            }
            edgeTooltipDiv.textContent = (amt + (tsText || '')).trim();
            edgeTooltipDiv.style.left = (pos.left + 8) + 'px';
            edgeTooltipDiv.style.top  = (pos.top - 18) + 'px';
            edgeTooltipDiv.style.display = 'block';
        })
        .on('mouseout', function() {
            currentEdgeHover = null;
            if (edgeTooltipDiv) edgeTooltipDiv.style.display = 'none';
        })
        .on('mouseout', function(ev, d) {
            if (!edgeTooltipsVisible || !edgeTooltipDiv) return;
            edgeTooltipDiv.style.display = 'none';
        });

    // Hide tooltip when user starts dragging nodes
    g.select('.nodes').selectAll('circle').on('mousedown.tooltip-hide', () => { if (edgeTooltipDiv) edgeTooltipDiv.style.display = 'none'; });
}

/**
 * Draw/update dashed cyan rings around every Address node that has NOT yet
 * been expanded, so users can see what they can click to drill into.
 */
function updateExpandRings() {
    if (!g || !rawNodes.length) return;

    let ringGroup = g.select(".expand-rings");
    if (ringGroup.empty()) {
        // Insert before .nodes so rings appear behind the circles
        ringGroup = g.insert("g", ".nodes").attr("class", "expand-rings");
    }

    const expandable = rawNodes.filter(n => n.type === 'Address' && !expandedNodes.has(n.id));

    ringGroup.selectAll("circle")
        .data(expandable, d => d.id)
        .join(
            enter => enter.append("circle")
                .attr("fill",         "none")
                .attr("stroke",       "#06b6d4")
                .attr("stroke-width", 1.5)
                .attr("stroke-dasharray", "4 3")
                .attr("opacity",      0.55)
                .attr("r",  d => (d.isTarget ? 18 : 7) + 7)
                .attr("cx", d => d.x || 0)
                .attr("cy", d => d.y || 0),
            update => update
                .attr("r",  d => (d.isTarget ? 18 : 7) + 7),
            exit => exit.remove()
        );
}

/**
 * Fetch the subgraph for `nodeId`, merge new nodes/edges into the live
 * graph, restart the simulation, and update visual indicators.
 * Safe to call multiple times — already-expanded nodes are no-ops.
 */
async function expandNode(nodeId) {
    if (!fullGraphData || expandedNodes.has(nodeId)) return;
    expandedNodes.add(nodeId);
    updateExpandBtn();

    // Update rings immediately so the ring disappears while loading
    updateExpandRings();

    const short = nodeId.length > 16 ? nodeId.substring(0, 8) + '…' + nodeId.slice(-6) : nodeId;
    setBusy(true, 'EXPANDING NODE...', `Fetching connections for ${short}`);

    try {
        const res  = await fetch(`/api/trace/${nodeId}`);
        const data = await res.json();
        if (!data.graph?.nodes) { setBusy(false); return; }

        // Anchor position — new nodes will spawn around this point
        const anchor = rawNodes.find(n => n.id === nodeId);
        const ax = anchor?.x ?? 0;
        const ay = anchor?.y ?? 0;

        // Dedup maps
        const existingNodeIds  = new Set(rawNodes.map(n => n.id));
        const existingEdgeKeys = new Set(rawLinks.map(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return `${s}|${t}`;
        }));

        let newNodeCount = 0, newEdgeCount = 0;

        // ── Merge nodes ──────────────────────────────────────────────────────
        Object.entries(data.graph.nodes).forEach(([id, n]) => {
            if (existingNodeIds.has(id)) return;
            // Spawn in a ring around the anchor so the simulation has room to spread them
            const angle = Math.random() * 2 * Math.PI;
            const dist  = 80 + Math.random() * 80;
            rawNodes.push({
                id, ...n,
                label:    n.label || id,
                isTarget: false,
                x:  ax + Math.cos(angle) * dist,
                y:  ay + Math.sin(angle) * dist,
            });
            fullGraphData.nodes[id] = n;
            newNodeCount++;
        });

        // ── Merge edges ──────────────────────────────────────────────────────
        (data.graph.edges || []).forEach(e => {
            const key = `${e.source}|${e.target}`;
            if (existingEdgeKeys.has(key)) return;
            rawLinks.push({ ...e });
            if (!fullGraphData.edges) fullGraphData.edges = [];
            fullGraphData.edges.push(e);
            newEdgeCount++;
        });

        // ── Re-bind D3 selections with the merged data ───────────────────────
        rebindGraphSelections();
        updateExpandRings();

        // Update counters in sidebar
        document.getElementById('nodeCount').textContent = rawNodes.length.toLocaleString();
        document.getElementById('edgeCount').textContent = rawLinks.length.toLocaleString();

        // ── Rebuild simulation — do NOT reuse old one ────────────────────────
        // The old simulation already has stale node/link references.
        if (simulation) simulation.stop();
        simulation = d3.forceSimulation(rawNodes)
            .force("link",   d3.forceLink(rawLinks).id(d => d.id).distance(d => (d.amount||0) > 1 ? 100 : 50))
            .force("charge", d3.forceManyBody().strength(-120))
            .force("center", d3.forceCenter(0, 0))
            .on("tick", ticked);

        const msg = newNodeCount > 0
            ? `Added ${newNodeCount} node${newNodeCount!==1?'s':''}, ${newEdgeCount} edge${newEdgeCount!==1?'s':''}`
            : 'No new connections found';
        setBusy(true, 'RECALCULATING LAYOUT...', msg);
        setTimeout(() => { if (simulation) simulation.stop(); fitGraphToScreen(); setBusy(false); }, 2500);
        // Refresh timeline to include any newly added timestamps from expansion
        refreshTimelineFromRawLinks();

        // Ensure timeline covers any transaction timestamps present at initial load
        refreshTimelineFromRawLinks();

    } catch (err) {
        // Allow retry on network error
        expandedNodes.delete(nodeId);
        updateExpandRings();
        setBusy(false);
        console.error('expandNode error:', err);
    }
}
window.expandNode = expandNode;

// =============================================================================
// MISC CONVENIENCE HELPERS (toggle freeze/labels/layout etc.)
// =============================================================================

/**
 * Toggle node freezing on/off.  When frozen we pin current positions and stop
 * the simulation; unfreezing restarts it (or switches back from tree mode).
 */
export function toggleFreeze() {
    // In tree mode simulation is null — but nodes are already pinned, so
    // "unfreeze" means switching back to force layout, not just unpinning.
    if (!node) return;
    isFrozen = !isFrozen;
    const btn = document.getElementById('freezeText');
    if (isFrozen) {
        node.data().forEach(d => { d.fx = d.x; d.fy = d.y; });
        if (simulation) simulation.stop();
        if (btn) {
            btn.textContent = '[UNFREEZE]';
            btn.parentElement.classList.remove('bg-slate-800/90', 'border-slate-600');
            btn.parentElement.classList.add('bg-blue-700/90', 'border-blue-500', 'text-white');
        }
    } else {
        node.data().forEach(d => { d.fx = null; d.fy = null; });
        if (simulation) {
            simulation.alphaTarget(0).restart();
        }
        if (btn) {
            btn.textContent = '[FREEZE]';
            btn.parentElement.classList.remove('bg-blue-700/90', 'border-blue-500', 'text-white');
            btn.parentElement.classList.add('bg-slate-800/90', 'border-slate-600');
        }
    }
}

// =============================================================================
// TREE LAYOUT — proper d3.hierarchy + d3.cluster(), NOT force simulation
// =============================================================================

function applyTreeLayout() {
    if (!node || !link || !label || rawNodes.length === 0) return;

    // ── Step 1: Kill simulation completely. Do NOT reuse it. ──────────────────
    if (simulation) {
        simulation.stop();
        simulation = null;
    }
    // Clear every pinned position left over from force layout.
    // If any fx/fy survive, D3 will honour them and override our tree positions.
    node.data().forEach(d => { d.fx = null; d.fy = null; });
    isFrozen = true;

    const freezeBtn = document.getElementById('freezeText');
    if (freezeBtn) {
        freezeBtn.textContent = '[UNFREEZE]';
        freezeBtn.parentElement.classList.remove('bg-slate-800/90', 'border-slate-600');
        freezeBtn.parentElement.classList.add('bg-blue-700/90', 'border-blue-500', 'text-white');
    }

    // ── Step 2: Build a BFS spanning tree rooted at the target ───────────────
    // d3.hierarchy requires a strict tree (no cycles). The blockchain graph has
    // cycles, so we do a BFS and visit each node exactly once, turning the graph
    // into a spanning tree. Each edge is recorded as parent→child only once.
    const rootId = currentTargetId || rawNodes[0]?.id;
    if (!rootId) return;

    // Undirected adjacency from all raw edges
    const adj = new Map(rawNodes.map(n => [n.id, []]));
    rawLinks.forEach(l => {
        const sid = l.source.id || l.source;
        const tid = l.target.id || l.target;
        if (adj.has(sid)) adj.get(sid).push(tid);
        if (adj.has(tid)) adj.get(tid).push(sid);
    });

    // BFS: each visited node becomes a child of the node that first discovered it.
    const treeNodes = new Map(rawNodes.map(n => [n.id, { id: n.id, children: [] }]));
    const visited   = new Set([rootId]);
    const queue     = [rootId];
    while (queue.length) {
        const curr = queue.shift();
        for (const nb of (adj.get(curr) || [])) {
            if (!visited.has(nb)) {
                visited.add(nb);
                treeNodes.get(curr).children.push(treeNodes.get(nb));
                queue.push(nb);
            }
        }
    }
    // Disconnected nodes that BFS never reached: attach directly to root so
    // they don't disappear from the view.
    rawNodes.forEach(n => {
        if (!visited.has(n.id)) treeNodes.get(rootId).children.push(treeNodes.get(n.id));
    });

    // ── Step 3: Build d3.hierarchy and compute layout with d3.cluster() ──────
    // d3.cluster() aligns all leaves at the same depth — better visual for
    // dense wallet graphs than d3.tree(), which separates subtrees.
    const hierarchyRoot = d3.hierarchy(treeNodes.get(rootId), d => d.children);

    d3.cluster().nodeSize([36, 200])(hierarchyRoot);
    // d3.cluster assigns: d.x = breadth position, d.y = depth position.
    // We want left-to-right, so: screenX = d.y  (depth),  screenY = d.x  (breadth).

    // ── Step 4: Overwrite node positions ABSOLUTELY — not adjust, not animate from ──
    // Write directly into the data objects that the `node` selection references,
    // then pin with fx/fy so nothing can move them.
    const posMap = new Map();
    hierarchyRoot.descendants().forEach(d => posMap.set(d.data.id, { x: d.y, y: d.x }));

    node.data().forEach(d => {
        const pos = posMap.get(d.id);
        if (pos) { d.x = pos.x; d.y = pos.y; d.fx = pos.x; d.fy = pos.y; }
    });

    // ── Step 5: Replace visible edges with hierarchy-only edges ──────────────
    // Hide the original force-graph edges (they include non-tree cycles).
    // Draw a new <g class="tree-links"> with only the spanning-tree paths.
    link.style("display", "none");
    g.select(".tree-links").remove();

    const treeLinkData = hierarchyRoot.links().map(hl => {
        // Resolve back to the live node-data objects so coordinates are shared refs.
        const src = node.data().find(n => n.id === hl.source.data.id);
        const tgt = node.data().find(n => n.id === hl.target.data.id);
        // Carry through the original edge amount for stroke-width parity.
        const orig = rawLinks.find(rl => {
            const s = rl.source.id || rl.source, t = rl.target.id || rl.target;
            return (s === hl.source.data.id && t === hl.target.data.id) ||
                   (s === hl.target.data.id && t === hl.source.data.id);
        });
        return { source: src, target: tgt, amount: orig?.amount || 0 };
    }).filter(l => l.source && l.target);

    g.insert("g", ".nodes")                  // insert before nodes layer so nodes sit on top
        .attr("class", "tree-links")
        .selectAll("line")
        .data(treeLinkData)
        .enter().append("line")
        .attr("stroke", "#64748b")
        .attr("stroke-opacity", 0.85)
        .attr("stroke-width", d => Math.max(1.5, Math.min(Math.sqrt((d.amount || 0) + 1) * 2, 6)))
        .attr("marker-end", "url(#arrowhead-default)")
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);

    // ── Step 6: Animate nodes and labels to their absolute positions ──────────
    // The positions are already written into d.x/d.y — this is purely cosmetic.
    const t = d3.transition().duration(700).ease(d3.easeCubicInOut);
    node.transition(t).attr("cx", d => d.x).attr("cy", d => d.y);
    label.transition(t).attr("x", d => d.x).attr("y", d => d.y);

    // ── Step 7: Fit the entire tree to the viewport after animation ───────────
    setTimeout(() => fitGraphToScreen(), 750);
}

function applyForceLayout() {
    if (!node || !rawNodes.length) return;

    // Restore original force-graph edges (tree mode hid them and drew new ones).
    g.select(".tree-links").remove();
    link.style("display", null);

    // Unpin all nodes so the simulation can move them freely.
    node.data().forEach(d => { d.fx = null; d.fy = null; });
    isFrozen = false;

    const freezeBtn = document.getElementById('freezeText');
    if (freezeBtn) {
        freezeBtn.textContent = '[FREEZE]';
        freezeBtn.parentElement.classList.remove('bg-blue-700/90', 'border-blue-500', 'text-white');
        freezeBtn.parentElement.classList.add('bg-slate-800/90', 'border-slate-600');
    }

    // Simulation was nulled in applyTreeLayout — rebuild it from the stored raw data.
    simulation = d3.forceSimulation(node.data())
        .force("link",   d3.forceLink(rawLinks).id(d => d.id).distance(d => d.amount > 1 ? 100 : 50))
        .force("charge", d3.forceManyBody().strength(-100))
        .force("center", d3.forceCenter(0, 0))
        .on("tick", ticked);

    setBusy(true, 'RECALCULATING LAYOUT...', 'Running force simulation');
    setTimeout(() => { simulation.stop(); fitGraphToScreen(); setBusy(false); }, 2500);
}

export function toggleLayout() {
    if (!node) return;
    const btn = document.getElementById('layoutText');

    if (currentLayout === 'force') {
        currentLayout = 'tree';
        applyTreeLayout();
        if (btn) btn.textContent = '[FORCE VIEW]';
    } else {
        currentLayout = 'force';
        applyForceLayout();
        if (btn) btn.textContent = '[TREE VIEW]';
    }
}

export function toggleLabels() {
    labelsVisible = !labelsVisible;
    label.style("display", labelsVisible ? "block" : "none");
    document.getElementById('labelToggleText').textContent = labelsVisible ? '[HIDE LABELS]' : '[SHOW LABELS]';
}



export function zoomIn()  { if (svg) svg.transition().duration(300).call(zoom.scaleBy, 1.5); }
export function zoomOut() { if (svg) svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.5); }

export function recenterGraph() {
    if (!svg || !currentTargetId) return;
    const tn = node.data().find(n => n.id === currentTargetId);
    if (!tn) { fitGraphToScreen(); return; }
    // The SVG viewBox centers (0,0) at the visual center — no (w/2, h/2) offset needed.
    svg.transition().duration(1200).call(zoom.transform,
        d3.zoomIdentity.scale(2).translate(-tn.x, -tn.y));
}

export function fitGraphToScreen() {
    if (!svg || !node || !node.data().length) return;
    const nd = node.data();
    const minX = d3.min(nd, d => d.x), maxX = d3.max(nd, d => d.x);
    const minY = d3.min(nd, d => d.y), maxY = d3.max(nd, d => d.y);
    const w = +svg.attr("width"), h = +svg.attr("height");
    const gw = maxX - minX, gh = maxY - minY;
    if (isNaN(gw) || isNaN(gh) || !gw || !gh) return;
    const scale = Math.min(w / gw, h / gh) * 0.9;
    // The SVG viewBox is [-w/2, -h/2, w, h], so (0,0) IS the visual center.
    // Do NOT translate by (w/2, h/2) — that would move the graph to the bottom-right corner.
    svg.transition().duration(1000).call(zoom.transform,
        d3.zoomIdentity.scale(scale)
            .translate(-(minX + maxX) / 2, -(minY + maxY) / 2));
}

// =============================================================================
// HIGHLIGHT
// =============================================================================
let linkedByIndex = {};
function updateLinkedByIndex() {
    Object.keys(linkedByIndex).forEach(k => delete linkedByIndex[k]);
    link.data().forEach(d => { linkedByIndex[`${d.source.id},${d.target.id}`] = 1; });
}
function connected(a, b) {
    return linkedByIndex[`${a.id},${b.id}`] || linkedByIndex[`${b.id},${a.id}`] || a.id === b.id;
}

function applyLinkHighlight(activePred) {
    link.style("opacity", o => activePred(o) ? 1 : 0.12)
        .attr("stroke", o => {
            if (activePred(o)) return "#0ea5e9";
            const tn = fullGraphData?.nodes[o.target?.id];
            const r = tn && tn.risk ? tn.risk : 0;
            return r >= 70 ? "#ef4444" : r >= 40 ? "#f97316" : r >= 10 ? "#f59e0b" : "#64748b";
        })
        .attr("marker-end", o => {
            if (activePred(o)) return "url(#arrowhead-highlight)";
            const tn = fullGraphData?.nodes[o.target?.id];
            const r = tn && tn.risk ? tn.risk : 0;
            return r >= 70 ? "url(#arrowhead-risk)" : "url(#arrowhead-default)";
        });
}

function highlightNeighbors(d, hovering) {
    if (hovering) {
        updateLinkedByIndex();
        node.style("opacity", o => connected(d, o) ? 1 : 0.12);
        applyLinkHighlight(o => o.source === d || o.target === d);
        label.style("opacity", o => connected(d, o) ? 1 : 0.08);
        // Show edge labels only for edges connected to the hovered node
        if (edgeLabel) {
            edgeLabel.style('display', e => (timestampsVisible && (e.source === d || e.target === d)) ? 'block' : 'none');
        }
    } else { unhighlightAll(); }
}

function highlightNode(nodeId) {
    updateLinkedByIndex();
    const tn = node.data().find(n => n.id === nodeId);
    if (!tn) return;
    node.style("opacity", o => connected(tn, o) ? 1 : 0.12);
    applyLinkHighlight(o => o.source.id === nodeId || o.target.id === nodeId);
    label.style("opacity", o => connected(tn, o) ? 1 : 0.12);

    // track selection for the expand button
    selectedNodeId = nodeId;
    updateExpandBtn();
    if (edgeLabel) {
        edgeLabel.style('display', e => (timestampsVisible && (e.source.id === nodeId || e.target.id === nodeId)) ? 'block' : 'none');
    }
}

function unhighlightAll() {
    if (!node || !link || !label) return;
    node.style("opacity", 1);
    link.style("opacity", 0.85)
        .attr("stroke", d => {
            const tn = fullGraphData?.nodes[d.target?.id];
            const r = tn && tn.risk ? tn.risk : 0;
            return r >= 70 ? "#ef4444" : r >= 40 ? "#f97316" : r >= 10 ? "#f59e0b" : "#64748b";
        })
        .attr("marker-end", d => {
            const tn = fullGraphData?.nodes[d.target?.id];
            const r = tn && tn.risk ? tn.risk : 0;
            return r >= 70 ? "url(#arrowhead-risk)" : "url(#arrowhead-default)";
        });
    label.style("opacity", 1);
}

// Toggle timestamps visibility for hover/select; wired to toolbar button
export function toggleTimestamps() {
    timestampsVisible = !timestampsVisible;
    const txt = document.getElementById('timestampToggleText');
    if (txt) txt.textContent = timestampsVisible ? '[HIDE INFO]' : '[INFO]';
    if (!timestampsVisible && edgeLabel) edgeLabel.style('display', 'none');
    if (timestampsVisible && selectedNodeId && edgeLabel) {
        edgeLabel.style('display', e => (e.source.id === selectedNodeId || e.target.id === selectedNodeId) ? 'block' : 'none');
    }
}

// Toggle per-edge tooltips (amount + timestamp) on hover
export function toggleEdgeTooltips() {
    edgeTooltipsVisible = !edgeTooltipsVisible;
    const btn = document.getElementById('toggleEdgeTipBtn');
    if (btn) btn.textContent = edgeTooltipsVisible ? '[TOOLTIPS ON]' : '[TOOLTIPS]';
    // Hide any visible labels when turning off
    if (!edgeTooltipsVisible && edgeLabel) edgeLabel.style('display', 'none');
}

// =============================================================================
// ENTITY INTELLIGENCE PANEL
// =============================================================================
function showEntityView(nodeId) {
    if (!fullGraphData || !fullGraphData.nodes[nodeId]) return;

    // Close trace panel if open (and clear its graph highlight)
    const tv = document.getElementById('traceView');
    if (tv && !tv.classList.contains('hidden')) {
        tv.classList.add('hidden');
        if (window.clearTrace) window.clearTrace();
    }
    const nodeData = fullGraphData.nodes[nodeId];
    const allLinks = link.data();
    const degree   = allLinks.filter(l => l.source.id === nodeId || l.target.id === nodeId).length;

    let totalReceived = 0, totalSent = 0, incomingTx = 0, outgoingTx = 0;
    const txEvents = [];

    allLinks.forEach(l => {
        if (l.target.id === nodeId) {
            totalReceived += l.amount || 0; incomingTx++;
            if (l.timestamp > 0)
                txEvents.push({ dir: 'in', amount: l.amount || 0, ts: l.timestamp, peer: l.source.id || l.source });
        } else if (l.source.id === nodeId) {
            totalSent += l.amount || 0; outgoingTx++;
            if (l.timestamp > 0)
                txEvents.push({ dir: 'out', amount: l.amount || 0, ts: l.timestamp, peer: l.target.id || l.target });
        }
    });
    txEvents.sort((a, b) => b.ts - a.ts);

    const neighbors = new Set();
    allLinks.forEach(l => {
        if (l.source.id === nodeId) neighbors.add(l.target.id);
        if (l.target.id === nodeId) neighbors.add(l.source.id);
    });
    const balance = totalReceived - totalSent;
    const isAddress = nodeData.type === 'Address';

    // ── Risk banner ──────────────────────────────────────────────────────────
    const risk       = nodeData.risk || 0;
    const rd         = nodeData.risk_data;
    const hasReports = rd && rd.report_count > 0;
    const hasError   = rd && rd.error;

    // hasTaintOnly = risk is inherited from graph proximity (taint propagation),
    // NOT from direct ChainAbuse reports for this address/tx.
    // We must never show "NO RISK REPORTS ✅" when risk > 0 — that is contradictory.
    const hasTaintOnly = !hasReports && !hasError && risk > 0;

    let rc, rl, rbg, rbrd, rglow, ri;
    if (hasError) {
        rc='orange'; rl='API LIMIT REACHED';
        rbg='bg-orange-50'; rbrd='border-orange-300'; rglow=''; ri='⏳';
    } else if (hasTaintOnly) {
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
    html += `
    <div class="${rbg} ${rbrd} ${rglow} border rounded-lg p-4">
        <div class="flex items-center justify-between mb-2">
            <span class="text-${rc}-700 font-bold text-xs uppercase tracking-wider">${ri} ${rl}</span>
            <span class="text-${rc}-700 text-2xl font-bold">${hasError ? '?' : risk}</span>
        </div>
        <div class="bg-white/60 rounded-full h-2 mb-3">
            <div class="bg-${rc}-500 h-2 rounded-full transition-all duration-500"
                 style="width: ${(hasReports || hasTaintOnly) ? Math.max(risk, 4) : 100}%"></div>
        </div>`;

    if (hasError) {
        html += `<div class="text-[9px] text-orange-800 font-bold">${rd.error}</div>
                 <div class="text-[9px] text-orange-700 mt-1">Risk data temporarily unavailable.</div>`;
    } else if (hasReports) {
        html += `<div class="grid grid-cols-2 gap-2 text-[9px]">
            <div><div class="text-slate-500 uppercase">Reports</div><div class="font-bold text-slate-800">${rd.report_count}</div></div>
            <div><div class="text-slate-500 uppercase">Verified</div><div class="font-bold text-slate-800">${rd.has_verified_reports ? '✓ Yes' : 'No'}</div></div>
            <div><div class="text-slate-500 uppercase">Confidence</div><div class="font-bold text-slate-800">${(rd.avg_confidence_score * 100).toFixed(0)}%</div></div>
            <div><div class="text-slate-500 uppercase">Lost</div><div class="font-bold text-slate-800">${rd.total_amount.toFixed(2)} BTC</div></div>
        </div>`;
    } else {
        if (hasTaintOnly) {
            html += `
            <div class="text-[9px] text-amber-800 font-bold mb-1">No direct abuse reports for this address.</div>
            <div class="text-[9px] text-amber-700 leading-relaxed">
                Risk score of <strong>${risk}</strong> is inherited from graph proximity —
                this entity is within a few hops of a flagged address. It does not indicate
                confirmed involvement.
            </div>`;
        } else {
            html += `<div class="text-[9px] text-emerald-700">No abuse reports found. Address appears clean.</div>`;
        }
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
            ${nodeData.mixer_info && nodeData.mixer_info.flagged ? ('<span class="px-2 py-1 rounded text-[9px] font-bold bg-indigo-100 text-indigo-600 border border-indigo-200" title="Mixer heuristic score: '+(nodeData.mixer_info.score||0).toFixed(2)+'">🌀 MIXER '+(nodeData.mixer_info.mixer_type || '')+'</span>') : ''}
            ${hasTaintOnly && risk >= 40 ? '<span class="px-2 py-1 rounded text-[9px] font-bold bg-amber-100 text-amber-700 border border-amber-300" title="Risk inherited from nearby flagged nodes — no direct reports">🔗 TAINT ' + risk + '</span>' : ''}
            <a href="https://mempool.space/${isAddress ? 'address' : 'tx'}/${encodeURIComponent(nodeData.label)}"
               target="_blank" rel="noopener"
               class="px-2 py-1 rounded text-[9px] font-bold bg-cyan-50 text-cyan-600 border border-cyan-200 hover:bg-cyan-100 transition">
               🔍 mempool.space ↗
            </a>
        </div>

        ${isAddress ? `
        <div class="flex gap-2">
            <button onclick="window.expandNode('${nodeId}')"
                ${expandedNodes.has(nodeId) ? 'disabled' : ''}
                class="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg
                       ${expandedNodes.has(nodeId)
                           ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                           : 'bg-cyan-600 hover:bg-cyan-500 text-white'}
                       text-[10px] font-bold uppercase tracking-widest transition shadow">
                <span>${expandedNodes.has(nodeId) ? '✓' : '⊕'}</span>
                <span>${expandedNodes.has(nodeId) ? 'Already Expanded' : 'Expand Search'}</span>
            </button>
        </div>` : ''}

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
    document.getElementById('traceView')?.classList.add('hidden');
    document.getElementById('entityView').classList.remove('hidden');
}

// =============================================================================
// LIVE MEMPOOL ENRICHMENT — ADDRESS
// =============================================================================
window.enrichFromMempool = async function(nodeId, address) {
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
            <div class="bg-white border border-slate-200 rounded p-2">${recentTxRows}</div>
        </div>` : ''}
        ${utxoRows ? `
        <div class="mb-2">
            <div class="text-[9px] font-bold text-slate-500 uppercase mb-2">UTXOs (Unspent Outputs)</div>
            <div class="bg-white border border-slate-200 rounded p-2">${utxoRows}</div>
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
};

// =============================================================================
// LIVE MEMPOOL ENRICHMENT — TRANSACTION
// =============================================================================
window.enrichTxFromMempool = async function(txid) {
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
        ${inputRows ? `<div class="mb-2">
            <div class="text-[9px] font-bold text-slate-500 uppercase mb-1">
                Inputs${(tx.vin||[]).length > 5 ? ` (5 of ${tx.vin.length})` : ''}</div>
            <div class="bg-white border border-slate-200 rounded p-2">${inputRows}</div>
        </div>` : ''}
        ${outputRows ? `<div class="mb-2">
            <div class="text-[9px] font-bold text-slate-500 uppercase mb-1">
                Outputs${(tx.vout||[]).length > 5 ? ` (5 of ${tx.vout.length})` : ''}</div>
            <div class="bg-white border border-slate-200 rounded p-2">${outputRows}</div>
        </div>` : ''}
        <div class="mt-2 text-right">
            <a href="https://mempool.space/tx/${encodeURIComponent(txid)}" target="_blank"
               class="text-[9px] text-cyan-600 hover:underline">Full TX on mempool.space ↗</a>
        </div>`;

    } catch (err) {
        el.innerHTML = `<div class="text-[9px] text-red-500">⚠️ ${err.message}</div>`;
    }

    btn.disabled = false;
    btn.innerHTML = '⟳ Refresh';
};

function closeEntityView() {
    document.getElementById('entityView').classList.add('hidden');
    const tv = document.getElementById('traceView');
    if (!tv || tv.classList.contains('hidden')) {
        document.getElementById('liveView').classList.remove('hidden');
    }
}

// =============================================================================
// TIMELINE
// =============================================================================
function initTimeline(edges) {
    const ts_edges = edges.filter(e => e.timestamp > 0);
    if (!ts_edges.length) { document.getElementById('timelineUI').classList.add('hidden'); return; }

    const timestamps = ts_edges.map(e => e.timestamp).sort((a, b) => a - b);
    const minTS = timestamps[0], maxTS = timestamps[timestamps.length - 1];

    calendarTxDates = {};
    ts_edges.forEach(e => {
        const k = new Date(e.timestamp * 1000).toISOString().split('T')[0];
        calendarTxDates[k] = (calendarTxDates[k] || 0) + 1;
    });
    calendarViewDate = new Date(maxTS * 1000);

    if (!document.getElementById('calendarModal')) createCalendarUI();

    const ui = document.getElementById('timelineUI');
    if (!document.getElementById('btnOpenCalendar')) {
        const btn = document.createElement('button');
        btn.id = 'btnOpenCalendar';
        btn.className = 'ml-4 px-3 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-bold rounded uppercase tracking-wider transition';
        btn.textContent = 'Calendar';
        btn.onclick = toggleCalendar;
        ui.appendChild(btn);
    }

    const slider  = document.getElementById('timeSlider');
    const display = document.getElementById('dateDisplay');
    ui.classList.remove('hidden');
    slider.min = minTS; slider.max = maxTS; slider.value = maxTS;

    slider.oninput = () => {
        const v = parseInt(slider.value);
        const d = new Date(v * 1000);
        display.innerText = d.toISOString().split('T')[0];
        calendarViewDate = d;
        const cm = document.getElementById('calendarModal');
        if (cm && !cm.classList.contains('hidden')) renderCalendar();
        if (!link || !node) return;

        link.style("display", l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            const key = s + '|' + t;
            // keep trace-path edges visible regardless of timestamp
            if (typeof tracePathEdgeKeys !== 'undefined' && tracePathEdgeKeys && tracePathEdgeKeys.has(key)) return 'block';
            return (l.timestamp > 0 && l.timestamp > v) ? 'none' : 'block';
        });

        const vis = new Set([currentTargetId]);
        link.data().forEach(l => {
            if (l.timestamp === 0 || l.timestamp <= v) { vis.add(l.source.id); vis.add(l.target.id); }
        });
        // Ensure any nodes that are part of a traced path remain visible while scrubbing
        if (typeof tracePathNodeIds !== 'undefined' && tracePathNodeIds && tracePathNodeIds.size) {
            tracePathNodeIds.forEach(id => vis.add(id));
        }
        node.style("display",  d => vis.has(d.id) ? "block" : "none");
        label.style("display", d => vis.has(d.id) && labelsVisible ? "block" : "none");
    };
    slider.oninput();
}

/** Recompute timeline ranges from current `rawLinks` and update the UI slider.
 * Safe to call any time the graph gains new edges (e.g. expand or trace merge).
 */
function refreshTimelineFromRawLinks() {
    if (!rawLinks || rawLinks.length === 0) {
        const ui = document.getElementById('timelineUI');
        if (ui) ui.classList.add('hidden');
        return;
    }
    const ts_edges = rawLinks.filter(e => e.timestamp > 0);
    if (!ts_edges.length) { document.getElementById('timelineUI').classList.add('hidden'); return; }

    const timestamps = ts_edges.map(e => e.timestamp).sort((a, b) => a - b);
    const minTS = timestamps[0], maxTS = timestamps[timestamps.length - 1];

    calendarTxDates = {};
    ts_edges.forEach(e => {
        const k = new Date(e.timestamp * 1000).toISOString().split('T')[0];
        calendarTxDates[k] = (calendarTxDates[k] || 0) + 1;
    });
    calendarViewDate = new Date(maxTS * 1000);

    if (!document.getElementById('calendarModal')) createCalendarUI();

    const ui = document.getElementById('timelineUI');
    const slider  = document.getElementById('timeSlider');
    if (!ui || !slider) return;
    ui.classList.remove('hidden');
    slider.min = minTS; slider.max = maxTS;
    // If current slider value is outside new range, clamp it to max (latest)
    if (parseInt(slider.value) > maxTS || parseInt(slider.value) < minTS) slider.value = maxTS;
    // Update calendar display and invoke the oninput handler to re-evaluate visibility
    const display = document.getElementById('dateDisplay');
    const v = parseInt(slider.value);
    if (display) display.innerText = new Date(v * 1000).toISOString().split('T')[0];
    if (typeof slider.oninput === 'function') slider.oninput();
}

// =============================================================================
// CALENDAR
// =============================================================================
function createCalendarUI() {
    const div = document.createElement('div');
    div.id = 'calendarModal';
    div.className = 'hidden fixed bottom-20 left-1/2 -translate-x-1/2 bg-white border border-slate-200 shadow-2xl rounded-xl p-4 z-50 w-72 font-sans';
    div.innerHTML = `
        <div class="flex justify-between items-center mb-4">
            <button id="calPrev" class="p-1 hover:bg-slate-100 rounded text-slate-500">◀</button>
            <span id="calMonthYear" class="font-bold text-slate-700 text-sm"></span>
            <button id="calNext" class="p-1 hover:bg-slate-100 rounded text-slate-500">▶</button>
        </div>
        <div class="grid grid-cols-7 gap-1 text-center text-[10px] text-slate-400 mb-2 font-bold uppercase">
            <div>Su</div><div>Mo</div><div>Tu</div><div>We</div><div>Th</div><div>Fr</div><div>Sa</div>
        </div>
        <div id="calGrid" class="grid grid-cols-7 gap-1 text-xs"></div>
        <div class="mt-3 pt-2 border-t border-slate-100 flex justify-between items-center">
            <div class="flex items-center gap-1 text-[9px] text-slate-400">
                <div class="w-1.5 h-1.5 bg-red-500 rounded-full"></div><span>Activity</span>
            </div>
            <button onclick="toggleCalendar()" class="text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase">Close</button>
        </div>`;
    document.body.appendChild(div);
    document.getElementById('calPrev').onclick = () => { calendarViewDate.setMonth(calendarViewDate.getMonth() - 1); renderCalendar(); };
    document.getElementById('calNext').onclick = () => { calendarViewDate.setMonth(calendarViewDate.getMonth() + 1); renderCalendar(); };
}

export function toggleCalendar() {
    const m = document.getElementById('calendarModal');
    if (m.classList.contains('hidden')) { m.classList.remove('hidden'); renderCalendar(); }
    else m.classList.add('hidden');
}

function renderCalendar() {
    const yr = calendarViewDate.getFullYear(), mo = calendarViewDate.getMonth();
    document.getElementById('calMonthYear').textContent =
        calendarViewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const dim = new Date(yr, mo + 1, 0).getDate();
    const sdw = new Date(yr, mo, 1).getDay();
    const grid = document.getElementById('calGrid');
    grid.innerHTML = '';
    for (let i = 0; i < sdw; i++) grid.appendChild(document.createElement('div'));
    for (let d = 1; d <= dim; d++) {
        const ds  = `${yr}-${String(mo + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const cnt = calendarTxDates[ds] || 0;
        const sel = d === calendarViewDate.getDate() && mo === calendarViewDate.getMonth() && yr === calendarViewDate.getFullYear();
        const cell = document.createElement('div');
        cell.className = `p-2 text-center cursor-pointer rounded transition relative ${sel ? 'bg-cyan-500 text-white font-bold' : cnt > 0 ? 'hover:bg-red-50 font-bold text-slate-700' : 'hover:bg-slate-100 text-slate-500'}`;
        cell.innerHTML = `<span>${d}</span>${cnt > 0 ? `<div class="w-1 h-1 ${sel ? 'bg-white' : 'bg-red-500'} rounded-full mx-auto mt-0.5"></div>` : ''}`;
        cell.onclick = () => {
            const ts = Math.floor(new Date(yr, mo, d, 23, 59, 59).getTime() / 1000);
            const sl = document.getElementById('timeSlider');
            if (sl) { sl.value = Math.max(sl.min, Math.min(sl.max, ts)); sl.oninput(); }
            toggleCalendar();
        };
        grid.appendChild(cell);
    }
}

// =============================================================================
// TRACE PATH — merge hops into live graph + apply highlight
// =============================================================================

/** Convenience: resolve default fill for any node */
function defaultNodeFill(d) {
    if (d.isTarget)               return '#fbbf24';
    if (d.risk > 0)               return '#ef4444';
    if (d.type === 'Transaction') return '#6366f1';
    return '#0ea5e9';
}

/** Apply/refresh the orange path highlight across all current selections */
function applyTraceHighlight() {
    if (!node || !link || !label || !tracePathNodeIds) return;

    node.attr('fill', d => {
            if (d.id === traceFinalAddr) return '#f97316';
            if (tracePathNodeIds.has(d.id)) return defaultNodeFill(d);
            return defaultNodeFill(d);
        })
        .attr('r', d => {
            if (d.id === traceFinalAddr) return 16;
            return d.isTarget ? 18 : d.risk > 0 ? 12 : d.type === 'Transaction' ? 4 : 7;
        })
        .style('opacity', d => tracePathNodeIds.has(d.id) ? 1 : 0.15);

    link.attr('stroke', d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return tracePathEdgeKeys.has(s + '|' + t) ? '#f97316' : '#64748b';
        })
        .attr('stroke-width', d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return tracePathEdgeKeys.has(s + '|' + t) ? 3 : Math.max(1, Math.sqrt((d.amount || 0) + 1));
        })
        .attr('marker-end', d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return tracePathEdgeKeys.has(s + '|' + t) ? 'url(#arrowhead-trace)' : 'url(#arrowhead-default)';
        })
        .style('opacity', d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return tracePathEdgeKeys.has(s + '|' + t) ? 1 : 0.08;
        });

    label.style('opacity', d => tracePathNodeIds.has(d.id) ? 1 : 0.06);
}

/** Draw (or update) the glowing destination ring around the final node */
function drawDestRing() {
    if (!g || !traceFinalAddr) return;
    const fn = rawNodes.find(n => n.id === traceFinalAddr);
    if (!fn) return;

    let destGroup = g.select('.dest-ring');
    if (destGroup.empty()) destGroup = g.insert('g', '.nodes').attr('class', 'dest-ring');
    destGroup.selectAll('circle').remove();

    // Outer glow ring
    destGroup.append('circle')
        .attr('cx', fn.x || 0).attr('cy', fn.y || 0)
        .attr('r', 28)
        .attr('fill', 'none')
        .attr('stroke', '#f97316')
        .attr('stroke-width', 3)
        .attr('stroke-dasharray', '7 4')
        .attr('opacity', 0.9);

    // Inner solid ring
    destGroup.append('circle')
        .attr('cx', fn.x || 0).attr('cy', fn.y || 0)
        .attr('r', 20)
        .attr('fill', 'rgba(249,115,22,0.12)')
        .attr('stroke', '#fb923c')
        .attr('stroke-width', 1.5)
        .attr('opacity', 0.7);
}

/**
 * Merge a TracePath object into the live D3 graph one hop at a time,
 * animating each new node/edge appearing as the simulation runs.
 * The final destination is highlighted with an orange glow ring.
 * Safe to call before runSleuth — bootstraps the SVG if needed.
 */
export async function mergePathIntoGraph(path) {
    if (!path || !path.hops || path.hops.length === 0) return;

    // Bootstrap a bare SVG if no graph has been loaded yet
    if (!g || !svg) {
        const containerEl = document.getElementById('graph-container');
        containerEl.innerHTML = '';
        const width = containerEl.clientWidth, height = containerEl.clientHeight;

        svg = d3.select(containerEl).append('svg')
            .attr('width', width).attr('height', height)
            .style('background', '#ffffff')
            .attr('viewBox', [-width / 2, -height / 2, width, height])
            .on('click', ev => {
                if (ev.target.tagName === 'svg') {
                    closeEntityView(); unhighlightAll();
                    selectedNodeId = null; updateExpandBtn();
                }
            });

        const defs = svg.append('defs');
        const mkArrow = (id, color) => defs.append('marker').attr('id', id)
            .attr('viewBox', '0 -5 10 10').attr('refX', 20).attr('refY', 0)
            .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto')
            .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', color);
        mkArrow('arrowhead-default',   '#64748b');
        mkArrow('arrowhead-highlight', '#0ea5e9');
        mkArrow('arrowhead-risk',      '#ef4444');
        mkArrow('arrowhead-trace',     '#f97316');

        g = svg.append('g');
        g.append('g').attr('class', 'links');
        g.append('g').attr('class', 'nodes');
        g.append('g').attr('class', 'labels');

        zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', ev => g.attr('transform', ev.transform));
        svg.call(zoom);
        state.svg = svg;

        rawNodes = [];
        rawLinks = [];
        link  = g.select('.links').selectAll('line');
        node  = g.select('.nodes').selectAll('circle');
        label = g.select('.labels').selectAll('text');
        state.link = link;
        state.node = node;
        fullGraphData = { nodes: {}, edges: [] };
        state.fullGraphData = fullGraphData;
    }

    // Initialise module-level trace state
    traceFinalAddr    = path.final_addr;
    tracePathNodeIds  = new Set([path.start]);
    tracePathEdgeKeys = new Set();

    // Build lookup sets from what's already in the graph
    const existingNodeIds  = new Set(rawNodes.map(n => n.id));
    const existingEdgeKeys = new Set(rawLinks.map(l => {
        const s = l.source?.id || l.source;
        const t = l.target?.id || l.target;
        return s + '|' + t;
    }));

    // Anchor position: start from the origin node if it exists, else centre
    const startNode = rawNodes.find(n => n.id === path.start);
    let prevX = startNode?.x ?? 0;
    let prevY = startNode?.y ?? 0;

    // Add the origin node if missing
    if (!existingNodeIds.has(path.start)) {
        rawNodes.push({
            id: path.start, label: path.start, type: 'Address',
            sources: ['Trace'], risk: 0, isTarget: !rawNodes.length,
            x: prevX, y: prevY
        });
        fullGraphData.nodes[path.start] = { label: path.start, type: 'Address', sources: ['Trace'], risk: 0 };
        existingNodeIds.add(path.start);
    }

    // Kick off a gentle simulation over everything already in the graph
    if (simulation) simulation.stop();
    simulation = d3.forceSimulation(rawNodes)
        .force('link',   d3.forceLink(rawLinks).id(d => d.id).distance(60))
        .force('charge', d3.forceManyBody().strength(-120))
        .force('center', d3.forceCenter(0, 0))
        .alphaDecay(0.03)
        .on('tick', ticked);

    rebindGraphSelections();
    applyTraceHighlight();

    // ── Add hops one at a time ────────────────────────────────────────────────
    const STEP_X = 180;
    const total  = path.hops.length;

    for (let idx = 0; idx < total; idx++) {
        const hop = path.hops[idx];

        setBusy(true,
            'TRACING PATH… HOP ' + (idx + 1) + ' / ' + total,
            '\u2192 ' + (hop.to_addr.length > 28 ? hop.to_addr.substring(0, 14) + '\u2026' + hop.to_addr.slice(-10) : hop.to_addr)
        );

        // Spread hops in a slight arc to avoid overlap
        const angle  = (idx - (total - 1) / 2) * 0.3; // radians
        const txX    = prevX + STEP_X * Math.cos(angle);
        const txY    = prevY + STEP_X * Math.sin(angle) * 0.5;
        const toX    = prevX + STEP_X * 1.9 * Math.cos(angle);
        const toY    = prevY + STEP_X * 1.9 * Math.sin(angle) * 0.5;

        // Add TX node
        if (!existingNodeIds.has(hop.tx_hash)) {
            rawNodes.push({
                id: hop.tx_hash, label: hop.tx_hash, type: 'Transaction',
                sources: ['Trace'], risk: 0, isTarget: false, x: txX, y: txY
            });
            fullGraphData.nodes[hop.tx_hash] = { label: hop.tx_hash, type: 'Transaction', sources: ['Trace'], risk: 0 };
            existingNodeIds.add(hop.tx_hash);
        }
        tracePathNodeIds.add(hop.tx_hash);

        // Add destination address node
        if (!existingNodeIds.has(hop.to_addr)) {
            rawNodes.push({
                id: hop.to_addr, label: hop.label || hop.to_addr, type: 'Address',
                sources: ['Trace'], risk: hop.risk || 0, isTarget: false, x: toX, y: toY
            });
            fullGraphData.nodes[hop.to_addr] = {
                label: hop.label || hop.to_addr, type: 'Address',
                sources: ['Trace'], risk: hop.risk || 0
            };
            existingNodeIds.add(hop.to_addr);
        }
        tracePathNodeIds.add(hop.from_addr);
        tracePathNodeIds.add(hop.to_addr);

        // from_addr → tx_hash
        const k1 = hop.from_addr + '|' + hop.tx_hash;
        if (!existingEdgeKeys.has(k1)) {
            rawLinks.push({ source: hop.from_addr, target: hop.tx_hash, amount: hop.amount, timestamp: hop.timestamp });
            fullGraphData.edges.push({ source: hop.from_addr, target: hop.tx_hash, amount: hop.amount });
            existingEdgeKeys.add(k1);
        }
        tracePathEdgeKeys.add(k1);

        // tx_hash → to_addr
        const k2 = hop.tx_hash + '|' + hop.to_addr;
        if (!existingEdgeKeys.has(k2)) {
            rawLinks.push({ source: hop.tx_hash, target: hop.to_addr, amount: hop.amount, timestamp: hop.timestamp });
            fullGraphData.edges.push({ source: hop.tx_hash, target: hop.to_addr, amount: hop.amount });
            existingEdgeKeys.add(k2);
        }
        tracePathEdgeKeys.add(k2);

        prevX = toX;
        prevY = toY;

        // Rebind selections so new nodes/edges enter the DOM
        rebindGraphSelections();

        // Restart simulation with a small kick so new nodes animate in
        if (simulation) {
            simulation.nodes(rawNodes);
            simulation.force('link').links(rawLinks);
            simulation.alpha(0.4).restart();
        }

        // Apply highlight to path so far
        applyTraceHighlight();

        document.getElementById('nodeCount').textContent = rawNodes.length.toLocaleString();
        document.getElementById('edgeCount').textContent = rawLinks.length.toLocaleString();

        // Pause between hops so the user sees each one appear
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    // ── All hops added — finalise ─────────────────────────────────────────────
    setBusy(true, 'FINALISING TRACE…', 'Settling layout');

    if (simulation) simulation.alpha(0.6).restart();

    // Let the simulation settle then do the final highlight + ring
    await new Promise(resolve => setTimeout(resolve, 1500));

    if (simulation) simulation.stop();

    updateExpandRings();
    applyTraceHighlight();
    drawDestRing();
    fitGraphToScreen();
    // Ensure timeline covers trace hops' timestamps
    refreshTimelineFromRawLinks();
    setBusy(false);
}

/**
 * Reset all node/edge colours and opacities back to defaults,
 * remove the destination ring, and clear module-level trace state.
 * Called when the trace panel is closed.
 */
export function clearPathHighlight() {
    traceFinalAddr    = null;
    tracePathNodeIds  = null;
    tracePathEdgeKeys = null;

    if (!node || !link || !label) return;

    node.attr('fill', d => defaultNodeFill(d))
        .attr('r',    d => d.isTarget ? 18 : (d.type === 'Transaction' ? 4 : (d.risk ? 12 : 7)))
        .style('opacity', 1);

    link.attr('stroke', d => {
            const tn = fullGraphData?.nodes[d.target?.id];
            const r = tn && tn.risk ? tn.risk : 0;
            return r >= 70 ? '#ef4444' : r >= 40 ? '#f97316' : r >= 10 ? '#f59e0b' : '#64748b';
        })
        .attr('stroke-width', d => Math.max(2.5, Math.min(Math.sqrt((d.amount || 0) + 1) * 2, 8)))
        .attr('marker-end', d => {
            const tn = fullGraphData?.nodes[d.target?.id];
            const r = tn && tn.risk ? tn.risk : 0;
            return r >= 70 ? 'url(#arrowhead-risk)' : 'url(#arrowhead-default)';
        })
        .style('opacity', 0.85);

    label.style('opacity', 1);
    g?.select('.dest-ring')?.selectAll('circle')?.remove();
}

// Graph module: exports D3 rendering and interaction functions
// runSleuth is defined in main.js as the primary orchestrator
export { expandNode, updateExpandRings, updateExpandBtn };