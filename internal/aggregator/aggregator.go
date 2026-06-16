package aggregator

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"money-tracer/db"
	"money-tracer/internal/bitquery"
	"money-tracer/internal/blockstream"
	"money-tracer/internal/intel"
	"money-tracer/internal/mempool"
)

const (
	mempoolGuideBase = "https://mempool.guide/api"
)

var entityTypeMap map[string]EntityType

func init() {
	entityTypeMap = make(map[string]EntityType)
	for _, entry := range knownLabels {
		entityTypeMap[entry.needle] = entry.entity
	}
}

var (
	whirlpoolPools     = map[int64]bool{100000: true, 1000000: true, 5000000: true, 50000000: true}
	mempoolGuideClient = &http.Client{Timeout: 10 * time.Second}
)

// ─────────────────────────────────────────────────────────────
// GRAPH TYPES
// ─────────────────────────────────────────────────────────────

type ProvenanceNode struct {
	ID         string                    `json:"id"`
	Label      string                    `json:"label"`
	Type       string                    `json:"type"`
	Sources    []string                  `json:"sources"`
	Risk       int                       `json:"risk"`
	RiskData   *intel.ChainAbuseRiskData `json:"risk_data,omitempty"`
	EntityType EntityType                `json:"entity_type"`
	MixerInfo  *DetectionResult          `json:"mixer_info,omitempty"`
	ExchInfo   *ExchangeResult           `json:"exchange_info,omitempty"`
	HopDepth   int                       `json:"hop_depth"`

	// ── Clustering (co-spend heuristic) ──────────────────────
	// ClusterID is a stable identifier for the wallet cluster this address
	// belongs to. Addresses sharing a ClusterID are co-controlled.
	// Empty for singleton addresses and for Transaction nodes.
	ClusterID string `json:"cluster_id,omitempty"`
	// ClusterSize is the number of on-chain addresses in this cluster.
	// 1 = singleton (no co-spend evidence). >1 = shared wallet.
	ClusterSize int `json:"cluster_size,omitempty"`

	// ── Extended entity intelligence ──────────────────────────
	GamblingInfo *GamblingResult `json:"gambling_info,omitempty"`
	MiningInfo   *MiningResult   `json:"mining_info,omitempty"`

	// ── Mining transaction detection ─────────────────────────
	IsCoinbase     bool              `json:"is_coinbase,omitempty"`      // true if transaction is a coinbase (block reward)
	InputCount     int               `json:"input_count,omitempty"`      // number of transaction inputs (0 for coinbase)
	MiningPoolInfo *mempool.PoolInfo `json:"mining_pool_info,omitempty"` // pool that mined the block (set for coinbase & confirmed txs)
}

type ProvenanceEdge struct {
	Source    string   `json:"source"`
	Target    string   `json:"target"`
	Amount    float64  `json:"amount"`
	Sources   []string `json:"sources"`
	Timestamp int64    `json:"timestamp,omitempty"`
	Taint     float64  `json:"taint,omitempty"` // inherited risk 0–1
}

type UnifiedGraph struct {
	Nodes   map[string]ProvenanceNode `json:"nodes"`
	Edges   []ProvenanceEdge          `json:"edges"`
	Summary GraphSummary              `json:"summary"`
}

type GraphSummary struct {
	TotalNodes    int `json:"total_nodes"`
	TotalEdges    int `json:"total_edges"`
	MaxRisk       int `json:"max_risk"`
	MixerCount    int `json:"mixer_count"`
	ExchangeCount int `json:"exchange_count"`
	HighRiskCount int `json:"high_risk_count"`
	TaintedCount  int `json:"tainted_count"`
	ClusterCount  int `json:"cluster_count"` // multi-address wallet clusters
	GamblingCount int `json:"gambling_count"`
	MiningCount   int `json:"mining_count"`
}

// ─────────────────────────────────────────────────────────────
// ENTITY CLASSIFICATION
// ─────────────────────────────────────────────────────────────

type EntityType string

const (
	EntityUnknown  EntityType = "unknown"
	EntityPersonal EntityType = "personal"
	EntityExchange EntityType = "exchange"
	EntityMixer    EntityType = "mixer"
	EntityDarknet  EntityType = "darknet"
	EntityGambling EntityType = "gambling"
	EntityMining   EntityType = "mining"
	EntityDefi     EntityType = "defi"
)

// ─────────────────────────────────────────────────────────────
// MIXER DETECTION
// ─────────────────────────────────────────────────────────────

type MixerType string

const (
	MixerUnknown     MixerType = "Unknown"
	MixerWasabi      MixerType = "Wasabi Wallet 1.x (CoinJoin)" // Wasabi 1.0/1.1 — ZeroLink/Chaumian CoinJoin, ~0.1 BTC denomination
	MixerWasabi2     MixerType = "Wasabi Wallet 2.0 (WabiSabi)" // Wasabi 2.0 — WabiSabi protocol, variable denominations, 50+ inputs
	MixerJoinMarket  MixerType = "JoinMarket"                   // Peer-coordinated CoinJoin, equal denominations, n>=3
	MixerWhirlpool   MixerType = "Whirlpool (Samourai)"         // Exactly 5 inputs / 5 outputs, fixed pool denomination
	MixerCentralized MixerType = "Centralized Mixer"            // 1-in 2-out, P2SH, >5x output ratio, >1 BTC (Shojaeinasab et al.)
	MixerCoinjoin    MixerType = "Generic CoinJoin"
)

// TransactionIO is a full representation of a transaction used for heuristics.
type TransactionIO struct {
	Txid      string
	Inputs    []TxInput
	Outputs   []TxOutput
	FeeRate   float64 // sat/vByte, 0 if unknown
	Timestamp int64
	Version   int
	LockTime  uint32
	// HasCoinbase is true if any input is a coinbase (no prevout).
	// Required for mining pool detection.
	HasCoinbase bool
}

type TxInput struct {
	Address  string
	Value    int64 // Satoshis
	Sequence uint32
}

type TxOutput struct {
	Address    string
	Value      int64  // Satoshis
	ScriptType string // p2pkh, p2wpkh, p2sh, p2wsh, p2tr, op_return
}

// MixerResult holds the full analysis result for a transaction.
type MixerResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	MixerType MixerType          `json:"mixer_type"`
	Breakdown map[string]float64 `json:"breakdown"`
	Notes     []string           `json:"notes"`
}

// DetectionResult is a small wrapper that exposes mixer detection
// with a human-friendly confidence score and explanation.
type DetectionResult struct {
	IsMixer     bool        `json:"is_mixer"`
	Confidence  int         `json:"confidence"` // 0-100
	Explanation string      `json:"explanation"`
	Raw         MixerResult `json:"raw,omitempty"`
}

const defaultMixerThreshold = 0.70

// ─────────────────────────────────────────────────────────────
// FALLBACK DATA FETCHING HELPERS
// ─────────────────────────────────────────────────────────────

