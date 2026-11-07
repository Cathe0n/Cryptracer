import { state } from './state.js';
// D3.js Graph Renderer — Cryptracer
// Mempool.space API integrated for live on-chain enrichment
console.log('Cryptracer: D3 Renderer Loaded');

import { MEMPOOL_API } from './state.js';
import { getNodeCustomColor, getNodeCustomName } from './annotations.js';
import { showEntityView, getEnrichedEntityInfo } from './ui.js';
import { setBusy, showToast } from './utils.js';
import { initPlayback } from './playback.js';
import { getEdgeColor as getGraphEdgeColor } from './graph-colors.js';
import {
    buildWalletGraph as buildWalletGraphModule,
    getWalletId as getWalletIdModule,
} from './graph-wallet.js';

const getEdgeColor = edge => getGraphEdgeColor(edge, fullGraphData, detectMiningPool);

/**
 * Update node count display in both DOM and state
 * @param {number} count - Number of nodes to display
 */
function updateNodeCountDisplay(count) {
    const previousCount = state.nodeCount;
    state.nodeCount = count;
    const el = document.getElementById('nodeCount');
    if (el) {
        el.textContent = count.toLocaleString();
        
        // Trigger animation when count changes
        if (count !== previousCount) {
            // Remove existing animation classes
            el.classList.remove('updating', 'flash');
            // Trigger reflow to restart animation
            void el.offsetWidth;
            // Add animation classes
            el.classList.add('updating');
            if (count > previousCount) {
                el.classList.add('flash');
            }
            // Remove animation classes after animation completes
            setTimeout(() => {
                el.classList.remove('updating', 'flash');
            }, 800);
        }
    }
}

/**
 * Update mixer detection display
 * @param {Array} mixerNodes - Array of nodes with mixer_info detected
 */
function updateMixerDetectionDisplay(mixerNodes) {
    const panel = document.getElementById('mixerDetectionPanel');
    const countEl = document.getElementById('mixerCount');
    const statusEl = document.getElementById('mixerStatus');
    const detailsEl = document.getElementById('mixerDetails');
    
    if (!panel || !countEl || !statusEl) return;
    
    if (mixerNodes.length === 0) {
        panel.classList.add('hidden');
        return;
    }
    
    // Show the panel
    panel.classList.remove('hidden');
    
    // Update count
    countEl.textContent = mixerNodes.length;
    
    // Update status
    if (mixerNodes.length === 1) {
        statusEl.textContent = ' 1 Mixer Found';
    } else {
        statusEl.textContent = ` ${mixerNodes.length} Mixers Found`;
    }
    
    // Build details
    let detailsHTML = '';
    mixerNodes.slice(0, 5).forEach(mixer => {
        const type = mixer.mixer_info?.raw?.mixer_type || 'Unknown';
        const conf = mixer.mixer_info?.confidence || 0;
        const shortId = mixer.id.substring(0, 12) + '...';
        detailsHTML += `
            <div class="p-2 rounded bg-indigo-900/40 border border-indigo-500/30">
                <div class="font-bold text-indigo-300">${type}</div>
                <div class="text-slate-400 text-[7px] mt-0.5">${shortId}</div>
                <div class="text-indigo-400 text-[8px] mt-1">Confidence: <strong>${conf}%</strong></div>
            </div>
        `;
    });
    
    if (mixerNodes.length > 5) {
        detailsHTML += `<div class="text-slate-500 text-[8px] italic p-2">+${mixerNodes.length - 5} more mixers</div>`;
    }
    
    if (detailsEl) {
        detailsEl.innerHTML = detailsHTML;
        detailsEl.classList.remove('hidden');
    }
}

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
let timestampsVisible = false;
let edgeTooltipsVisible = false; // show amount+timestamp tooltips on hover when true
let isFrozen = false;
let currentLayout = 'force';  // 'force' | 'tree'
let layoutSettleTimeout = null;
let miningFilterActive = false; // true when hiding mining pool nodes
let incomingFilterActive = false; // true when showing only incoming transactions
let outgoingFilterActive = false; // true when showing only outgoing transactions
let rawNodes = [];
let rawLinks = [];
let calendarTxDates = {};
let calendarViewDate = new Date();
let timelineCollapsed = false;
let expandedNodes   = new Set(); // tracks which address nodes have been expanded
window._expandedNodes = expandedNodes;  // expose for ui.js button state
let selectedNodeId  = null;   // currently-selected node (used by toolbar button)

// ── Wallet View (co-spend cluster collapse) ──────────────────────────────────
let walletViewActive  = false;   // true when graph is in wallet/cluster view
let walletGraphData   = null;    // the collapsed wallet graph (built on demand)
let _fullGraphDataBak = null;    // stash of original address-level graph
let _targetIdBak      = null;    // stash of original targetId before collapse

// ── Trace-path state (kept at module level so ticked() can use it) ──────────
let traceFinalAddr    = null;  // final destination address of current trace
let tracePathNodeIds  = null;  // Set<id> of nodes in active trace path
let tracePathEdgeKeys = null;  // Set<"s|t"> of edges in active trace path
let traceRequestGeneration = 0;
let renderWarmupTimeout = null;
let lastGraphRenderAt = 0;

// ── Arrow marker management ──────────────────────────────────────────────────
let defs = null;  // SVG <defs> element for markers
let arrowMarkerCache = new Map();  // Cache of created arrow marker IDs

/**
 * Get or create an arrow marker for a specific color
 * @param {string} color - Hex color code
 * @returns {string} URL reference to the marker (e.g., "url(#arrowhead-xxx)")
 */
function getArrowMarkerId(color) {
    if (!defs) return "url(#arrowhead-default)";
    if (!arrowMarkerCache.has(color)) {
        const markerId = `arrowhead-${color.slice(1)}`;
        arrowMarkerCache.set(color, markerId);
        defs.append("marker")
            .attr("id", markerId).attr("viewBox", "0 -6 12 12")
            .attr("refX", 11).attr("refY", 0)
            .attr("markerWidth", 9).attr("markerHeight", 9)
            .attr("markerUnits", "userSpaceOnUse")
            .attr("orient", "auto")
            .append("path").attr("d", "M0,-6L12,0L0,6Z").attr("fill", color);
    }
    return `url(#${arrowMarkerCache.get(color)})`;
}

// ── Mining Pool Detection (using mempool.space API) ──────────────────────────
let miningPoolsCache = null;  // Cache of mining pools fetched from API
let miningPoolSlugMap = {};   // Map of slug -> pool info for quick lookup
let miningPoolCacheTimeout = 3600000; // 1 hour cache
let miningPoolCacheTime = 0;

/**
 * Fetch and cache mining pools from mempool.space API
 * @returns {Promise<Object>} Mining pools data { pools: [...], blockCount, lastEstimatedHashrate }
 */
async function fetchMiningPools() {
    const now = Date.now();
    // Use cache if fresh (within 1 hour)
    if (miningPoolsCache && (now - miningPoolCacheTime) < miningPoolCacheTimeout) {
        return miningPoolsCache;
    }
    
    try {
        const { mempoolGetMiningPools } = await import('./api.js');
        const data = await mempoolGetMiningPools('1w');
        if (data && data.pools) {
            // Build slug map for quick reference
            miningPoolSlugMap = {};
            data.pools.forEach(pool => {
                miningPoolSlugMap[pool.slug] = pool;
            });
            miningPoolsCache = data;
            miningPoolCacheTime = now;
            return data;
        }
    } catch (err) {
        console.warn('Failed to fetch mining pools from mempool.space:', err);
    }
    return null;
}

/**
 * Check if a node is a known mining pool or mining transaction
 * Detects both mining pool address nodes AND coinbase transaction nodes
 * @param {Object} nodeData - Node data object
 * @returns {Object|null} Mining pool/tx info or null
 */
function detectMiningPool(nodeData) {
    if (!nodeData) return null;

    // ── Tier 1: hard data set by backend (100% reliable) ────────────────────
    // The aggregator calls /v1/block/:hash for every confirmed tx and writes
    // mining_pool_info + entity_type='mining' on matches. Trust these blindly.
    if (nodeData.mining_pool_info) {
        return nodeData.mining_pool_info;
    }
    if (nodeData.entity_type === 'mining') {
        const lbl = (nodeData.label || '').toLowerCase();
        for (const [slug, pool] of Object.entries(miningPoolSlugMap)) {
            if (lbl.includes(slug) || lbl.includes(pool.name.toLowerCase())) return pool;
        }
        return { name: nodeData.label || 'Mining Pool', slug: 'unknown', entity_type: 'mining' };
    }

    // ── Tier 2: explicit coinbase flag on Transaction nodes ──────────────────
    // IMPORTANT: DO NOT check input_count === 0 here.
    // In the Go JSON response, input_count defaults to 0 for every Transaction
    // node that was added via addNode() without going through the TX-enrichment
    // loop (e.g., Bitquery-sourced nodes, local-DB nodes).  Using it as a
    // coinbase signal causes ALL unenriched transaction nodes to be flagged,
    // which removes ALL edges from the graph — the exact bug this fixes.
    if (nodeData.type === 'Transaction') {
        if (nodeData.is_coinbase === true) {
            return { name: 'Coinbase TX', slug: 'coinbase', entity_type: 'mining', is_coinbase: true };
        }
        if (nodeData.mining_info) {
            return { name: 'Mining Pool TX', slug: 'mining_pool_tx', entity_type: 'mining' };
        }
        // Label-based matching: only fire when the backend has already embedded
        // a pool name in the label (e.g. "Foundry USA (Coinbase)", "F2Pool (TX)")
        const lbl = (nodeData.label || '').toLowerCase();
        if (lbl.includes('coinbase tx') || lbl.endsWith('(coinbase)')) {
            return { name: nodeData.label, slug: 'coinbase', entity_type: 'mining', is_coinbase: true };
        }
        for (const [slug, pool] of Object.entries(miningPoolSlugMap)) {
            if (pool.name && lbl.includes(pool.name.toLowerCase())) {
                return { name: pool.name, slug, entity_type: 'mining' };
            }
        }
    }

    return null;
}

/**
 * Get enriched display name for a node, prioritizing entity enrichment
 * @param {string} nodeId - The node ID
 * @param {Object} nodeData - The node data object
 * @returns {string} Display name to show in graph
 */
function getEnrichedNodeName(nodeId, nodeData) {
    // First check for user-provided custom name
    const customName = getNodeCustomName(nodeId);
    if (customName) return customName;
    
    // Then check for enriched entity info
    const enriched = getEnrichedEntityInfo(nodeData);
    if (enriched && enriched.name) return enriched.name;
    
    // Fall back to node label or ID
    return nodeData.label || nodeId;
}

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

// =============================================================================
// MEMPOOL.SPACE API HELPERS
// =============================================================================

/** Fetch with 8s timeout and mempool.guide fallback */
async function mempoolFetch(path) {
    const apis = [
        MEMPOOL_API, 
        "https://mempool.guide/api", 
        "https://mempool.emzy.de/api",
        "https://blockstream.info/api"
    ];
    let lastErr;

    for (const api of apis) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // Faster failover for takeover
        try {
            const res = await fetch(`${api}${path}`, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            lastErr = err;
            continue; // Try next API
        } finally {
            clearTimeout(timeout);
        }
    }
    throw lastErr || new Error("All mempool APIs failed");
}

