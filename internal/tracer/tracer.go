package tracer

import (
	"context"
	"math"
	"money-tracer/internal/aggregator"
	"money-tracer/internal/intel"
	"money-tracer/internal/mempool"
	"sort"
)

const DefaultMaxHops = 10

// Hop represents one step in a forward trace chain.
type Hop struct {
	HopIndex       int     `json:"hop_index"`
	FromAddr       string  `json:"from_addr"`
	TxHash         string  `json:"tx_hash"`
	ToAddr         string  `json:"to_addr"`
	Amount         float64 `json:"amount"`
	Timestamp      int64   `json:"timestamp"`
	Label          string  `json:"label,omitempty"`
	Risk           int     `json:"risk"`
	DestConfidence string  `json:"dest_confidence"`          // "high" | "medium" | "low"
	IsPeelingHop   bool    `json:"is_peeling_hop,omitempty"` // true when peeling chain detected

	MixerScore float64              `json:"mixer_score,omitempty"`
	MixerType  aggregator.MixerType `json:"mixer_type,omitempty"`
}

type TracePath struct {
	Start      string `json:"start"`
	Hops       []Hop  `json:"hops"`
	FinalAddr  string `json:"final_addr"`
	TotalHops  int    `json:"total_hops"`
	StopReason string `json:"stop_reason"`
}

// StopReasonLabel returns a human-readable explanation for why tracing stopped.
func StopReasonLabel(r string) string {
	switch r {
	case "utxo":
		return "Unspent output — likely final destination"
	case "high_risk":
		return "Stopped at high-risk / flagged address"
	case "known_service":
		return "Reached known exchange or service"
	case "mixer_detected":
		return "Funds entered a coin mixer — trail obfuscated"
	case "cycle":
		return "Cycle detected — address reused in chain"
	case "max_hops":
		return "Maximum hop depth reached"
	case "no_outgoing_tx":
		return "No outgoing transactions found"
	case "no_destination":
		return "Could not determine destination output"
	case "timeout":
		return "Context deadline exceeded"
	default:
		return r
	}
}

// isRoundBTC returns true if a BTC value is "round" — a signal of intentional payment.
func isRoundBTC(btc float64) bool {
	for _, step := range []float64{1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005, 0.001, 0.0001} {
		remainder := math.Mod(btc, step)
		if remainder/step < 0.001 || (step-remainder)/step < 0.001 {
			return true
		}
	}
	return false
}

var scriptTypePriority = map[string]int{
	"p2tr":   5,
	"p2wpkh": 4,
	"p2wsh":  3,
	"p2sh":   2,
	"p2pkh":  1,
}

type scoredOutput struct {
	vout      mempool.Vout
	score     int
	conf      string
	isPeeling bool // set when this output was chosen via peeling heuristic
}

