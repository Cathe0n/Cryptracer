// Sigma.js Graph Renderer - Handles unlimited nodes/edges

let graph = null;
let renderer = null;
let layoutRunning = false;
let currentTargetId = null;
let fullGraphData = null;

const loader = document.getElementById('loader');

const setBusy = (isBusy, title = 'RECONSTRUCTING TIMELINE...', details = '') => {
    loader.style.display = isBusy ? 'flex' : 'none';
    if (isBusy) {
        document.getElementById('loaderTitle').textContent = title;
        document.getElementById('loaderDetails').textContent = details;
    }
};

async function runSleuth() {
    const id = document.getElementById('targetId').value.trim();
    if(!id) return;

    currentTargetId = id;
    setBusy(true, 'INITIATING INVESTIGATION...', `Target: ${id.substring(0, 20)}...`);

    try {
        setBusy(true, 'FETCHING NETWORK DATA...', 'Querying blockchain graph database...');
        
        const res = await fetch(`/api/trace/${id}`);
        const data = await res.json();
        
        if (!data.graph) { 
            setBusy(false);
            alert('No graph data returned. Entity may not exist or API error occurred.');
            return;
        }

        const nodeCount = Object.keys(data.graph.nodes || {}).length;
        const edgeCount = (data.graph.edges || []).length;
        
        console.log(`✅ Received ${nodeCount} nodes and ${edgeCount} edges`);
        
        setBusy(true, 'PROCESSING GRAPH DATA...', `Found ${nodeCount} entities and ${edgeCount} transactions`);

        document.getElementById('intelBox').classList.remove('hidden');
        document.getElementById('riskCount').innerText = data.graph.nodes[id]?.risk || 0;
        document.getElementById('identityLabel').innerText = data.graph.nodes[id]?.label || id;

        setBusy(true, 'LOADING TRANSACTION HISTORY...', 'Retrieving activity logs...');
        
        const hRes = await fetch(`/api/history/${id}`);
        const txs = await hRes.json();
        
        document.getElementById('historyList').innerHTML = (txs || []).slice(0, 10).map(tx => `
            <div class="p-3 rounded-md bg-slate-800/20 border border-slate-800">
                <div class="text-[9px] text-slate-500 truncate mb-1">${tx.txid || 'Unknown'}</div>
                <div class="text-cyan-400 font-bold text-[10px]">${tx.vout && tx.vout[0] ? (tx.vout[0].value/100000000).toFixed(4) : '0.0000'} BTC</div>
            </div>
        `).join('') || '<div class="text-[10px] text-slate-600 italic">No history found.</div>';

        setBusy(true, 'CONSTRUCTING GRAPH...', `Preparing ${nodeCount} nodes for WebGL rendering`);
        
        renderGraph(data.graph, id);
    } catch (err) { 
        console.error('Error in runSleuth:', err);
        setBusy(false);
        alert('Error loading data: ' + err.message);
    }
}