// convertBlockstreamTx converts a blockstream transaction to mempool format
func convertBlockstreamTx(bstx *blockstream.Tx) *mempool.Tx {
	if bstx == nil {
		return nil
	}

	// Convert Vins
	vins := make([]mempool.Vin, len(bstx.Vin))
	for i, v := range bstx.Vin {
		var prevout *mempool.Vout
		if v.Prevout != nil {
			prevout = &mempool.Vout{
				Value:               v.Prevout.Value,
				ScriptPubKeyAddress: v.Prevout.ScriptPubKeyAddress,
				ScriptPubKeyType:    v.Prevout.ScriptPubKeyType,
			}
		}
		vins[i] = mempool.Vin{
			Txid:     v.Txid,
			Vout:     v.Vout,
			Sequence: v.Sequence,
			Prevout:  prevout,
		}
	}

	// Convert Vouts
	vouts := make([]mempool.Vout, len(bstx.Vout))
	for i, v := range bstx.Vout {
		vouts[i] = mempool.Vout{
			Value:               v.Value,
			ScriptPubKeyAddress: v.ScriptPubKeyAddress,
			ScriptPubKeyType:    v.ScriptPubKeyType,
		}
	}

	return &mempool.Tx{
		Txid: bstx.Txid,
		Vin:  vins,
		Vout: vouts,
		Status: mempool.Status{
			Confirmed:   bstx.Status.Confirmed,
			BlockHeight: bstx.Status.BlockHeight,
			BlockTime:   bstx.Status.BlockTime,
		},
		Fee:    bstx.Fee,
		Weight: bstx.Weight,
		Size:   bstx.Size,
	}
}

// convertBlockstreamTxs converts a slice of blockstream transactions to mempool format
func convertBlockstreamTxs(bstxs []blockstream.Tx) []mempool.Tx {
	var result []mempool.Tx
	for _, tx := range bstxs {
		if converted := convertBlockstreamTx(&tx); converted != nil {
			result = append(result, *converted)
		}
	}
	return result
}

// convertBlockstreamAddressInfo converts blockstream address info to mempool format
func convertBlockstreamAddressInfo(bsinfo *blockstream.AddressInfo) *mempool.AddressInfo {
	if bsinfo == nil {
		return nil
	}

	return &mempool.AddressInfo{
		Address: bsinfo.Address,
		ChainStats: mempool.AddressStats{
			FundedTxoSum: bsinfo.ChainStats.FundedTxoSum,
			SpentTxoSum:  bsinfo.ChainStats.SpentTxoSum,
			TxCount:      bsinfo.ChainStats.TxCount,
		},
		MempoolStats: mempool.AddressStats{
			FundedTxoSum: bsinfo.MempoolStats.FundedTxoSum,
			SpentTxoSum:  bsinfo.MempoolStats.SpentTxoSum,
			TxCount:      bsinfo.MempoolStats.TxCount,
		},
	}
}

