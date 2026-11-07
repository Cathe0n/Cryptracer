import {
    getNodeCustomColor,
    getNodeCustomEdgeColor,
} from './annotations.js';

export const GRAPH_COLORS = Object.freeze({
    default: '#64748b',
    target: '#fbbf24',
    address: '#0ea5e9',
    transaction: '#6366f1',
    mining: '#facc15',
    mixer: '#7c3aed',
    exchange: '#0284c7',
    darknet: '#be123c',
    highRisk: '#ef4444',
    mediumRisk: '#f97316',
    lowRisk: '#f59e0b',
    minimalRisk: '#06b6d4',
    clustered: '#10b981',
});

const MIXER_COLORS = Object.freeze({
    'Wasabi Wallet 1.x (CoinJoin)': '#7c3aed',
    'Wasabi Wallet 2.0 (WabiSabi)': '#6d28d9',
    JoinMarket: '#0891b2',
    'Whirlpool (Samourai)': '#0e7490',
    'Centralized Mixer': '#b45309',
    'Generic CoinJoin': '#4f46e5',
});

export function desaturateColor(hexColor, desatPercent = 30) {
    if (!hexColor || !hexColor.startsWith('#')) return hexColor;

    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    let h;
    let s;
    const l = (max + min) / 2;

    if (max === min) {
        h = s = 0;
    } else {
        const delta = max - min;
        s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        switch (max) {
            case rn: h = (gn - bn) / delta + (gn < bn ? 6 : 0); break;
            case gn: h = (bn - rn) / delta + 2; break;
            default: h = (rn - gn) / delta + 4; break;
        }
        h /= 6;
    }

    s = Math.max(0, s * (1 - desatPercent / 100));

    const hueToRgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const toHex = value => Math.round(value * 255).toString(16).padStart(2, '0');

    return `#${toHex(hueToRgb(p, q, h + 1 / 3))}${toHex(hueToRgb(p, q, h))}${toHex(hueToRgb(p, q, h - 1 / 3))}`;
}

export function isNodeTainted(nodeData) {
    if (!nodeData?.risk) return false;

    const riskData = nodeData.risk_data;
    return !(riskData?.report_count > 0 || riskData?.error);
}

function getRiskColor(risk, clustered) {
    if (risk >= 70) return GRAPH_COLORS.highRisk;
    if (risk >= 40) return GRAPH_COLORS.mediumRisk;
    if (risk >= 10) return GRAPH_COLORS.lowRisk;
    return clustered ? GRAPH_COLORS.clustered : GRAPH_COLORS.minimalRisk;
}

export function getNodeBaseColor(node, detectMiningPool) {
    if (!node) return GRAPH_COLORS.default;

    if (node.isTarget) return GRAPH_COLORS.target;
    if (node.mixer_info?.is_mixer) {
        return MIXER_COLORS[node.mixer_info.raw?.mixer_type] || GRAPH_COLORS.mixer;
    }
    if (node.entity_type === 'mixer') return GRAPH_COLORS.mixer;
    if (node.entity_type === 'exchange') return GRAPH_COLORS.exchange;
    if (node.entity_type === 'darknet') return GRAPH_COLORS.darknet;
    if (node.entity_type === 'mining' || detectMiningPool(node)) return GRAPH_COLORS.mining;
    if (node.risk) return getRiskColor(node.risk, node.member_count > 1);
    if (node.type === 'Transaction') return GRAPH_COLORS.transaction;

    return GRAPH_COLORS.address;
}

export function getEdgeColor(edge, graphData, detectMiningPool) {
    const targetId = typeof edge.target === 'object' ? edge.target?.id : edge.target;
    const targetNode = graphData?.nodes?.[targetId];
    const customEdgeColor = getNodeCustomEdgeColor(targetId);

    if (customEdgeColor) return customEdgeColor;

    const baseColor = getNodeCustomColor(targetNode?.id)
        || getNodeBaseColor(targetNode, detectMiningPool);

    return targetNode && isNodeTainted(targetNode)
        ? desaturateColor(baseColor, 30)
        : baseColor;
}