const mempoolGetAddress    = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}`);
const mempoolGetUTXOs      = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}/utxo`);
const mempoolGetTxs        = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}/txs`);
const mempoolGetTx         = txid  => mempoolFetch(`/tx/${encodeURIComponent(txid)}`);
/** Format satoshis → BTC string */
function satsToBTC(sats) {
    return (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

// Format BTC value that's already in BTC (not satoshis)
function formatBTC(btc) {
    if (typeof btc !== 'number') return '0';
    return btc.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function edgeLabelText(d) {
    const amount = typeof d.amount !== 'undefined' ? `${formatBTC(d.amount)} BTC` : '';
    const timestamp = d.timestamp || d.ts || 0;
    if (!amount || !timestamp || !timestampsVisible || !selectedNodeId) return amount;

    try {
        const date = new Date(Number(timestamp) * 1000);
        if (!Number.isFinite(date.getTime())) return amount;
        return `${amount} • ${date.toISOString().replace('T', ' ').split('.')[0]} UTC`;
    } catch {
        return amount;
    }
}

function positionVisibleEdgeLabels() {
    if (!edgeLabel || !link) return;
    edgeLabel.filter(function() { return this.style.display !== 'none'; })
        .each(function(d) {
            const position = linkLabelPosition(d);
            d3.select(this).attr('x', position.x).attr('y', position.y);
        });
}

function updateEdgeLabelText() {
    if (edgeLabel) edgeLabel.text(edgeLabelText);
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
            const res = await fetch('/api/network-stats');
            const data = await res.json();
            
            if (!data.fees || !data.height) {
                el.innerHTML = `<span class="text-[10px] text-slate-600 italic">Stats partially available...</span>`;
                if (!data.height) return;
            }

            const { fees, height, da } = data;

            const daHtml = da ? `
                <span class="text-slate-600">|</span>
                <span class="text-slate-400 uppercase">Diff</span>
                <span title="Next adjustment in ${da.remainingBlocks} blocks" class="text-violet-400 font-bold">${da.difficultyChange > 0 ? '+' : ''}${da.difficultyChange.toFixed(2)}%</span>
            ` : '';

            const feeHtml = fees ? `
                <span class="text-slate-400 uppercase">Fees</span>
                <span title="~10 min" class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-green-400"></span><span class="text-green-400 font-bold">${fees.fastestFee}</span></span>
                <span title="~30 min" class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-yellow-400"></span><span class="text-yellow-400 font-bold">${fees.halfHourFee}</span></span>
                <span title="~1 hr" class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-orange-400"></span><span class="text-orange-400 font-bold">${fees.hourFee}</span></span>
            ` : '';

            el.innerHTML = `
                <div class="flex items-center gap-4 text-[10px] font-mono">
                    <span class="text-slate-400 uppercase tracking-wider">Block</span>
                    <span class="text-cyan-400 font-bold">#${height.toLocaleString()}</span>
                    <span class="text-slate-600">|</span>
                    ${feeHtml}
                    ${daHtml}
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
                    ${entry.risk > 0 ? `<span class="font-bold ${riskColor}"> ${entry.risk}</span>` : '<span class="text-emerald-600">✓ clean</span>'}
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
    const requestGeneration = ++traceRequestGeneration;

    // Keep the input in sync when called programmatically
    if (forcedId) document.getElementById('targetId').value = forcedId;
    state.currentTargetId = id;

    currentTargetId = id;
    setBusy(true, 'INITIATING INVESTIGATION...', `Target: ${id.substring(0, 20)}...`);

    try {
        setBusy(true, 'FETCHING NETWORK DATA...', 'Querying blockchain graph database...');
        // The graph and the history panel are independent — fire both
        // requests together instead of paying two serial round-trips.
        const tracePromise   = fetch(`/api/trace/${id}`).then(r => r.json());
        const historyPromise = fetch(`/api/history/${id}`).then(r => r.json());
        const data = await tracePromise;
        if (requestGeneration !== traceRequestGeneration) return;

        if (!data.graph || !data.graph.nodes) {
            setBusy(false); alert('No graph data returned.'); return;
        }

        const nodeCount = Object.keys(data.graph.nodes || {}).length;
        const edgeCount = (data.graph.edges || []).length;
        console.log(`Received ${nodeCount} nodes, ${edgeCount} edges`);

        setBusy(true, 'PROCESSING GRAPH DATA...', `Found ${nodeCount} entities and ${edgeCount} transactions`);

        // Show mixer detection is active
        showToast(
            ' Advanced Mixer Detection Engine Active — Analyzing transaction patterns...',
            'info',
            3000
        );

        document.getElementById('intelBox').classList.remove('hidden');
        document.getElementById('riskCount').innerText     = data.graph.nodes[id]?.risk  || 0;
        document.getElementById('identityLabel').innerText = data.graph.nodes[id]?.label || id;

        // Record this search in history before rendering
        addToHistory(id, data.graph);

        setBusy(true, 'LOADING TRANSACTION HISTORY...', 'Retrieving activity logs...');
        const txs = await historyPromise;
        if (requestGeneration !== traceRequestGeneration) return;

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
        if (requestGeneration !== traceRequestGeneration) return;
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

export function clearGraph() {
    traceRequestGeneration++;
    clearTimeout(renderWarmupTimeout);
    renderWarmupTimeout = null;
    clearTimeout(layoutSettleTimeout);
    layoutSettleTimeout = null;
    sessionStorage.removeItem(RELOAD_SESSION_KEY);
    setBusy(false);
    simulation?.stop();
    simulation = null;
    window.stopPlayback?.();
    window.clearTrace?.();
    window.closeEntityView?.();

    const graphContainer = document.getElementById('graph-container');
    if (graphContainer) graphContainer.innerHTML = '';
    const targetInput = document.getElementById('targetId');
    if (targetInput) targetInput.value = '';
    const graphSearchInput = document.getElementById('graphSearchInput');
    if (graphSearchInput) graphSearchInput.value = '';
    const graphSearchResults = document.getElementById('graphSearchResults');
    if (graphSearchResults) graphSearchResults.innerHTML = '';

    document.getElementById('intelBox')?.classList.add('hidden');
    const riskCount = document.getElementById('riskCount');
    if (riskCount) riskCount.textContent = '0';
    const identityLabel = document.getElementById('identityLabel');
    if (identityLabel) identityLabel.textContent = 'Unknown';
    const historyList = document.getElementById('historyList');
    if (historyList) historyList.innerHTML = 'No history found.';
    document.getElementById('timelineUI')?.classList.add('hidden');

    edgeTooltipDiv?.remove();
    edgeTooltipDiv = null;
    currentEdgeHover = null;
    currentTargetId = null;
    fullGraphData = null;
    currentLayout = 'force';
    rawNodes = [];
    rawLinks = [];
    expandedNodes.clear();
    selectedNodeId = null;
    walletViewActive = false;
    walletGraphData = null;
    _fullGraphDataBak = null;
    _targetIdBak = null;
    traceFinalAddr = null;
    tracePathNodeIds = null;
    tracePathEdgeKeys = null;
    calendarTxDates = {};
    svg = null;
    zoom = null;
    container = null;
    g = null;
    link = null;
    node = null;
    label = null;
    edgeLabel = null;

    state.simulation = null;
    state.svg = null;
    state.zoom = null;
    state.container = null;
    state.g = null;
    state.link = null;
    state.node = null;
    state.label = null;
    state.currentTargetId = null;
    state.fullGraphData = null;
    state.nodeCount = 0;
    window._rawLinks = [];
    updateNodeCountDisplay(0);
    const edgeCount = document.getElementById('edgeCount');
    if (edgeCount) edgeCount.textContent = '0';
    updateExpandBtn();
    updateLayoutButton();
}

function _renderGraphImpl(graphData, targetId) {
    try {
        clearTimeout(renderWarmupTimeout);
        renderWarmupTimeout = null;
        clearTimeout(layoutSettleTimeout);
        layoutSettleTimeout = null;
        simulation?.stop();
        fullGraphData = graphData;
        state.fullGraphData = graphData;
        currentLayout = 'force';
        updateLayoutButton();
        rawNodes = [];
        rawLinks = [];
        expandedNodes.clear();  // fresh search resets expansion state
        // clear any node selection when the graph is reset
        selectedNodeId = null;
        updateExpandBtn();

        // Fetch mining pools data for filtering
        setBusy(true, 'LOADING GRAPH DATA...', 'Fetching mining pool information');
        fetchMiningPools().catch(err => {
            console.warn('Failed to fetch mining pools, falling back to entity_type detection:', err);
        });
        const nodeBalances = new Map();
        for (const edge of graphData.edges || []) {
            const amountSats = Math.round(Number(edge.amount) * 1e8);
            if (!Number.isFinite(amountSats)) continue;
            nodeBalances.set(edge.source, (nodeBalances.get(edge.source) || 0) - amountSats);
            nodeBalances.set(edge.target, (nodeBalances.get(edge.target) || 0) + amountSats);
        }
        const nodes = Object.entries(graphData.nodes).map(([id, n]) => ({
            id, ...n, label: n.label || id, isTarget: id === targetId
        }));
        nodes.forEach(n => {
            if (n.type !== 'Address') return;
            n._graphBalanceSats = nodeBalances.get(n.id) || 0;
            n._negativeBalance = n._graphBalanceSats < 0;
        });
        const negativeBalanceCount = nodes.filter(n => n._negativeBalance).length;
        if (negativeBalanceCount) {
            showToast(
                `${negativeBalanceCount} address node(s) have a negative graph balance. This indicates an incomplete trace; expand the node to load more of its history.`,
                'warning',
                9000
            );
        }
        const links = graphData.edges.map(e => ({ ...e, source: e.source, target: e.target }));
        rawNodes = nodes;
        rawLinks = links;
        markOppositeDirectionEdges(rawLinks);
        window._rawLinks = rawLinks;  // Expose to playback module

        // ─── Analyze Mixer Detection Results ───────────────────────────────────
        const mixerDetections = nodes.filter(n => n.mixer_info && n.mixer_info.is_mixer);
        
        // Update the mixer detection panel in the sidebar
        updateMixerDetectionDisplay(mixerDetections);
        
        if (mixerDetections.length > 0) {
            showToast(
                ` Advanced Mixer Detection: Found ${mixerDetections.length} mixing transaction(s)`,
                'mixer',
                7000
            );
            
            // Show details for each detected mixer
            mixerDetections.slice(0, 3).forEach(mixer => {
                const mixerType = mixer.mixer_info.raw?.mixer_type || 'Unknown Mixer';
                const confidence = mixer.mixer_info.confidence || 0;
                const shortId = mixer.id.substring(0, 14) + '...';
                showToast(
                    `${mixerType} (${confidence}% confidence) • ${shortId}`,
                    'mixer',
                    5000
                );
            });
            
            if (mixerDetections.length > 3) {
                showToast(
                    `+${mixerDetections.length - 3} more mixer(s) detected in graph`,
                    'info',
                    4000
                );
            }
        } else {
            showToast(
                '✓ Analysis complete - No mixers detected in this transaction chain',
                'success',
                4000
            );
        }

        setBusy(true, 'INITIALIZING SVG...', 'Setting up D3 rendering context');
        const containerEl = document.getElementById('graph-container');
        containerEl.innerHTML = '';
        const width = containerEl.clientWidth, height = containerEl.clientHeight;

        svg = d3.select(containerEl).append("svg")
            .attr("width", width).attr("height", height)
            .style("background", "#ffffff")   // white background
            .attr("viewBox", [-width / 2, -height / 2, width, height])
            .on("click", ev => {
                if (ev.target.tagName === 'svg') { 
                    closeEntityView();
                    unhighlightAll();
                    selectedNodeId = null;
                    updateExpandBtn();
                }
            });

        defs = svg.append("defs");
        arrowMarkerCache.clear();

        // Add search pulse animation style
        svg.append("style").text(`
            @keyframes search-pulse {
                0% { filter: drop-shadow(0 0 2px #fbbf24); stroke-width: 2; }
                50% { filter: drop-shadow(0 0 12px #fbbf24); stroke-width: 6; }
                100% { filter: drop-shadow(0 0 2px #fbbf24); stroke-width: 2; }
            }
            .search-highlight {
                animation: search-pulse 1.5s ease-in-out infinite;
                stroke: #fbbf24 !important;
                stroke-opacity: 1 !important;
            }
        `);

        // Create default markers upfront
        const mkArrow = (id, color) => defs.append("marker")
            .attr("id", id).attr("viewBox", "0 -6 12 12")
            .attr("refX", 11).attr("refY", 0)
            .attr("markerWidth", 9).attr("markerHeight", 9)
            .attr("markerUnits", "userSpaceOnUse")
            .attr("orient", "auto")
            .append("path").attr("d", "M0,-6L12,0L0,6Z").attr("fill", color);

        mkArrow("arrowhead-default",   "#64748b");
        mkArrow("arrowhead-highlight", "#0ea5e9");
        mkArrow("arrowhead-risk",      "#ef4444");
        mkArrow("arrowhead-trace",     "#f97316");

        // ── Compute per-node degree for adaptive sizing + charge ──────────────
        const degreeMap = new Map(nodes.map(n => [n.id, 0]));
        const links_copy = graphData.edges.map(e => ({ ...e, source: e.source, target: e.target }));
        links_copy.forEach(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            if (s) degreeMap.set(s, (degreeMap.get(s) || 0) + 1);
            if (t) degreeMap.set(t, (degreeMap.get(t) || 0) + 1);
        });
        nodes.forEach(n => { n._degree = degreeMap.get(n.id) || 0; });

        g = svg.append("g");

        simulation = d3.forceSimulation(nodes)
            .force("link", d3.forceLink(links).id(d => d.id)
                .distance(d => {
                    const sd = (d.source._degree || d.source?.data?._degree || 0);
                    const td = (d.target._degree || d.target?.data?._degree || 0);
                    const combined = sd + td;
                    // Mining nodes get extra link distance to push them away from the cluster
                    const srcNode = fullGraphData?.nodes[d.source?.id || d.source];
                    const tgtNode = fullGraphData?.nodes[d.target?.id || d.target];
                    const isMiningLink = (srcNode && (srcNode.entity_type === 'mining' || srcNode.mining_pool_info)) ||
                                         (tgtNode && (tgtNode.entity_type === 'mining' || tgtNode.mining_pool_info));
                    if (isMiningLink) return 100;
                    if (combined > 12) return 70;
                    if (d.amount > 1) return 50;
                    return 35;
                })
                .strength(0.6)
            )
            .force("charge", d3.forceManyBody()
                .strength(d => {
                    // Mining nodes get moderate repulsion to space them out but allow normal nodes closer
                    if (d.entity_type === 'mining' || d.mining_pool_info) {
                        return -950;
                    }
                    // Transaction nodes get repulsion for clustering
                    if (d.type === 'Transaction') {
                        return -500;
                    }
                    // Address nodes get standard repulsion for tight clustering
                    return Math.max(-400, -100 - (d._degree || 0) * 10);
                })
                .distanceMax(600)
            )
            .force("collide", d3.forceCollide(d => {
                // Mining nodes keep their spacing
                if (d.entity_type === 'mining' || d.mining_pool_info) {
                    return nodeRadius(d) + 8;
                }
                // Normal nodes get tighter collision radius for closer clustering
                return nodeRadius(d) + 3;
            }).strength(0.8))
            .force("center", d3.forceCenter(0, 0).strength(0.03))
            .on("tick", ticked);

        link = g.append("g").attr("class", "links")
            .selectAll("path").data(links).enter().append("path")
            .attr("class", "link")
            .attr("fill", "none")
            .style("stroke", d => getEdgeColor(d))
            .attr("stroke-opacity", 0.85)
            .attr("stroke-width", d => Math.max(2.5, Math.min(Math.sqrt((d.amount || 0) + 1) * 2, 8)))
            .attr("marker-end", d => getArrowMarkerId(getEdgeColor(d)));
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
            .attr("r", d => {
                const deg = d._degree || 0;
                const bonus = Math.min(deg * 0.6, 7); // hub bonus: up to +7px
                if (d.isTarget) return 20;
                if (d.member_count > 1) return Math.min(12 + d.member_count * 0.9, 28);
                if (d.is_coinbase || d.entity_type === 'mining' || detectMiningPool(d)) return 10 + bonus;
                if (d.type === 'Transaction') return 4 + Math.min(bonus * 0.4, 3);
                if (d.risk >= 70) return 14 + bonus;
                if (d.risk >= 40) return 12 + bonus;
                if (d.risk)       return 10 + bonus;
                return 6 + Math.min(bonus, 4);
            })
            .attr("fill", d => defaultNodeFill(d))
            .attr("stroke", d => {
                if (d.isTarget) return '#fbbf24';
                if (d._negativeBalance) return '#dc2626';
                if (d.is_coinbase || d.entity_type === 'mining' || detectMiningPool(d)) return '#d97706';
                if (d.risk >= 70) return '#dc2626';
                if (d.risk >= 40) return '#ea580c';
                if (d.mixer_info?.is_mixer) return '#7c3aed';
                if (d.type === 'Transaction') return '#4338ca';
                return 'none';
            })
            .attr("stroke-width", d => d._negativeBalance ? 3 : (d.isTarget || d.risk >= 40 || d.is_coinbase) ? 2 : 1)
            .attr("stroke-opacity", 0.6)
            .attr("title", d => d._negativeBalance
                ? `Negative graph balance (${formatBTC(d._graphBalanceSats / 1e8)} BTC). This node's trace is incomplete; expand it to load more history.`
                : (d.label || d.id))
            .each(function(d) {
                d3.select(this).append("title").text(d._negativeBalance
                    ? `Negative graph balance (${formatBTC(d._graphBalanceSats / 1e8)} BTC). This node's trace is incomplete; expand it to load more history.`
                    : (d.label || d.id));
            })
            .on("click", (ev, d) => { ev.stopPropagation(); showEntityView(d.id); highlightNode(d.id); })
            .on("mouseover", (ev, d) => highlightNeighbors(d, true))
            .on("mouseout",  (ev, d) => highlightNeighbors(d, false))
            .call(drag());
        state.node = node;

        label = g.append("g").attr("class", "labels")
            .selectAll("text").data(nodes).enter().append("text")
            .attr("class", "node-label")
            .text(d => {
                const base = getEnrichedNodeName(d.id, d);
                let display = base;
                // ── Mining badge ─────────────────────────────────────────────
                if (d.is_coinbase || d.entity_type === 'mining' || detectMiningPool(d)) {
                    const pi = detectMiningPool(d);
                    const poolName = pi?.name && pi.name !== 'Mining Reward Tx' ? pi.name
                        : (d.is_coinbase ? 'Coinbase TX' : null);
                    display = poolName && poolName !== base ? ` ${poolName}` : ` ${base}`;
                } else if (base.length > 18 && base === d.id) {
                    // Keep raw addresses and transaction IDs compact at default zoom.
                    display = base.slice(0, 8) + '…' + base.slice(-6);
                } else if (base !== d.id) {
                    const shortId = d.id.slice(0, 4) + '…' + d.id.slice(-4);
                    display = `${base} (${shortId})`;
                } else if (base.length > 24) {
                    display = base.slice(0, 20) + '…';
                }
                return d._negativeBalance ? ` ${display}` : display;
            })
            .attr("title", d => d._negativeBalance
                ? `Negative graph balance (${formatBTC(d._graphBalanceSats / 1e8)} BTC). This node's trace is incomplete; expand it to load more history.`
                : (d.label || d.id))
            .attr("dx", 10).attr("dy", ".35em")
            .attr("fill", "#1e293b") // Dark slate text for white background
            .attr("font-size", d => {
                // Bigger text for high-importance nodes
                if (d.isTarget) return "13px";
                if (d.risk >= 70 || d.entity_type === 'mining') return "11px";
                return "10px";
            })
            .attr("font-weight", d => (d.isTarget || d.risk >= 40 || d.entity_type === 'mining') ? "700" : "500")
            // Only show labels for notable nodes by default; others appear on hover/zoom
            .style("display", d => {
                if (!labelsVisible) return "none";
                if (d.isTarget) return null;
                if (d._negativeBalance) return null;
                if (d.risk >= 40) return null;
                if (d.entity_type === 'mining' || d.is_coinbase) return null;
                if (d.entity_type === 'exchange' || d.entity_type === 'mixer') return null;
                if (d._degree >= 4) return null;  // hubs always labelled
                // Hide labels for plain low-degree nodes at initial render
                // (they appear on hover via highlightNeighbors)
                return "none";
            });

        // Edge labels (timestamp + amount)
        edgeLabel = g.append("g").attr("class", "edge-labels")
            .selectAll("text").data(links).enter().append("text")
            .attr("class", "edge-label")
            .attr("text-anchor", "middle")
            .attr("fill", "#0f172a").attr("font-size", "10px").attr("font-weight", "500")
            .attr("paint-order", "stroke")
            .attr("stroke", "#ffffff").attr("stroke-width", "5px").attr("stroke-linejoin", "round")
            .style("display", "none")
            .text(edgeLabelText);

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

        updateNodeCountDisplay(nodes.length);
        document.getElementById('edgeCount').textContent = links.length.toLocaleString();

        initNetworkStats(); // Ensure ticker is started
        initPlayback();  // Initialize playback before timeline scrubbing is wired.
        initTimeline(links);
        setBusy(true, 'CALCULATING LAYOUT...', 'Running D3 force simulation');
        // Extended warmup: 5s for large graphs (≥100 nodes), 3s otherwise
        const warmupMs = nodes.length >= 100 ? 5000 : 3000;
        renderWarmupTimeout = setTimeout(() => {
            if (!simulation) return;
            simulation.stop();
            recenterGraph();
            updateExpandRings();
            setBusy(false);
            renderWarmupTimeout = null;
        }, warmupMs);

    } catch (err) {
        console.error('renderGraph error:', err);
        setBusy(false);
        alert('Failed to render graph: ' + err.message);
    }
}

