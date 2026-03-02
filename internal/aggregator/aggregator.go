package aggregator

import (
	"context"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
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
	MixerInfo  *DetectionResult         `json:"mixer_info,omitempty"`
	ExchInfo   *ExchangeResult           `json:"exchange_info,omitempty"`
	HopDepth   int                       `json:"hop_depth"`
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

// MixerType identifies specific mixing services/protocols.
type MixerType string

const (
	MixerUnknown     MixerType = "Unknown"
	MixerWasabi      MixerType = "Wasabi Wallet (CoinJoin)"
	MixerJoinMarket  MixerType = "JoinMarket"
	MixerWhirlpool   MixerType = "Whirlpool (Samourai)"
	MixerJoinMosaic  MixerType = "JoinMosaic"
	MixerCentralized MixerType = "Centralized Mixer"
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
}

type TxInput struct {
	Address  string
	Value    float64 // BTC
	Sequence uint32
}

type TxOutput struct {
	Address    string
	Value      float64 // BTC
	ScriptType string  // p2pkh, p2wpkh, p2sh, p2wsh, p2tr, op_return
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
// with a human-friendly confidence score and explanation. This
// helps avoid simply presenting a binary "mixer" label to users
// without context.
type DetectionResult struct {
	IsMixer     bool   `json:"is_mixer"`
	Confidence  int    `json:"confidence"` // 0-100
	Explanation string `json:"explanation"`
	Raw         MixerResult `json:"raw,omitempty"`
}

const defaultMixerThreshold = 0.70

// IsCoinMixer performs multi-rule heuristic analysis to detect mixing transactions.
// Returns score in [0,1], flagged status, and a full MixerResult.
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

	if len(outputs) == 0 {
		result.Notes = append(result.Notes, "No outputs — cannot analyse")
		return result
	}

	// ── collect non-dust output values ──────────────────────────
	const dustThreshold = 0.00001 // 1000 sat
	cleanOutputs := make([]float64, 0, len(outputs))
	for _, o := range outputs {
		if o.Value >= dustThreshold && o.ScriptType != "op_return" {
			cleanOutputs = append(cleanOutputs, o.Value)
		}
	}
	if len(cleanOutputs) == 0 {
		result.Notes = append(result.Notes, "Only dust/OP_RETURN outputs")
		return result
	}

	// ── round to 4 dp for BTC ──────────────────────────────────
	rounded := make([]float64, len(cleanOutputs))
	for i, a := range cleanOutputs {
		rounded[i] = math.Round(a*10000) / 10000.0
	}

	// most common output value
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

	// ── RULE 1: Equal Output Amounts  (0.45) ─────────────────
	equalRatio := float64(maxCount) / float64(len(rounded))
	if equalRatio > 0.5 {
		result.Breakdown["equal_outputs"] = 0.45 * equalRatio
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%.1f%% of outputs share value %.8f BTC", equalRatio*100, mostCommon))
	}

	// ── RULE 2: Participant Scale  (0.20) ──────────────────────
	inputCount := len(inputs)
	outputCount := len(outputs)
	if inputCount >= 5 && outputCount >= 5 {
		// use divisor 50 so smaller JoinMarket rounds still score well
		ps := math.Min(float64(inputCount+outputCount)/50.0, 1.0)
		result.Breakdown["participant_count"] = 0.20 * ps
		result.Notes = append(result.Notes, fmt.Sprintf(
			"%d inputs / %d outputs", inputCount, outputCount))
	}

	// ── RULE 3: Input/Output Count Symmetry  (0.15) ───────────
	if inputCount > 0 && outputCount > 0 {
		sym := math.Min(float64(inputCount), float64(outputCount)) /
			math.Max(float64(inputCount), float64(outputCount))
		if sym > 0.75 {
			result.Breakdown["io_symmetry"] = 0.15 * sym
		}
	}

	// ── RULE 4: Known Denomination  (0.10) ────────────────────
	type denomInfo struct{ name string }
	knownDenoms := map[float64]denomInfo{
		0.1:    {"Wasabi standard"},
		0.01:   {"Wasabi/JoinMarket"},
		0.001:  {"Wasabi small"},
		1.0:    {"Centralized mixer"},
		0.0001: {"Micro-mix"},
	}
	if di, ok := knownDenoms[mostCommon]; ok {
		result.Breakdown["known_denom"] = 0.10
		result.Notes = append(result.Notes, "Known denomination: "+di.name)
	}

	// ── RULE 5: No / Minimal Change  (0.10) ───────────────────
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
		result.Notes = append(result.Notes, "Zero change outputs")
	case oddRatio < 0.15:
		result.Breakdown["no_change"] = 0.05
	}

	// ── RULE 6: Uniform Script Types  (0.08) ──────────────────
	// Mixers enforce homogeneous script types to prevent fingerprinting
	scriptCounts := make(map[string]int)
	for _, o := range outputs {
		if o.ScriptType != "" && o.ScriptType != "op_return" {
			scriptCounts[o.ScriptType]++
		}
	}
	if len(scriptCounts) == 1 && len(outputs) > 5 {
		result.Breakdown["uniform_scripts"] = 0.08
		for st := range scriptCounts {
			result.Notes = append(result.Notes, "All outputs use script type: "+st)
		}
	}

	// ── RULE 7: Address Reuse Absence  (0.06) ─────────────────
	// CoinJoin outputs almost never reuse addresses
	inputAddrs := make(map[string]struct{})
	for _, inp := range inputs {
		if inp.Address != "" {
			inputAddrs[inp.Address] = struct{}{}
		}
	}
	reused := 0
	for _, o := range outputs {
		if _, ok := inputAddrs[o.Address]; ok {
			reused++
		}
	}
	if reused == 0 && len(inputs) >= 5 {
		result.Breakdown["no_addr_reuse"] = 0.06
	}

	// ── RULE 8: Distinct Input Amounts  (0.06) ────────────────
	// Each participant brings a different input amount
	if inputCount >= 5 {
		uniqueInputVals := make(map[float64]struct{})
		for _, inp := range inputs {
			uniqueInputVals[math.Round(inp.Value*10000)/10000.0] = struct{}{}
		}
		uniqueRatio := float64(len(uniqueInputVals)) / float64(inputCount)
		if uniqueRatio > 0.8 {
			result.Breakdown["distinct_inputs"] = 0.06 * uniqueRatio
		}
	}

	// ── RULE 9: RBF Disabled on all inputs  (0.05) ────────────
	// Wasabi sets nSequence = 0xFFFFFFFE (RBF opt-in disabled)
	rbfDisabled := 0
	for _, inp := range inputs {
		if inp.Sequence == 0xFFFFFFFE || inp.Sequence == 0xFFFFFFFF {
			rbfDisabled++
		}
	}
	if inputCount > 0 {
		if float64(rbfDisabled)/float64(inputCount) > 0.9 {
			result.Breakdown["rbf_disabled"] = 0.05
		}
	}

	// ── RULE 10: Output Value Entropy  (bonus 0.05) ───────────
	// Many distinct equal outputs → high Shannon entropy
	entropy := shannonEntropy(rounded)
	if entropy > 3.0 && equalRatio > 0.6 {
		result.Breakdown["high_entropy"] = 0.05
	}

	// ── Aggregate score ────────────────────────────────────────
	var total float64
	for _, v := range result.Breakdown {
		total += v
	}
	result.Score = math.Min(total, 1.0)
	result.Flagged = result.Score >= threshold

	// ── Classify mixer type ────────────────────────────────────
	result.MixerType = classifyMixer(tx, mostCommon, inputCount, result.Breakdown)

	return result
}