function renderGraph(graphData, targetId) {
    try {
        // Store full data
        fullGraphData = graphData;
        
        const nodeCount = Object.keys(graphData.nodes || {}).length;
        const edgeCount = (graphData.edges || []).length;
        
        console.log(`🎨 Rendering ${nodeCount} nodes and ${edgeCount} edges with Sigma.js...`);
        
        setBusy(true, 'INITIALIZING WEBGL...', 'Setting up GPU-accelerated rendering');
        
        // Create new Graphology graph
        if (graph) {
            graph.clear();
        } else {
            graph = new graphology.Graph({ multi: true });
        }
        
        // Add all nodes
        let addedNodes = 0;
        Object.entries(graphData.nodes).forEach(([id, node]) => {
            try {
                // Random initial position (layout will fix)
                const x = Math.random() * 1000 - 500;
                const y = Math.random() * 1000 - 500;
                
                // Determine color based on type and risk
                let color = '#0ea5e9'; // Default: blue (Address)
                if (node.type === 'Transaction') {
                    color = '#6366f1'; // Purple
                }
                if (node.risk > 0) {
                    color = '#ef4444'; // Red (High risk)
                }
                if (id === targetId) {
                    color = '#fbbf24'; // Gold (Target)
                }
                
                // Determine size - Transactions smaller, Addresses larger
                let size = node.type === 'Transaction' ? 3 : 6;
                if (node.risk > 0) size = 10;
                if (id === targetId) size = 15;
                
                // IMPORTANT: Don't use 'type' - Sigma reserves it for renderer selection
                // Use 'entityType' instead
                graph.addNode(id, {
                    x, y,
                    size,
                    color,
                    label: node.label || id,
                    fullLabel: node.label || id,
                    entityType: node.type || 'Unknown',  // Changed from 'type' to 'entityType'
                    risk: node.risk || 0,
                    sources: node.sources || [],
                    isTarget: id === targetId,
                    originalData: node
                });
                addedNodes++;
            } catch (e) {
                console.warn(`Failed to add node ${id}:`, e.message);
            }
        });
        
        console.log(`✅ Added ${addedNodes} nodes`);
        
        // Add all edges
        setBusy(true, 'ADDING CONNECTIONS...', `Processing ${edgeCount} transactions`);
        
        let addedEdges = 0;
        let skippedEdges = 0;
        graphData.edges.forEach((edge, i) => {
            try {
                if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
                    skippedEdges++;
                    return;
                }
                
                graph.addEdge(edge.source, edge.target, {
                    size: 1,
                    color: '#475569',
                    label: `${edge.amount.toFixed(4)} BTC`,
                    amount: edge.amount,
                    timestamp: edge.timestamp || 0,
                    sources: edge.sources || []
                });
                addedEdges++;
            } catch (e) {
                // Edge already exists or other error
                skippedEdges++;
            }
        });
        
        console.log(`✅ Added ${addedEdges} edges (${skippedEdges} skipped/duplicates)`);
        
        // Update stats
        document.getElementById('nodeCount').textContent = graph.order.toLocaleString();
        document.getElementById('edgeCount').textContent = graph.size.toLocaleString();
        
        // Initialize or update renderer
        setBusy(true, 'STARTING RENDERER...', 'Initializing WebGL context');
        
        const container = document.getElementById('sigma-container');
        
        if (renderer) {
            renderer.kill();
        }
        
        renderer = new Sigma(graph, container, {
            renderEdgeLabels: false, // Never show edge labels (too cluttered)
            enableEdgeEvents: false,
            labelDensity: 0.03,  // Much lower - show fewer labels
            labelGridCellSize: 100,  // Larger grid = fewer labels
            labelRenderedSizeThreshold: 12,  // Only show labels for bigger nodes
            zIndex: true,
            // Reduce label rendering for performance
            minCameraRatio: 0.1,
            maxCameraRatio: 10
        });
        
        console.log('✅ Sigma renderer initialized');
        
        // Setup interactions
        setupInteractions();
        
        // Initialize timeline if edges have timestamps
        initTimeline(graphData.edges);
        
        // Run layout
        setBusy(true, 'CALCULATING LAYOUT...', 'Computing optimal positions (this may take a moment)');
        
        setTimeout(() => {
            runLayout();
            
            // After layout, fit graph to screen to see everything
            setTimeout(() => {
                fitGraphToScreen();
                console.log('✅ Graph fitted to screen');
            }, 800);
            
            setBusy(false);
        }, 100);
        
    } catch (err) {
        console.error('Error rendering graph:', err);
        setBusy(false);
        alert('Failed to render graph: ' + err.message);
    }
}