// Returns the visual radius of a node data object (mirrors the .attr("r") logic above)
function nodeRadius(d) {
    if (!d) return 6;
    const deg = d._degree || 0;
    const bonus = Math.min(deg * 0.6, 7);
    if (d.isTarget) return 20;
    if (d.member_count > 1) return Math.min(12 + d.member_count * 0.9, 28);
    if (d.is_coinbase || d.entity_type === 'mining') return 10 + bonus;
    if (d.type === 'Transaction') return 4 + Math.min(bonus * 0.4, 3);
    if (d.risk >= 70) return 14 + bonus;
    if (d.risk >= 40) return 12 + bonus;
    if (d.risk)       return 10 + bonus;
    return 6 + Math.min(bonus, 4);
}

function markOppositeDirectionEdges(edges) {
    const directions = new Set();
    const parallelGroups = new Map();
    for (const edge of edges) {
        const source = edge.source?.id || edge.source;
        const target = edge.target?.id || edge.target;
        directions.add(JSON.stringify([source, target]));
        const groupKey = [String(source), String(target)].sort().join('|');
        if (!parallelGroups.has(groupKey)) parallelGroups.set(groupKey, []);
        parallelGroups.get(groupKey).push(edge);
    }

    for (const edge of edges) {
        const source = edge.source?.id || edge.source;
        const target = edge.target?.id || edge.target;
        edge._hasReverseEdge = directions.has(JSON.stringify([target, source]));
        const groupKey = [String(source), String(target)].sort().join('|');
        const group = parallelGroups.get(groupKey);
        const laneIndex = group.indexOf(edge);
        edge._laneOffset = (laneIndex - (group.length - 1) / 2) * 22;
    }
}

