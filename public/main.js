import { runSleuth, renderGraph, toggleFreeze, toggleLayout, toggleLabels, toggleTimestamps, zoomIn, zoomOut, recenterGraph, fitGraphToScreen, toggleCalendar, toggleEdgeTooltips, updateGraphNodeColor, updateGraphNodeLabel, toggleWalletView, expandNode, expandSelected, expandAll, saveSession, restoreSession, checkPendingSession } from './graph.js';
import { initNetworkStats } from './api.js';
import { closeEntityView, enrichFromMempool, enrichTxFromMempool, showEntityView } from './ui.js';
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
window.showEntityView   = showEntityView;
window.initNetworkStats = initNetworkStats;
window.enrichFromMempool    = enrichFromMempool;
window.enrichTxFromMempool  = enrichTxFromMempool;
window.runTracePath     = runTracePath;
window.closeTraceView   = closeTraceView;
window.updateGraphNodeColor = updateGraphNodeColor;
window.updateGraphNodeLabel = updateGraphNodeLabel;
window.toggleWalletView    = toggleWalletView;
window.expandNode          = expandNode;
window.expandSelected      = expandSelected;
window.expandAll           = expandAll;
window.saveSession         = saveSession;
window.restoreSession      = restoreSession;
window.checkPendingSession = checkPendingSession;

// Boot network stats ticker and restore any pending session
window.addEventListener('DOMContentLoaded', () => {
    initNetworkStats();
    checkPendingSession();
});