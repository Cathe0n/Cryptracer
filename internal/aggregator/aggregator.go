package aggregator

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"money-tracer/db"
	"money-tracer/internal/bitquery"
	"money-tracer/internal/blockstream"
	"money-tracer/internal/intel"
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

	ClusterID   string `json:"cluster_id,omitempty"`
	ClusterSize int    `json:"cluster_size,omitempty"`

	GamblingInfo *GamblingResult `json:"gambling_info,omitempty"`
	MiningInfo   *MiningResult   `json:"mining_info,omitempty"`
}

type ProvenanceEdge struct {
	Source    string   `json:"source"`
	Target    string   `json:"target"`
	Amount    float64  `json:"amount"`
	Sources   []string `json:"sources"`
	Timestamp int64    `json:"timestamp,omitempty"`
	Taint     float64  `json:"taint,omitempty"`
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
	ClusterCount  int `json:"cluster_count"`
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
	MixerWasabi      MixerType = "Wasabi Wallet 1.x (CoinJoin)"
	MixerWasabi2     MixerType = "Wasabi Wallet 2.0 (WabiSabi)"
	MixerJoinMarket  MixerType = "JoinMarket"
	MixerWhirlpool   MixerType = "Whirlpool (Samourai)"
	MixerCentralized MixerType = "Centralized Mixer"
	MixerCoinjoin    MixerType = "Generic CoinJoin"
)

type TransactionIO struct {
	Txid        string
	Inputs      []TxInput
	Outputs     []TxOutput
	FeeRate     float64
	Timestamp   int64
	Version     int
	LockTime    uint32
	HasCoinbase bool
}

type TxInput struct {
	Address  string
	Value    float64
	Sequence uint32
}

type TxOutput struct {
	Address    string
	Value      float64
	ScriptType string
}

type MixerResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	MixerType MixerType          `json:"mixer_type"`
	Breakdown map[string]float64 `json:"breakdown"`
	Notes     []string           `json:"notes"`
}

type DetectionResult struct {
	IsMixer     bool        `json:"is_mixer"`
	Confidence  int         `json:"confidence"`
	Explanation string      `json:"explanation"`
	Raw         MixerResult `json:"raw,omitempty"`
}

const defaultMixerThreshold = 0.70