function linkCoordinates(d) {
    const sx = Number.isFinite(d.source?.x) ? d.source.x : 0;
    const sy = Number.isFinite(d.source?.y) ? d.source.y : 0;
    const tx = Number.isFinite(d.target?.x) ? d.target.x : 0;
    const ty = Number.isFinite(d.target?.y) ? d.target.y : 0;
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const sr = nodeRadius(d.source);
    const tr = nodeRadius(d.target);
    const laneOffset = d._laneOffset || 0;
    const sourceLane = Math.max(-sr + 1, Math.min(sr - 1, laneOffset));
    const targetLane = Math.max(-tr + 1, Math.min(tr - 1, laneOffset));
    const sourceAlong = Math.sqrt(Math.max(0, sr * sr - sourceLane * sourceLane));
    const targetAlong = Math.sqrt(Math.max(0, tr * tr - targetLane * targetLane));
    return {
        x1: sx + ux * sourceAlong - uy * sourceLane,
        y1: sy + uy * sourceAlong + ux * sourceLane,
        x2: tx - ux * targetAlong - uy * targetLane,
        y2: ty - uy * targetAlong + ux * targetLane
    };
}

function linkPath(d) {
    const coords = linkCoordinates(d);
    const sourceX = Number.isFinite(d.source?.x) ? d.source.x : 0;
    const sourceY = Number.isFinite(d.source?.y) ? d.source.y : 0;
    const targetX = Number.isFinite(d.target?.x) ? d.target.x : 0;
    const targetY = Number.isFinite(d.target?.y) ? d.target.y : 0;
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const laneOffset = d._laneOffset || 0;
    const curveOffset = laneOffset * 3;
    const controlX = (sourceX + targetX) / 2 - (dy / distance) * curveOffset;
    const controlY = (sourceY + targetY) / 2 + (dx / distance) * curveOffset;

    return `M${coords.x1},${coords.y1} Q${controlX},${controlY} ${coords.x2},${coords.y2}`;
}

function linkLabelPosition(d) {
    const sourceX = Number.isFinite(d.source?.x) ? d.source.x : 0;
    const sourceY = Number.isFinite(d.source?.y) ? d.source.y : 0;
    const targetX = Number.isFinite(d.target?.x) ? d.target.x : 0;
    const targetY = Number.isFinite(d.target?.y) ? d.target.y : 0;
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const laneOffset = d._laneOffset || 0;

    return {
        x: (sourceX + targetX) / 2 - (dy / distance) * laneOffset,
        y: (sourceY + targetY) / 2 + (dx / distance) * laneOffset - 6
    };
}

