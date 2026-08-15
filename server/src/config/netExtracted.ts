// How often accumulated net USDD flow per coin (buys minus sells, see
// CoinState.pendingNetFlowUsdd) gets settled into netExtracted (see
// engine/gravity.ts) — long enough that ordinary two-way noise trading within
// a period nets out close to zero, short enough that a sustained one-way
// extraction strategy gets tracked well before a macro cycle (hours) ends.
export const NET_EXTRACTED_CHECK_INTERVAL_MS = 5 * 60_000;
