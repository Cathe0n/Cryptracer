export function satsToBTC(sats) {
    return (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

export function setBusy(isBusy, title = 'RECONSTRUCTING TIMELINE...', details = '') {
    const loader = document.getElementById('loader');
    if (!loader) return;
    loader.style.display = isBusy ? 'flex' : 'none';
    if (isBusy) {
        document.getElementById('loaderTitle').textContent = title;
        document.getElementById('loaderDetails').textContent = details;
    }
}

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - 'info', 'success', 'warning', 'error', 'mixer'
 * @param {number} duration - Duration in ms (0 = persistent)
 */
export function showToast(message, type = 'info', duration = 5000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 10px;
            max-width: 400px;
        `;
        document.body.appendChild(container);
    }

    const toastEl = document.createElement('div');
    toastEl.className = 'toast-notification';
    
    const typeStyles = {
        info: {
            bg: '#0f172a',
            border: '#06b6d4',
            icon: '🔍',
            color: '#06b6d4'
        },
        success: {
            bg: '#0f172a',
            border: '#10b981',
            icon: '✓',
            color: '#10b981'
        },
        warning: {
            bg: '#0f172a',
            border: '#f59e0b',
            icon: '⚠️',
            color: '#f59e0b'
        },
        error: {
            bg: '#0f172a',
            border: '#ef4444',
            icon: '✕',
            color: '#ef4444'
        },
        mixer: {
            bg: '#1e1b4b',
            border: '#7c3aed',
            icon: '🌀',
            color: '#a78bfa',
            textColor: '#c4b5fd'
        }
    };

    const style = typeStyles[type] || typeStyles.info;
    
    toastEl.style.cssText = `
        background: ${style.bg};
        border: 1px solid ${style.border};
        border-radius: 8px;
        padding: 12px 16px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 13px;
        color: ${style.textColor || style.color};
        font-family: 'JetBrains Mono', monospace;
        animation: slideIn 0.3s ease-out;
        max-height: 100px;
        overflow: hidden;
    `;

    toastEl.innerHTML = `
        <span style="font-size: 16px; flex-shrink: 0;">${style.icon}</span>
        <span style="flex: 1; word-wrap: break-word;">${message}</span>
        <button onclick="this.parentElement.remove()" style="
            background: none;
            border: none;
            color: ${style.color};
            cursor: pointer;
            font-size: 16px;
            padding: 0;
            flex-shrink: 0;
        ">×</button>
    `;

    container.appendChild(toastEl);

    if (duration > 0) {
        setTimeout(() => {
            toastEl.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => toastEl.remove(), 300);
        }, duration);
    }

    return toastEl;
}

// Add animations if not already present
if (!document.getElementById('toastAnimations')) {
    const style = document.createElement('style');
    style.id = 'toastAnimations';
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(420px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @keyframes slideOut {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(420px);
                opacity: 0;
            }
        }
    `;
    document.head.appendChild(style);
}