function ticked() {
    const now = performance.now();
    const minRenderInterval = rawNodes.length >= 1000 ? 50 : rawNodes.length >= 500 ? 33 : 0;
    if (minRenderInterval && now - lastGraphRenderAt < minRenderInterval) return;
    lastGraphRenderAt = now;

    // Draw each link from the source node's boundary to the target node's boundary.
    // This ensures the arrowhead (marker-end) appears just outside the target circle
    // and that the line visually exits from the source circle, not its centre.
    link.attr("d", linkPath);
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
    if (timestampsVisible) positionVisibleEdgeLabels();
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
    let draggedNodeId = null;
    let connectedNodesState = null; // Track initial positions of connected nodes
    let dragStartPos = null; // Track where the drag started
    
    return d3.drag()
        .on("start", (ev, d) => {
            if (edgeTooltipDiv) edgeTooltipDiv.style.display = 'none';
            draggedNodeId = d.id;
            
            // Allow dragging if not frozen OR if the dragged node is the selected node
            const isSelectedNode = d.id === selectedNodeId;
            if ((!isFrozen || isSelectedNode) && !ev.active && simulation) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
            
            // If dragging the selected node, prepare to move connected nodes
            if (isSelectedNode) {
                dragStartPos = { x: d.x, y: d.y };
                connectedNodesState = new Map();
                // Find all nodes connected to the selected node
                if (rawLinks) {
                    rawLinks.forEach(link => {
                        const sourceId = link.source?.id || link.source;
                        const targetId = link.target?.id || link.target;
                        const connectedId = sourceId === selectedNodeId ? targetId : (targetId === selectedNodeId ? sourceId : null);
                        
                        if (connectedId) {
                            const connectedNode = rawNodes.find(n => n.id === connectedId);
                            if (connectedNode) {
                                connectedNodesState.set(connectedId, {
                                    x: connectedNode.x || 0,
                                    y: connectedNode.y || 0
                                });
                            }
                        }
                    });
                }
            }
        })
        .on("drag", (ev, d) => {
            d.fx = ev.x; d.fy = ev.y;
            
            // Move connected nodes along with the selected node
            if (d.id === selectedNodeId && connectedNodesState && dragStartPos) {
                // Calculate how far the mouse has moved from the start of the drag
                const dx = ev.x - dragStartPos.x;
                const dy = ev.y - dragStartPos.y;
                
                connectedNodesState.forEach((initialPos, connectedId) => {
                    const connectedNode = rawNodes.find(n => n.id === connectedId);
                    if (connectedNode) {
                        connectedNode.fx = initialPos.x + dx;
                        connectedNode.fy = initialPos.y + dy;
                    }
                });
            }
            
            if (isFrozen) ticked();
        })
        .on("end", (ev, d) => {
            // Allow simulation to continue if not frozen OR if the dragged node is the selected node
            const isSelectedNode = d.id === selectedNodeId;
            if ((!isFrozen || isSelectedNode) && !ev.active && simulation) simulation.alphaTarget(0);
            
            // Persist the node position so the user's layout is preserved during this session
            d.fx = d.x; d.fy = d.y;
            try {
                if (fullGraphData && fullGraphData.nodes && fullGraphData.nodes[d.id]) {
                    fullGraphData.nodes[d.id].x = d.x;
                    fullGraphData.nodes[d.id].y = d.y;
                }
            } catch (e) { /* ignore */ }
            
            // Persist connected nodes' positions if we moved them
            if (isSelectedNode && connectedNodesState) {
                connectedNodesState.forEach((_, connectedId) => {
                    const connectedNode = rawNodes.find(n => n.id === connectedId);
                    if (connectedNode && fullGraphData && fullGraphData.nodes && fullGraphData.nodes[connectedId]) {
                        fullGraphData.nodes[connectedId].x = connectedNode.x;
                        fullGraphData.nodes[connectedId].y = connectedNode.y;
                    }
                });
                connectedNodesState = null;
                dragStartPos = null;
            }
            
            draggedNodeId = null;
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
    markOppositeDirectionEdges(rawLinks);
    // ── Links ────────────────────────────────────────────────────────────────
    g.select(".links").selectAll("path")
        .data(rawLinks, l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return `${s}|${t}`;
        })
        .join(
            enter => enter.append("path")
                .attr("class", "link")
                .attr("fill", "none")
                .style("stroke", d => getEdgeColor(d))
                .attr("stroke-opacity", 0.85)
                .attr("stroke-width", d => Math.max(2.5, Math.min(Math.sqrt((d.amount||0)+1)*2, 8)))
                .attr("marker-end", d => getArrowMarkerId(getEdgeColor(d))),
            update => update,
            exit   => exit.remove()
        );
    link = g.select(".links").selectAll("path");
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
    // Rebuild edge labels keyed by source|target so they align correctly after expand/rebind
    const edgeKey = l => {
        const s = l.source?.id || l.source;
        const t = l.target?.id || l.target;
        return `${s}|${t}`;
    };
    // Remove any stale group and recreate with a single authoritative keyed join
    g.select('.edge-labels').remove();
    edgeLabel = g.insert('g', '.nodes').attr('class', 'edge-labels')
        .selectAll('text').data(rawLinks, edgeKey)
        .join(
            enter => enter.append('text')
                .attr('class', 'edge-label')
                .attr('text-anchor', 'middle')
                .attr('fill', '#0f172a').attr('font-size', '10px').attr('font-weight', '500')
                .attr('paint-order', 'stroke')
                .attr('stroke', '#ffffff').attr('stroke-width', '5px').attr('stroke-linejoin', 'round')
                .style('display', 'none')
                .text(edgeLabelText),
            update => update.text(edgeLabelText),
            exit => exit.remove()
        );

    // Add hover listeners on links to show per-edge tooltip when enabled
    g.select('.links').selectAll('path')
        .on('mouseover', function(ev, d) {
            if (!edgeTooltipsVisible) return;
            if (!edgeTooltipDiv) createEdgeTooltip();
            currentEdgeHover = d;
            // position tooltip at the midpoint of the edge using current zoom transform
            const midx = (d.source.x + d.target.x) / 2;
            const midy = (d.source.y + d.target.y) / 2;
            const pos = screenPosFromGraph(midx, midy);
            const amt = typeof d.amount !== 'undefined' ? (formatBTC(d.amount) + ' • ') : '';
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
        window._rawLinks = rawLinks;  // Update playback module with new links

        // ── Re-bind D3 selections with the merged data ───────────────────────
        rebindGraphSelections();
        updateExpandRings();

        // Update counters in sidebar
        updateNodeCountDisplay(rawNodes.length);
        document.getElementById('edgeCount').textContent = rawLinks.length.toLocaleString();

        const msg = newNodeCount > 0
            ? `Added ${newNodeCount} node${newNodeCount!==1?'s':''}, ${newEdgeCount} edge${newEdgeCount!==1?'s':''}`
            : 'No new connections found';
        if (currentLayout === 'tree') {
            simulation?.stop();
            simulation = null;
            applyTreeLayout();
            setBusy(false);
        } else {
            // Rebuild: the previous simulation has stale node/link references.
            if (simulation) simulation.stop();
            simulation = d3.forceSimulation(rawNodes)
                .force("link",   d3.forceLink(rawLinks).id(d => d.id).distance(d => {
                    if (d.source?.type === 'Transaction' || d.target?.type === 'Transaction') {
                        return (d.amount||0) > 1 ? 120 : 80;
                    }
                    return (d.amount||0) > 1 ? 100 : 60;
                }))
                .force("charge", d3.forceManyBody().strength(d => d.type === 'Transaction' ? -200 : -100))
                .force("center", d3.forceCenter(0, 0))
                .on("tick", ticked);
            const expandedSimulation = simulation;
            setBusy(true, 'RECALCULATING LAYOUT...', msg);
            setTimeout(() => {
                if (simulation !== expandedSimulation) return;
                expandedSimulation.stop();
                fitGraphToScreen();
                setBusy(false);
            }, 2500);
        }
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
window.expandNode     = expandNode;
window.expandSelected = expandSelected;

// ── Expand All ───────────────────────────────────────────────────────────────
let _expandAllAbort = false;

function stopExpandAll() {
    _expandAllAbort = true;
    const stopBtn = document.getElementById('stopExpandBtn');
    if (stopBtn) stopBtn.style.display = 'none';
    const loaderStop = document.getElementById('loaderStopBtn');
    if (loaderStop) loaderStop.style.display = 'none';
}
window.stopExpandAll = stopExpandAll;

async function expandAll() {
    const btn = document.getElementById('expandAllBtn');
    const stopBtn = document.getElementById('stopExpandBtn');
    const loaderStop = document.getElementById('loaderStopBtn');
    const setBtn = (running, remaining) => {
        if (!btn) return;
        if (!running) {
            btn.disabled = false;
            btn.textContent = ' Expand All';
            btn.classList.remove('bg-red-700', 'hover:bg-red-600');
            btn.classList.add('bg-violet-700', 'hover:bg-violet-600');
            if (stopBtn) stopBtn.style.display = 'none';
            if (loaderStop) loaderStop.style.display = 'none';
        } else {
            btn.disabled = false;
            btn.textContent = ` Expanding… ${remaining}`;
            btn.classList.remove('bg-violet-700', 'hover:bg-violet-600');
            btn.classList.add('bg-violet-900', 'hover:bg-violet-800');
            if (stopBtn) stopBtn.style.display = '';
            if (loaderStop) loaderStop.style.display = '';
        }
    };

    // Second click = abort
    if (btn && btn.textContent.startsWith('⏹')) {
        _expandAllAbort = true;
        setBtn(false, 0);
        setBusy(false);
        return;
    }

    _expandAllAbort = false;

    // Snapshot unexpanded Address nodes — new nodes found during expansion are NOT
    // auto-queued to prevent runaway growth on highly-connected graphs.
    const queue = rawNodes
        .filter(n => n.type === 'Address' && !expandedNodes.has(n.id))
        .map(n => n.id);

    if (queue.length === 0) {
        setBusy(true, 'EXPAND ALL', 'All visible nodes already expanded.');
        setTimeout(() => setBusy(false), 2500);
        return;
    }

    setBtn(true, `0 / ${queue.length}`);
    let done = 0;

    // Expand in server-side-parallel batches via /api/trace-batch. The old
    // version awaited a full /api/trace round-trip per node with a 400ms
    // throttle — minutes of waiting on larger graphs.
    const BATCH_SIZE = 8;

    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
        if (_expandAllAbort) break;
        const chunk = queue.slice(i, i + BATCH_SIZE);
        const progressed = Math.min(i + BATCH_SIZE, queue.length);
        setBtn(true, `${progressed} / ${queue.length}`);
        setBusy(true, `EXPANDING ${progressed} / ${queue.length}`,
            chunk[0].substring(0, 10) + '…' + chunk[0].slice(-6));

        // Mark the whole chunk up front; un-mark on failure so a retry works
        chunk.forEach(nodeId => expandedNodes.add(nodeId));
        window._expandedNodes = expandedNodes;
        updateExpandRings();

        try {
            const res = await fetch('/api/trace-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: chunk }),
            });
            const data = await res.json();
            if (!data.graphs) throw new Error(data.error || 'batch request failed');

            const anchor = rawNodes.find(n => n.id === chunk[0]);
            const ax = anchor?.x ?? 0, ay = anchor?.y ?? 0;
            const existingIds  = new Set(rawNodes.map(n => n.id));
            const existingKeys = new Set(rawLinks.map(l =>
                `${l.source?.id || l.source}|${l.target?.id || l.target}`));

            Object.values(data.graphs).forEach(g => {
                Object.entries(g.nodes).forEach(([id, n]) => {
                    if (existingIds.has(id)) return;
                    const angle = Math.random() * 2 * Math.PI;
                    const dist  = 80 + Math.random() * 80;
                    rawNodes.push({ id, ...n, label: n.label || id, isTarget: false,
                        x: ax + Math.cos(angle) * dist, y: ay + Math.sin(angle) * dist });
                    fullGraphData.nodes[id] = n;
                });
                (g.edges || []).forEach(e => {
                    if (existingKeys.has(`${e.source}|${e.target}`)) return;
                    rawLinks.push({ ...e });
                    if (!fullGraphData.edges) fullGraphData.edges = [];
                    fullGraphData.edges.push(e);
                });
            });
            window._rawLinks = rawLinks;  // Update playback module with new links

            rebindGraphSelections();
            updateExpandRings();
            updateNodeCountDisplay(rawNodes.length);
            document.getElementById('edgeCount').textContent = rawLinks.length.toLocaleString();

            if (currentLayout === 'tree') {
                simulation?.stop();
                simulation = null;
            } else {
                if (simulation) simulation.stop();
                simulation = d3.forceSimulation(rawNodes)
                    .force('link',   d3.forceLink(rawLinks).id(d => d.id).distance(d => {
                        if (d.source?.type === 'Transaction' || d.target?.type === 'Transaction') {
                            return (d.amount||0) > 1 ? 120 : 80;
                        }
                        return (d.amount||0) > 1 ? 100 : 60;
                    }))
                    .force('charge', d3.forceManyBody().strength(d => d.type === 'Transaction' ? -200 : -100))
                    .force('center', d3.forceCenter(0, 0))
                    .on('tick', ticked);
            }
            refreshTimelineFromRawLinks();
        } catch (err) {
            chunk.forEach(nodeId => expandedNodes.delete(nodeId));
            console.error('expandAll batch error:', err);
        }
        done += chunk.length;
    }

    setBtn(false, 0);
    if (currentLayout === 'tree') applyTreeLayout();
    setBusy(true, 'EXPAND ALL COMPLETE', `Expanded ${done} node${done !== 1 ? 's' : ''}`);
    if (currentLayout !== 'tree') fitGraphToScreen();
    setTimeout(() => setBusy(false), 3000);
}
window.expandAll = expandAll;

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

/**
 * Update a node's color in the graph visualization
 * Called when user changes a node's custom color annotation
 */
export function updateGraphNodeColor(nodeId, hexColor) {
    if (!node) return;
    
    // Update the visual representation
    node.attr("fill", d => {
        if (d.id === nodeId) {
            return getNodeCustomColor(nodeId) || defaultNodeFill(d);
        }
        return defaultNodeFill(d);
    });
}

/**
 * Update a node's display label in the graph visualization
 * Called when user changes a node's custom display name annotation
 */
export function updateGraphNodeLabel(nodeId, customName) {
    if (!label) return;
    
    // Update the label text and tooltip
    label.text(d => {
        if (d.id === nodeId) {
            return getEnrichedNodeName(nodeId, d);
        }
        return getEnrichedNodeName(d.id, d);
    }).attr("title", d => {
        if (d.id === nodeId) {
            const customName = getNodeCustomName(nodeId);
            const enrichedName = getEnrichedNodeName(nodeId, d);
            if (customName) return `${customName} (${d.label})`;
            if (enrichedName && enrichedName !== d.label && enrichedName !== d.id) return `${enrichedName} (${d.label})`;
            return d.label;
        }
        const customName = getNodeCustomName(d.id);
        const enrichedName = getEnrichedNodeName(d.id, d);
        if (customName) return `${customName} (${d.label})`;
        if (enrichedName && enrichedName !== d.label && enrichedName !== d.id) return `${enrichedName} (${d.label})`;
        return d.label;
    });
}

/**
 * Update edge colors for all edges pointing to a specific node
 * Called when user changes a node's custom edge color annotation
 */
export function updateGraphEdgeColors(targetNodeId) {
    if (!link) return;
    
    // We need to re-render all edges since they depend on the full node colors
    // Edge color logic updated to use common defaultNodeFill logic implicitly 
    // or explicit refresh
    _recolorEdges();
}

// =============================================================================
// TREE LAYOUT — rooted hierarchy with a stable spanning tree
// =============================================================================

function updateLayoutButton() {
    const btn = document.getElementById('layoutBtn');
    const text = document.getElementById('layoutText');
    if (!btn || !text) return;

    const isTree = currentLayout === 'tree';
    text.textContent = isTree ? 'Force layout' : 'Tree layout';
    btn.title = isTree
        ? 'Switch to force-directed layout'
        : 'Switch to hierarchy layout';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(isTree));
    btn.classList.toggle('bg-emerald-700', isTree);
    btn.classList.toggle('border-emerald-500', isTree);
    btn.classList.toggle('text-white', isTree);
    btn.classList.toggle('hover:bg-emerald-600', isTree);
    btn.classList.toggle('bg-slate-700', !isTree);
    btn.classList.toggle('border-slate-600', !isTree);
    btn.classList.toggle('text-slate-200', !isTree);
    btn.classList.toggle('hover:bg-slate-600', !isTree);
}

function undirectedEdgeKey(source, target) {
    const a = String(source);
    const b = String(target);
    return JSON.stringify(a < b ? [a, b] : [b, a]);
}

function applyTreeLayout() {
    if (!node || !link || !label || rawNodes.length === 0) return;

    simulation?.stop();
    simulation = null;
    isFrozen = true;

    const freezeBtn = document.getElementById('freezeText');
    if (freezeBtn) {
        freezeBtn.textContent = '[UNFREEZE]';
        freezeBtn.parentElement.classList.remove('bg-slate-800/90', 'border-slate-600');
        freezeBtn.parentElement.classList.add('bg-blue-700/90', 'border-blue-500', 'text-white');
    }

    const liveNodesById = new Map(node.data().map(d => [d.id, d]));
    rawLinks.forEach(edge => {
        const sourceId = edge.source?.id ?? edge.source;
        const targetId = edge.target?.id ?? edge.target;
        if (liveNodesById.has(sourceId)) edge.source = liveNodesById.get(sourceId);
        if (liveNodesById.has(targetId)) edge.target = liveNodesById.get(targetId);
    });

    const adjacency = new Map(rawNodes.map(n => [n.id, new Set()]));
    rawLinks.forEach(edge => {
        const source = edge.source?.id ?? edge.source;
        const target = edge.target?.id ?? edge.target;
        if (source === target || !adjacency.has(source) || !adjacency.has(target)) return;
        adjacency.get(source).add(target);
        adjacency.get(target).add(source);
    });

    const hierarchyNodes = new Map(rawNodes.map(n => [n.id, { id: n.id, children: [] }]));
    const preferredRoot = hierarchyNodes.has(currentTargetId)
        ? currentTargetId
        : rawNodes[0].id;
    const candidates = [preferredRoot, ...rawNodes.map(n => n.id).filter(id => id !== preferredRoot)];
    const visited = new Set();
    const componentRoots = [];
    const treeEdgeKeys = new Set();

    // Use an index-based queue to keep the traversal linear on large graphs.
    for (const rootId of candidates) {
        if (visited.has(rootId)) continue;
        componentRoots.push(hierarchyNodes.get(rootId));
        visited.add(rootId);
        const queue = [rootId];
        for (let cursor = 0; cursor < queue.length; cursor++) {
            const parentId = queue[cursor];
            for (const childId of adjacency.get(parentId)) {
                if (visited.has(childId)) continue;
                visited.add(childId);
                hierarchyNodes.get(parentId).children.push(hierarchyNodes.get(childId));
                treeEdgeKeys.add(undirectedEdgeKey(parentId, childId));
                queue.push(childId);
            }
        }
    }

    // A virtual root lays out disconnected components separately without
    // drawing made-up links between them.
    const hierarchyData = componentRoots.length === 1
        ? componentRoots[0]
        : { children: componentRoots };
    const hierarchyRoot = d3.hierarchy(hierarchyData, d => d.children);
    const breadthGap = Math.max(28, Math.min(56, 1800 / Math.sqrt(rawNodes.length)));
    d3.tree().nodeSize([breadthGap, 170])(hierarchyRoot);

    const positions = new Map();
    hierarchyRoot.descendants().forEach(d => {
        if (d.data.id != null) positions.set(d.data.id, { x: d.y, y: d.x });
    });
    node.data().forEach(d => {
        const position = positions.get(d.id);
        if (!position) return;
        d.x = d.fx = position.x;
        d.y = d.fy = position.y;
        d.vx = d.vy = 0;
    });

    // Keep every real relationship visible. Tree edges are emphasized; cycles
    // and other non-tree edges remain as faint context instead of disappearing.
    link.each(d => {
        d._treeLayoutEdge = treeEdgeKeys.has(undirectedEdgeKey(d.source.id, d.target.id));
    });
    link.style('display', null)
        .style('stroke', d => d._treeLayoutEdge
            ? getEdgeColor(d)
            : '#94a3b8')
        .attr('stroke-opacity', d => d._treeLayoutEdge ? 0.9 : 0.18)
        .attr('stroke-width', d => d._treeLayoutEdge
            ? Math.max(1.5, Math.min(Math.sqrt((d.amount || 0) + 1) * 2, 6))
            : 1)
        .attr('marker-end', d => getArrowMarkerId(d._treeLayoutEdge ? getEdgeColor(d) : '#94a3b8'));

    const t = d3.transition().duration(650).ease(d3.easeCubicInOut);
    const finalEdgePositions = new Map();
    link.each(d => finalEdgePositions.set(d, linkCoordinates(d)));
    node.transition(t).attr('cx', d => d.x).attr('cy', d => d.y);
    label.transition(t).attr('x', d => d.x).attr('y', d => d.y);
    link.transition(t)
        .attr('x1', d => finalEdgePositions.get(d).x1)
        .attr('y1', d => finalEdgePositions.get(d).y1)
        .attr('x2', d => finalEdgePositions.get(d).x2)
        .attr('y2', d => finalEdgePositions.get(d).y2);
    g.select('.expand-rings').selectAll('circle').transition(t)
        .attr('cx', d => d.x).attr('cy', d => d.y);
    if (traceFinalAddr) {
        const finalNode = rawNodes.find(n => n.id === traceFinalAddr);
        if (finalNode) {
            g.select('.dest-ring').selectAll('circle').transition(t)
                .attr('cx', finalNode.x || 0).attr('cy', finalNode.y || 0);
        }
    }
    const firstNode = node.node();
    node.transition(t).on('end.layout', function() {
        if (this !== firstNode || currentLayout !== 'tree') return;
        positionVisibleEdgeLabels();
        fitGraphToScreen();
    });
}

function applyForceLayout() {
    if (!node || !rawNodes.length) return;

    link.each(d => { d._treeLayoutEdge = false; });
    link.style('display', null)
        .style('stroke', d => getEdgeColor(d))
        .attr('stroke-opacity', 0.85)
        .attr('stroke-width', d => Math.max(2.5, Math.min(Math.sqrt((d.amount || 0) + 1) * 2, 8)))
        .attr('marker-end', d => getArrowMarkerId(getEdgeColor(d)));

    // Unpin all nodes so the simulation can move them freely.
    node.data().forEach(d => {
        d.fx = d.fy = null;
        d.vx = d.vy = 0;
    });
    isFrozen = false;

    const freezeBtn = document.getElementById('freezeText');
    if (freezeBtn) {
        freezeBtn.textContent = '[FREEZE]';
        freezeBtn.parentElement.classList.remove('bg-blue-700/90', 'border-blue-500', 'text-white');
        freezeBtn.parentElement.classList.add('bg-slate-800/90', 'border-slate-600');
    }

    // Simulation was nulled in applyTreeLayout — rebuild it from the stored raw data.
    simulation = d3.forceSimulation(node.data())
        .force("link",   d3.forceLink(rawLinks).id(d => d.id).distance(d => {
            if (d.source?.type === 'Transaction' || d.target?.type === 'Transaction') {
                return d.amount > 1 ? 120 : 80;
            }
            return d.amount > 1 ? 100 : 60;
        }))
        .force("charge", d3.forceManyBody()
            .strength(d => d.type === 'Transaction' ? -200 : -90)
            .distanceMax(600))
        .force("collide", d3.forceCollide(d => nodeRadius(d) + 3).strength(0.8))
        .force("center", d3.forceCenter(0, 0).strength(0.03))
        .on("tick", ticked);
    const activeSimulation = simulation;

    setBusy(true, 'RECALCULATING LAYOUT...', 'Running force simulation');
    layoutSettleTimeout = setTimeout(() => {
        layoutSettleTimeout = null;
        if (simulation !== activeSimulation || currentLayout !== 'force') return;
        activeSimulation.stop();
        fitGraphToScreen();
        setBusy(false);
    }, 3000);
}

export function toggleLayout() {
    if (!node || rawNodes.length === 0) return;

    clearTimeout(renderWarmupTimeout);
    renderWarmupTimeout = null;
    clearTimeout(layoutSettleTimeout);
    layoutSettleTimeout = null;
    node.interrupt();
    link.interrupt();
    label.interrupt();
    svg?.interrupt();
    setBusy(false);

    if (currentLayout === 'force') {
        currentLayout = 'tree';
        applyTreeLayout();
    } else {
        currentLayout = 'force';
        applyForceLayout();
    }
    updateLayoutButton();
}

export function toggleLabels() {
    labelsVisible = !labelsVisible;
    if (!labelsVisible) {
        label.style("display", "none");
    } else {
        // Restore selective label visibility
        label.style("display", d => {
            if (d.isTarget || d.risk >= 40) return null;
            if (d.entity_type === 'mining' || d.is_coinbase) return null;
            if (d.entity_type === 'exchange' || d.entity_type === 'mixer') return null;
            if (d._degree >= 4) return null;
            return "none";
        });
    }
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
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nd.forEach(d => {
        const padding = nodeRadius(d) + 12;
        minX = Math.min(minX, d.x - padding);
        maxX = Math.max(maxX, d.x + padding);
        minY = Math.min(minY, d.y - padding);
        maxY = Math.max(maxY, d.y + padding);
    });
    const svgNode = svg.node();
    const w = +svg.attr("width") || svgNode?.clientWidth || 0;
    const h = +svg.attr("height") || svgNode?.clientHeight || 0;
    if (!w || !h) return;
    const gw = Math.max(maxX - minX, 1);
    const gh = Math.max(maxY - minY, 1);
    const scale = Math.min((w - 48) / gw, (h - 48) / gh, 2.5) * 0.95;
    if (!Number.isFinite(scale) || scale <= 0) return;
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

function applyLinkHighlight(activePred, focusNodeId = null) {
    link.style("opacity", o => activePred(o) ? 1 : 0.12)
        .style("stroke", o => {
            if (activePred(o) && focusNodeId) {
                return o.source.id === focusNodeId ? "#ef4444" : "#22c55e";
            }
            if (activePred(o)) return "#0ea5e9";
            return getEdgeColor(o);
        })
        .attr("marker-end", o => {
            if (activePred(o) && focusNodeId) {
                const color = o.source.id === focusNodeId ? "#ef4444" : "#22c55e";
                return getArrowMarkerId(color);
            }
            if (activePred(o)) return "url(#arrowhead-highlight)";
            return getArrowMarkerId(getEdgeColor(o));
        });
}

function highlightNeighbors(d, hovering) {
    if (hovering) {
        updateLinkedByIndex();
        node.style("opacity", o => connected(d, o) ? 1 : 0.1);
        applyLinkHighlight(o => o.source === d || o.target === d, d.id);
        // Show all labels for connected nodes while hovering, even if normally hidden
        label.style("opacity", o => connected(d, o) ? 1 : 0.0)
             .style("display", o => (connected(d, o) && labelsVisible) ? null : "none");
        if (edgeLabel) {
            edgeLabel.style('display', e => (timestampsVisible && (e.source === d || e.target === d)) ? 'block' : 'none');
            positionVisibleEdgeLabels();
        }
    } else if (selectedNodeId) {
        highlightNode(selectedNodeId);
    } else {
        unhighlightAll();
    }
}

function highlightNode(nodeId) {
    updateLinkedByIndex();
    const tn = node.data().find(n => n.id === nodeId);
    if (!tn) return;
    node.style("opacity", o => connected(tn, o) ? 1 : 0.12);
    applyLinkHighlight(o => o.source.id === nodeId || o.target.id === nodeId, nodeId);
    label.style("opacity", o => connected(tn, o) ? 1 : 0.12);

    // track selection for the expand button
    selectedNodeId = nodeId;
    updateExpandBtn();
    if (edgeLabel) {
        edgeLabel.style('display', e => (timestampsVisible && (e.source.id === nodeId || e.target.id === nodeId)) ? 'block' : 'none');
        updateEdgeLabelText();
        positionVisibleEdgeLabels();
    }
}

function unhighlightAll() {
    if (!node || !link || !label) return;

    // If mining filter is active, maintain the hidden state of mining nodes and their neighbors
    let miningNodeIds = new Set();
    let miningNeighborIds = new Set();
    if (miningFilterActive) {
        rawNodes.forEach(n => { if (detectMiningPool(n)) miningNodeIds.add(n.id); });
        rawLinks.forEach(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            if (miningNodeIds.has(s)) miningNeighborIds.add(t);
            if (miningNodeIds.has(t)) miningNeighborIds.add(s);
        });
    }
    const isHidden = (id) => {
        if (!miningFilterActive) return false;
        return miningNodeIds.has(id) || (miningNeighborIds.has(id) && id !== currentTargetId);
    };

    node.style("opacity", 1).style("display", d => isHidden(d.id) ? "none" : null);
    link.style("opacity", 0.7)
        .style("display", d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return (isHidden(s) || isHidden(t)) ? "none" : null;
        })
        .style("stroke", d => getEdgeColor(d))
        .attr("marker-end", d => getArrowMarkerId(getEdgeColor(d)));

    // Restore selective label visibility
    label.style("opacity", 1)
         .style("display", d => {
            if (!labelsVisible) return "none";
            if (miningFilterActive) {
                const pi = detectMiningPool(d);
                if (pi) return "none";
            }
            if (d.isTarget || d.risk >= 40) return null;
            if (d.entity_type === 'mining' || d.is_coinbase) return null;
            if (d.entity_type === 'exchange' || d.entity_type === 'mixer') return null;
            if (d._degree >= 4) return null;
            return "none";
         });
}