// Layout algorithm - improved for better clustering
function runLayout() {
    if (layoutRunning) return;
    
    layoutRunning = true;
    console.log('🔄 Running ForceAtlas2 layout with clustering...');
    
    const nodeCount = graph.order;
    
    // Settings optimized for blockchain graphs
    const settings = {
        iterations: nodeCount > 1000 ? 100 : 200,  // More iterations for smaller graphs
        settings: {
            gravity: 2,  // Stronger gravity pulls nodes together
            scalingRatio: 50,  // More spacing between clusters
            slowDown: 2,  // Slower = more stable
            barnesHutOptimize: nodeCount > 500,  // Use Barnes-Hut for large graphs
            barnesHutTheta: 0.5,
            strongGravityMode: false,
            linLogMode: true,  // Better for clustered networks
            outboundAttractionDistribution: true,  // Hubs get more space
            edgeWeightInfluence: 1  // Edge weight affects layout
        }
    };
    
    try {
        // Run layout
        graphologyLibrary.layoutForceAtlas2.assign(graph, settings);
        
        // Spread out the graph for better visibility
        const bbox = getBoundingBox();
        const scale = 800 / Math.max(bbox.width, bbox.height);
        
        graph.forEachNode((node, attrs) => {
            graph.setNodeAttribute(node, 'x', (attrs.x - bbox.centerX) * scale);
            graph.setNodeAttribute(node, 'y', (attrs.y - bbox.centerY) * scale);
        });
        
        renderer.refresh();
        console.log('✅ Layout complete with clustering');
    } catch (e) {
        console.warn('Layout error:', e);
        // Fallback: circular layout with clustering by type
        layoutByType();
    }
    
    layoutRunning = false;
}

// Helper: Get bounding box of all nodes
function getBoundingBox() {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    
    graph.forEachNode((node, attrs) => {
        minX = Math.min(minX, attrs.x);
        maxX = Math.max(maxX, attrs.x);
        minY = Math.min(minY, attrs.y);
        maxY = Math.max(maxY, attrs.y);
    });
    
    return {
        minX, maxX, minY, maxY,
        width: maxX - minX,
        height: maxY - minY,
        centerX: (minX + maxX) / 2,
        centerY: (minY + maxY) / 2
    };
}

// Fallback layout: Group by entity type in separate clusters
function layoutByType() {
    const addresses = [];
    const transactions = [];
    
    graph.forEachNode((node, attrs) => {
        if (attrs.entityType === 'Transaction') {
            transactions.push(node);
        } else {
            addresses.push(node);
        }
    });
    
    // Layout addresses in a circle on the left
    addresses.forEach((node, i) => {
        const angle = (i / addresses.length) * Math.PI * 2;
        const radius = 300;
        graph.setNodeAttribute(node, 'x', -400 + Math.cos(angle) * radius);
        graph.setNodeAttribute(node, 'y', Math.sin(angle) * radius);
    });
    
    // Layout transactions in a circle on the right
    transactions.forEach((node, i) => {
        const angle = (i / transactions.length) * Math.PI * 2;
        const radius = 200;
        graph.setNodeAttribute(node, 'x', 400 + Math.cos(angle) * radius);
        graph.setNodeAttribute(node, 'y', Math.sin(angle) * radius);
    });
    
    renderer.refresh();
}

function toggleLayout() {
    if (!layoutRunning) {
        runLayout();
    }
}

// New utility functions
let labelsVisible = false;

function toggleLabels() {
    labelsVisible = !labelsVisible;
    
    if (!renderer) return;
    
    const toggleBtn = document.getElementById('labelToggleText');
    
    if (labelsVisible) {
        // Show all labels
        renderer.setSetting('labelRenderedSizeThreshold', 0);
        toggleBtn.textContent = '[HIDE LABELS]';
    } else {
        // Hide labels except important ones
        renderer.setSetting('labelRenderedSizeThreshold', 12);
        toggleBtn.textContent = '[SHOW LABELS]';
    }
    
    renderer.refresh();
}

function zoomIn() {
    if (!renderer) return;
    const camera = renderer.getCamera();
    camera.animate({ ratio: camera.ratio / 1.5 }, { duration: 300 });
}

function zoomOut() {
    if (!renderer) return;
    const camera = renderer.getCamera();
    camera.animate({ ratio: camera.ratio * 1.5 }, { duration: 300 });
}

