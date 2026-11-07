/**
 * Wallet-view graph transformations.
 *
 * This module is deliberately independent from D3 and the DOM so the
 * address-to-wallet transformation can be tested without rendering a graph.
 */

function getEndpointId(endpoint) {
    return typeof endpoint === 'object' ? endpoint?.id : endpoint;
}

/**
 * Collapse co-spending address clusters into wallet nodes.
 *
 * @param {object} graphData Address-level graph data.
 * @returns {object} Wallet-level graph data.
 */
export function buildWalletGraph(graphData) {
    if (!graphData || !graphData.nodes) return graphData;

    const nodeToWallet = {};
    for (const [id, node] of Object.entries(graphData.nodes)) {
        if (node.type !== 'Address') {
            nodeToWallet[id] = id;
        } else if (node.cluster_id && node.cluster_size > 1) {
            nodeToWallet[id] = `wallet__${node.cluster_id}`;
        } else {
            nodeToWallet[id] = id;
        }
    }

    const walletNodes = {};
    for (const [id, node] of Object.entries(graphData.nodes)) {
        const walletId = nodeToWallet[id];

        if (!walletNodes[walletId]) {
            walletNodes[walletId] = {
                id: walletId,
                label: node.label || id,
                type: node.type,
                risk: node.risk || 0,
                entity_type: node.entity_type || 'unknown',
                sources: node.sources || [],
                member_count: 1,
                members: [id],
                cluster_id: walletId,
                mixer_info: node.mixer_info || null,
                exchange_info: node.exchange_info || null,
                gambling_info: node.gambling_info || null,
                mining_info: node.mining_info || null,
            };
            continue;
        }

        const walletNode = walletNodes[walletId];
        walletNode.members.push(id);
        walletNode.member_count++;

        if ((node.risk || 0) > walletNode.risk) {
            walletNode.risk = node.risk;
        }

        if (
            node.entity_type &&
            node.entity_type !== 'unknown' &&
            walletNode.entity_type === 'unknown'
        ) {
            walletNode.entity_type = node.entity_type;
        }

        if (
            node.label &&
            node.label !== id &&
            walletNode.label === walletNode.members[0]
        ) {
            walletNode.label = node.label;
        }

        walletNode.mixer_info ||= node.mixer_info || null;
        walletNode.exchange_info ||= node.exchange_info || null;
        walletNode.gambling_info ||= node.gambling_info || null;
        walletNode.mining_info ||= node.mining_info || null;
    }

    for (const walletNode of Object.values(walletNodes)) {
        if (walletNode.member_count <= 1) continue;

        const namedNode = walletNode.members
            .map(memberId => graphData.nodes[memberId])
            .find(node => node?.label && node.label !== node.id && node.label.length < 50);

        walletNode.label = namedNode
            ? `${namedNode.label} (+${walletNode.member_count - 1})`
            : `Wallet · ${walletNode.member_count} addrs`;
    }

    const edgeMap = {};
    for (const edge of graphData.edges || []) {
        const sourceId = getEndpointId(edge.source);
        const targetId = getEndpointId(edge.target);
        const source = nodeToWallet[sourceId] || sourceId;
        const target = nodeToWallet[targetId] || targetId;

        if (source === target) continue;

        const key = `${source}|${target}`;
        if (!edgeMap[key]) {
            edgeMap[key] = {
                source,
                target,
                amount: edge.amount || 0,
                timestamp: edge.timestamp || 0,
                sources: edge.sources || [],
            };
            continue;
        }

        edgeMap[key].amount += edge.amount || 0;
        if ((edge.timestamp || 0) > edgeMap[key].timestamp) {
            edgeMap[key].timestamp = edge.timestamp;
        }
    }

    return {
        nodes: walletNodes,
        edges: Object.values(edgeMap),
        summary: graphData.summary,
    };
}

export function getWalletId(nodeId, graphData) {
    if (!graphData || !nodeId) return nodeId;

    const node = graphData.nodes[nodeId];
    return node?.cluster_id && node.cluster_size > 1
        ? `wallet__${node.cluster_id}`
        : nodeId;
}
