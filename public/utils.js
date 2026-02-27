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