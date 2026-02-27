package tracer

import (
	"context"
	"math"
	"money-tracer/internal/blockstream"
	"money-tracer/internal/intel"
	"sort"
)

const DefaultMaxHops = 10

// Hop represents one step in a forward trace chain.
// Each hop is: currentAddress → sendingTx → nextAddress
type Hop struct {
	HopIndex  int     `json:"hop_index"`
	FromAddr  string  `json:"from_addr"`
	TxHash    string  `json:"tx_hash"`
	ToAddr    string  `json:"to_addr"`
	Amount    float64 `json:"amount"`
	Timestamp int64   `json:"timestamp"`
	Label     string  `json:"label,omitempty"`
	Risk      int     `json:"risk"`
	// Confidence that the ToAddr is the "real" destination (vs. change)
	DestConfidence string `json:"dest_confidence"` // "high" | "medium" | "low"
}

type TracePath struct {
	Start      string `json:"start"`
	Hops       []Hop  `json:"hops"`
	FinalAddr  string `json:"final_addr"`
	TotalHops  int    `json:"total_hops"`
	StopReason string `json:"stop_reason"`
}

// stopReasonLabel returns a human-readable explanation for why tracing stopped.
func StopReasonLabel(r string) string {
	switch r {
	case "utxo":
		return "Unspent output — likely final destination"
	case "high_risk":
		return "Stopped at high-risk / flagged address"
	case "known_service":
		return "Reached known exchange or service"
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
// an intentional payment rather than change.  We check common round increments
// down to 0.0001 BTC (10,000 sats).
func isRoundBTC(btc float64) bool {
	for _, step := range []float64{1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005, 0.001, 0.0001} {
		remainder := math.Mod(btc, step)
		if remainder/step < 0.001 || (step-remainder)/step < 0.001 {
			return true
		}
	}
	return false
}

type scoredOutput struct {
	vout  blockstream.Vout
	score int
	conf  string
}

// pickDestination applies three heuristics to choose the most likely "real"
// destination output from a transaction:
//
//  1. Fresh address — output address not seen in any input (strong signal, +4)
//  2. Round amount  — BTC value is a round number (+2)
//  3. Larger value  — among ties, prefer the bigger output (+1)
//
// Returns nil if no spendable outputs exist.
func pickDestination(tx blockstream.Tx, inputAddrs map[string]bool) *scoredOutput {
	var candidates []scoredOutput

	for _, vout := range tx.Vout {
		addr := vout.ScriptPubKeyAddress
		if addr == "" {
			continue // OP_RETURN, P2PK without decoded address, etc.
		}

		score := 0
		if !inputAddrs[addr] {
			score += 4 // fresh address
		}
		btc := float64(vout.Value) / 1e8
		if isRoundBTC(btc) {
			score += 2
		}
		if btc >= 0.001 {
			score += 1
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

	// Assign confidence label based on score
	switch {
	case best.score >= 6:
		best.conf = "high"
	case best.score >= 3:
		best.conf = "medium"
	default:
		best.conf = "low"
	}

	return best
}

// TraceForward follows BTC from startAddr forward hop-by-hop, applying
// change-detection heuristics at each transaction to find the most likely
// final destination address.
//
//   - maxHops: maximum number of address→tx→address hops to follow (default 10)
//   - caKey:   ChainAbuse API key (empty = skip risk scoring)
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
		//
		// Blockstream returns txs newest-first.  We scan for the first TX
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

		// ── 3. Collect all input addresses for change detection ──────────────
		inputAddrs := map[string]bool{}
		for _, vin := range sendingTx.Vin {
			if vin.Prevout != nil && vin.Prevout.ScriptPubKeyAddress != "" {
				inputAddrs[vin.Prevout.ScriptPubKeyAddress] = true
			}
		}

		// ── 4. Pick most likely destination output ───────────────────────────
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

		// ── 5. Enrich with label and optional risk scoring ───────────────────
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

		// ── 6. Stop conditions ───────────────────────────────────────────────
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