// classifyMixer uses denomination + structural signals to guess the specific protocol.
func classifyMixer(tx TransactionIO, denom float64, inputCount int, breakdown map[string]float64) MixerType {
	_, hasDenom := breakdown["known_denom"]

	// Whirlpool: fixed pool sizes 0.001 / 0.01 / 0.05 / 0.5, always 5 inputs + 5 outputs
	whirlpoolDenoms := map[float64]bool{0.001: true, 0.01: true, 0.05: true, 0.5: true}
	if whirlpoolDenoms[denom] && inputCount == 5 && len(tx.Outputs) == 5 {
		return MixerWhirlpool
	}

	// Wasabi: denom 0.1 BTC, large rounds, native segwit outputs
	if hasDenom && denom == 0.1 && inputCount >= 50 {
		return MixerWasabi
	}

	// JoinMarket: smaller rounds, varied denoms
	if hasDenom && inputCount >= 3 && inputCount < 50 {
		return MixerJoinMarket
	}

	// Centralized: denom 1.0 BTC exactly, fewer participants
	if denom == 1.0 && inputCount < 10 {
		return MixerCentralized
	}

	// Generic CoinJoin fallback
	if breakdown["equal_outputs"] > 0 && breakdown["participant_count"] > 0 {
		return MixerCoinjoin
	}

	return MixerUnknown
}