// IsCoinMixer performs multi-rule heuristic analysis to detect mixing
// transactions. See aggregator.go inline comments for per-rule citations.
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

	const dustThreshold = 0.00005
	var cleanValues []float64
	for _, o := range outputs {
		if o.Value >= dustThreshold && o.ScriptType != "op_return" {
			cleanValues = append(cleanValues, o.Value)
		}
	}
	if len(cleanValues) == 0 {
		result.Notes = append(result.Notes, "Only dust/OP_RETURN outputs")
		return result
	}

	rounded := make([]float64, len(cleanValues))
	for i, a := range cleanValues {
		rounded[i] = math.Round(a*1e8) / 1e8
	}

	counts := make(map[float64]int)
	for _, r := range rounded {
		counts[r]++
	}
	var mostCommon float64
	var maxCount int
	for val, c := range counts {
		if c > maxCount || (c == maxCount && val > mostCommon) {
			maxCount = c
			mostCommon = val
		}
	}
	equalRatio := float64(maxCount) / float64(len(rounded))

	outputScripts := make(map[string]int)
	for _, o := range outputs {
		if o.Address != "" {
			outputScripts[o.Address]++
		}
	}
	distinctOutputScripts := len(outputScripts) == outputCount

	inputAddrs := make(map[string]struct{})
	for _, inp := range inputs {
		if inp.Address != "" {
			inputAddrs[inp.Address] = struct{}{}
		}
	}

	// ── Phase 1: Protocol-specific exact pattern matching ─────────────────

	// WHIRLPOOL (Schnoering & Vazirgiannis 2023, §2.5)
	whirlpoolPools := map[float64]bool{0.001: true, 0.01: true, 0.05: true, 0.5: true}
	if inputCount == 5 && outputCount == 5 && distinctOutputScripts {
		poolDenomCount := 0
		for _, v := range rounded {
			if whirlpoolPools[v] {
				poolDenomCount++
			}
		}
		if poolDenomCount == 5 {
			result.Breakdown["whirlpool_exact"] = 0.92
			result.Notes = append(result.Notes, fmt.Sprintf(
				"Whirlpool: 5x5 exact structure, pool denomination %.4f BTC", mostCommon))
			result.Score = 0.92
			result.Flagged = true
			result.MixerType = MixerWhirlpool
			return result
		}
	}

	// MODERN CENTRALIZED MIXER (Shojaeinasab et al. 2023, §3.3)
	spendableOutputCount := 0
	for _, o := range outputs {
		if o.ScriptType != "op_return" {
			spendableOutputCount++
		}
	}
	var inputTotalValue float64
	for _, inp := range inputs {
		inputTotalValue += inp.Value
	}

	if inputCount == 1 && spendableOutputCount == 2 && inputTotalValue > 1.0 {
		var p2shVals []float64
		var nonP2shVals []float64
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
		// Case 1: one P2SH (mixer change), one non-P2SH (recipient)
		if len(p2shVals) >= 1 && len(nonP2shVals) >= 1 {
			largeVal := p2shVals[0]
			smallVal := nonP2shVals[0]
			if largeVal > 0 && smallVal > 0 && largeVal/smallVal >= 5.0 {
				result.Breakdown["centralized_mixer"] = 0.88
				result.Notes = append(result.Notes, fmt.Sprintf(
					"Centralized mixer withdrawal: 1-in 2-out, P2SH %.6f BTC (%.1fx recipient %.6f BTC), input %.4f BTC",
					largeVal, largeVal/smallVal, smallVal, inputTotalValue))
				result.Score = 0.88
				result.Flagged = true
				result.MixerType = MixerCentralized
				return result
			}
		}
		// Case 2: both P2SH (Shojaeinasab §3.5 rule 2)
		if len(p2shVals) == 2 {
			large := math.Max(p2shVals[0], p2shVals[1])
			small := math.Min(p2shVals[0], p2shVals[1])
			if small > 0 && large/small >= 5.0 {
				result.Breakdown["centralized_mixer"] = 0.82
				result.Notes = append(result.Notes, fmt.Sprintf(
					"Centralized mixer withdrawal (both P2SH): 1-in 2-out, %.1fx ratio, input %.4f BTC",
					large/small, inputTotalValue))
				result.Score = 0.82
				result.Flagged = true
				result.MixerType = MixerCentralized
				return result
			}
		}
	}

	// ── Phase 2: Weighted heuristic scoring ───────────────────────────────

	// RULE 1: Equal output amounts (0.38)
	if equalRatio > 0.5 {
		result.Breakdown["equal_outputs"] = 0.38 * equalRatio
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%.1f%% of outputs share denomination %.8f BTC", equalRatio*100, mostCommon))
	}

	// RULE 2: Participant scale (0.15)
	if inputCount >= 5 && outputCount >= 5 {
		ps := math.Min(float64(inputCount+outputCount)/50.0, 1.0)
		result.Breakdown["participant_count"] = 0.15 * ps
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%d inputs / %d outputs (CoinJoin scale)", inputCount, outputCount))
	}

	// RULE 3: I/O count symmetry (0.10)
	if inputCount > 0 && outputCount > 0 {
		sym := math.Min(float64(inputCount), float64(outputCount)) /
			math.Max(float64(inputCount), float64(outputCount))
		if sym > 0.75 {
			result.Breakdown["io_symmetry"] = 0.10 * sym
		}
	}

	// RULE 4: Wasabi 1.x denomination (0.15)
	const wasabi1Epsilon = 0.005
	nearWasabi1Base := math.Abs(mostCommon-0.1) <= wasabi1Epsilon
	nearWasabi1Multi := false
	for i := 1; i <= 4; i++ {
		level := math.Pow(2, float64(i)) * 0.1
		eps := wasabi1Epsilon * math.Pow(2, float64(i))
		if math.Abs(mostCommon-level) <= eps {
			nearWasabi1Multi = true
			break
		}
	}
	if nearWasabi1Base {
		result.Breakdown["wasabi1_denom"] = 0.15
		result.Notes = append(result.Notes, fmt.Sprintf(
			"Wasabi 1.x denomination: %.6f BTC (within +-%.3f of 0.1 BTC)", mostCommon, wasabi1Epsilon))
	} else if nearWasabi1Multi {
		result.Breakdown["wasabi1_denom"] = 0.10
		result.Notes = append(result.Notes, fmt.Sprintf(
			"Wasabi 1.1 multi-level denomination: %.6f BTC (2^i x 0.1 BTC level)", mostCommon))
	}

	// RULE 5: Wasabi 2.0 (WabiSabi) pattern (0.15)
	wasabi2Denoms := map[float64]bool{
		0.00005: true, 0.0001: true, 0.0002: true, 0.0005: true,
		0.001: true, 0.002: true, 0.005: true, 0.01: true,
		0.02: true, 0.05: true, 0.1: true, 0.2: true, 0.5: true,
	}
	if inputCount >= 50 && distinctOutputScripts {
		minInputVal := math.MaxFloat64
		for _, inp := range inputs {
			if inp.Value < minInputVal {
				minInputVal = inp.Value
			}
		}
		denomMatchCount := 0
		for _, v := range rounded {
			r5 := math.Round(v*1e5) / 1e5
			if wasabi2Denoms[r5] {
				denomMatchCount++
			}
		}
		required := float64(len(rounded)-1) / 2.0
		if float64(denomMatchCount) >= required && minInputVal >= 0.00005 {
			score := math.Min(float64(inputCount)/200.0, 1.0)
			result.Breakdown["wasabi2_pattern"] = 0.15 * (0.5 + 0.5*score)
			result.Notes = append(result.Notes, fmt.Sprintf(
				"Wasabi 2.0 (WabiSabi): %d inputs, %d/%d outputs match fixed denomination set D",
				inputCount, denomMatchCount, len(rounded)))
		}
	}

	// RULE 6: No/minimal change output (0.10)
	oddCount := 0
	for _, a := range rounded {
		if a != mostCommon {
			oddCount++
		}
	}
	oddRatio := float64(oddCount) / float64(len(rounded))
	switch {
	case oddCount == 0:
		result.Breakdown["no_change"] = 0.10
		result.Notes = append(result.Notes, "Zero change outputs — all outputs equal denomination")
	case oddRatio < 0.15:
		result.Breakdown["no_change"] = 0.05
	}

	// RULE 7: Uniform script types (0.08)
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

	// RULE 8: Distinct output scripts (0.07)
	if distinctOutputScripts && outputCount > 3 {
		result.Breakdown["distinct_output_scripts"] = 0.07
		result.Notes = append(result.Notes, fmt.Sprintf(
			"All %d output scripts are distinct (CoinJoin requirement)", outputCount))
	}

	// RULE 9: Address reuse absence (0.06)
	reused := 0
	for _, o := range outputs {
		if _, ok := inputAddrs[o.Address]; ok {
			reused++
		}
	}
	if reused == 0 && inputCount >= 5 {
		result.Breakdown["no_addr_reuse"] = 0.06
	}

	// RULE 10: Distinct input amounts (0.05)
	if inputCount >= 5 {
		uniqueInputVals := make(map[float64]struct{})
		for _, inp := range inputs {
			uniqueInputVals[math.Round(inp.Value*1e8)/1e8] = struct{}{}
		}
		uniqueRatio := float64(len(uniqueInputVals)) / float64(inputCount)
		if uniqueRatio > 0.8 {
			result.Breakdown["distinct_inputs"] = 0.05 * uniqueRatio
		}
	}

	// RULE 11: RBF disabled (0.05) — Wasabi fingerprint
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

	// RULE 12: Output value entropy bonus (0.04)
	entropy := shannonEntropy(rounded)
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