// Toggle timestamps visibility for hover/select; wired to toolbar button
export function toggleTimestamps() {
    timestampsVisible = !timestampsVisible;
    const txt = document.getElementById('timestampToggleText');
    if (txt) txt.textContent = timestampsVisible ? '[HIDE INFO]' : '[INFO]';
    if (!timestampsVisible && edgeLabel) edgeLabel.style('display', 'none');
    if (timestampsVisible && selectedNodeId && edgeLabel) {
        edgeLabel.style('display', e => (e.source.id === selectedNodeId || e.target.id === selectedNodeId) ? 'block' : 'none');
        updateEdgeLabelText();
        positionVisibleEdgeLabels();
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

// Toggle mining pool filter — visually hide/show mining nodes using display:none.
// This approach NEVER mutates rawNodes/rawLinks or restarts the simulation,
// which means node positions are preserved and edges can never become 0.
export function toggleMiningFilter() {
    if (!fullGraphData || !node) return;
    miningFilterActive = !miningFilterActive;
    // Turn off other filters when enabling mining filter
    if (miningFilterActive) {
        incomingFilterActive = false;
        outgoingFilterActive = false;
    }
    applyFilters();
}

// Toggle incoming transactions filter — show only transactions coming TO the target
export function toggleIncomingFilter() {
    if (!fullGraphData || !node || !currentTargetId) return;
    incomingFilterActive = !incomingFilterActive;
    // Turn off other filters when enabling incoming filter
    if (incomingFilterActive) {
        outgoingFilterActive = false;
        miningFilterActive = false;
    }
    applyFilters();
}

// Toggle outgoing transactions filter — show only transactions going FROM the target
export function toggleOutgoingFilter() {
    if (!fullGraphData || !node || !currentTargetId) return;
    outgoingFilterActive = !outgoingFilterActive;
    // Turn off other filters when enabling outgoing filter
    if (outgoingFilterActive) {
        incomingFilterActive = false;
        miningFilterActive = false;
    }
    applyFilters();
}

function applyMiningFilter() {
    if (!fullGraphData || !node || !link || !label) return;

    // Collect mining node IDs — strict criteria only, no input_count heuristic
    const miningNodeIds = new Set();
    const miningNames   = [];
    rawNodes.forEach(n => {
        const pi = detectMiningPool(n);
        if (pi) {
            miningNodeIds.add(n.id);
            const name = pi.name || n.label || 'Mining';
            if (!miningNames.includes(name)) miningNames.push(name);
        }
    });

    // Find neighbors of mining nodes to also hide them (noise reduction)
    const miningNeighborIds = new Set();
    rawLinks.forEach(l => {
        const s = l.source?.id || l.source;
        const t = l.target?.id || l.target;
        if (miningNodeIds.has(s)) miningNeighborIds.add(t);
        if (miningNodeIds.has(t)) miningNeighborIds.add(s);
    });

    const txt = document.getElementById('miningFilterText');

    if (miningFilterActive) {
        const isHidden = (id) => {
            if (miningNodeIds.has(id)) return true;
            // Hide nodes connected to mining nodes, unless it's the target of investigation
            if (miningNeighborIds.has(id) && id !== currentTargetId) return true;
            return false;
        };

        // ── Hide mining nodes, neighbors, + edges via display:none ────────────
        node.style("display",  d => isHidden(d.id) ? "none" : null);
        label.style("display", d => (labelsVisible && !isHidden(d.id)) ? null : "none");
        link.style("display",  d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return (isHidden(s) || isHidden(t)) ? "none" : null;
        });

        if (txt) txt.textContent = miningNodeIds.size > 0
            ? `[SHOW MINING (${miningNodeIds.size})]`
            : '[MINING FILTER ON]';

        // Update visible counts (don't change rawNodes/rawLinks — just the display)
        const visNodes = rawNodes.filter(n => !isHidden(n.id)).length;
        const visLinks = rawLinks.filter(l => {
            const s = l.source?.id || l.source;
            const t = l.target?.id || l.target;
            return !isHidden(s) && !isHidden(t);
        }).length;
        updateNodeCountDisplay(visNodes);
        document.getElementById('edgeCount').textContent = visLinks.toLocaleString();

        const det = document.getElementById('loaderDetails');
        if (det) {
            if (miningNodeIds.size > 0) {
                const list  = miningNames.slice(0, 3).join(', ');
                const extra = miningNames.length > 3 ? ` +${miningNames.length - 3}` : '';
                const totalHidden = rawNodes.length - visNodes;
                det.textContent = ` Hiding ${totalHidden} node(s) (Pools: ${miningNodeIds.size}, Payouts: ${totalHidden - miningNodeIds.size}): ${list}${extra}`;
            } else {
                det.textContent = ' No mining nodes detected in current graph';
            }
        }

    } else {
        // ── Restore all hidden elements ───────────────────────────────────────
        node.style("display",  null);
        // Restore label visibility respecting the labelsVisible toggle
        label.style("display", d => {
            if (!labelsVisible) return "none";
            if (d.isTarget || d.risk >= 40 || d.entity_type === 'mining' || d.is_coinbase) return null;
            if (d.entity_type === 'exchange' || d.entity_type === 'mixer') return null;
            if (d._degree >= 4) return null;
            return "none";
        });
        link.style("display",  null);

        if (txt) txt.textContent = '[MINING]';
        updateNodeCountDisplay(rawNodes.length);
        document.getElementById('edgeCount').textContent = rawLinks.length.toLocaleString();

        const det = document.getElementById('loaderDetails');
        if (det) det.textContent = miningNodeIds.size > 0
            ? ` Mining nodes restored (${miningNodeIds.size})` : '';
    }
}

function applyIncomingOutgoingFilters() {
    if (!fullGraphData || !node || !link || !label) return;
    if (!currentTargetId) return;

    const incomingBtn = document.getElementById('incomingFilterText');
    const outgoingBtn = document.getElementById('outgoingFilterText');

    if (incomingFilterActive) {
        // Show only transactions coming TO the target
        const visibleNodeIds = new Set([currentTargetId]);
        const visibleEdgeIds = new Set();
        let incomingCount = 0;
        
        rawLinks.forEach(l => {
            const t = l.target?.id || l.target;
            // Show edges where target is the destination
            if (t === currentTargetId) {
                visibleEdgeIds.add(`${l.source?.id || l.source}|${t}`);
                visibleNodeIds.add(l.source?.id || l.source);
                incomingCount++;
            }
        });

        node.style("display", d => visibleNodeIds.has(d.id) ? null : "none");
        label.style("display", d => (labelsVisible && visibleNodeIds.has(d.id)) ? null : "none");
        link.style("display", d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            const edgeId = `${s}|${t}`;
            return visibleEdgeIds.has(edgeId) ? null : "none";
        });
        
        if (incomingBtn) incomingBtn.textContent = `[INCOMING (${incomingCount})]`;
        if (outgoingBtn) outgoingBtn.textContent = 'Outgoing';
        
        // Update node and edge counts
        updateNodeCountDisplay(visibleNodeIds.size);
        document.getElementById('edgeCount').textContent = incomingCount.toLocaleString();
        
        const det = document.getElementById('loaderDetails');
        if (det) det.textContent = `← Showing ${incomingCount} incoming transaction(s)`;
    } else if (outgoingFilterActive) {
        // Show only transactions going FROM the target
        const visibleNodeIds = new Set([currentTargetId]);
        const visibleEdgeIds = new Set();
        let outgoingCount = 0;
        
        rawLinks.forEach(l => {
            const s = l.source?.id || l.source;
            // Show edges where target is the source
            if (s === currentTargetId) {
                visibleEdgeIds.add(`${s}|${l.target?.id || l.target}`);
                visibleNodeIds.add(l.target?.id || l.target);
                outgoingCount++;
            }
        });

        node.style("display", d => visibleNodeIds.has(d.id) ? null : "none");
        label.style("display", d => (labelsVisible && visibleNodeIds.has(d.id)) ? null : "none");
        link.style("display", d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            const edgeId = `${s}|${t}`;
            return visibleEdgeIds.has(edgeId) ? null : "none";
        });
        
        if (incomingBtn) incomingBtn.textContent = 'Incoming';
        if (outgoingBtn) outgoingBtn.textContent = `[OUTGOING (${outgoingCount})]`;
        
        // Update node and edge counts
        updateNodeCountDisplay(visibleNodeIds.size);
        document.getElementById('edgeCount').textContent = outgoingCount.toLocaleString();
        
        const det = document.getElementById('loaderDetails');
        if (det) det.textContent = `→ Showing ${outgoingCount} outgoing transaction(s)`;
    } else {
        // Show all nodes and edges normally
        node.style("display", null);
        link.style("display", null);
        label.style("display", d => {
            if (!labelsVisible) return "none";
            if (d.isTarget || d.risk >= 40 || d.entity_type === 'mining' || d.is_coinbase) return null;
            if (d.entity_type === 'exchange' || d.entity_type === 'mixer') return null;
            if (d._degree >= 4) return null;
            return "none";
        });
        if (incomingBtn) incomingBtn.textContent = 'Incoming';
        if (outgoingBtn) outgoingBtn.textContent = 'Outgoing';
        
        updateNodeCountDisplay(rawNodes.length);
        document.getElementById('edgeCount').textContent = rawLinks.length.toLocaleString();
    }
}