// pickDestination applies heuristics to choose the most likely "real"
// destination output from a transaction. The scoring rules are:
//
//  1. Peeling chain boost (+8) — 1-in 2-out with one output >70% of input.
//     The larger output is almost certainly the carried-forward change;
//     the smaller one is the payment. We give a large bonus to the LARGER
//     output (the "continuation") since the tracer follows the main chain.
//  2. Fresh address (+4)       — output address not seen in any input
//  3. Round amount (+2)        — BTC value is a round number
//  4. Larger value (+1)        — prefer bigger output on ties
//  5. Modern script (+1–5)     — Taproot/SegWit preferred over P2PKH
//
// Returns nil if no spendable outputs exist.
func pickDestination(tx mempool.Tx, inputAddrs map[string]bool) *scoredOutput {
	var candidates []scoredOutput

	// ── Peeling chain detection ────────────────────────────────
	// A peeling chain transaction has exactly 1 non-coinbase input and
	// exactly 2 outputs where one output carries the bulk of the value
	// forward (>70% of the total) — this is the "change" in peeling.
	// We give a large score bonus to the large output so it is reliably
	// chosen over the smaller "peeled" payment output.
	isPeelingTx, peelingLargeIdx := detectPeelingPattern(tx)

	for i, vout := range tx.Vout {
		addr := vout.ScriptPubKeyAddress
		if addr == "" || vout.ScriptPubKeyType == "op_return" {
			continue
		}

		score := 0
		isPeelingOut := false

		// Peeling boost: large output in a peel-chain tx gets a dominant bonus
		if isPeelingTx && i == peelingLargeIdx {
			score += 8 // overwhelms all other signals
			isPeelingOut = true
		}

		if !inputAddrs[addr] {
			score += 4
		}
		btc := float64(vout.Value) / 1e8
		if isRoundBTC(btc) {
			score += 2
		}
		if btc >= 0.001 {
			score += 1
		}
		if p, ok := scriptTypePriority[vout.ScriptPubKeyType]; ok {
			score += p
		}

		candidates = append(candidates, scoredOutput{vout, score, "", isPeelingOut})
	}

	if len(candidates) == 0 {
		return nil
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].vout.Value > candidates[j].vout.Value
	})

	best := &candidates[0]

	// Assign confidence — peeling hops are intrinsically high-confidence
	switch {
	case best.isPeeling:
		best.conf = "high"
	case best.score >= 7:
		best.conf = "high"
	case best.score >= 4:
		best.conf = "medium"
	default:
		best.conf = "low"
	}

	return best
}

// detectPeelingPattern identifies a "peel chain" transaction:
//   - Exactly 1 real input (non-coinbase)
//   - Exactly 2 non-OP_RETURN outputs
//   - One output is significantly larger (>70% of total output value)
//
// Returns (isPeeling bool, indexOfLargeOutput int).
// indexOfLargeOutput is -1 when isPeeling is false.
func detectPeelingPattern(tx mempool.Tx) (bool, int) {
	// Count real inputs (skip coinbase)
	realInputs := 0
	for _, vin := range tx.Vin {
		if vin.Prevout != nil {
			realInputs++
		}
	}
	if realInputs != 1 {
		return false, -1
	}

	// Filter spendable outputs
	type idxVal struct {
		idx int
		val int64
	}
	var spendable []idxVal
	for i, vout := range tx.Vout {
		if vout.ScriptPubKeyType == "op_return" || vout.ScriptPubKeyAddress == "" {
			continue
		}
		spendable = append(spendable, idxVal{i, vout.Value})
	}

	if len(spendable) != 2 {
		return false, -1
	}

	total := spendable[0].val + spendable[1].val
	if total == 0 {
		return false, -1
	}

	large := spendable[0]
	if spendable[1].val > spendable[0].val {
		large = spendable[1]
	}

	// The large output must be more than 70% of total to qualify as peeling
	ratio := float64(large.val) / float64(total)
	if ratio < 0.70 {
		return false, -1
	}

	return true, large.idx
}

// buildTransactionIO converts a mempool.Tx into the aggregator.TransactionIO
// format so we can run mixer-detection heuristics inline during tracing.
func buildTransactionIO(tx mempool.Tx) aggregator.TransactionIO {
	tio := aggregator.TransactionIO{
		Txid:      tx.Txid,
		Timestamp: tx.Status.BlockTime,
	}
	for _, vin := range tx.Vin {
		if vin.Prevout == nil {
			tio.HasCoinbase = true
			continue
		}
		tio.Inputs = append(tio.Inputs, aggregator.TxInput{
			Address:  vin.Prevout.ScriptPubKeyAddress,
			Value:    float64(vin.Prevout.Value) / 1e8,
			Sequence: vin.Sequence,
		})
	}
	for _, vout := range tx.Vout {
		tio.Outputs = append(tio.Outputs, aggregator.TxOutput{
			Address:    vout.ScriptPubKeyAddress,
			Value:      float64(vout.Value) / 1e8,
			ScriptType: vout.ScriptPubKeyType,
		})
	}
	return tio
}