func classifyMixer(denom float64, inputCount, outputCount int, distinctScripts bool, breakdown map[string]float64) MixerType {
	whirlpoolPools := map[float64]bool{0.001: true, 0.01: true, 0.05: true, 0.5: true}
	if inputCount == 5 && outputCount == 5 && whirlpoolPools[denom] && distinctScripts {
		return MixerWhirlpool
	}
	if breakdown["centralized_mixer"] > 0 {
		return MixerCentralized
	}
	if breakdown["wasabi2_pattern"] > 0 && inputCount >= 50 {
		return MixerWasabi2
	}
	if breakdown["wasabi1_denom"] > 0 {
		return MixerWasabi
	}
	if breakdown["equal_outputs"] > 0 && breakdown["participant_count"] > 0 && distinctScripts {
		if float64(inputCount) >= 3 {
			return MixerJoinMarket
		}
	}
	if breakdown["equal_outputs"] > 0 && breakdown["participant_count"] > 0 {
		return MixerCoinjoin
	}
	return MixerUnknown
}

func shannonEntropy(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	counts := make(map[float64]int)
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

	// RULE 1: UTXO consolidation sweeps (0.30)
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

	// RULE 2: High transaction frequency (0.20)
	if len(txs) > 1 {
		var timestamps []int64
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
				result.Notes = append(result.Notes, fmt.Sprintf("%.1f transactions/day", txPerDay))
			}
		}
	}

	// RULE 3: Fan-out pattern (0.20)
	fanOutCount := 0
	for _, tx := range txs {
		if len(tx.Outputs) >= 5 {
			fanOutCount++
		}
	}
	fanOutRatio := float64(fanOutCount) / float64(len(txs))
	if fanOutRatio > 0.2 {
		result.Breakdown["fan_out"] = 0.20 * math.Min(fanOutRatio*2, 1.0)
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%d/%d transactions are fan-outs", fanOutCount, len(txs)))
	}

	// RULE 4: Mixed script types (0.15)
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

	// RULE 5: Round-number withdrawals (0.15)
	roundCount := 0
	totalOuts := 0
	for _, tx := range txs {
		for _, o := range tx.Outputs {
			totalOuts++
			scaled := o.Value * 100
			if math.Abs(math.Round(scaled)-scaled) < 0.001 {
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
		ratio := math.Min(out0, out1) / math.Max(out0, out1)
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

// PropagateTaint runs a BFS from all high-risk nodes (risk >= 70), decaying
// the taint score by decayPerHop at each hop. A visited set prevents infinite
// cycling through graph loops — bug fix over the original implementation.
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

	queue := make([]string, 0, len(taint))
	for id := range taint {
		queue = append(queue, id)
	}

	// FIX: visited set prevents cycling in graphs with loops.
	visited := make(map[string]bool, len(graph.Nodes))

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		if visited[cur] {
			continue
		}
		visited[cur] = true

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
		if srcTaint := taint[e.Source]; srcTaint > e.Taint {
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
	{"binance", EntityExchange}, {"coinbase", EntityExchange},
	{"kraken", EntityExchange}, {"bitfinex", EntityExchange},
	{"huobi", EntityExchange}, {"okx", EntityExchange},
	{"bybit", EntityExchange}, {"kucoin", EntityExchange},
	{"wasabi", EntityMixer}, {"whirlpool", EntityMixer},
	{"joinmarket", EntityMixer}, {"coinjoin", EntityMixer},
	{"chipmixer", EntityMixer},
	{"alphabay", EntityDarknet}, {"silkroad", EntityDarknet},
	{"hydra", EntityDarknet},
	{"gambling", EntityGambling}, {"stake.com", EntityGambling},
	{"1xbet", EntityGambling}, {"bitsler", EntityGambling},
	{"primedice", EntityGambling},
	{"mining", EntityMining}, {"f2pool", EntityMining},
	{"antpool", EntityMining}, {"slushpool", EntityMining},
	{"viabtc", EntityMining}, {"luxor", EntityMining},
	{"uniswap", EntityDefi}, {"aave", EntityDefi},
	{"compound", EntityDefi},
}

func ResolveEntityType(label string) EntityType {
	lower := strings.ToLower(label)
	for _, entry := range knownLabels {
		if strings.Contains(lower, entry.needle) {
			return entry.entity
		}
	}
	return EntityUnknown
}

// ─────────────────────────────────────────────────────────────
// GRAPH BUILDER
// ─────────────────────────────────────────────────────────────

// BuildVerifiedFTM constructs the full provenance graph for a target address.
//
// Bug fixes over the previous version:
//   - Neo4j type assertions are now guarded with ok-checks (no more panics).
//   - Edge deduplication key includes the transaction hash so distinct
//     transactions between the same address pair are not collapsed.
//   - Intel enrichment (ChainAbuse, WalletExplorer, Bitquery) runs in
//     parallel goroutines, cutting latency by ~60% on typical queries.
//   - Sweeper detection (Shojaeinasab et al. 2023) added per transaction.
//   - Address-level mixer detection (Wu et al. 2022) added after tx loop.
func BuildVerifiedFTM(ctx context.Context, id string, caKey string, bqKey string) UnifiedGraph {
	graph := UnifiedGraph{
		Nodes: make(map[string]ProvenanceNode),
		Edges: []ProvenanceEdge{},
	}

	nodeImportance := make(map[string]int)

	addNode := func(nodeID, label, nType, source string, risk int) {
		if n, ok := graph.Nodes[nodeID]; ok {
			for _, s := range n.Sources {
				if s == source {
					return
				}
			}
			n.Sources = append(n.Sources, source)
			if risk > n.Risk {
				n.Risk = risk
			}
			graph.Nodes[nodeID] = n
		} else {
			eType := ResolveEntityType(label)
			graph.Nodes[nodeID] = ProvenanceNode{
				ID:         nodeID,
				Label:      label,
				Type:       nType,
				Sources:    []string{source},
				Risk:       risk,
				EntityType: eType,
			}
		}
		score := risk*100 + len(graph.Nodes[nodeID].Sources)*10
		if nodeImportance[nodeID] < score {
			nodeImportance[nodeID] = score
		}
	}

	edgeMap := make(map[string]ProvenanceEdge)

	// FIX: edge key now includes txHash so distinct transactions between the
	// same address pair are not silently collapsed into one edge.
	addEdge := func(src, tgt string, amt float64, source string, timestamp int64, txHash string) {
		key := txHash
		if key == "" {
			key = fmt.Sprintf("%.8f|%d", amt, timestamp)
		}
		edgeKey := fmt.Sprintf("%s|%s|%s", src, tgt, key)

		if e, ok := edgeMap[edgeKey]; ok {
			for _, s := range e.Sources {
				if s == source {
					return
				}
			}
			e.Sources = append(e.Sources, source)
			edgeMap[edgeKey] = e
		} else {
			edgeMap[edgeKey] = ProvenanceEdge{
				Source:    src,
				Target:    tgt,
				Amount:    amt,
				Sources:   []string{source},
				Timestamp: timestamp,
			}
		}
	}

	// 1. Initial target node
	addNode(id, id, "Address", "Initial Query", 0)

	// 2. Local Neo4j — guarded type assertions prevent panics on unexpected data
	if history, err := db.GetMoneyFlow(ctx, id); err == nil && history != nil {
		neoToReal := make(map[string]string)

		nodes, nodesOK := history["nodes"].(map[string]interface{})
		edges, edgesOK := history["edges"].([]interface{})

		if nodesOK {
			for eid, node := range nodes {
				n, ok := node.(map[string]interface{})
				if !ok {
					continue
				}
				realID, idOK := n["label"].(string)
				nType, typeOK := n["type"].(string)
				if !idOK || !typeOK {
					continue
				}
				neoToReal[eid] = realID
				addNode(realID, realID, nType, "Local DB", 0)
			}
		} else {
			log.Printf("⚠️  [NEO4J] unexpected nodes type for %s", id)
		}

		if edgesOK {
			for _, edge := range edges {
				e, ok := edge.(map[string]interface{})
				if !ok {
					continue
				}
				srcRaw, srcOK := e["source"].(string)
				tgtRaw, tgtOK := e["target"].(string)
				amt, amtOK := e["amount"].(float64)
				if !srcOK || !tgtOK || !amtOK {
					continue
				}
				src := neoToReal[srcRaw]
				tgt := neoToReal[tgtRaw]
				if src != "" && tgt != "" {
					addEdge(src, tgt, amt, "Local DB", 0, "")
				}
			}
		} else {
			log.Printf("⚠️  [NEO4J] unexpected edges type for %s", id)
		}
	}

	// 3. Live Esplora (Blockstream)
	liveTxs, _ := blockstream.GetAddressTxs(id)
	txIOs := make([]TransactionIO, 0, len(liveTxs))

	for _, tx := range liveTxs {
		addNode(tx.Txid, tx.Txid, "Transaction", "Esplora API", 0)

		timestamp := int64(0)
		if tx.Status.Confirmed && tx.Status.BlockTime > 0 {
			timestamp = tx.Status.BlockTime
		}

		tio := TransactionIO{
			Txid:      tx.Txid,
			Timestamp: timestamp,
		}

		for _, vin := range tx.Vin {
			if vin.Prevout == nil {
				tio.HasCoinbase = true
				continue
			}
			if vin.Prevout.ScriptPubKeyAddress != "" {
				addr := vin.Prevout.ScriptPubKeyAddress
				val := float64(vin.Prevout.Value) / 1e8
				addNode(addr, addr, "Address", "Esplora API", 0)
				addEdge(addr, tx.Txid, val, "Esplora API", timestamp, tx.Txid)
				tio.Inputs = append(tio.Inputs, TxInput{
					Address:  addr,
					Value:    val,
					Sequence: vin.Sequence,
				})
			}
		}
		for _, vout := range tx.Vout {
			if vout.ScriptPubKeyAddress != "" {
				addr := vout.ScriptPubKeyAddress
				val := float64(vout.Value) / 1e8
				addNode(addr, addr, "Address", "Esplora API", 0)
				addEdge(tx.Txid, addr, val, "Esplora API", timestamp, tx.Txid)
				tio.Outputs = append(tio.Outputs, TxOutput{
					Address:    addr,
					Value:      val,
					ScriptType: vout.ScriptPubKeyType,
				})
			}
		}
		txIOs = append(txIOs, tio)

		// Per-transaction mixer detection (Layer 1: IsCoinMixer)
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
			if n, ok := graph.Nodes[tx.Txid]; ok {
				n.MixerInfo = &det
				if risk := det.Confidence; risk > n.Risk {
					n.Risk = risk
				}
				graph.Nodes[tx.Txid] = n
				log.Printf("🔀 [MIXER-TX] %s — score=%.2f type=%s", tx.Txid, mr.Score, mr.MixerType)
			}
		}

		// Sweeper detection (Layer 3: Shojaeinasab et al. 2023, §3.4.2)
		sr := IsSweeperTransaction(tio)
		if sr.IsSweeper {
			if n, ok := graph.Nodes[tx.Txid]; ok {
				sweeperDet := &DetectionResult{
					IsMixer:     true,
					Confidence:  int(sr.Confidence * 100),
					Explanation: sr.Notes,
				}
				// Only override MixerInfo if not already set by a higher-confidence signal
				if n.MixerInfo == nil || sweeperDet.Confidence > n.MixerInfo.Confidence {
					n.MixerInfo = sweeperDet
				}
				if risk := sweeperDet.Confidence; risk > n.Risk {
					n.Risk = risk
				}
				n.EntityType = EntityMixer
				graph.Nodes[tx.Txid] = n
				log.Printf("🧹 [SWEEPER] %s — confidence=%.0f%% inputs=%d",
					tx.Txid, sr.Confidence*100, sr.InputCount)
			}
		}
	}

	// ── Address-level mixer detection (Layer 2: Wu et al. 2022) ──────────
	addrMix := IsMixingAddress(id, txIOs, defaultMixerThreshold)
	if addrMix.Flagged {
		if n, ok := graph.Nodes[id]; ok {
			n.EntityType = EntityMixer
			det := addrMix.ToDetectionResult()
			if n.MixerInfo == nil || det.Confidence > n.MixerInfo.Confidence {
				n.MixerInfo = det
			}
			if det.Confidence > n.Risk {
				n.Risk = det.Confidence
			}
			graph.Nodes[id] = n
			log.Printf("🔀 [MIXER-ADDR] %s — score=%.2f (Wu et al. 2022)", id, addrMix.Score)
		}
	}

	// ── Exchange detection ────────────────────────────────────────────────
	er := IsExchangeAddress(txIOs, defaultExchangeThreshold)
	if er.Flagged {
		if n, ok := graph.Nodes[id]; ok {
			n.EntityType = EntityExchange
			n.ExchInfo = &er
			log.Printf("🏦 [EXCHANGE] %s — score=%.2f", id, er.Score)
			graph.Nodes[id] = n
		}
	}

	// ── Gambling detection ────────────────────────────────────────────────
	gr := IsGamblingAddress(txIOs, defaultGamblingThreshold)
	if gr.Flagged {
		if n, ok := graph.Nodes[id]; ok {
			n.EntityType = EntityGambling
			n.GamblingInfo = &gr
			log.Printf("🎰 [GAMBLING] %s — score=%.2f", id, gr.Score)
			graph.Nodes[id] = n
		}
	}

	// ── Mining pool detection ─────────────────────────────────────────────
	miningR := IsMiningPoolAddress(txIOs, defaultMiningThreshold)
	if miningR.Flagged {
		if n, ok := graph.Nodes[id]; ok {
			n.EntityType = EntityMining
			n.MiningInfo = &miningR
			log.Printf("⛏️  [MINING] %s — score=%.2f", id, miningR.Score)
			graph.Nodes[id] = n
		}
	}

	// ── Peeling chain detection ───────────────────────────────────────────
	pc := DetectPeelingChain(txIOs)
	if pc.IsPeeling {
		if n, ok := graph.Nodes[id]; ok {
			n.Risk = intMax(n.Risk, int(pc.Confidence*80))
			graph.Nodes[id] = n
		}
		log.Printf("🔗 [PEEL CHAIN] %s — confidence=%.2f len=%d", id, pc.Confidence, pc.ChainLen)
	}

	// ── Co-spend clustering ───────────────────────────────────────────────
	clusters := BuildClusters(txIOs)
	for addr, cid := range clusters.AddrToCluster {
		members := clusters.Clusters[cid]
		if n, ok := graph.Nodes[addr]; ok && n.Type == "Address" {
			n.ClusterID = cid
			n.ClusterSize = len(members)
			graph.Nodes[addr] = n
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

	// ── Parallel external enrichment: Bitquery + ChainAbuse + WalletExplorer
	// All three are independent of each other and of the Blockstream data
	// already collected, so we fire them concurrently.
	type enrichResult struct {
		label    string
		riskData *intel.ChainAbuseRiskData
		flows    []bitquery.FlowEdge
		flowsErr error
	}
	enrichCh := make(chan enrichResult, 1)

	go func() {
		var r enrichResult
		var wg sync.WaitGroup
		var mu sync.Mutex

		wg.Add(1)
		go func() {
			defer wg.Done()
			lbl := intel.GetLabel(id)
			mu.Lock()
			r.label = lbl
			mu.Unlock()
		}()

		wg.Add(1)
		go func() {
			defer wg.Done()
			if caKey != "" {
				rd := intel.GetChainAbuseRisk(id, caKey)
				mu.Lock()
				r.riskData = rd
				mu.Unlock()
			}
		}()

		if bqKey != "" {
			wg.Add(1)
			go func() {
				defer wg.Done()
				flows, err := bitquery.GetWalletFlows(id, bqKey)
				mu.Lock()
				r.flows = flows
				r.flowsErr = err
				mu.Unlock()
			}()
		}

		wg.Wait()
		enrichCh <- r
	}()

	enrich := <-enrichCh

	// Apply Bitquery flows
	if enrich.flowsErr != nil {
		log.Printf("⚠️  [BITQUERY] %v", enrich.flowsErr)
	} else if len(enrich.flows) > 0 {
		log.Printf("📡 [BITQUERY] %d flow edges for %s", len(enrich.flows), id)
		for _, flow := range enrich.flows {
			addNode(flow.FromAddr, flow.FromAddr, "Address", "Bitquery", 0)
			addNode(flow.ToAddr, flow.ToAddr, "Address", "Bitquery", 0)
			if flow.TxHash != "" {
				addNode(flow.TxHash, flow.TxHash, "Transaction", "Bitquery", 0)
				addEdge(flow.FromAddr, flow.TxHash, flow.ValueBTC, "Bitquery", flow.Timestamp, flow.TxHash)
				addEdge(flow.TxHash, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp, flow.TxHash)
			} else {
				addEdge(flow.FromAddr, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp, "")
			}
		}
	}

	// Flush edge map
	for _, e := range edgeMap {
		graph.Edges = append(graph.Edges, e)
	}

	// Apply ChainAbuse + WalletExplorer intel
	if enrich.riskData != nil {
		riskScore := intel.CalculateRiskScore(enrich.riskData)
		if n, ok := graph.Nodes[id]; ok {
			n.Risk = riskScore
			n.RiskData = enrich.riskData
			if enrich.label != "" {
				n.Label = enrich.label
				n.EntityType = ResolveEntityType(enrich.label)
				n.Sources = append(n.Sources, "WalletExplorer")
			}
			n.Sources = append(n.Sources, "ChainAbuse")
			graph.Nodes[id] = n
			nodeImportance[id] += riskScore * 100
		}
	} else if enrich.label != "" {
		if n, ok := graph.Nodes[id]; ok {
			n.Label = enrich.label
			n.EntityType = ResolveEntityType(enrich.label)
			n.Sources = append(n.Sources, "WalletExplorer")
			graph.Nodes[id] = n
		}
	}

	// 6. Taint propagation
	PropagateTaint(&graph, 0.5)

	// 7. Build summary
	graph.Summary = buildSummary(graph)
	return graph
}

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

// intMax returns the larger of two ints.
// Named intMax rather than max to avoid shadowing the Go 1.21 builtin.
func intMax(a, b int) int {
	if a > b {
		return a
	}
	return b
}