function recenterGraph() {
    if (!renderer || !currentTargetId || !graph) return;
    
    try {
        // Check if target node exists
        if (!graph.hasNode(currentTargetId)) {
            console.warn('Target node not found in graph');
            fitGraphToScreen();
            return;
        }
        
        // Get target node position in graph coordinates
        const nodeDisplayData = renderer.getNodeDisplayData(currentTargetId);
        
        if (!nodeDisplayData) {
            console.warn('Could not get node display data');
            fitGraphToScreen();
            return;
        }
        
        console.log('Centering on target node at:', nodeDisplayData);
        
        // Get camera
        const camera = renderer.getCamera();
        
        // Zoom to the target node
        // Use the node's actual rendered position
        camera.animate(
            { 
                x: nodeDisplayData.x,
                y: nodeDisplayData.y,
                ratio: 0.15  // Zoom in very close
            },
            { 
                duration: 1200,
                easing: 'quadraticInOut'
            }
        );
        
        // Highlight the target node temporarily
        const originalColor = graph.getNodeAttribute(currentTargetId, 'color');
        const originalSize = graph.getNodeAttribute(currentTargetId, 'size');
        
        // Pulse effect
        graph.setNodeAttribute(currentTargetId, 'size', originalSize * 2);
        renderer.refresh();
        
        setTimeout(() => {
            graph.setNodeAttribute(currentTargetId, 'size', originalSize);
            renderer.refresh();
        }, 1500);
        
    } catch (e) {
        console.error('Error in recenterGraph:', e);
        fitGraphToScreen();
    }
}

// Fit entire graph to screen
function fitGraphToScreen() {
    if (!renderer) return;
    
    try {
        const camera = renderer.getCamera();
        
        // Get all node positions to calculate bounds
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        
        graph.forEachNode((node) => {
            const data = renderer.getNodeDisplayData(node);
            if (data) {
                minX = Math.min(minX, data.x);
                maxX = Math.max(maxX, data.x);
                minY = Math.min(minY, data.y);
                maxY = Math.max(maxY, data.y);
            }
        });
        
        // Calculate center and size
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const width = maxX - minX;
        const height = maxY - minY;
        
        // Get container size
        const container = renderer.getContainer();
        const containerWidth = container.offsetWidth;
        const containerHeight = container.offsetHeight;
        
        // Calculate ratio to fit graph with some padding
        const padding = 100;
        const ratioX = (width + padding * 2) / containerWidth;
        const ratioY = (height + padding * 2) / containerHeight;
        const ratio = Math.max(ratioX, ratioY, 0.5); // Minimum ratio of 0.5
        
        console.log('Fitting graph to screen:', { centerX, centerY, ratio });
        
        camera.animate(
            { x: centerX, y: centerY, ratio: ratio },
            { duration: 1000 }
        );
    } catch (e) {
        console.error('Error fitting graph:', e);
    }
}

// Interactive features
function setupInteractions() {
    if (!renderer) return;
    
    // Zoom-based label visibility
    const camera = renderer.getCamera();
    
    // Update label visibility when camera moves
    renderer.on('afterRender', () => {
        const ratio = camera.ratio;
        
        // Only show labels when zoomed in (ratio < 0.5)
        // And only for important nodes
        graph.forEachNode((node, attrs) => {
            const shouldShowLabel = 
                ratio < 0.5 ||  // Zoomed in
                attrs.isTarget ||  // Always show target
                attrs.risk > 0 ||  // Always show risk nodes
                attrs.size > 10;  // Always show large nodes
            
            // Sigma doesn't have a built-in hide label property
            // But we can make the label empty string when we don't want it
            // This is handled by labelRenderedSizeThreshold in renderer config
        });
    });
    
    // Click node
    renderer.on('clickNode', ({ node }) => {
        console.log('Clicked node:', node);
        showEntityView(node);
        highlightNode(node);
    });
    
    // Click stage (background)
    renderer.on('clickStage', () => {
        closeEntityView();
        unhighlightAll();
    });
    
    // Hover node - make it and neighbors more visible
    renderer.on('enterNode', ({ node }) => {
        const nodeData = graph.getNodeAttributes(node);
        
        // Temporarily increase size on hover
        const originalSize = nodeData.size;
        graph.setNodeAttribute(node, 'size', originalSize * 1.5);
        graph.setNodeAttribute(node, 'highlighted', true);
        
        // Highlight neighbors
        const neighbors = graph.neighbors(node);
        neighbors.forEach(n => {
            const nAttrs = graph.getNodeAttributes(n);
            graph.setNodeAttribute(n, 'size', nAttrs.size * 1.2);
        });
        
        renderer.refresh();
    });
    
    renderer.on('leaveNode', ({ node }) => {
        const nodeData = graph.getNodeAttributes(node);
        
        // Restore original size
        // We need to recalculate original size based on entity type
        let originalSize = nodeData.entityType === 'Transaction' ? 3 : 6;
        if (nodeData.risk > 0) originalSize = 10;
        if (nodeData.isTarget) originalSize = 15;
        
        graph.setNodeAttribute(node, 'size', originalSize);
        graph.setNodeAttribute(node, 'highlighted', false);
        
        // Restore neighbor sizes
        const neighbors = graph.neighbors(node);
        neighbors.forEach(n => {
            const nAttrs = graph.getNodeAttributes(n);
            let nSize = nAttrs.entityType === 'Transaction' ? 3 : 6;
            if (nAttrs.risk > 0) nSize = 10;
            if (nAttrs.isTarget) nSize = 15;
            graph.setNodeAttribute(n, 'size', nSize);
        });
        
        renderer.refresh();
    });
}