// TraceForward follows BTC from startAddr forward hop-by-hop, applying
// change-detection heuristics at each transaction to find the most likely
// final destination address.
func TraceForward(ctx context.Context, startAddr string, caKey string, maxHops int) TracePath {
	if maxHops <= 0 {
		maxHops = DefaultMaxHops
	}

	path := TracePath{
		Start: startAddr,
		Hops:  []Hop{},
	}

	visited := map[string]bool{startAddr: true}
	currentAddr := startAddr

	for i := 0; i < maxHops; i++ {
		select {
		case <-ctx.Done():
			path.StopReason = "timeout"
			path.FinalAddr = currentAddr
			path.TotalHops = len(path.Hops)
			return path
		default:
		}

		// 1. Fetch live transactions for the current address
		txs, err := mempool.GetAddressTxs(currentAddr)
		if err != nil || len(txs) == 0 {
			path.StopReason = "no_outgoing_tx"
			break
		}

		// 2. Find the most recent TX where this address is a SENDER
		var sendingTx *mempool.Tx
		for idx := range txs {
			for _, vin := range txs[idx].Vin {
				if vin.Prevout != nil && vin.Prevout.ScriptPubKeyAddress == currentAddr {
					sendingTx = &txs[idx]
					break
				}
			}
			if sendingTx != nil {
				break
			}
		}

		if sendingTx == nil {
			path.StopReason = "utxo"
			break
		}

		// 3. Run mixer detection
		tio := buildTransactionIO(*sendingTx)
		mixerResult := aggregator.IsCoinMixer(tio, 0.70)
		if mixerResult.Flagged {
			hop := Hop{
				HopIndex:       i + 1,
				FromAddr:       currentAddr,
				TxHash:         sendingTx.Txid,
				ToAddr:         "",
				MixerScore:     mixerResult.Score,
				MixerType:      mixerResult.MixerType,
				DestConfidence: "low",
			}
			if sendingTx.Status.Confirmed {
				hop.Timestamp = sendingTx.Status.BlockTime
			}
			path.Hops = append(path.Hops, hop)
			path.StopReason = "mixer_detected"
			break
		}

		// 4. Collect all input addresses for change detection
		inputAddrs := map[string]bool{}
		for _, vin := range sendingTx.Vin {
			if vin.Prevout != nil && vin.Prevout.ScriptPubKeyAddress != "" {
				inputAddrs[vin.Prevout.ScriptPubKeyAddress] = true
			}
		}

		// 5. Pick most likely destination output (with peeling chain awareness)
		dest := pickDestination(*sendingTx, inputAddrs)
		if dest == nil {
			path.StopReason = "no_destination"
			break
		}

		nextAddr := dest.vout.ScriptPubKeyAddress
		amount := float64(dest.vout.Value) / 1e8

		var ts int64
		if sendingTx.Status.Confirmed {
			ts = sendingTx.Status.BlockTime
		}

		// 6. Enrich with label and optional risk scoring
		label := intel.GetLabel(nextAddr)
		var risk int
		if caKey != "" {
			riskData := intel.GetChainAbuseRisk(nextAddr, caKey)
			risk = intel.CalculateRiskScore(riskData)
		}

		hop := Hop{
			HopIndex:       i + 1,
			FromAddr:       currentAddr,
			TxHash:         sendingTx.Txid,
			ToAddr:         nextAddr,
			Amount:         amount,
			Timestamp:      ts,
			Label:          label,
			Risk:           risk,
			DestConfidence: dest.conf,
			IsPeelingHop:   dest.isPeeling,
		}
		path.Hops = append(path.Hops, hop)

		// 7. Stop conditions
		if risk >= 50 {
			path.StopReason = "high_risk"
			currentAddr = nextAddr
			break
		}
		if label != "" {
			path.StopReason = "known_service"
			currentAddr = nextAddr
			break
		}
		if visited[nextAddr] {
			path.StopReason = "cycle"
			currentAddr = nextAddr
			break
		}

		visited[nextAddr] = true
		currentAddr = nextAddr
	}

	if path.StopReason == "" {
		path.StopReason = "max_hops"
	}

	path.FinalAddr = currentAddr
	path.TotalHops = len(path.Hops)
	return path
}
