import { runSleuth, renderGraph, toggleFreeze, toggleLayout, toggleLabels, toggleTimestamps, zoomIn, zoomOut, recenterGraph, fitGraphToScreen, toggleCalendar, toggleEdgeTooltips, updateGraphNodeColor, updateGraphNodeLabel, updateGraphEdgeColors, toggleWalletView, expandNode, expandSelected, expandAll, saveSession, restoreSession, checkPendingSession, toggleMiningFilter, toggleIncomingFilter, toggleOutgoingFilter, updateNodeCountDisplay } from './graph.js';
import { initNetworkStats } from './api.js';
import { closeEntityView, enrichFromMempool, enrichTxFromMempool, showEntityView } from './ui.js';
import { runTracePath, closeTraceView } from './tracer.js';
import { startPlayback, pausePlayback, resumePlayback, stopPlayback, togglePlayback, setPlaybackSpeed, increaseSpeed, decreaseSpeed, nextFrame, previousFrame, initPlayback, getPlaybackStats } from './playback.js';

console.log('Cryptracer: D3 Renderer Loaded (Modular)');
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
window.toggleMiningFilter = toggleMiningFilter;
window.toggleIncomingFilter = toggleIncomingFilter;
window.toggleOutgoingFilter = toggleOutgoingFilter;
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
window.updateGraphEdgeColors = updateGraphEdgeColors;
window.toggleWalletView    = toggleWalletView;
window.expandNode          = expandNode;
window.expandSelected      = expandSelected;
window.expandAll           = expandAll;
window.saveSession         = saveSession;
window.restoreSession      = restoreSession;
window.checkPendingSession = checkPendingSession;
window.updateNodeCountDisplay = updateNodeCountDisplay;

// Playback / Time-Travel Animation controls
window.startPlayback  = startPlayback;
window.pausePlayback  = pausePlayback;
window.resumePlayback = resumePlayback;
window.stopPlayback   = stopPlayback;
window.togglePlayback = togglePlayback;
window.setPlaybackSpeed = setPlaybackSpeed;
window.increaseSpeed  = increaseSpeed;
window.decreaseSpeed  = decreaseSpeed;
window.nextFrame      = nextFrame;
window.previousFrame  = previousFrame;
window.initPlayback   = initPlayback;
window.getPlaybackStats = getPlaybackStats;

// Boot network stats ticker and restore any pending session
window.addEventListener('DOMContentLoaded', () => {
    initNetworkStats();
    checkPendingSession();
});