import { runSleuth, renderGraph, toggleFreeze, toggleLayout, toggleLabels, toggleTimestamps, zoomIn, zoomOut, recenterGraph, fitGraphToScreen, toggleCalendar, toggleEdgeTooltips } from './graph.js';
import { initNetworkStats } from './api.js';
import { closeEntityView, enrichFromMempool, enrichTxFromMempool } from './ui.js';
import { runTracePath, closeTraceView } from './tracer.js';

console.log('Cryptracker: D3 Renderer Loaded (Modular)');
// Backend uses Blockstream API, Frontend uses Mempool.space for live enrichment.

// =============================================================================
// GLOBAL EXPOSURE (for HTML onclick handlers)
// =============================================================================
window.runSleuth        = runSleuth;
window.renderGraph      = renderGraph;
window.toggleFreeze     = toggleFreeze;
window.toggleLayout     = toggleLayout;
window.toggleLabels     = toggleLabels;
window.toggleTimestamps = toggleTimestamps;
window.zoomIn           = zoomIn;
window.zoomOut          = zoomOut;
window.recenterGraph    = recenterGraph;
window.fitGraphToScreen = fitGraphToScreen;
window.toggleCalendar   = toggleCalendar;
window.toggleEdgeTooltips = toggleEdgeTooltips;
window.closeEntityView  = closeEntityView;
window.initNetworkStats = initNetworkStats;
window.enrichFromMempool    = enrichFromMempool;
window.enrichTxFromMempool  = enrichTxFromMempool;
window.runTracePath     = runTracePath;
window.closeTraceView   = closeTraceView;

// Boot network stats ticker
window.addEventListener('DOMContentLoaded', () => initNetworkStats());