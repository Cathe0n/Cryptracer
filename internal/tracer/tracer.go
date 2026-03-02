package tracer

import (
	"context"
	"math"
	"money-tracer/internal/aggregator"
	"money-tracer/internal/blockstream"
	"money-tracer/internal/intel"
	"sort"
)

const DefaultMaxHops = 10

// Hop represents one step in a forward trace chain.
// Each hop is: currentAddress → sendingTx → nextAddress
type Hop struct {
	HopIndex       int     `json:"hop_index"`
	FromAddr       string  `json:"from_addr"`
	TxHash         string  `json:"tx_hash"`
	ToAddr         string  `json:"to_addr"`
	Amount         float64 `json:"amount"`
	Timestamp      int64   `json:"timestamp"`
	Label          string  `json:"label,omitempty"`
	Risk           int     `json:"risk"`
	DestConfidence string  `json:"dest_confidence"` // "high" | "medium" | "low"

	// MixerScore is set when a CoinJoin/mixer transaction is detected on this hop.
	// A non-zero value means the trace was halted because funds entered a mixer.
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

// isRoundBTC returns true if a BTC value is "round" — a signal that it's
// an intentional payment rather than change.
func isRoundBTC(btc float64) bool {
	for _, step := range []float64{1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005, 0.001, 0.0001} {
		remainder := math.Mod(btc, step)
		if remainder/step < 0.001 || (step-remainder)/step < 0.001 {
			return true
		}
	}
	return false
}

// scriptTypePriority ranks script types by how "modern" they are.
// Outputs with newer, more common script types are preferred as real payments
// versus change outputs which sometimes use older types.
var scriptTypePriority = map[string]int{
	"p2tr":   5, // Taproot — modern, unambiguously intentional
	"p2wpkh": 4, // Native SegWit — most common modern payment type
	"p2wsh":  3, // SegWit script hash — multi-sig / contract
	"p2sh":   2, // Legacy SegWit wrapped
	"p2pkh":  1, // Legacy — oldest, often change
}

type scoredOutput struct {
	vout  blockstream.Vout
	score int
	conf  string
}

// pickDestination applies heuristics to choose the most likely "real"
// destination output from a transaction:
//
//  1. Fresh address (+4) — output address not seen in any input
//  2. Round amount (+2)  — BTC value is a round number
//  3. Larger value (+1)  — prefer bigger output on ties
//  4. Modern script (+1) — Taproot/SegWit outputs preferred over P2PKH
//
// Returns nil if no spendable outputs exist.
func pickDestination(tx blockstream.Tx, inputAddrs map[string]bool) *scoredOutput {
	var candidates []scoredOutput

	for _, vout := range tx.Vout {
		addr := vout.ScriptPubKeyAddress
		// Skip OP_RETURN and undecodable outputs
		if addr == "" || vout.ScriptPubKeyType == "op_return" {
			continue
		}

		score := 0
		if !inputAddrs[addr] {
			score += 4 // fresh address — strongest signal
		}
		btc := float64(vout.Value) / 1e8
		if isRoundBTC(btc) {
			score += 2
		}
		if btc >= 0.001 {
			score += 1 // non-dust
		}
		if p, ok := scriptTypePriority[vout.ScriptPubKeyType]; ok {
			score += p // favour modern script types
		}

		candidates = append(candidates, scoredOutput{vout, score, ""})
	}

	if len(candidates) == 0 {
		return nil
	}

	// Sort: higher score first, then higher value as tiebreaker
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].vout.Value > candidates[j].vout.Value
	})

	best := &candidates[0]

	// Assign confidence label
	switch {
	case best.score >= 7:
		best.conf = "high"
	case best.score >= 4:
		best.conf = "medium"
	default:
		best.conf = "low"
	}

	return best
}

// buildTransactionIO converts a blockstream.Tx into the aggregator.TransactionIO
// format so we can run mixer-detection heuristics inline during tracing.
func buildTransactionIO(tx blockstream.Tx) aggregator.TransactionIO {
	tio := aggregator.TransactionIO{
		Txid:      tx.Txid,
		Timestamp: tx.Status.BlockTime,
	}
	for _, vin := range tx.Vin {
		if vin.Prevout == nil {
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
//
//   - maxHops: maximum number of address→tx→address hops (default 10)
//   - caKey:   ChainAbuse API key (empty = skip risk scoring)
//
// Tracing stops early when funds enter a mixer, reach a known service,
// hit a high-risk address, or encounter a cycle.
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
		// Honour context cancellation / deadline
		select {
		case <-ctx.Done():
			path.StopReason = "timeout"
			path.FinalAddr = currentAddr
			path.TotalHops = len(path.Hops)
			return path
		default:
		}

		// ── 1. Fetch live transactions for the current address ──────────────
		txs, err := blockstream.GetAddressTxs(currentAddr)
		if err != nil || len(txs) == 0 {
			path.StopReason = "no_outgoing_tx"
			break
		}

		// ── 2. Find the most recent TX where this address is a SENDER ───────
		// Blockstream returns txs newest-first. We scan for the first TX
		// that has an input whose prevout address matches currentAddr.
		var sendingTx *blockstream.Tx
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

		// No outgoing TX found → all UTXOs are unspent, this is the end
		if sendingTx == nil {
			path.StopReason = "utxo"
			break
		}

		// ── 3. Run mixer detection on this transaction ───────────────────────
		// If the sending transaction looks like a CoinJoin, flag the hop and stop.
		// Continuing past a mixer is meaningless — we can't follow the funds.
		tio := buildTransactionIO(*sendingTx)
		mixerResult := aggregator.IsCoinMixer(tio, 0.70)
		if mixerResult.Flagged {
			// Record the mixer hop with zero destination (funds are obfuscated)
			hop := Hop{
				HopIndex:       i + 1,
				FromAddr:       currentAddr,
				TxHash:         sendingTx.Txid,
				ToAddr:         "", // can't determine — mixed
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

		// ── 4. Collect all input addresses for change detection ──────────────
		inputAddrs := map[string]bool{}
		for _, vin := range sendingTx.Vin {
			if vin.Prevout != nil && vin.Prevout.ScriptPubKeyAddress != "" {
				inputAddrs[vin.Prevout.ScriptPubKeyAddress] = true
			}
		}

		// ── 5. Pick most likely destination output ───────────────────────────
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

		// ── 6. Enrich with label and optional risk scoring ───────────────────
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
		}
		path.Hops = append(path.Hops, hop)

		// ── 7. Stop conditions ───────────────────────────────────────────────
		if risk >= 50 {
			path.StopReason = "high_risk"
			currentAddr = nextAddr
			break
		}
		if label != "" {
			// Reached an identified service (exchange, mixer, etc.) — end of trail
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
