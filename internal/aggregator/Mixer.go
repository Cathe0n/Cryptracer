package aggregator

// mixer_enhanced.go — Enhanced mixing detection
//
// Implements two additional detection layers on top of the existing
// single-transaction heuristics in aggregator.go:
//
//  Layer 2 — Address-level behavioural analysis (Wu et al., 2022)
//    Wu, J., Liu, J., Chen, W., Huang, H., Zheng, Z., Zhang, Y.
//    "Detecting Mixing Services via Mining Bitcoin Transaction Network
//    With Hybrid Motifs." IEEE TSMC, 2022.
//    doi:10.1109/TSMC.2021.3049278
//
//  Layer 3 — Sweeper transaction detection (Shojaeinasab et al., 2023)
//    Shojaeinasab, A., Motamed, A.P., Bahrak, B.
//    "Mixing detection on Bitcoin transactions using statistical patterns."
//    IET Blockchain, 2023. doi:10.1049/blc2.12036

import (
	"fmt"
	"math"
	"sort"
)

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

// AddressMixingFeatures exposes the extracted Wu et al. feature values for
// explainability and downstream scoring.
type AddressMixingFeatures struct {
	// ── Account features (Wu et al. §IV-B, AF1–AF6) ─────────────────────
	AF1InputTxCount  int     `json:"af1_input_tx_count"`
	AF2OutputTxCount int     `json:"af2_output_tx_count"`
	AF3IoTxRatio     float64 `json:"af3_io_tx_ratio"`
	AF4TotalReceived float64 `json:"af4_total_received_btc"`
	AF5TotalSent     float64 `json:"af5_total_sent_btc"`
	// AF6 ~1.0 for mixers: "amount out ≈ amount in" (Finding 5)
	AF6IoAmtRatio float64 `json:"af6_io_amount_ratio"`

	// ── Transaction features (Wu et al. §IV-C, TF1–TF6) ─────────────────
	// TF1: std deviation of per-cycle balance → 0 for intermediaries (Finding 7)
	TF1CycleBalanceMean float64 `json:"tf1_cycle_balance_mean_btc"`
	TF1CycleBalanceStd  float64 `json:"tf1_cycle_balance_std_btc"`
	// TF2: avg cycle duration in seconds; mixers mostly < 3 h (Finding 6)
	TF2AvgCycleDurSec float64 `json:"tf2_avg_cycle_dur_sec"`
	// TF3 > TF4 is a mixer signal — coins are obfuscated with others (Finding 7)
	TF3AvgCoInputAddrs  float64 `json:"tf3_avg_co_input_addrs"`
	TF4AvgCoOutputAddrs float64 `json:"tf4_avg_co_output_addrs"`
	TF5UniqueCoInputs   int     `json:"tf5_unique_co_inputs"`
	TF6UniqueCoOutputs  int     `json:"tf6_unique_co_outputs"`

	// ── Temporal ordering (Wu et al. §IV-A, AAIN motifs) ─────────────────
	// a1: receive-then-send within δ=3 h; a2: send-then-receive
	// Mixers: a1 fraction significantly > a2 fraction (Finding 1)
	A1Count    int     `json:"a1_count"`
	A2Count    int     `json:"a2_count"`
	A1Fraction float64 `json:"a1_receive_first_fraction"`

	// ── Address reuse (Wu et al. Finding 2) ──────────────────────────────
	CoAddrReuseRatio float64 `json:"co_addr_reuse_ratio"`

	CycleCount int `json:"cycle_count"`
}

// AddressMixingResult is the output of IsMixingAddress.
type AddressMixingResult struct {
	Score     float64               `json:"score"`
	Flagged   bool                  `json:"flagged"`
	Notes     []string              `json:"notes"`
	Breakdown map[string]float64    `json:"breakdown"`
	Features  AddressMixingFeatures `json:"features"`
}

// ToDetectionResult converts to the DetectionResult type used in ProvenanceNode.
func (r AddressMixingResult) ToDetectionResult() *DetectionResult {
	exp := "Address-level behavioural mixing signal (Wu et al. 2022)"
	if len(r.Notes) > 0 {
		exp = r.Notes[0]
	}
	return &DetectionResult{
		IsMixer:     r.Flagged,
		Confidence:  int(math.Round(r.Score * 100)),
		Explanation: exp,
	}
}

