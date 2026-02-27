export const MEMPOOL_API = 'https://mempool.space/api';

export const state = {
    simulation: null,
    svg: null,
    zoom: null,
    container: null,
    g: null,
    link: null,
    node: null,
    label: null,
    currentTargetId: null,
    fullGraphData: null,
    labelsVisible: true,
    isFrozen: false,
    calendarTxDates: {},
    calendarViewDate: new Date()
};