/**
 * Node Annotations Manager
 * Handles storing and retrieving custom notes and colors for nodes
 */

const STORAGE_KEY = 'cryptracer_node_annotations';

/**
 * Get all annotations
 * @returns {Object} Map of nodeId -> { name: string, notes: string, color: string }
 */
export function getAllAnnotations() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        return data ? JSON.parse(data) : {};
    } catch (e) {
        console.error('Failed to load annotations:', e);
        return {};
    }
}

/**
 * Get annotation for a specific node
 * @param {string} nodeId - The node ID
 * @returns {Object|null} { name: string, notes: string, color: string } or null if not exists
 */
export function getAnnotation(nodeId) {
    const all = getAllAnnotations();
    return all[nodeId] || null;
}

/**
 * Set annotation for a node
 * @param {string} nodeId - The node ID
 * @param {string} name - Custom display name
 * @param {string} notes - User notes
 * @param {string} color - Hex color code
 */
export function setAnnotation(nodeId, name, notes, color) {
    try {
        const all = getAllAnnotations();
        all[nodeId] = { name: name || '', notes: notes || '', color: color || null };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
        console.error('Failed to save annotation:', e);
    }
}

/**
 * Get custom name for a node if it exists
 * @param {string} nodeId - The node ID
 * @returns {string|null} Custom name or null
 */
export function getNodeCustomName(nodeId) {
    const annot = getAnnotation(nodeId);
    return annot ? annot.name : null;
}

/**
 * Get custom color for a node if it exists, otherwise return null
 * @param {string} nodeId - The node ID
 * @returns {string|null} Hex color code or null
 */
export function getNodeCustomColor(nodeId) {
    const annot = getAnnotation(nodeId);
    return annot ? annot.color : null;
}

/**
 * Predefined color palette for easy selection
 */
export const COLOR_PALETTE = [
    { name: 'Red', hex: '#ef4444' },
    { name: 'Orange', hex: '#f97316' },
    { name: 'Amber', hex: '#f59e0b' },
    { name: 'Yellow', hex: '#eab308' },
    { name: 'Lime', hex: '#84cc16' },
    { name: 'Green', hex: '#22c55e' },
    { name: 'Emerald', hex: '#10b981' },
    { name: 'Teal', hex: '#14b8a6' },
    { name: 'Cyan', hex: '#06b6d4' },
    { name: 'Sky', hex: '#0ea5e9' },
    { name: 'Blue', hex: '#3b82f6' },
    { name: 'Indigo', hex: '#6366f1' },
    { name: 'Violet', hex: '#a855f7' },
    { name: 'Purple', hex: '#d946ef' },
    { name: 'Pink', hex: '#ec4899' },
    { name: 'Rose', hex: '#f43f5e' },
    { name: 'Gray', hex: '#6b7280' },
    { name: 'Slate', hex: '#64748b' }
];
