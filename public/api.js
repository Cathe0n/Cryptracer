import { MEMPOOL_API } from './state.js';

async function mempoolFetch(path) {
    const apis = [MEMPOOL_API, "https://mempool.guide/api", "https://blockstream.info/api"];
    let lastErr;

    for (const api of apis) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const res = await fetch(`${api}${path}`, { signal: controller.signal });
            if (!res.ok) {
                throw { status: res.status, message: `HTTP ${res.status}: ${res.statusText || 'Error'}` };
            }
            return await res.json();
        } catch (err) {
            lastErr = err;
            console.warn(`⚠️ [API Fallback] ${api} failed, trying next...`, err);
            continue; // Try next API in the chain
        } finally {
            clearTimeout(timeout);
        }
    }
    throw lastErr || new Error("All blockchain data providers failed");
}

export const mempoolGetAddress     = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}`);
export const mempoolGetUTXOs       = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}/utxo`);
export const mempoolGetTxs         = addr  => mempoolFetch(`/address/${encodeURIComponent(addr)}/txs`);
export const mempoolGetTx          = txid  => mempoolFetch(`/tx/${encodeURIComponent(txid)}`);
export const mempoolGetFees        = ()    => mempoolFetch('/v1/fees/recommended');
export const mempoolGetTxProjection = txid => mempoolFetch(`/v1/tx/${encodeURIComponent(txid)}/projection`);
export const mempoolGetBlockHeight = ()    => mempoolFetch('/blocks/tip/height');
export const mempoolGetMiningPools = (period = '1w') => mempoolFetch(`/v1/mining/pools/${period}`);
export const mempoolGetMiningPool  = (slug) => mempoolFetch(`/v1/mining/pool/${encodeURIComponent(slug)}`);

let feeRefreshInterval = null;

export async function initNetworkStats() {
    const el = document.getElementById('networkStats');
    if (!el) return;
    async function refresh() {
        try {
            const [fees, height] = await Promise.all([mempoolGetFees(), mempoolGetBlockHeight()]);
            el.innerHTML = `
                <div class="flex items-center gap-4 text-[10px] font-mono">
                    <span class="text-slate-400 uppercase tracking-wider">Block</span>
                    <span class="text-cyan-400 font-bold">#${height.toLocaleString()}</span>
                    <span class="text-slate-600">|</span>
                    <span class="text-slate-400 uppercase">Fees (sat/vB)</span>
                    <span title="~10 min" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span>
                        <span class="text-green-400 font-bold">${fees.fastestFee}</span>
                    </span>
                    <span title="~30 min" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-yellow-400"></span>
                        <span class="text-yellow-400 font-bold">${fees.halfHourFee}</span>
                    </span>
                    <span title="~1 hr" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-orange-400"></span>
                        <span class="text-orange-400 font-bold">${fees.hourFee}</span>
                    </span>
                    <span title="Economy" class="flex items-center gap-1">
                        <span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span>
                        <span class="text-slate-400 font-bold">${fees.economyFee}</span>
                    </span>
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