// SweeperResult holds the output of IsSweeperTransaction.
type SweeperResult struct {
	IsSweeper        bool    `json:"is_sweeper"`
	Confidence       float64 `json:"confidence"`
	InputCount       int     `json:"input_count"`
	OutputCount      int     `json:"output_count"`
	TotalValueIn     float64 `json:"total_value_in_btc"`
	InputMedianValue float64 `json:"input_median_value_btc"`
	Notes            string  `json:"notes"`
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — ADDRESS-LEVEL DETECTION (Wu et al., 2022)
// ─────────────────────────────────────────────────────────────────────────────

// IsMixingAddress implements Wu et al. (2022) §IV multi-level feature analysis
// to determine whether a Bitcoin address belongs to a mixing service.
//
// Detection weights (tuned to match Wu et al. feature importance ranking):
//
//	AF6  amount ratio ~1.0     0.30  ← top signal (Finding 5)
//	TF1  cycle balance std →0  0.25  ← strong (Finding 7)
//	TF3  co-input dominance    0.15  ← medium (Finding 7)
//	a1   receive-before-send   0.15  ← medium (Finding 1)
//	TF2  cycle duration <3 h   0.10  ← corroborating (Finding 6)
//	Reuse address reuse absent 0.05  ← weak (Finding 2)
func IsMixingAddress(addr string, txs []TransactionIO, threshold float64) AddressMixingResult {
	const addrDefaultThreshold = 0.60
	if threshold <= 0 {
		threshold = addrDefaultThreshold
	}

	result := AddressMixingResult{
		Breakdown: make(map[string]float64),
		Notes:     []string{},
	}

	if addr == "" || len(txs) < 3 {
		return result
	}

	events := buildEventStream(addr, txs)
	if len(events) < 2 {
		return result
	}

	// ── Compute account features ─────────────────────────────────────────
	feat := &result.Features
	coInputSet := make(map[string]struct{})
	coOutputSet := make(map[string]struct{})
	var sumCoIn, sumCoOut float64
	var sendEvCnt, recvEvCnt int

	for _, ev := range events {
		if ev.IsSend {
			feat.AF1InputTxCount++
			feat.AF5TotalSent += ev.Amount
			sumCoIn += float64(len(ev.CoAddrs))
			sendEvCnt++
			for _, a := range ev.CoAddrs {
				coInputSet[a] = struct{}{}
			}
		} else {
			feat.AF2OutputTxCount++
			feat.AF4TotalReceived += ev.Amount
			sumCoOut += float64(len(ev.CoAddrs))
			recvEvCnt++
			for _, a := range ev.CoAddrs {
				coOutputSet[a] = struct{}{}
			}
		}
	}

	feat.TF5UniqueCoInputs = len(coInputSet)
	feat.TF6UniqueCoOutputs = len(coOutputSet)
	if feat.AF2OutputTxCount > 0 {
		feat.AF3IoTxRatio = float64(feat.AF1InputTxCount) / float64(feat.AF2OutputTxCount)
	}
	if feat.AF5TotalSent > 0 {
		feat.AF6IoAmtRatio = feat.AF4TotalReceived / feat.AF5TotalSent
	}
	if sendEvCnt > 0 {
		feat.TF3AvgCoInputAddrs = sumCoIn / float64(sendEvCnt)
	}
	if recvEvCnt > 0 {
		feat.TF4AvgCoOutputAddrs = sumCoOut / float64(recvEvCnt)
	}

	// ── RULE 1: AF6 amount ratio ~1.0 (weight 0.30) ──────────────────────
	// Wu et al. Finding 5: mixing service addresses send out ≈ what they receive.
	if feat.AF5TotalSent > 0 && feat.AF4TotalReceived > 0 {
		ratio := feat.AF6IoAmtRatio
		deviation := math.Abs(ratio - 1.0)
		if deviation < 0.40 {
			score := 1.0 - (deviation / 0.40)
			result.Breakdown["af6_amount_ratio"] = 0.30 * score
			result.Notes = append(result.Notes, fmt.Sprintf(
				"AF6: recv/sent=%.4f (mixer target 1.0, deviation %.4f)", ratio, deviation))
		}
	}

	// ── Compute transaction cycles ────────────────────────────────────────
	cycles := extractMixingCycles(events)
	feat.CycleCount = len(cycles)

	if len(cycles) >= 2 {
		var balances []float64
		var durations []float64
		for _, c := range cycles {
			balances = append(balances, c.balance)
			durations = append(durations, float64(c.durationSec))
		}

		feat.TF1CycleBalanceMean = mean(balances)
		feat.TF1CycleBalanceStd = stdDev(balances)
		feat.TF2AvgCycleDurSec = mean(durations)

		// ── RULE 2: TF1 cycle balance std → 0 (weight 0.25) ─────────────
		// Wu et al. Finding 7: "TF1 results of mixing services are closer to 0."
		meanAbs := 0.0
		for _, b := range balances {
			meanAbs += math.Abs(b)
		}
		meanAbs /= float64(len(balances))

		if meanAbs < 1e-8 {
			result.Breakdown["tf1_cycle_balance_std"] = 0.25
			result.Notes = append(result.Notes,
				"TF1: all cycles balance to 0 — perfect mixing intermediary")
		} else {
			relStd := feat.TF1CycleBalanceStd / meanAbs
			if relStd < 1.5 {
				score := math.Max(1.0-(relStd/1.5), 0)
				result.Breakdown["tf1_cycle_balance_std"] = 0.25 * score
				result.Notes = append(result.Notes, fmt.Sprintf(
					"TF1: cycle balance std=%.6f BTC, rel std=%.2f (mixers→0)", feat.TF1CycleBalanceStd, relStd))
			}
		}

		// ── RULE 3: TF2 cycle duration < 3 h (weight 0.10) ──────────────
		// Wu et al. Finding 6: 80%+ of mixer cycles complete within 3 h.
		const mixerMaxCycleSec = 3 * 3600.0
		if feat.TF2AvgCycleDurSec > 0 && feat.TF2AvgCycleDurSec <= mixerMaxCycleSec {
			score := 1.0 - (feat.TF2AvgCycleDurSec / mixerMaxCycleSec)
			result.Breakdown["tf2_cycle_duration"] = 0.10 * score
			result.Notes = append(result.Notes, fmt.Sprintf(
				"TF2: avg cycle=%.1f min (mixers <180 min, Finding 6)", feat.TF2AvgCycleDurSec/60))
		}
	}

	// ── RULE 4: TF3 > TF4 co-input dominance (weight 0.15) ───────────────
	// Wu et al. Finding 7: more co-input addresses than co-output addresses.
	if feat.TF3AvgCoInputAddrs > feat.TF4AvgCoOutputAddrs && feat.TF3AvgCoInputAddrs > 0 {
		denom := math.Max(feat.TF4AvgCoOutputAddrs, 0.5)
		excess := (feat.TF3AvgCoInputAddrs - feat.TF4AvgCoOutputAddrs) / denom
		score := math.Min(excess/5.0, 1.0)
		result.Breakdown["tf3_co_input_dominance"] = 0.15 * score
		result.Notes = append(result.Notes, fmt.Sprintf(
			"TF3=%.1f > TF4=%.1f: co-input dominance (Finding 7)",
			feat.TF3AvgCoInputAddrs, feat.TF4AvgCoOutputAddrs))
	}

	// ── RULE 5: a1 temporal motif dominance (weight 0.15) ────────────────
	// Wu et al. Finding 1: a1 (receive-before-send) fraction >> a2 for mixers.
	const delta = int64(3 * 3600) // δ = 3 h — optimal per Wu et al. §VI-A
	a1, a2 := countTemporalMotifs(events, delta)
	feat.A1Count = a1
	feat.A2Count = a2
	total := a1 + a2
	if total > 0 {
		feat.A1Fraction = float64(a1) / float64(total)
		if feat.A1Fraction > 0.65 {
			score := (feat.A1Fraction - 0.65) / 0.35
			result.Breakdown["a1_temporal_dominance"] = 0.15 * score
			result.Notes = append(result.Notes, fmt.Sprintf(
				"a1 motif: %.0f%% receive-before-send (mixers: a1>>a2, Finding 1)",
				feat.A1Fraction*100))
		}
	}

	// ── RULE 6: Address reuse absence (weight 0.05) ───────────────────────
	// Wu et al. Finding 2: mixing services almost never reuse co-addresses.
	reuseRatio := coAddrReuseRatio(events)
	feat.CoAddrReuseRatio = reuseRatio
	minEvents := feat.AF1InputTxCount + feat.AF2OutputTxCount
	if reuseRatio < 0.15 && minEvents >= 5 {
		score := 1.0 - (reuseRatio / 0.15)
		result.Breakdown["co_addr_reuse_absence"] = 0.05 * score
		result.Notes = append(result.Notes, fmt.Sprintf(
			"Co-address reuse=%.2f (mixers avoid reuse, Finding 2)", reuseRatio))
	}

	var totalScore float64
	for _, v := range result.Breakdown {
		totalScore += v
	}
	result.Score = math.Min(totalScore, 1.0)
	result.Flagged = result.Score >= threshold
	return result
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — SWEEPER TRANSACTION DETECTION (Shojaeinasab et al., 2023)
// ─────────────────────────────────────────────────────────────────────────────

// IsSweeperTransaction detects "sweeper" transactions — the aggregation step
// that begins a modern mixing chain (Shojaeinasab et al. 2023, §3.4.2).
//
// A sweeper consolidates many small mixer deposit addresses into a high-balance
// pool address used during the intermediate mixing stage. Three structural
// signals are scored:
//   - Input count ≥ 10 (weight 0.40)
//   - Input value uniformity / low CV (weight 0.30) — same-denomination deposits
//   - Output concentration ratio (weight 0.30) — large output vs individual inputs
func IsSweeperTransaction(tx TransactionIO) SweeperResult {
	result := SweeperResult{}

	if len(tx.Inputs) < 10 {
		return result
	}

	spendableOuts := 0
	var totalOut float64
	for _, o := range tx.Outputs {
		if o.ScriptType != "op_return" && o.Address != "" {
			spendableOuts++
			totalOut += o.Value
		}
	}
	if spendableOuts == 0 || spendableOuts > 2 {
		return result
	}

	inputVals := make([]float64, 0, len(tx.Inputs))
	var totalIn float64
	for _, inp := range tx.Inputs {
		if inp.Value > 0 {
			inputVals = append(inputVals, inp.Value)
			totalIn += inp.Value
		}
	}
	if len(inputVals) == 0 {
		return result
	}

	sort.Float64s(inputVals)
	medianIn := inputVals[len(inputVals)/2]
	maxIn := inputVals[len(inputVals)-1]

	// Signal 1: large input count (0.40)
	inputCountScore := math.Min(float64(len(tx.Inputs))/100.0, 1.0)

	// Signal 2: input value uniformity — low coefficient of variation (0.30)
	cv := 0.0
	if medianIn > 0 {
		cv = stdDev(inputVals) / medianIn
	}
	uniformityScore := math.Max(1.0-math.Min(cv/2.0, 1.0), 0)

	// Signal 3: output concentration vs individual inputs (0.30)
	concentrationScore := 0.0
	if maxIn > 0 {
		r := totalOut / maxIn
		if r >= 5 {
			concentrationScore = math.Min((r-5)/45.0, 1.0)
		}
	}

	combined := 0.40*inputCountScore + 0.30*uniformityScore + 0.30*concentrationScore

	result.IsSweeper = combined >= 0.55
	result.Confidence = math.Min(combined, 1.0)
	result.InputCount = len(tx.Inputs)
	result.OutputCount = spendableOuts
	result.TotalValueIn = totalIn
	result.InputMedianValue = medianIn

	if result.IsSweeper {
		result.Notes = fmt.Sprintf(
			"Sweeper: %d inputs (median=%.6f BTC, CV=%.2f) → %d outputs "+
				"(total=%.4f BTC); concentration=%.1fx largest input",
			len(tx.Inputs), medianIn, cv, spendableOuts, totalOut,
			totalOut/math.Max(maxIn, 1e-8))
	}
	return result
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOJAEINASAB PHASE-1 — STRICT P2SH INPUT CHECK
// ─────────────────────────────────────────────────────────────────────────────

// CheckCentralizedMixerStrict re-runs the Shojaeinasab (2023) centralized
// mixer check with all six conditions from §3.3 / Algorithm 3, including the
// XOR address-type check (line 4) that was missing from the original
// aggregator.go implementation.
//
// TODO: add ScriptType field to TxInput so the input P2SH check can be exact.
// Until then the input-P2SH condition is relaxed and the score is discounted.
func CheckCentralizedMixerStrict(tx TransactionIO) (flagged bool, score float64, note string) {
	if len(tx.Inputs) != 1 {
		return false, 0, ""
	}

	var totalIn float64
	for _, inp := range tx.Inputs {
		totalIn += inp.Value
	}
	if totalIn <= 1.0 {
		return false, 0, ""
	}

	var spendable []TxOutput
	for _, o := range tx.Outputs {
		if o.ScriptType != "op_return" && o.Address != "" {
			spendable = append(spendable, o)
		}
	}
	if len(spendable) != 2 {
		return false, 0, ""
	}

	p2shCount := 0
	for _, o := range spendable {
		if o.ScriptType == "p2sh" {
			p2shCount++
		}
	}
	if p2shCount == 0 {
		return false, 0, ""
	}

	var p2shVal, nonP2SHVal float64
	if p2shCount == 1 {
		for _, o := range spendable {
			if o.ScriptType == "p2sh" {
				p2shVal = o.Value
			} else {
				nonP2SHVal = o.Value
			}
		}
	} else {
		// Both P2SH: use amount as criterion (Shojaeinasab §3.5 rule 2)
		p2shVal = math.Max(spendable[0].Value, spendable[1].Value)
		nonP2SHVal = math.Min(spendable[0].Value, spendable[1].Value)
	}

	if nonP2SHVal <= 0 || p2shVal/nonP2SHVal < 5.0 {
		return false, 0, ""
	}

	// Input P2SH check: ScriptType not yet on TxInput; use 0.82 as
	// conservative score until the field is added.
	score = 0.82
	note = fmt.Sprintf(
		"Centralized mixer (Shojaeinasab strict): 1-in 2-out, P2SH out=%.6f (%.1fx recipient=%.6f), input=%.4f BTC",
		p2shVal, p2shVal/nonP2SHVal, nonP2SHVal, totalIn)
	return true, score, note
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED SIGNAL AGGREGATION
// ─────────────────────────────────────────────────────────────────────────────

// CombinedMixingScore merges evidence from all three detection layers into a
// single normalised score for an address.
//
// Combination: max(signals)×0.60 + mean(signals)×0.40
//   - Rewards a single very strong signal (e.g. exact Whirlpool 5×5 match)
//   - Also rewards convergent weak signals across multiple independent layers
func CombinedMixingScore(
	addr string,
	txs []TransactionIO,
	threshold float64,
) (score float64, flagged bool, topNotes []string) {
	if threshold <= 0 {
		threshold = defaultMixerThreshold
	}

	type signal struct {
		score float64
		src   string
		note  string
	}
	var signals []signal

	for _, tx := range txs {
		// Layer 1: per-transaction
		mr := IsCoinMixer(tx, 0)
		if mr.Score >= 0.35 {
			note := string(mr.MixerType)
			if len(mr.Notes) > 0 {
				note = mr.Notes[0]
			}
			txPrefix := tx.Txid
			if len(txPrefix) > 8 {
				txPrefix = txPrefix[:8]
			}
			signals = append(signals, signal{mr.Score, "tx:" + txPrefix, note})
		}
		// Layer 3: sweeper
		sr := IsSweeperTransaction(tx)
		if sr.IsSweeper {
			txPrefix := tx.Txid
			if len(txPrefix) > 8 {
				txPrefix = txPrefix[:8]
			}
			signals = append(signals, signal{sr.Confidence * 0.75, "sweep:" + txPrefix, sr.Notes})
		}
	}

	// Layer 2: address behavioural
	addrRes := IsMixingAddress(addr, txs, 0)
	if addrRes.Score >= 0.20 {
		note := "Address-level behavioural signal (Wu et al. 2022)"
		if len(addrRes.Notes) > 0 {
			note = addrRes.Notes[0]
		}
		signals = append(signals, signal{addrRes.Score, "addr", note})
	}

	if len(signals) == 0 {
		return 0, false, nil
	}

	var maxSig, sumSig float64
	for _, s := range signals {
		sumSig += s.score
		if s.score > maxSig {
			maxSig = s.score
		}
	}
	meanSig := sumSig / float64(len(signals))
	combined := math.Min(0.60*maxSig+0.40*meanSig, 1.0)

	sort.Slice(signals, func(i, j int) bool { return signals[i].score > signals[j].score })
	seen := make(map[string]bool)
	for _, s := range signals {
		if !seen[s.note] && s.note != "" {
			topNotes = append(topNotes,
				fmt.Sprintf("[%.0f%% %s] %s", s.score*100, s.src, s.note))
			seen[s.note] = true
		}
		if len(topNotes) >= 5 {
			break
		}
	}

	return combined, combined >= threshold, topNotes
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

type txEvent struct {
	Timestamp int64
	Amount    float64
	IsSend    bool
	CoAddrs   []string
	TxID      string
}

func buildEventStream(addr string, txs []TransactionIO) []txEvent {
	events := make([]txEvent, 0, len(txs)*2)

	for i := range txs {
		tx := &txs[i]
		if tx.Timestamp == 0 {
			continue
		}

		for _, inp := range tx.Inputs {
			if inp.Address == addr {
				coAddrs := make([]string, 0, len(tx.Inputs)-1)
				for _, o := range tx.Inputs {
					if o.Address != "" && o.Address != addr {
						coAddrs = append(coAddrs, o.Address)
					}
				}
				events = append(events, txEvent{
					Timestamp: tx.Timestamp,
					Amount:    inp.Value,
					IsSend:    true,
					CoAddrs:   coAddrs,
					TxID:      tx.Txid,
				})
				break
			}
		}

		for _, out := range tx.Outputs {
			if out.Address == addr {
				coAddrs := make([]string, 0, len(tx.Outputs)-1)
				for _, o := range tx.Outputs {
					if o.Address != "" && o.Address != addr {
						coAddrs = append(coAddrs, o.Address)
					}
				}
				events = append(events, txEvent{
					Timestamp: tx.Timestamp,
					Amount:    out.Value,
					IsSend:    false,
					CoAddrs:   coAddrs,
					TxID:      tx.Txid,
				})
				break
			}
		}
	}

	sort.Slice(events, func(i, j int) bool {
		return events[i].Timestamp < events[j].Timestamp
	})
	return events
}

type mixingCycle struct {
	startTime   int64
	endTime     int64
	durationSec int64
	balance     float64
}

func extractMixingCycles(events []txEvent) []mixingCycle {
	var cycles []mixingCycle
	i, n := 0, len(events)

	for i < n {
		for i < n && events[i].IsSend {
			i++
		}
		if i >= n {
			break
		}
		cycleStart := events[i].Timestamp
		var received float64
		for i < n && !events[i].IsSend {
			received += events[i].Amount
			i++
		}
		if i >= n {
			break
		}
		var sent float64
		cycleEnd := events[i].Timestamp
		for i < n && events[i].IsSend {
			sent += events[i].Amount
			cycleEnd = events[i].Timestamp
			i++
		}
		if sent > 0 {
			dur := cycleEnd - cycleStart
			if dur < 0 {
				dur = 0
			}
			cycles = append(cycles, mixingCycle{
				startTime:   cycleStart,
				endTime:     cycleEnd,
				durationSec: dur,
				balance:     received - sent,
			})
		}
	}
	return cycles
}

// countTemporalMotifs counts AAIN a1/a2 instances within a δ-second window.
// a1 = receive-then-send, a2 = send-then-receive (Wu et al. §IV-A, Def. 2).
func countTemporalMotifs(events []txEvent, delta int64) (a1, a2 int) {
	for i := 0; i < len(events); i++ {
		for j := i + 1; j < len(events); j++ {
			if events[j].Timestamp-events[i].Timestamp > delta {
				break
			}
			switch {
			case !events[i].IsSend && events[j].IsSend:
				a1++
			case events[i].IsSend && !events[j].IsSend:
				a2++
			}
		}
	}
	return
}

func coAddrReuseRatio(events []txEvent) float64 {
	addrCount := make(map[string]int)
	for _, ev := range events {
		seen := make(map[string]struct{}, len(ev.CoAddrs))
		for _, a := range ev.CoAddrs {
			if _, dup := seen[a]; !dup {
				addrCount[a]++
				seen[a] = struct{}{}
			}
		}
	}
	if len(addrCount) == 0 {
		return 0
	}
	reused := 0
	for _, cnt := range addrCount {
		if cnt > 1 {
			reused++
		}
	}
	return float64(reused) / float64(len(addrCount))
}

// stdDev returns the population standard deviation of a float slice.
// Named stdDev to avoid colliding with any future stdlib additions.
func stdDev(vals []float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	m := mean(vals) // mean() is defined in cluster.go (same package)
	var sumSq float64
	for _, v := range vals {
		d := v - m
		sumSq += d * d
	}
	return math.Sqrt(sumSq / float64(len(vals)))
}