function highlightNode(nodeId) {
    if (!graph) return;
    
    // Dim all nodes
    graph.forEachNode(node => {
        const attrs = graph.getNodeAttributes(node);
        graph.setNodeAttribute(node, 'color', node === nodeId ? attrs.color : `${attrs.color}40`);
    });
    
    // Highlight neighbors
    const neighbors = graph.neighbors(nodeId);
    neighbors.forEach(n => {
        const attrs = graph.getNodeAttributes(n);
        graph.setNodeAttribute(n, 'color', attrs.color);
    });
    
    renderer.refresh();
}

function unhighlightAll() {
    if (!graph || !fullGraphData) return;
    
    // Restore original colors
    graph.forEachNode(node => {
        const originalData = fullGraphData.nodes[node];
        if (originalData) {
            let color = '#0ea5e9';
            if (originalData.type === 'Transaction') color = '#6366f1';
            if (originalData.risk > 0) color = '#ef4444';
            if (node === currentTargetId) color = '#fbbf24';
            
            graph.setNodeAttribute(node, 'color', color);
        }
    });
    
    renderer.refresh();
}

// Entity intelligence panel
function showEntityView(nodeId) {
    if (!fullGraphData || !fullGraphData.nodes[nodeId]) return;
    
    const nodeData = fullGraphData.nodes[nodeId];
    const graphAttrs = graph.getNodeAttributes(nodeId);
    
    // Calculate network metrics
    const degree = graph.degree(nodeId);
    const neighbors = graph.neighbors(nodeId);
    
    let totalReceived = 0;
    let totalSent = 0;
    let incomingTx = 0;
    let outgoingTx = 0;
    
    graph.forEachEdge(nodeId, (edge, attrs, source, target) => {
        if (target === nodeId) {
            totalReceived += attrs.amount || 0;
            incomingTx++;
        } else {
            totalSent += attrs.amount || 0;
            outgoingTx++;
        }
    });
    
    const balance = totalReceived - totalSent;
    
    // Build HTML
    let html = `
        <div class="space-y-3">
            <div class="flex items-center gap-2">
                <span class="px-2 py-1 rounded text-[9px] font-bold ${nodeData.type === 'Address' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-purple-500/20 text-purple-400 border border-purple-500/30'}">${nodeData.type}</span>
                ${nodeData.risk > 0 ? '<span class="px-2 py-1 rounded text-[9px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">HIGH RISK</span>' : ''}
            </div>
            
            <div>
                <label class="text-[9px] text-slate-500 font-bold uppercase">Entity ID</label>
                <div class="text-xs font-mono text-cyan-400 break-all mt-1">${nodeData.label}</div>
            </div>
        </div>
        
        <div class="border-t border-slate-800 pt-4">
            <h4 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Network Metrics</h4>
            <div class="grid grid-cols-2 gap-3">
                <div class="bg-slate-800/30 p-3 rounded border border-slate-700/50">
                    <div class="text-[9px] text-slate-500 uppercase">Connections</div>
                    <div class="text-lg font-bold text-white">${degree}</div>
                </div>
                <div class="bg-slate-800/30 p-3 rounded border border-slate-700/50">
                    <div class="text-[9px] text-slate-500 uppercase">Neighbors</div>
                    <div class="text-lg font-bold text-white">${neighbors.length}</div>
                </div>
                <div class="bg-green-900/20 p-3 rounded border border-green-700/30">
                    <div class="text-[9px] text-green-400 uppercase">Received</div>
                    <div class="text-sm font-bold text-green-300">${totalReceived.toFixed(4)} BTC</div>
                    <div class="text-[9px] text-slate-500 mt-1">${incomingTx} tx</div>
                </div>
                <div class="bg-orange-900/20 p-3 rounded border border-orange-700/30">
                    <div class="text-[9px] text-orange-400 uppercase">Sent</div>
                    <div class="text-sm font-bold text-orange-300">${totalSent.toFixed(4)} BTC</div>
                    <div class="text-[9px] text-slate-500 mt-1">${outgoingTx} tx</div>
                </div>
            </div>
            <div class="mt-3 p-3 rounded ${balance >= 0 ? 'bg-cyan-900/20 border border-cyan-700/30' : 'bg-slate-800/30 border border-slate-700/50'}">
                <div class="text-[9px] text-slate-400 uppercase">Balance</div>
                <div class="text-lg font-bold ${balance >= 0 ? 'text-cyan-400' : 'text-slate-400'}">${balance.toFixed(4)} BTC</div>
            </div>
        </div>
    `;
    
    // Add sources if available
    if (nodeData.sources && nodeData.sources.length > 0) {
        html += `
        <div class="border-t border-slate-800 pt-4">
            <h4 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Intelligence Sources</h4>
            <div class="space-y-1">
                ${nodeData.sources.map(src => `<div class="text-[9px] font-mono text-slate-500 bg-slate-800/30 px-2 py-1 rounded">${src}</div>`).join('')}
            </div>
        </div>
        `;
    }
    
    document.getElementById('entityContent').innerHTML = html;
    document.getElementById('liveView').classList.add('hidden');
    document.getElementById('entityView').classList.remove('hidden');
}