// Combined filter function that applies all active filters
function applyFilters() {
    if (miningFilterActive) {
        applyMiningFilter();
    } else {
        applyIncomingOutgoingFilters();
    }
}

// =============================================================================
// ENTITY INTELLIGENCE PANEL
// =============================================================================
// Entity view is now handled by ui.js module (imported above)

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
                    <div class="text-[8px] text-slate-400">${time} ${confirmed ? `· Block #${tx.status.block_height}` : '·  Mempool'}</div>
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
                    <div class="text-[8px] text-slate-400">${u.status?.confirmed ? ' Confirmed' : ' Unconfirmed'}</div>
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
        el.innerHTML = `<div class="text-[9px] text-red-500"> ${err.message}</div>
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
                    ${confirmed ? ` Confirmed · Block #${tx.status.block_height}` : ' Unconfirmed (Mempool)'}
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
        el.innerHTML = `<div class="text-[9px] text-red-500"> ${err.message}</div>`;
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
/**
 * Toggle the complete timeline overlay, including its calendar controls.
 */
window.toggleTimelineCollapse = function() {
    const timeline = document.getElementById('timelineUI');
    const calendar = document.getElementById('calendarModal');
    if (!timeline) return;

    timelineCollapsed = !timelineCollapsed;
    timeline.classList.toggle('hidden', timelineCollapsed);
    calendar?.classList.add('hidden');

    const collapseButton = document.getElementById('timelineCollapseBtn');
    if (collapseButton) {
        collapseButton.textContent = timelineCollapsed ? '▶' : '▼';
        collapseButton.title = timelineCollapsed ? 'Show Timeline' : 'Hide Timeline';
    }
};

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
    ui.classList.toggle('hidden', timelineCollapsed);
    slider.min = minTS; slider.max = maxTS; slider.value = maxTS;
    updateTimelineRangeLabels(minTS, maxTS);

    slider.oninput = () => {
        let v = parseInt(slider.value);
        const frameTimestamp = window.seekPlaybackToTimestamp?.(v);
        if (frameTimestamp !== undefined && frameTimestamp !== null) {
            v = frameTimestamp;
            slider.value = String(v);
        }
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
        window.initPlayback?.();
        return;
    }
    const ts_edges = rawLinks.filter(e => e.timestamp > 0);
    if (!ts_edges.length) {
        document.getElementById('timelineUI').classList.add('hidden');
        window.initPlayback?.();
        return;
    }

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
    ui.classList.toggle('hidden', timelineCollapsed);
    slider.min = minTS; slider.max = maxTS;
    // If current slider value is outside new range, clamp it to max (latest)
    if (parseInt(slider.value) > maxTS || parseInt(slider.value) < minTS) slider.value = maxTS;
    updateTimelineRangeLabels(minTS, maxTS);
    // Update calendar display and invoke the oninput handler to re-evaluate visibility
    const display = document.getElementById('dateDisplay');
    const v = parseInt(slider.value);
    if (display) display.innerText = new Date(v * 1000).toISOString().split('T')[0];
    window.initPlayback?.();
    if (typeof slider.oninput === 'function') slider.oninput();
}

