import { runSleuth, renderGraph, toggleFreeze, toggleLayout, toggleLabels, zoomIn, zoomOut, recenterGraph, fitGraphToScreen, toggleCalendar } from './graph.js';
import { initNetworkStats } from './api.js';
import { closeEntityView, enrichFromMempool, enrichTxFromMempool } from './ui.js';

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
window.zoomIn           = zoomIn;
window.zoomOut          = zoomOut;
window.recenterGraph    = recenterGraph;
window.fitGraphToScreen = fitGraphToScreen;
window.toggleCalendar   = toggleCalendar;
window.closeEntityView  = closeEntityView;
window.initNetworkStats = initNetworkStats;
window.enrichFromMempool = enrichFromMempool;
window.enrichTxFromMempool = enrichTxFromMempool;

// Boot network stats ticker
window.addEventListener('DOMContentLoaded', () => initNetworkStats());