function closeEntityView() {
    document.getElementById('entityView').classList.add('hidden');
    document.getElementById('liveView').classList.remove('hidden');
}

// Timeline filtering
function initTimeline(edges) {
    const timestampedEdges = edges.filter(e => e.timestamp > 0);
    if (timestampedEdges.length === 0) return;

    const timestamps = timestampedEdges.map(e => e.timestamp).sort((a, b) => a - b);
    const minTS = timestamps[0];
    const maxTS = timestamps[timestamps.length - 1];

    const ui = document.getElementById('timelineUI');
    const slider = document.getElementById('timeSlider');
    const display = document.getElementById('dateDisplay');

    ui.classList.remove('hidden');
    slider.min = minTS;
    slider.max = maxTS;
    slider.value = maxTS;

    const updateFilter = () => {
        const currentVal = parseInt(slider.value);
        display.innerText = new Date(currentVal * 1000).toISOString().split('T')[0];
        
        if (!graph) return;
        
        // Hide/show edges based on timestamp
        graph.forEachEdge((edge, attrs) => {
            const ts = attrs.timestamp || 0;
            if (ts > 0 && ts > currentVal) {
                graph.setEdgeAttribute(edge, 'hidden', true);
            } else {
                graph.setEdgeAttribute(edge, 'hidden', false);
            }
        });
        
        // Hide nodes with no visible edges
        graph.forEachNode((node, attrs) => {
            if (attrs.isTarget) return; // Always show target
            
            const visibleEdges = graph.edges(node).filter(e => !graph.getEdgeAttribute(e, 'hidden'));
            graph.setNodeAttribute(node, 'hidden', visibleEdges.length === 0);
        });
        
        renderer.refresh();
    };

    slider.oninput = updateFilter;
    updateFilter();
}