function updateTimelineRangeLabels(minTS, maxTS) {
    const start = document.getElementById('timelineStartDate');
    const end = document.getElementById('timelineEndDate');
    if (start) start.textContent = new Date(minTS * 1000).toISOString().split('T')[0];
    if (end) end.textContent = new Date(maxTS * 1000).toISOString().split('T')[0];
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
    // Check for custom color annotation first
    const customColor = getNodeCustomColor(d.id);
    if (customColor) return customColor;
    
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

    link.style('stroke', d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return tracePathEdgeKeys.has(s + '|' + t) ? '#f97316' : getEdgeColor(d);
        })
        .attr('stroke-width', d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return tracePathEdgeKeys.has(s + '|' + t) ? 3 : Math.max(1, Math.sqrt((d.amount || 0) + 1));
        })
        .attr('marker-end', d => {
            const s = d.source?.id || d.source;
            const t = d.target?.id || d.target;
            return tracePathEdgeKeys.has(s + '|' + t) ? 'url(#arrowhead-trace)' : getArrowMarkerId(getEdgeColor(d));
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

        defs = svg.append('defs');
        const mkArrow = (id, color) => defs.append('marker').attr('id', id)
            .attr('viewBox', '0 -6 12 12').attr('refX', 11).attr('refY', 0)
            .attr('markerWidth', 9).attr('markerHeight', 9)
            .attr('markerUnits', 'userSpaceOnUse').attr('orient', 'auto')
            .append('path').attr('d', 'M0,-6L12,0L0,6Z').attr('fill', color);
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
        link  = g.select('.links').selectAll('path');
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
        .force('link',   d3.forceLink(rawLinks).id(d => d.id).distance(d => d.type === 'Transaction' ? 80 : 60))
        .force('charge', d3.forceManyBody().strength(d => d.type === 'Transaction' ? -225 : -110))
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
        window._rawLinks = rawLinks;  // Update playback module with new links

        // Restart simulation with a small kick so new nodes animate in
        if (simulation) {
            simulation.nodes(rawNodes);
            simulation.force('link').links(rawLinks);
            simulation.alpha(0.4).restart();
        }

        // Apply highlight to path so far
        applyTraceHighlight();

        updateNodeCountDisplay(rawNodes.length);
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

    link.style('stroke', d => getEdgeColor(d))
        .attr('stroke-width', d => Math.max(2.5, Math.min(Math.sqrt((d.amount || 0) + 1) * 2, 8)))
        .attr('marker-end', d => getArrowMarkerId(getEdgeColor(d)))
        .style('opacity', 0.85);

    label.style('opacity', 1);
    g?.select('.dest-ring')?.selectAll('circle')?.remove();
}

// Graph module: exports D3 rendering and interaction functions
// runSleuth is defined in main.js as the primary orchestrator
// =============================================================================
// GRAPH NODE SEARCH
// =============================================================================
// Finds nodes whose id or label contains the query string (case-insensitive).
// Highlights matches, zooms/pans to the first result, opens the entity panel.

window.graphSearch = function(query) {
    query = (query || '').trim().toLowerCase();
    const resultEl = document.getElementById('graphSearchResults');

    if (!query || !fullGraphData) {
        if (resultEl) resultEl.innerHTML = '';
        // Clear any existing highlight
        if (state.node) state.node.attr('opacity', 1);
        if (state.node) state.node.classed('search-highlight', false);
        return;
    }

    const matches = Object.entries(fullGraphData.nodes).filter(([id, n]) => {
        return id.toLowerCase().includes(query) ||
               (n.label || '').toLowerCase().includes(query) ||
               (n.entity_type || '').toLowerCase().includes(query);
    });

    // Highlight matches vs non-matches in the graph
    if (state.node) {
        state.node.attr('opacity', d => {
            if (walletViewActive && d.members) {
                return d.members.some(mId => 
                    mId.toLowerCase().includes(query) || 
                    ((_fullGraphDataBak?.nodes[mId]?.label || '').toLowerCase().includes(query))
                ) ? 1 : 0.15;
            }
            const match = d.id.toLowerCase().includes(query) ||
                          (d.label || '').toLowerCase().includes(query);
            return match ? 1 : 0.15;
        });
    }

    if (resultEl) {
        if (matches.length === 0) {
            resultEl.innerHTML = `<div style="font-size:9px;color:#ef4444;padding:4px 0;font-style:italic">No nodes found for "${query}"</div>`;
            return;
        }

        resultEl.innerHTML = matches.slice(0, 8).map(([id, n]) => {
            const short = id.length > 20 ? id.slice(0, 10) + '…' + id.slice(-8) : id;
            const label = n.label && n.label !== id ? ` · ${n.label}` : '';
            const risk  = n.risk > 0 ? `<span style="color:#ef4444;font-weight:700;margin-left:4px">${n.risk}</span>` : '';
            return `<button onclick="window.graphSearchSelect('${id}')"
                style="display:block;width:100%;text-align:left;padding:5px 8px;margin-bottom:3px;
                       border-radius:5px;border:1px solid #334155;background:#0f172a;cursor:pointer;
                       font-size:9px;font-family:monospace;color:#94a3b8;
                       transition:background .15s"
                onmouseover="this.style.background='#1e293b'"
                onmouseout="this.style.background='#0f172a'">
                <span style="color:#67e8f9">${short}</span>${label}${risk}
            </button>`;
        }).join('');

        if (matches.length > 8) {
            resultEl.innerHTML += `<div style="font-size:8px;color:#475569;padding:2px 4px">${matches.length - 8} more — refine your query</div>`;
        }
    }

    // Pan/zoom to the first match
    if (matches.length > 0) {
        window.graphSearchSelect(matches[0][0], false);
    }
};

// Jump to a node and optionally open its panel
window.graphSearchSelect = function(nodeId, openPanel = true) {
    // Resolve the ID if we are in Wallet View (cluster-collapsed)
    let actualId = nodeId;
    if (walletViewActive) {
        actualId = getWalletIdModule(nodeId, _fullGraphDataBak || fullGraphData);
    }

    const n = rawNodes.find(n => n.id === actualId);
    if (!n || !state.svg || !zoom) return;

    const k = 2.2;
    state.svg.transition().duration(600)
        .call(zoom.transform, d3.zoomIdentity.scale(k).translate(-(n.x || 0), -(n.y || 0)));

    // Apply the "glow in and out" pulse animation
    if (state.node) {
        state.node.classed('search-highlight', false); // Clear previous
        state.node.filter(d => d.id === actualId)
            .classed('search-highlight', true);
    }

    if (openPanel && window.showEntityView) {
        window.showEntityView(nodeId);
        if (typeof enrichNodeIfNeeded === 'function') enrichNodeIfNeeded(nodeId);
    }
};

// Clear search highlights
window.graphSearchClear = function() {
    if (state.node) {
        state.node.attr('opacity', 1);
        state.node.classed('search-highlight', false);
    }
    const q = document.getElementById('graphSearchInput');
    const r = document.getElementById('graphSearchResults');
    if (q) q.value = '';
    if (r) r.innerHTML = '';
};


export { expandNode, expandSelected, expandAll, updateExpandRings, updateExpandBtn };
export { saveSession, restoreSession, checkPendingSession };
export { updateNodeCountDisplay, updateMixerDetectionDisplay };


/**
 * Toggle between Address View (default) and Wallet View (co-spend collapsed).
 *
 * In Wallet View:
 *  - All addresses sharing a cluster (co-spend heuristic) are merged into one node.
 *  - The merged node shows a member count badge and a combined risk/label.
 *  - Edges are deduplicated across the collapsed boundary and amounts summed.
 *  - The graph is much smaller and reveals the true inter-entity flow.
 *
 * Calling again toggles back to the full address view.
 */
export function toggleWalletView() {
    const btn = document.getElementById('walletViewText');

    if (!fullGraphData) {
        // Nothing loaded yet — silently ignore
        return;
    }

    walletViewActive = !walletViewActive;

    if (walletViewActive) {
        // Stash original data so we can restore it
        _fullGraphDataBak = fullGraphData;
        _targetIdBak      = currentTargetId;

        // Build and render the collapsed wallet graph
        walletGraphData = buildWalletGraphModule(fullGraphData);
        const walletTargetId = getWalletIdModule(currentTargetId, fullGraphData);

        renderGraph(walletGraphData, walletTargetId);

        if (btn) btn.textContent = '[ADDR VIEW]';

        // Update legend note
        const legend = document.getElementById('walletViewLegend');
        if (legend) legend.classList.remove('hidden');

    } else {
        // Restore the original address-level graph
        fullGraphData  = _fullGraphDataBak;
        currentTargetId = _targetIdBak;
        walletGraphData  = null;

        if (_fullGraphDataBak) renderGraph(_fullGraphDataBak, _targetIdBak);

        if (btn) btn.textContent = '[WALLET VIEW]';

        const legend = document.getElementById('walletViewLegend');
        if (legend) legend.classList.add('hidden');
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION SAVE / LOAD
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_VERSION = 1; // Increment if session format changes
const PENDING_SESSION_KEY = 'cryptrace_pending_session';
const RELOAD_SESSION_KEY = 'cryptracer_reload_session';

function saveReloadSession() {
    if (!fullGraphData || !currentTargetId) {
        sessionStorage.removeItem(RELOAD_SESSION_KEY);
        return;
    }

    const session = {
        version: SESSION_VERSION,
        saved_at: new Date().toISOString(),
        target: currentTargetId,
        graph: fullGraphData,
        expanded_nodes: [...expandedNodes],
    };

    try {
        sessionStorage.setItem(RELOAD_SESSION_KEY, JSON.stringify(session));
    } catch (error) {
        console.error('Failed to save the current graph for reload:', error);
        showToast('This graph could not be saved for reload. It may be too large for browser storage.', 'warning', 9000);
    }
}

window.addEventListener('pagehide', saveReloadSession);

/**
 * Save the current graph state to a downloadable .ctk file.
 * Includes: graph data, annotations, expanded node list, and the search target.
 */
function saveSession() {
    if (!fullGraphData || !rawNodes.length) {
        alert('Nothing to save — run a search first.');
        return;
    }

    // Pull annotations from localStorage
    let annotations = {};
    try {
        const raw = localStorage.getItem('cryptracer_node_annotations'); // matches annotations.js STORAGE_KEY
        if (raw) annotations = JSON.parse(raw);
    } catch (_) {}

    const session = {
        version:        SESSION_VERSION,
        saved_at:       new Date().toISOString(),
        target:         currentTargetId || '',
        graph:          fullGraphData,
        annotations,
        expanded_nodes: [...expandedNodes],
    };

    const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href     = url;
    a.download = `cryptracker-session-${currentTargetId ? currentTargetId.slice(0, 12) : 'graph'}-${ts}.ctk`;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Restore a session object that was loaded from a .ctk file.
 * Called either directly (in-page) or on app boot when a pending session exists.
 */
async function restoreSession(session) {
    if (!session || session.version !== SESSION_VERSION) {
        alert('Invalid or incompatible session file.');
        return;
    }

    // 1. Restore annotations
    if (session.annotations && Object.keys(session.annotations).length > 0) {
        localStorage.setItem('cryptracer_node_annotations', JSON.stringify(session.annotations)); // matches annotations.js STORAGE_KEY
    }

    // 2. Render the graph
    if (session.graph && session.target) {
        document.getElementById('targetId').value = session.target;
        await renderGraph(session.graph, session.target);
        currentTargetId = session.target;
        state.currentTargetId = session.target;
    }

    // 3. Restore expanded-node set (rings + button state)
    if (Array.isArray(session.expanded_nodes)) {
        session.expanded_nodes.forEach(id => expandedNodes.add(id));
        window._expandedNodes = expandedNodes;
        if (window.updateExpandRings) updateExpandRings();
    }

    // 4. Show a toast
    const el = document.getElementById('loaderDetails');
    if (el) {
        el.textContent = `Session restored — ${Object.keys(session.graph?.nodes || {}).length} nodes, saved ${new Date(session.saved_at).toLocaleString()}`;
    }
}

/**
 * Check on app boot whether a session was queued for restore (from setup page).
 */
function checkPendingSession() {
    const raw = sessionStorage.getItem(PENDING_SESSION_KEY);
    const isPendingImport = Boolean(raw);
    const sessionRaw = raw || sessionStorage.getItem(RELOAD_SESSION_KEY);
    if (!sessionRaw) return;
    if (isPendingImport) sessionStorage.removeItem(PENDING_SESSION_KEY);
    try {
        const session = JSON.parse(sessionRaw);
        // Slight delay so D3 canvas is ready
        setTimeout(() => restoreSession(session), 600);
    } catch (e) {
        console.error('Failed to restore saved session:', e);
        showToast('The saved graph could not be restored.', 'error', 9000);
        if (!isPendingImport) sessionStorage.removeItem(RELOAD_SESSION_KEY);
    }
}