// mempoolGuideFetch is a helper for hitting the mempool.guide fallback
func mempoolGuideFetch(ctx context.Context, path string, target interface{}) error {
	req, err := http.NewRequestWithContext(ctx, "GET", mempoolGuideBase+path, nil)
	if err != nil { // No need to wrap here, NewRequestWithContext returns a fresh error
		return err
	}
	resp, err := mempoolGuideClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("mempool.guide HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

// GetAddressTxsWithFallback attempts to fetch address transactions from mempool.space first,
// falling back to blockstream.info if mempool fails or times out.
func GetAddressTxsWithFallback(ctx context.Context, address string) ([]mempool.Tx, error) {
	// Try mempool first
	txs, err := mempool.GetAddressTxs(address)
	if err == nil && txs != nil {
		log.Printf("✅ [MEMPOOL] Successfully fetched transactions for %s", address)
		return txs, nil
	}

	// Log why mempool failed
	log.Printf("⚠️  [MEMPOOL] Failed to fetch txs for %s: %v — attempting fallback to mempool.guide", address, err)

	// Fallback 1: Mempool.guide
	var guideTxs []mempool.Tx
	if err := mempoolGuideFetch(ctx, "/address/"+address+"/txs", &guideTxs); err == nil {
		log.Printf("✅ [MEMPOOL.GUIDE] Fallback succeeded for %s", address)
		return guideTxs, nil
	}
	log.Printf("⚠️  [MEMPOOL.GUIDE] Failed to fetch txs for %s — attempting fallback to blockstream", address)

	// Fallback to blockstream
	bsTxs, bsErr := blockstream.GetAddressTxs(address)
	if bsErr != nil {
		log.Printf("⚠️  [BLOCKSTREAM] Also failed to fetch txs for %s: %v", address, bsErr)
		return nil, fmt.Errorf("both mempool and blockstream failed: mempool(%v), blockstream(%w)", err, bsErr)
	}

	log.Printf("✅ [BLOCKSTREAM] Fallback succeeded — fetched %d transactions for %s", len(bsTxs), address)
	return convertBlockstreamTxs(bsTxs), nil
}

// GetTxWithFallback attempts to fetch a transaction from mempool.space first,
// falling back to blockstream.info if mempool fails or times out.
func GetTxWithFallback(ctx context.Context, txid string) (*mempool.Tx, error) {
	// Try mempool first
	tx, err := mempool.GetTx(txid)
	if err == nil && tx != nil {
		log.Printf("✅ [MEMPOOL] Successfully fetched tx %s", txid[:16])
		return tx, nil
	}

	// Log why mempool failed
	log.Printf("⚠️  [MEMPOOL] Failed to fetch tx %s: %v — attempting fallback to mempool.guide", txid, err)

	// Fallback 1: Mempool.guide
	var guideTx mempool.Tx
	if err := mempoolGuideFetch(ctx, "/tx/"+txid, &guideTx); err == nil {
		log.Printf("✅ [MEMPOOL.GUIDE] Fallback succeeded for tx %s", txid[:16])
		return &guideTx, nil
	}
	log.Printf("⚠️  [MEMPOOL.GUIDE] Failed to fetch tx %s — attempting fallback to blockstream", txid)

	// Fallback to blockstream
	bsTx, bsErr := blockstream.GetTx(txid)
	if bsErr != nil {
		log.Printf("⚠️  [BLOCKSTREAM] Also failed to fetch tx %s: %v", txid, bsErr)
		return nil, fmt.Errorf("both mempool and blockstream failed: mempool(%v), blockstream(%w)", err, bsErr)
	}

	log.Printf("✅ [BLOCKSTREAM] Fallback succeeded — fetched tx %s", txid[:16])
	return convertBlockstreamTx(bsTx), nil
}

// GetAddressInfoWithFallback attempts to fetch address info from mempool.space first,
// falling back to blockstream.info if mempool fails or times out.
func GetAddressInfoWithFallback(ctx context.Context, address string) (*mempool.AddressInfo, error) {
	// Try mempool first
	info, err := mempool.GetAddressInfo(address)
	if err == nil && info != nil {
		log.Printf("✅ [MEMPOOL] Successfully fetched address info for %s", address)
		return info, nil
	}

	// Log why mempool failed
	log.Printf("⚠️  [MEMPOOL] Failed to fetch address info for %s: %v — attempting fallback to mempool.guide", address, err)

	// Fallback 1: Mempool.guide
	var guideInfo mempool.AddressInfo
	if err := mempoolGuideFetch(ctx, "/address/"+address, &guideInfo); err == nil {
		log.Printf("✅ [MEMPOOL.GUIDE] Fallback succeeded for %s", address)
		return &guideInfo, nil
	}
	log.Printf("⚠️  [MEMPOOL.GUIDE] Failed to fetch address info for %s — attempting fallback to blockstream", address)

	// Fallback to blockstream
	bsInfo, bsErr := blockstream.GetAddressInfo(address)
	if bsErr != nil {
		log.Printf("⚠️  [BLOCKSTREAM] Also failed to fetch address info for %s: %v", address, bsErr)
		return nil, fmt.Errorf("both mempool and blockstream failed: mempool(%v), blockstream(%w)", err, bsErr)
	}

	log.Printf("✅ [BLOCKSTREAM] Fallback succeeded — fetched address info for %s", address)
	return convertBlockstreamAddressInfo(bsInfo), nil
}

// IsCoinMixer performs multi-rule heuristic analysis to detect mixing transactions.
//
// Detection is structured in two phases:
//
// Phase 1 — Protocol-specific exact pattern matching (standalone detectors):
//   - Whirlpool (Samourai): Schnoering & Vazirgiannis (2023) — exactly 5 inputs,
//     5 outputs, all distinct scripts, denomination from known pool set.
//   - Modern Centralized Mixer: Shojaeinasab et al. (2023) — 1 input, 2 outputs,
//     P2SH input, one output >=5x the other, input value >1 BTC.
//
// Phase 2 — Weighted heuristic scoring for CoinJoin variants (JoinMarket, Wasabi 1.x,
//
//	Wasabi 2.0, Generic CoinJoin). A transaction is flagged if the cumulative
//	score meets or exceeds the threshold (default 0.70).
func IsCoinMixer(tx TransactionIO, threshold float64) MixerResult {
	if threshold <= 0 {
		threshold = defaultMixerThreshold
	}

	result := MixerResult{
		Breakdown: make(map[string]float64),
		Notes:     []string{},
	}

	inputs := tx.Inputs
	outputs := tx.Outputs
	inputCount := len(inputs)
	outputCount := len(outputs)

	if outputCount == 0 {
		result.Notes = append(result.Notes, "No outputs — cannot analyse")
		return result
	}

	// Pre-compute clean outputs (exclude dust and OP_RETURN)
	// Wasabi 2.0 minimum output value is 5000 sat = 0.00005 BTC (Schnoering §2.4)
	const dustThreshold int64 = 5000
	var cleanValues []int64
	for _, o := range outputs {
		if o.Value >= dustThreshold && o.ScriptType != "op_return" {
			cleanValues = append(cleanValues, o.Value)
		}
	}
	cleanCount := len(cleanValues)
	if cleanCount == 0 {
		result.Notes = append(result.Notes, "Only dust/OP_RETURN outputs")
		return result
	}

	// Find most-common output denomination
	counts := make(map[int64]int)
	for _, r := range cleanValues {
		counts[r]++
	}
	var mostCommon int64
	var maxCount int
	for val, c := range counts {
		if c > maxCount || (c == maxCount && val > mostCommon) {
			maxCount = c
			mostCommon = val
		}
	}
	equalRatio := float64(maxCount) / float64(cleanCount)

	// Check distinct output scripts
	// All CoinJoin protocols require distinct output scripts (Schnoering eq. 10, 15, 33, 43)
	outputScripts := make(map[string]int)
	for _, o := range outputs {
		if o.Address != "" {
			outputScripts[o.Address]++
		}
	}
	distinctOutputScripts := len(outputScripts) == outputCount

	// Input address map for address-reuse check
	inputAddrs := make(map[string]struct{})
	for _, inp := range inputs {
		if inp.Address != "" {
			inputAddrs[inp.Address] = struct{}{}
		}
	}

	// =========================================================================
	// PHASE 1: Protocol-specific exact pattern matching
	// =========================================================================

	// WHIRLPOOL DETECTION (Schnoering & Vazirgiannis, 2023, Section 2.5)
	// A Whirlpool CoinJoin has EXACTLY 5 inputs from distinct scripts and
	// EXACTLY 5 outputs with the pool denomination. Four pools exist:
	//   0.001 BTC, 0.01 BTC, 0.05 BTC, 0.5 BTC (defined in whirlpoolPools)
	// Condition: |inputs| = n_scripts,in = n_scripts,out = |outputs| = 5
	if inputCount == 5 && outputCount == 5 && distinctOutputScripts {
		poolDenomCount := 0
		for _, v := range cleanValues {
			if whirlpoolPools[v] {
				poolDenomCount++
			}
		}
		if poolDenomCount == 5 {
			result.Breakdown["whirlpool_exact"] = 0.92
			result.Notes = append(result.Notes, fmt.Sprintf(
				"Whirlpool: 5x5 exact structure, pool denomination %.4f BTC", float64(mostCommon)/1e8))
			result.Score = 0.92
			result.Flagged = true
			result.MixerType = MixerWhirlpool
			return result
		}
	}

	// MODERN CENTRALIZED MIXER (Shojaeinasab et al., 2023, Section 3.3)
	// Withdrawal transactions from MixTum, Blender, and CryptoMixer follow a
	// strict 1-input 2-output (1:2) structure:
	//   - Exactly 1 real input
	//   - Exactly 2 spendable outputs
	//   - Input address is P2SH
	//   - At least one output is P2SH
	//   - P2SH output >= 5x the non-P2SH output (97% of observed cases)
	//   - Input value > 1 BTC
	// The large P2SH output is the mixer's internal change address;
	// the small non-P2SH output is the recipient's cleaned funds.
	spendableOutputCount := 0
	for _, o := range outputs {
		if o.ScriptType != "op_return" {
			spendableOutputCount++
		}
	}
	var inputTotalValue int64
	for _, inp := range inputs {
		inputTotalValue += inp.Value
	}

	if inputCount == 1 && spendableOutputCount == 2 && inputTotalValue > 100000000 {
		var p2shVals []int64
		var nonP2shVals []int64
		for _, o := range outputs {
			if o.ScriptType == "op_return" {
				continue
			}
			if o.ScriptType == "p2sh" {
				p2shVals = append(p2shVals, o.Value)
			} else {
				nonP2shVals = append(nonP2shVals, o.Value)
			}
		}
		// Case 1: One P2SH (mixer change), one non-P2SH (recipient)
		if len(p2shVals) >= 1 && len(nonP2shVals) >= 1 {
			largeVal := p2shVals[0]
			smallVal := nonP2shVals[0]
			if largeVal > 0 && smallVal > 0 && float64(largeVal)/float64(smallVal) >= 5.0 {
				result.Breakdown["centralized_mixer"] = 0.88
				result.Notes = append(result.Notes, fmt.Sprintf(
					"Centralized mixer withdrawal: 1-in 2-out, P2SH %.6f BTC (%.1fx recipient %.6f BTC), input %.4f BTC",
					float64(largeVal)/1e8, float64(largeVal)/float64(smallVal), float64(smallVal)/1e8, float64(inputTotalValue)/1e8))
				result.Score = 0.88
				result.Flagged = true
				result.MixerType = MixerCentralized
				return result
			}
		}
		// Case 2: Both P2SH — use amount as criterion (Shojaeinasab Section 3.3.2)
		if len(p2shVals) == 2 {
			large := max(p2shVals[0], p2shVals[1])
			small := min(p2shVals[0], p2shVals[1])
			if small > 0 && float64(large)/float64(small) >= 5.0 {
				result.Breakdown["centralized_mixer"] = 0.82
				result.Notes = append(result.Notes, fmt.Sprintf(
					"Centralized mixer withdrawal (both P2SH): 1-in 2-out, %.1fx ratio, input %.4f BTC",
					float64(large)/float64(small), float64(inputTotalValue)/1e8))
				result.Score = 0.82
				result.Flagged = true
				result.MixerType = MixerCentralized
				return result
			}
		}
	}

	// =========================================================================
	// PHASE 2: Weighted heuristic scoring for CoinJoin variants
	// =========================================================================

	// RULE 1: Equal Output Amounts (weight 0.38)
	// The defining characteristic of CoinJoin: all participants receive equal
	// denominations making it impossible to link inputs to outputs by value.
	// n = max_{v'} sum(1_{v=v'}) for JoinMarket/Wasabi (Schnoering eq. 7, 16).
	if equalRatio > 0.5 {
		result.Breakdown["equal_outputs"] = 0.38 * equalRatio
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%.1f%% of outputs share denomination %.8f BTC", equalRatio*100, float64(mostCommon)/1e8))
	}

	// RULE 2: Participant Scale (weight 0.15)
	// All CoinJoin protocols require multiple independent participants.
	// Minimum: JoinMarket n>=3 (eq. 9), Wasabi typically n>=10.
	if inputCount >= 5 && outputCount >= 5 {
		ps := math.Min(float64(inputCount+outputCount)/50.0, 1.0)
		result.Breakdown["participant_count"] = 0.15 * ps
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%d inputs / %d outputs (CoinJoin scale)", inputCount, outputCount))
	}

	// RULE 3: Input/Output Count Symmetry (weight 0.10)
	// CoinJoin gives each participant one input and one post-mix output,
	// producing roughly balanced input/output counts (Schnoering eq. 6, 12, 14).
	if inputCount > 0 && outputCount > 0 {
		sym := math.Min(float64(inputCount), float64(outputCount)) /
			math.Max(float64(inputCount), float64(outputCount))
		if sym > 0.75 {
			result.Breakdown["io_symmetry"] = 0.10 * sym
		}
	}

	// RULE 4: Wasabi 1.x Denomination (weight 0.15)
	// Wasabi 1.0/1.1 use denomination d close to 0.1 BTC (Schnoering §2.2, eq. 11):
	//   0.1 - epsilon <= d <= 0.1 + epsilon, epsilon << 1
	// Wasabi 1.1 adds mixing levels at 2^i * d (eq. 18).
	const wasabi1Base int64 = 10000000
	const wasabi1Epsilon int64 = 500000
	nearWasabi1Base := intAbs(mostCommon-wasabi1Base) <= wasabi1Epsilon
	nearWasabi1Multi := false
	for i := 1; i <= 4; i++ {
		level := int64(math.Pow(2, float64(i)) * float64(wasabi1Base))
		eps := wasabi1Epsilon * int64(math.Pow(2, float64(i)))
		if intAbs(mostCommon-level) <= eps {
			nearWasabi1Multi = true
			break
		}
	}
	if nearWasabi1Base {
		result.Breakdown["wasabi1_denom"] = 0.15
		result.Notes = append(result.Notes, fmt.Sprintf(
			"Wasabi 1.x denomination: %.6f BTC (within +-%.3f of 0.1 BTC)", float64(mostCommon)/1e8, float64(wasabi1Epsilon)/1e8))
	} else if nearWasabi1Multi {
		result.Breakdown["wasabi1_denom"] = 0.10
		result.Notes = append(result.Notes, fmt.Sprintf(
			"Wasabi 1.1 multi-level denomination: %.6f BTC (2^i x 0.1 BTC level)", float64(mostCommon)/1e8))
	}

	// RULE 5: Wasabi 2.0 (WabiSabi) Pattern (weight 0.15)
	// Wasabi 2.0 characteristics (Schnoering §2.4):
	//   - Target input count p=50, so |inputs| >= 50 (eq. 29)
	//   - Fixed denomination set D; majority of outputs match D (eq. 28):
	//     sum(1_{v in D}) >= (|outputs| - 1) / 2
	//   - Minimum input value v_min = 5000 sat = 0.00005 BTC (eq. 32)
	//   - All output scripts distinct (eq. 33)
	wasabi2Denoms := map[int64]bool{
		5000: true, 10000: true, 20000: true, 50000: true,
		100000: true, 200000: true, 500000: true, 1000000: true,
		2000000: true, 5000000: true, 10000000: true, 20000000: true, 50000000: true,
	}
	if inputCount >= 50 && distinctOutputScripts {
		var minInputVal int64 = math.MaxInt64
		for _, inp := range inputs {
			if inp.Value < minInputVal {
				minInputVal = inp.Value
			}
		}
		denomMatchCount := 0
		for _, v := range cleanValues {
			if wasabi2Denoms[v] {
				denomMatchCount++
			}
		}
		required := float64(cleanCount-1) / 2.0
		if float64(denomMatchCount) >= required && minInputVal >= 5000 {
			score := math.Min(float64(inputCount)/200.0, 1.0)
			result.Breakdown["wasabi2_pattern"] = 0.15 * (0.5 + 0.5*score)
			result.Notes = append(result.Notes, fmt.Sprintf(
				"Wasabi 2.0 (WabiSabi): %d inputs, %d/%d outputs match fixed denomination set D",
				inputCount, denomMatchCount, cleanCount))
		}
	}

	// RULE 6: No / Minimal Change Output (weight 0.10)
	// CoinJoin eliminates change outputs entirely. Wasabi ensures at least one
	// participant has no change (Schnoering footnote 9).
	oddCount := 0
	for _, a := range cleanValues {
		if a != mostCommon {
			oddCount++
		}
	}
	oddRatio := float64(oddCount) / float64(cleanCount)
	switch {
	case oddCount == 0:
		result.Breakdown["no_change"] = 0.10
		result.Notes = append(result.Notes, "Zero change outputs — all outputs equal denomination")
	case oddRatio < 0.15:
		result.Breakdown["no_change"] = 0.05
	}

	// RULE 7: Uniform Script Types (weight 0.08)
	// Wasabi enforces uniform P2WPKH output scripts to prevent fingerprinting.
	scriptCounts := make(map[string]int)
	for _, o := range outputs {
		if o.ScriptType != "" && o.ScriptType != "op_return" {
			scriptCounts[o.ScriptType]++
		}
	}
	if len(scriptCounts) == 1 && len(outputs) > 5 {
		result.Breakdown["uniform_scripts"] = 0.08
		for st := range scriptCounts {
			result.Notes = append(result.Notes, "Uniform output script type: "+st)
		}
	}

	// RULE 8: Distinct Output Scripts (weight 0.07)
	// All CoinJoin protocols require every output protected by a unique script
	// (Schnoering eq. 10 JoinMarket, eq. 15 Wasabi 1.x, eq. 33 Wasabi 2.0, eq. 43 Whirlpool).
	if distinctOutputScripts && outputCount > 3 {
		result.Breakdown["distinct_output_scripts"] = 0.07
		result.Notes = append(result.Notes, fmt.Sprintf(
			"All %d output scripts are distinct (CoinJoin requirement)", outputCount))
	}

	// RULE 9: Address Reuse Absence (weight 0.06)
	reused := 0
	for _, o := range outputs {
		if _, ok := inputAddrs[o.Address]; ok {
			reused++
		}
	}
	if reused == 0 && inputCount >= 5 {
		result.Breakdown["no_addr_reuse"] = 0.06
	}

	// RULE 10: Distinct Input Amounts (weight 0.05)
	// Each CoinJoin participant contributes funds from their own UTXO history,
	// resulting in highly varied input amounts.
	if inputCount >= 5 {
		uniqueInputVals := make(map[int64]struct{})
		for _, inp := range inputs {
			uniqueInputVals[inp.Value] = struct{}{}
		}
		uniqueRatio := float64(len(uniqueInputVals)) / float64(inputCount)
		if uniqueRatio > 0.8 {
			result.Breakdown["distinct_inputs"] = 0.05 * uniqueRatio
		}
	}

	// RULE 11: RBF Disabled (weight 0.05)
	// Wasabi sets nSequence=0xFFFFFFFE on all inputs — a Wasabi-specific fingerprint.
	// Allowing any participant to RBF would invalidate the entire CoinJoin round.
	rbfDisabled := 0
	for _, inp := range inputs {
		if inp.Sequence == 0xFFFFFFFE || inp.Sequence == 0xFFFFFFFF {
			rbfDisabled++
		}
	}
	if inputCount > 0 && float64(rbfDisabled)/float64(inputCount) > 0.9 {
		result.Breakdown["rbf_disabled"] = 0.05
		result.Notes = append(result.Notes, "RBF disabled on all inputs (Wasabi fingerprint)")
	}

	// RULE 12: Output Value Entropy Bonus (weight 0.04)
	entropy := shannonEntropy(cleanValues)
	if entropy > 3.0 && equalRatio > 0.6 {
		result.Breakdown["high_entropy"] = 0.04
	}

	var total float64
	for _, v := range result.Breakdown {
		total += v
	}
	result.Score = math.Min(total, 1.0)
	result.Flagged = result.Score >= threshold

	result.MixerType = classifyMixer(mostCommon, inputCount, outputCount, distinctOutputScripts, result.Breakdown)
	return result
}

// classifyMixer identifies the specific mixing protocol based on structural
// fingerprints from Schnoering & Vazirgiannis (2023) and Shojaeinasab et al. (2023).
func classifyMixer(denom int64, inputCount, outputCount int, distinctScripts bool, breakdown map[string]float64) MixerType {
	// Whirlpool: 5x5 exact structure + pool denomination
	if inputCount == 5 && outputCount == 5 && whirlpoolPools[denom] && distinctScripts {
		return MixerWhirlpool
	}
	// Centralized mixer: Shojaeinasab 1:2 P2SH pattern
	if breakdown["centralized_mixer"] > 0 {
		return MixerCentralized
	}
	// Wasabi 2.0: large input count + WabiSabi fixed denomination set
	if breakdown["wasabi2_pattern"] > 0 && inputCount >= 50 {
		return MixerWasabi2
	}
	// Wasabi 1.x: denomination near 0.1 BTC (ZeroLink / Chaumian CoinJoin)
	if breakdown["wasabi1_denom"] > 0 {
		return MixerWasabi
	}
	// JoinMarket: equal denominations, n>=3 participants, all outputs distinct
	// Distinguished from Wasabi by denomination not near 0.1 BTC (Schnoering §2.1)
	if breakdown["equal_outputs"] > 0 && breakdown["participant_count"] > 0 && distinctScripts {
		if float64(inputCount) >= 3 {
			return MixerJoinMarket
		}
	}
	// Generic CoinJoin fallback
	if breakdown["equal_outputs"] > 0 && breakdown["participant_count"] > 0 {
		return MixerCoinjoin
	}
	return MixerUnknown
}

func shannonEntropy(values []int64) float64 {
	if len(values) == 0 {
		return 0
	}
	counts := make(map[int64]int)
	for _, v := range values {
		counts[v]++
	}
	n := float64(len(values))
	var e float64
	for _, c := range counts {
		p := float64(c) / n
		e -= p * math.Log2(p)
	}
	return e
}

// ─────────────────────────────────────────────────────────────
// EXCHANGE DETECTION
// ─────────────────────────────────────────────────────────────

type ExchangeResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	Notes     []string           `json:"notes"`
	Breakdown map[string]float64 `json:"breakdown"`
}

const defaultExchangeThreshold = 0.60

// IsExchangeAddress applies heuristics to detect exchange/custodial hot-wallet behaviour.
func IsExchangeAddress(txs []TransactionIO, threshold float64) ExchangeResult {
	if threshold <= 0 {
		threshold = defaultExchangeThreshold
	}

	result := ExchangeResult{
		Breakdown: make(map[string]float64),
		Notes:     []string{},
	}

	if len(txs) == 0 {
		return result
	}

	// RULE 1: UTXO Consolidation Sweeps (0.30)
	sweepCount := 0
	for _, tx := range txs {
		if len(tx.Inputs) >= 10 && len(tx.Outputs) <= 3 {
			sweepCount++
		}
	}
	sweepRatio := float64(sweepCount) / float64(len(txs))
	if sweepRatio > 0.1 {
		result.Breakdown["utxo_sweeps"] = 0.30 * math.Min(sweepRatio*3, 1.0)
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%d/%d transactions look like UTXO sweeps", sweepCount, len(txs)))
	}

	// RULE 2: High Transaction Frequency (0.20)
	if len(txs) > 1 {
		timestamps := make([]int64, 0, len(txs))
		for _, tx := range txs {
			if tx.Timestamp > 0 {
				timestamps = append(timestamps, tx.Timestamp)
			}
		}
		sort.Slice(timestamps, func(i, j int) bool { return timestamps[i] < timestamps[j] })
		if len(timestamps) >= 2 {
			span := time.Duration(timestamps[len(timestamps)-1]-timestamps[0]) * time.Second
			txPerDay := float64(len(timestamps)) / math.Max(span.Hours()/24, 1)
			if txPerDay > 50 {
				score := math.Min(txPerDay/500, 1.0)
				result.Breakdown["high_frequency"] = 0.20 * score
				result.Notes = append(result.Notes, fmt.Sprintf(
					"%.1f transactions/day", txPerDay))
			}
		}
	}

	// RULE 3: Fan-Out Pattern (0.20)
	fanOutCount := 0
	allOutputAddrs := make(map[string]struct{})
	for _, tx := range txs {
		if len(tx.Outputs) >= 5 {
			fanOutCount++
		}
		for _, o := range tx.Outputs {
			allOutputAddrs[o.Address] = struct{}{}
		}
	}
	fanOutRatio := float64(fanOutCount) / float64(len(txs))
	if fanOutRatio > 0.2 {
		result.Breakdown["fan_out"] = 0.20 * math.Min(fanOutRatio*2, 1.0)
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%d/%d transactions are fan-outs", fanOutCount, len(txs)))
	}

	// RULE 4: Mixed Script Types (0.15)
	scriptTypes := make(map[string]int)
	for _, tx := range txs {
		for _, o := range tx.Outputs {
			if o.ScriptType != "" {
				scriptTypes[o.ScriptType]++
			}
		}
	}
	if len(scriptTypes) >= 3 {
		result.Breakdown["mixed_scripts"] = 0.15
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%d distinct output script types", len(scriptTypes)))
	}

	// RULE 5: Round-Number Withdrawals (0.15)
	roundCount := 0
	totalOuts := 0
	for _, tx := range txs {
		for _, o := range tx.Outputs {
			totalOuts++
			if o.Value > 0 && o.Value%1000000 == 0 {
				roundCount++
			}
		}
	}
	if totalOuts > 0 {
		roundRatio := float64(roundCount) / float64(totalOuts)
		if roundRatio > 0.4 {
			result.Breakdown["round_withdrawals"] = 0.15 * roundRatio
			result.Notes = append(result.Notes, fmt.Sprintf(
				"%.1f%% of outputs are round amounts", roundRatio*100))
		}
	}

	var total float64
	for _, v := range result.Breakdown {
		total += v
	}
	result.Score = math.Min(total, 1.0)
	result.Flagged = result.Score >= threshold

	return result
}

// ─────────────────────────────────────────────────────────────
// PEELING CHAIN DETECTION
// ─────────────────────────────────────────────────────────────

type PeelingChainResult struct {
	IsPeeling  bool    `json:"is_peeling"`
	Confidence float64 `json:"confidence"`
	ChainLen   int     `json:"chain_length"`
	Notes      string  `json:"notes"`
}

// DetectPeelingChain looks for a sequence of transactions where one output
// is markedly smaller than the input (the "peel") and one output is change.
func DetectPeelingChain(txs []TransactionIO) PeelingChainResult {
	result := PeelingChainResult{}
	if len(txs) < 3 {
		return result
	}

	peelCount := 0
	for _, tx := range txs {
		if len(tx.Inputs) != 1 || len(tx.Outputs) != 2 {
			continue
		}
		out0 := tx.Outputs[0].Value
		out1 := tx.Outputs[1].Value
		ratio := math.Min(float64(out0), float64(out1)) / math.Max(float64(out0), float64(out1))
		if ratio < 0.3 {
			peelCount++
		}
	}

	ratio := float64(peelCount) / float64(len(txs))
	if ratio > 0.5 {
		result.IsPeeling = true
		result.Confidence = math.Min(ratio, 1.0)
		result.ChainLen = peelCount
		result.Notes = fmt.Sprintf(
			"%d/%d txs match peel pattern (1-in 2-out with asymmetric amounts)",
			peelCount, len(txs))
	}
	return result
}

// ─────────────────────────────────────────────────────────────
// TAINT PROPAGATION
// ─────────────────────────────────────────────────────────────

func PropagateTaint(graph *UnifiedGraph, decayPerHop float64) {
	if decayPerHop <= 0 || decayPerHop >= 1 {
		decayPerHop = 0.5
	}

	adj := make(map[string][]ProvenanceEdge)
	for _, e := range graph.Edges {
		adj[e.Source] = append(adj[e.Source], e)
	}

	taint := make(map[string]float64)
	for id, n := range graph.Nodes {
		if n.Risk >= 70 {
			taint[id] = 1.0
		}
	}

	queue := make([]string, 0)
	for id := range taint {
		queue = append(queue, id)
	}

	for i := 0; i < len(queue); i++ {
		cur := queue[i]
		curTaint := taint[cur] * (1 - decayPerHop)
		if curTaint < 0.01 {
			continue
		}
		for _, edge := range adj[cur] {
			if curTaint > taint[edge.Target] {
				taint[edge.Target] = curTaint
				queue = append(queue, edge.Target)
			}
		}
	}

	for i := range graph.Edges {
		e := &graph.Edges[i]
		srcTaint := taint[e.Source]
		if srcTaint > e.Taint {
			e.Taint = srcTaint
		}
	}
	for id, t := range taint {
		if n, ok := graph.Nodes[id]; ok {
			derived := int(t * 100)
			if derived > n.Risk {
				n.Risk = derived
				graph.Nodes[id] = n
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────
// LABEL NORMALISATION
// ─────────────────────────────────────────────────────────────

var knownLabels = []struct {
	needle string
	entity EntityType
}{
	{"binance", EntityExchange},
	{"coinbase", EntityExchange},
	{"kraken", EntityExchange},
	{"bitfinex", EntityExchange},
	{"huobi", EntityExchange},
	{"okx", EntityExchange},
	{"bybit", EntityExchange},
	{"kucoin", EntityExchange},
	{"wasabi", EntityMixer},
	{"whirlpool", EntityMixer},
	{"joinmarket", EntityMixer},
	{"coinjoin", EntityMixer},
	{"chipmixer", EntityMixer},
	{"alphabay", EntityDarknet},
	{"silkroad", EntityDarknet},
	{"hydra", EntityDarknet},
	{"gambling", EntityGambling},
	{"stake.com", EntityGambling},
	{"1xbet", EntityGambling},
	{"bitsler", EntityGambling},
	{"primedice", EntityGambling},
	{"mining", EntityMining},
	{"f2pool", EntityMining},
	{"antpool", EntityMining},
	{"slushpool", EntityMining},
	{"viabtc", EntityMining},
	{"luxor", EntityMining},
	{"uniswap", EntityDefi},
	{"aave", EntityDefi},
	{"compound", EntityDefi},
}

func ResolveEntityType(label string) EntityType {
	lower := strings.ToLower(label)
	for needle, entity := range entityTypeMap { // Use pre-built map for faster lookup
		if strings.Contains(lower, needle) { // Still need Contains for partial matches
			return entity
		}
	}
	return EntityUnknown
}

// ─────────────────────────────────────────────────────────────
// GRAPH BUILDER
// ─────────────────────────────────────────────────────────────

type intelResult struct {
	label    string
	riskData *intel.ChainAbuseRiskData
}

type graphBuilder struct {
	graph          UnifiedGraph
	edgeMap        map[string]ProvenanceEdge
	nodeImportance map[string]int
	blockPoolCache map[string]*mempool.PoolInfo
	liveTxs        []mempool.Tx
	bqResult       *bitquery.AddressTransactions
	ir             intelResult
	ctx            context.Context
}

func newGraphBuilder(ctx context.Context) *graphBuilder {
	return &graphBuilder{
		graph: UnifiedGraph{
			Nodes: make(map[string]ProvenanceNode),
			Edges: []ProvenanceEdge{},
		},
		nodeImportance: make(map[string]int),
		edgeMap:        make(map[string]ProvenanceEdge),
		blockPoolCache: make(map[string]*mempool.PoolInfo),
		ctx:            ctx,
	}
}

func (b *graphBuilder) addNode(nodeID, label, nType, source string, risk int) {
	if n, ok := b.graph.Nodes[nodeID]; ok {
		if !contains(n.Sources, source) { // Use helper to avoid O(N) appendIfMissing
			n.Sources = append(n.Sources, source)
		}
		if risk > n.Risk {
			n.Risk = risk
		}
		b.graph.Nodes[nodeID] = n
	} else {
		eType := ResolveEntityType(label)
		b.graph.Nodes[nodeID] = ProvenanceNode{
			ID:         nodeID,
			Label:      label,
			Type:       nType,
			Sources:    []string{source},
			Risk:       risk,
			EntityType: eType,
		}
	}
	score := risk*100 + len(b.graph.Nodes[nodeID].Sources)*10
	if b.nodeImportance[nodeID] < score {
		b.nodeImportance[nodeID] = score
	}
}

func (b *graphBuilder) addEdge(src, tgt string, amt float64, source string, timestamp int64) {
	key := fmt.Sprintf("%s|%s|%.8f", src, tgt, amt)
	if e, ok := b.edgeMap[key]; ok {
		if !contains(e.Sources, source) { // Use helper to avoid O(N) appendIfMissing
			e.Sources = append(e.Sources, source)
		}
		b.edgeMap[key] = e
	} else {
		b.edgeMap[key] = ProvenanceEdge{
			Source:    src,
			Target:    tgt,
			Amount:    amt,
			Sources:   []string{source},
			Timestamp: timestamp,
		}
	}
}

func (b *graphBuilder) lookupBlockPool(blockHash string) *mempool.PoolInfo {
	if blockHash == "" {
		return nil
	}
	if p, found := b.blockPoolCache[blockHash]; found {
		return p
	}
	pool, err := mempool.GetBlockPool(blockHash)
	if err != nil {
		log.Printf("⚠️  [BLOCK-POOL] %s: %v — attempting fallback to mempool.guide", blockHash[:min16(len(blockHash))], err)
		var guideBlock struct {
			Extras struct {
				Pool *mempool.PoolInfo `json:"pool"`
			} `json:"extras"`
		}
		if gErr := mempoolGuideFetch(b.ctx, "/v1/block/"+blockHash, &guideBlock); gErr == nil {
			pool = guideBlock.Extras.Pool
		} else {
			b.blockPoolCache[blockHash] = nil
			return nil
		}
	}
	b.blockPoolCache[blockHash] = pool
	if pool != nil {
		log.Printf("⛏️  [BLOCK-POOL] block %s → %s (%s)", blockHash[:min16(len(blockHash))], pool.Name, pool.Slug)
	}
	return pool
}

func contains(slice []string, s string) bool {
	for _, v := range slice {
		if v == s {
			return true
		}
	}
	return false
}

func BuildVerifiedFTM(ctx context.Context, id string, caKey string, bqKey string) UnifiedGraph {
	builder := newGraphBuilder(ctx)

	// 1. Initial target node
	builder.addNode(id, id, "Address", "Initial Query", 0)

	// 2. Local Neo4j
	neoToReal := make(map[string]string)
	if history, err := db.GetMoneyFlow(ctx, id); err == nil && history != nil {
		log.Printf("✅ [LOCAL-DB] Retrieved money flow for %s", id)
		for eid, node := range history["nodes"].(map[string]interface{}) {
			n := node.(map[string]interface{})
			realID := n["label"].(string)
			neoToReal[eid] = realID
			builder.addNode(realID, realID, n["type"].(string), "Local DB", 0)
		}
		for _, edge := range history["edges"].([]interface{}) {
			e := edge.(map[string]interface{})
			src := neoToReal[e["source"].(string)]
			tgt := neoToReal[e["target"].(string)]
			if src != "" && tgt != "" {
				builder.addEdge(src, tgt, e["amount"].(float64), "Local DB", 0)
			}
		}
	} else {
		log.Printf("⚠️  [LOCAL-DB] Skipped (no local history for %s)", id)
	}

	var wg sync.WaitGroup

	wg.Add(3)
	// Parallel fetch: Mempool/Blockstream
	go func() {
		defer wg.Done()
		var err error
		builder.liveTxs, err = GetAddressTxsWithFallback(builder.ctx, id)
		if err != nil {
			log.Printf("⚠️  [FETCH-TX] %v", err)
		}
	}()

	// Parallel fetch: Bitquery
	go func() {
		defer wg.Done()
		if bqKey != "" {
			var err error
			builder.bqResult, err = bitquery.GetAddressTransactions(builder.ctx, id, bqKey, 200)
			if err != nil {
				log.Printf("⚠️  [BITQUERY] %v", err)
			}
		}
	}()

	// Parallel fetch: Intel
	go func() {
		defer wg.Done()
		builder.ir = intelResult{
			label:    intel.GetLabel(id), // intel.GetLabel does not take context
			riskData: intel.GetChainAbuseRisk(id, caKey),
		}
	}()

	wg.Wait()

	txIOs := make([]TransactionIO, 0, len(builder.liveTxs))
	for _, tx := range builder.liveTxs {
		builder.addNode(tx.Txid, tx.Txid, "Transaction", "Esplora API", 0)
		timestamp := int64(0)
		if tx.Status.Confirmed && tx.Status.BlockTime > 0 {
			timestamp = tx.Status.BlockTime
		}

		tio := TransactionIO{
			Txid:      tx.Txid,
			Timestamp: timestamp,
		}

		for _, vin := range tx.Vin {
			// Detect coinbase inputs (no prevout)
			if vin.Prevout == nil {
				tio.HasCoinbase = true
				continue
			}
			if vin.Prevout.ScriptPubKeyAddress != "" {
				addr := vin.Prevout.ScriptPubKeyAddress
				val := float64(vin.Prevout.Value) / 1e8
				builder.addNode(addr, addr, "Address", "Esplora API", 0)
				builder.addEdge(addr, tx.Txid, val, "Esplora API", timestamp)
				tio.Inputs = append(tio.Inputs, TxInput{
					Address:  addr,
					Value:    vin.Prevout.Value,
					Sequence: vin.Sequence,
				})
			}
		}

		// Mark transaction node with coinbase flag, input count, and mining pool.
		// - IsCoinbase: true when any Vin has no Prevout (block-reward transaction).
		// - MiningPoolInfo: populated for every confirmed transaction by querying
		//   mempool.space's /v1/block/:hash endpoint via the cached lookupBlockPool
		//   helper. This surfaces "Miner: Foundry USA" style attribution on every
		//   confirmed tx node — the same data mempool.space shows in its UI.
		// - EntityType = EntityMining is set when the pool is identified; this drives
		//   the amber colour, ⛏ label prefix, and the [HIDE MINING] filter.
		if n, ok := builder.graph.Nodes[tx.Txid]; ok {
			n.IsCoinbase = tio.HasCoinbase
			n.InputCount = len(tx.Vin)

			if tx.Status.Confirmed && tx.Status.BlockHash != "" {
				poolInfo := builder.lookupBlockPool(tx.Status.BlockHash)
				if poolInfo != nil {
					n.MiningPoolInfo = poolInfo
					n.EntityType = EntityMining
					if tio.HasCoinbase {
						n.Label = poolInfo.Name + " (Coinbase)"
					} else {
						n.Label = poolInfo.Name + " (TX)"
					}
					log.Printf("⛏️  [POOL-TAG] tx %s → %s (coinbase=%v)",
						tx.Txid[:min16(len(tx.Txid))], poolInfo.Name, tio.HasCoinbase)
				} else if tio.HasCoinbase {
					n.EntityType = EntityMining
					n.Label = "Coinbase TX"
				}
			} else if tio.HasCoinbase {
				n.EntityType = EntityMining
				n.Label = "Coinbase TX"
			}

			builder.graph.Nodes[tx.Txid] = n
		}

		for _, vout := range tx.Vout {
			if vout.ScriptPubKeyAddress != "" {
				addr := vout.ScriptPubKeyAddress
				val := float64(vout.Value) / 1e8
				builder.addNode(addr, addr, "Address", "Esplora API", 0)
				builder.addEdge(tx.Txid, addr, val, "Esplora API", timestamp)
				tio.Outputs = append(tio.Outputs, TxOutput{
					Address:    addr,
					Value:      vout.Value,
					ScriptType: vout.ScriptPubKeyType,
				})
			}
		}

		if len(tio.Inputs) > 0 || len(tio.Outputs) > 0 {
			log.Printf("  📝 TX %s: %d inputs → %d outputs", tx.Txid[:16], len(tio.Inputs), len(tio.Outputs))
		}

		txIOs = append(txIOs, tio)

		// Per-transaction mixer detection
		mr := IsCoinMixer(tio, defaultMixerThreshold)
		det := DetectionResult{
			IsMixer:    mr.Flagged,
			Confidence: int(math.Round(mr.Score * 100)),
			Raw:        mr,
		}
		if len(mr.Notes) > 0 {
			det.Explanation = strings.Join(mr.Notes, "; ")
		} else if mr.Score > 0 {
			det.Explanation = fmt.Sprintf("Heuristic score %.2f", mr.Score)
		} else {
			det.Explanation = "No clear mixer signals"
		}

		if mr.Flagged {
			if n, ok := builder.graph.Nodes[tx.Txid]; ok { // Access builder's graph
				n.MixerInfo = &det
				risk := det.Confidence
				if risk > n.Risk {
					n.Risk = risk
				}
				builder.graph.Nodes[tx.Txid] = n
				log.Printf("🔀 [MIXER] %s — score=%.2f type=%s conf=%d",
					tx.Txid, mr.Score, mr.MixerType, det.Confidence)
			}
		}
	}

	// 4. Bitquery inflows + outflows
	// Uses GetAddressTransactions (v2 API) which returns both FlowEdges for // Access builder's bqResult
	// graph construction AND fully-hydrated TxIO records that are merged into
	// the behavioral detection pipeline alongside mempool.space data.
	if builder.bqResult != nil {
		// 4a. Add flow edges and nodes to the graph
		for _, flow := range builder.bqResult.Flows {
			builder.addNode(flow.FromAddr, flow.FromAddr, "Address", "Bitquery", 0)
			builder.addNode(flow.ToAddr, flow.ToAddr, "Address", "Bitquery", 0)
			if flow.TxHash != "" {
				builder.addNode(flow.TxHash, flow.TxHash, "Transaction", "Bitquery", 0)
				builder.addEdge(flow.FromAddr, flow.TxHash, flow.ValueBTC, "Bitquery", flow.Timestamp)
				builder.addEdge(flow.TxHash, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp)
			} else {
				builder.addEdge(flow.FromAddr, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp)
			}
		}

		// 4b. Convert Bitquery TxIOs into aggregator.TransactionIO
		for _, btio := range builder.bqResult.TxIOs {
			alreadySeen := false
			for _, existing := range txIOs {
				if existing.Txid == btio.Txid {
					alreadySeen = true
					break
				}
			}
			if alreadySeen {
				continue
			}

			tio := TransactionIO{Txid: btio.Txid, Timestamp: btio.Timestamp}
			for _, inp := range btio.Inputs {
				tio.Inputs = append(tio.Inputs, TxInput{
					Address: inp.Address,
					Value:   int64(math.Round(inp.Value * 1e8)),
				})
			}
			for _, out := range btio.Outputs {
				tio.Outputs = append(tio.Outputs, TxOutput{
					Address:    out.Address,
					Value:      int64(math.Round(out.Value * 1e8)),
					ScriptType: "", // Bitquery v2 bitcoin endpoint does not expose script type
				})
			}
			txIOs = append(txIOs, tio)
			builder.addNode(btio.Txid, btio.Txid, "Transaction", "Bitquery", 0)
			// Mark Bitquery transaction with input count
			if n, ok := builder.graph.Nodes[btio.Txid]; ok {
				n.InputCount = len(btio.Inputs)
				n.IsCoinbase = len(btio.Inputs) == 0
				builder.graph.Nodes[btio.Txid] = n
			}
		}
		log.Printf("📡 [BITQUERY] merged %d new txs into behavioral pipeline (total: %d)", // Access builder's bqResult
			builder.bqResult.TotalTxs, len(txIOs))
	}

	// ── Behavioral detection (runs on FULL txIOs: mempool.space + Bitquery) ────
	// Exchange, gambling, mining, peeling and clustering all run here so they
	// see the combined dataset from both sources, not just mempool.space's 50 TXs.

	// ── Exchange detection ─────────────────────────────────────
	er := IsExchangeAddress(txIOs, defaultExchangeThreshold)
	if er.Flagged { // Access builder's graph
		if n, ok := builder.graph.Nodes[id]; ok {
			n.EntityType = EntityExchange
			n.ExchInfo = &er
			log.Printf("🏦 [EXCHANGE] %s — score=%.2f", id, er.Score)
			builder.graph.Nodes[id] = n
		}
	}

	// ── Gambling detection ────────────────────────────────────
	gr := IsGamblingAddress(txIOs, defaultGamblingThreshold)
	if gr.Flagged { // Access builder's graph
		if n, ok := builder.graph.Nodes[id]; ok {
			n.EntityType = EntityGambling
			n.GamblingInfo = &gr
			log.Printf("🎰 [GAMBLING] %s — score=%.2f", id, gr.Score)
			builder.graph.Nodes[id] = n
		}
	}

	// ── Mining pool detection ─────────────────────────────────
	mr := IsMiningPoolAddress(txIOs, defaultMiningThreshold)
	if mr.Flagged { // Access builder's graph
		if n, ok := builder.graph.Nodes[id]; ok {
			n.EntityType = EntityMining
			n.MiningInfo = &mr
			log.Printf("⛏️  [MINING] %s — score=%.2f", id, mr.Score)
			builder.graph.Nodes[id] = n
		}
	}

	// ── Peeling chain detection ───────────────────────────────
	pc := DetectPeelingChain(txIOs)
	if pc.IsPeeling { // Access builder's graph
		if n, ok := builder.graph.Nodes[id]; ok {
			n.Risk = intMax(n.Risk, int(pc.Confidence*80))
			builder.graph.Nodes[id] = n
		}
		log.Printf("🔗 [PEEL CHAIN] %s — confidence=%.2f len=%d", id, pc.Confidence, pc.ChainLen)
	}

	// ── Co-spend clustering ───────────────────────────────────
	clusters := BuildClusters(txIOs)
	for addr, cid := range clusters.AddrToCluster {
		members := clusters.Clusters[cid]
		if n, ok := builder.graph.Nodes[addr]; ok && n.Type == "Address" { // Access builder's graph
			n.ClusterID = cid
			n.ClusterSize = len(members)
			builder.graph.Nodes[addr] = n
		}
	}
	if len(clusters.Clusters) > 0 {
		var clusterData []map[string]interface{}
		for cid, members := range clusters.Clusters {
			if len(members) > 1 {
				for _, addr := range members {
					clusterData = append(clusterData, map[string]interface{}{
						"cluster_id": cid,
						"address":    addr,
					})
				}
			}
		}
		if len(clusterData) > 0 {
			db.SaveCluster(clusterData)
			log.Printf("🔗 [CLUSTER] %d multi-address wallet clusters for %s", len(clusters.Clusters), id)
		}
	}

	// Flush edge map
	for _, e := range builder.edgeMap {
		builder.graph.Edges = append(builder.graph.Edges, e)
	}

	// 5. Intel enrichment (ChainAbuse + WalletExplorer)
	// Both sources are ALWAYS recorded in node.Sources regardless of whether
	// they returned data, so the frontend intelligence panel always shows them
	// with their Verify and Open buttons, and the cross-validation engine can
	// correctly report "queried but found nothing" rather than silently omitting.
	if n, ok := builder.graph.Nodes[id]; ok { // Access builder's graph
		// Always add WalletExplorer — it is a public service with no key required.
		n.Sources = appendIfMissing(n.Sources, "WalletExplorer")
		if caKey != "" {
			n.Sources = appendIfMissing(n.Sources, "ChainAbuse")
		}
		if builder.ir.riskData != nil { // Access builder's ir
			riskScore := intel.CalculateRiskScore(builder.ir.riskData)
			n.Risk = riskScore
			n.RiskData = builder.ir.riskData
			builder.nodeImportance[id] += riskScore * 100
		}
		if builder.ir.label != "" { // Access builder's ir
			n.Label = builder.ir.label
			n.EntityType = ResolveEntityType(builder.ir.label)
		}
		builder.graph.Nodes[id] = n
	}

	// 6. Taint propagation
	PropagateTaint(&builder.graph, 0.5)

	// 7. Build summary
	builder.graph.Summary = buildSummary(builder.graph)

	// Final diagnostic log
	log.Printf("📊 [GRAPH] Final: %d nodes, %d edges | Node breakdown: %v",
		len(builder.graph.Nodes), len(builder.graph.Edges), len(builder.graph.Nodes))

	return builder.graph
}

// appendIfMissing appends s to slice only when it is not already present.
// Used to unconditionally record intelligence sources regardless of whether
// they returned data, so the frontend panel always shows them.
func appendIfMissing(slice []string, s string) []string {
	for _, v := range slice {
		if v == s {
			return slice
		}
	}
	return append(slice, s)
}

// buildSummary computes aggregate statistics over the final graph.
func buildSummary(g UnifiedGraph) GraphSummary {
	s := GraphSummary{
		TotalNodes: len(g.Nodes),
		TotalEdges: len(g.Edges),
	}
	clustersSeen := make(map[string]bool)
	for _, n := range g.Nodes {
		if n.Risk > s.MaxRisk {
			s.MaxRisk = n.Risk
		}
		if n.Risk >= 70 {
			s.HighRiskCount++
		}
		if n.EntityType == EntityMixer {
			s.MixerCount++
		}
		if n.EntityType == EntityExchange {
			s.ExchangeCount++
		}
		if n.EntityType == EntityGambling {
			s.GamblingCount++
		}
		if n.EntityType == EntityMining {
			s.MiningCount++
		}
		if n.Risk > 0 && n.Risk < 70 {
			s.TaintedCount++
		}
		if n.ClusterID != "" && n.ClusterSize > 1 && !clustersSeen[n.ClusterID] {
			clustersSeen[n.ClusterID] = true
			s.ClusterCount++
		}
	}
	return s
}

func intMax(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func intAbs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// min16 returns min(n, 16) — used to safely truncate txid/blockHash log strings.
func min16(n int) int {
	return min(n, 16)
}