// shannonEntropy computes the Shannon entropy of a value distribution.
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

// ExchangeResult holds exchange detection heuristic output.
type ExchangeResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	Notes     []string           `json:"notes"`
	Breakdown map[string]float64 `json:"breakdown"`
}

const defaultExchangeThreshold = 0.60

// IsExchangeAddress applies heuristics to detect exchange/custodial hot-wallet behaviour.
// It analyses a slice of transactions associated with a single address.
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

	// ── RULE 1: UTXO Consolidation Sweeps  (0.30) ─────────────
	// Exchanges regularly sweep many small deposits → one large output
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

	// ── RULE 2: High Transaction Frequency  (0.20) ────────────
	// Exchanges handle many txs per day
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

	// ── RULE 3: Fan-Out Pattern  (0.20) ───────────────────────
	// Exchanges send to many distinct addresses (withdrawals)
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

	// ── RULE 4: Mixed Script Types  (0.15) ────────────────────
	// Exchanges receive from all wallet types (P2PKH, P2WPKH, P2TR …)
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

	// ── RULE 5: Round-Number Withdrawals  (0.15) ──────────────
	// Exchanges often process user withdrawals in round BTC amounts
	roundCount := 0
	totalOuts := 0
	for _, tx := range txs {
		for _, o := range tx.Outputs {
			totalOuts++
			scaled := o.Value * 100 // check for multiples of 0.01 BTC
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

// PeelingChainResult describes a detected peel-chain pattern.
type PeelingChainResult struct {
	IsPeeling  bool    `json:"is_peeling"`
	Confidence float64 `json:"confidence"`
	ChainLen   int     `json:"chain_length"`
	Notes      string  `json:"notes"`
}

// DetectPeelingChain looks for a sequence of transactions where one output
// is markedly smaller than the input (the "peel") and one output is change.
// This pattern is used by both mixers and trackers to obfuscate fund flow.
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
		// If one output is significantly smaller (peel) and one is change
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

// PropagateTaint walks the graph from any high-risk node and applies a
// decaying taint score to downstream nodes. Taint halves every hop.
func PropagateTaint(graph *UnifiedGraph, decayPerHop float64) {
	if decayPerHop <= 0 || decayPerHop >= 1 {
		decayPerHop = 0.5
	}

	// Build adjacency: node → []outgoing edges
	adj := make(map[string][]ProvenanceEdge)
	for _, e := range graph.Edges {
		adj[e.Source] = append(adj[e.Source], e)
	}

	// Seed: every node with risk > 70 starts with taint = 1.0
	taint := make(map[string]float64)
	for id, n := range graph.Nodes {
		if n.Risk >= 70 {
			taint[id] = 1.0
		}
	}

	// BFS propagation
	queue := make([]string, 0)
	for id := range taint {
		queue = append(queue, id)
	}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
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

	// Write taint back to edges and nodes
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

// knownLabels maps substrings (lowercase) to EntityType.
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
	{"mining", EntityMining},
	{"f2pool", EntityMining},
	{"antpool", EntityMining},
	{"slushpool", EntityMining},
	{"uniswap", EntityDefi},
	{"aave", EntityDefi},
	{"compound", EntityDefi},
}

// ResolveEntityType infers EntityType from a label string.
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

	addEdge := func(src, tgt string, amt float64, source string, timestamp int64) {
		key := fmt.Sprintf("%s|%s|%.8f", src, tgt, amt)
		if e, ok := edgeMap[key]; ok {
			for _, s := range e.Sources {
				if s == source {
					return
				}
			}
			e.Sources = append(e.Sources, source)
			edgeMap[key] = e
		} else {
			edgeMap[key] = ProvenanceEdge{
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

	// 2. Local Neo4j
	neoToReal := make(map[string]string)
	if history, err := db.GetMoneyFlow(ctx, id); err == nil && history != nil {
		for eid, node := range history["nodes"].(map[string]interface{}) {
			n := node.(map[string]interface{})
			realID := n["label"].(string)
			neoToReal[eid] = realID
			addNode(realID, realID, n["type"].(string), "Local DB", 0)
		}
		for _, edge := range history["edges"].([]interface{}) {
			e := edge.(map[string]interface{})
			src := neoToReal[e["source"].(string)]
			tgt := neoToReal[e["target"].(string)]
			if src != "" && tgt != "" {
				addEdge(src, tgt, e["amount"].(float64), "Local DB", 0)
			}
		}
	}

	// 3. Live Esplora (Blockstream) — build TransactionIO list for heuristics
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
			if vin.Prevout != nil && vin.Prevout.ScriptPubKeyAddress != "" {
				addr := vin.Prevout.ScriptPubKeyAddress
				val := float64(vin.Prevout.Value) / 1e8
				addNode(addr, addr, "Address", "Esplora API", 0)
				addEdge(addr, tx.Txid, val, "Esplora API", timestamp)
				tio.Inputs = append(tio.Inputs, TxInput{
					Address:  addr,
					Value:    val,
					Sequence: 0,
				})
			}
		}
		for _, vout := range tx.Vout {
			if vout.ScriptPubKeyAddress != "" {
				addr := vout.ScriptPubKeyAddress
				val := float64(vout.Value) / 1e8
				addNode(addr, addr, "Address", "Esplora API", 0)
				addEdge(tx.Txid, addr, val, "Esplora API", timestamp)
				tio.Outputs = append(tio.Outputs, TxOutput{
					Address:    addr,
					Value:      val,
					ScriptType: "",
				})
			}
		}
		txIOs = append(txIOs, tio)

		// ── per-transaction mixer detection ─────────────────────
		mr := IsCoinMixer(tio, defaultMixerThreshold)
		det := DetectionResult{
			IsMixer:    mr.Flagged,
			Confidence: int(math.Round(mr.Score * 100)),
			Raw:        mr,
		}
		// Build a concise explanation from available notes.
		if len(mr.Notes) > 0 {
			det.Explanation = strings.Join(mr.Notes, "; ")
		} else if mr.Score > 0 {
			det.Explanation = fmt.Sprintf("Heuristic score %.2f", mr.Score)
		} else {
			det.Explanation = "No clear mixer signals"
		}

		if mr.Flagged {
			if n, ok := graph.Nodes[tx.Txid]; ok {
				// Do not mark the transaction node itself as an "EntityMixer";
				// instead attach mixer detection info with confidence and
				// explanation so the UI can present context to users. Only
				// promote risk level (numeric) but avoid changing entity type
				// which can be misleading.
				n.MixerInfo = &det
				risk := det.Confidence
				if risk > n.Risk {
					n.Risk = risk
				}
				graph.Nodes[tx.Txid] = n
				log.Printf("🔀 [MIXER] %s — score=%.2f type=%s conf=%d", tx.Txid, mr.Score, mr.MixerType, det.Confidence)
			}
		}
	}

	// ── exchange detection across all txs for this address ──────
	er := IsExchangeAddress(txIOs, defaultExchangeThreshold)
	if er.Flagged {
		if n, ok := graph.Nodes[id]; ok {
			n.EntityType = EntityExchange
			n.ExchInfo = &er
			log.Printf("🏦 [EXCHANGE] %s — score=%.2f", id, er.Score)
			graph.Nodes[id] = n
		}
	}

	// ── peeling chain detection ──────────────────────────────────
	pc := DetectPeelingChain(txIOs)
	if pc.IsPeeling {
		if n, ok := graph.Nodes[id]; ok {
			n.Risk = max(n.Risk, int(pc.Confidence*80))
			graph.Nodes[id] = n
		}
		log.Printf("🔗 [PEEL CHAIN] %s — confidence=%.2f len=%d", id, pc.Confidence, pc.ChainLen)
	}

	// 4. Bitquery inflows + outflows
	if bqKey != "" {
		flows, err := bitquery.GetWalletFlows(id, bqKey)
		if err != nil {
			log.Printf("⚠️  [BITQUERY] %v", err)
		} else {
			log.Printf("📡 [BITQUERY] %d flow edges for %s", len(flows), id)
			for _, flow := range flows {
				addNode(flow.FromAddr, flow.FromAddr, "Address", "Bitquery", 0)
				addNode(flow.ToAddr, flow.ToAddr, "Address", "Bitquery", 0)
				if flow.TxHash != "" {
					addNode(flow.TxHash, flow.TxHash, "Transaction", "Bitquery", 0)
					addEdge(flow.FromAddr, flow.TxHash, flow.ValueBTC, "Bitquery", flow.Timestamp)
					addEdge(flow.TxHash, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp)
				} else {
					addEdge(flow.FromAddr, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp)
				}
			}
		}
	}

	// Flush edge map
	for _, e := range edgeMap {
		graph.Edges = append(graph.Edges, e)
	}

	// 5. Intel enrichment (ChainAbuse + WalletExplorer)
	label := intel.GetLabel(id)
	riskData := intel.GetChainAbuseRisk(id, caKey)

	if riskData != nil {
		riskScore := intel.CalculateRiskScore(riskData)
		if n, ok := graph.Nodes[id]; ok {
			n.Risk = riskScore
			n.RiskData = riskData
			if label != "" {
				n.Label = label
				n.EntityType = ResolveEntityType(label)
				n.Sources = append(n.Sources, "WalletExplorer")
			}
			n.Sources = append(n.Sources, "ChainAbuse")
			graph.Nodes[id] = n
			nodeImportance[id] += riskScore * 100
		}
	} else if label != "" {
		if n, ok := graph.Nodes[id]; ok {
			n.Label = label
			n.EntityType = ResolveEntityType(label)
			n.Sources = append(n.Sources, "WalletExplorer")
			graph.Nodes[id] = n
		}
	}

	// 6. Taint propagation across the full graph
	PropagateTaint(&graph, 0.5)

	// 7. Build summary
	graph.Summary = buildSummary(graph)

	return graph
}

// buildSummary computes aggregate statistics over the final graph.
func buildSummary(g UnifiedGraph) GraphSummary {
	s := GraphSummary{
		TotalNodes: len(g.Nodes),
		TotalEdges: len(g.Edges),
	}
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
		if n.Risk > 0 && n.Risk < 70 {
			s.TaintedCount++ // derived taint, not direct report
		}
	}
	return s
}

// max is a helper since Go < 1.21 has no builtin max for int.
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
