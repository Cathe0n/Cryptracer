package aggregator

import (
	"fmt"
	"sort"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// UNION-FIND (DISJOINT SET)
// ─────────────────────────────────────────────────────────────

type unionFind struct {
	parent map[string]string
	rank   map[string]int
}

func newUnionFind() *unionFind {
	return &unionFind{
		parent: make(map[string]string),
		rank:   make(map[string]int),
	}
}

func (uf *unionFind) find(x string) string {
	if _, ok := uf.parent[x]; !ok {
		uf.parent[x] = x
		uf.rank[x] = 0
	}
	if uf.parent[x] != x {
		uf.parent[x] = uf.find(uf.parent[x])
	}
	return uf.parent[x]
}

func (uf *unionFind) union(x, y string) {
	rx, ry := uf.find(x), uf.find(y)
	if rx == ry {
		return
	}
	if uf.rank[rx] < uf.rank[ry] {
		rx, ry = ry, rx
	}
	uf.parent[ry] = rx
	if uf.rank[rx] == uf.rank[ry] {
		uf.rank[rx]++
	}
}

// ─────────────────────────────────────────────────────────────
// CLUSTER RESULT
// ─────────────────────────────────────────────────────────────

type ClusterResult struct {
	AddrToCluster map[string]string
	Clusters      map[string][]string
}

// ─────────────────────────────────────────────────────────────
// CO-SPEND HEURISTIC
// ─────────────────────────────────────────────────────────────

func BuildClusters(txs []TransactionIO) ClusterResult {
	uf := newUnionFind()

	for _, tx := range txs {
		if len(tx.Inputs) < 2 {
			if len(tx.Inputs) == 1 && tx.Inputs[0].Address != "" {
				uf.find(tx.Inputs[0].Address)
			}
			continue
		}
		first := ""
		for _, inp := range tx.Inputs {
			if inp.Address == "" {
				continue
			}
			if first == "" {
				first = inp.Address
				uf.find(first)
				continue
			}
			uf.union(first, inp.Address)
		}
	}

	addrToCluster := make(map[string]string, len(uf.parent))
	clusters := make(map[string][]string)

	for addr := range uf.parent {
		root := uf.find(addr)
		cid := clusterID(root)
		addrToCluster[addr] = cid
		clusters[cid] = append(clusters[cid], addr)
	}

	for cid := range clusters {
		sort.Strings(clusters[cid])
	}

	return ClusterResult{
		AddrToCluster: addrToCluster,
		Clusters:      clusters,
	}
}

func clusterID(representative string) string {
	if len(representative) <= 14 {
		return representative
	}
	return fmt.Sprintf("cluster_%s_%s",
		representative[:8],
		representative[len(representative)-6:])
}

// ─────────────────────────────────────────────────────────────
// GAMBLING DETECTION
// ─────────────────────────────────────────────────────────────

type GamblingResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	Notes     []string           `json:"notes"`
	Breakdown map[string]float64 `json:"breakdown"`
}

const defaultGamblingThreshold = 0.55

func IsGamblingAddress(txs []TransactionIO, threshold float64) GamblingResult {
	if threshold <= 0 {
		threshold = defaultGamblingThreshold
	}

	result := GamblingResult{
		Breakdown: make(map[string]float64),
		Notes:     []string{},
	}

	if len(txs) < 3 {
		return result
	}

	var allInputValues []float64
	var allOutputValues []float64
	uniqueSenders := make(map[string]struct{})

	batchTxCount := 0
	singleOutputTxCnt := 0
	coinbaseCount := 0
	totalOutputsCount := 0

	for _, tx := range txs {
		if tx.HasCoinbase {
			coinbaseCount++
		}

		outCount := 0
		for _, inp := range tx.Inputs {
			if inp.Value > 0 {
				allInputValues = append(allInputValues, inp.Value)
			}
			if inp.Address != "" {
				uniqueSenders[inp.Address] = struct{}{}
			}
		}
		for _, out := range tx.Outputs {
			if out.Value > 0 && out.ScriptType != "op_return" {
				allOutputValues = append(allOutputValues, out.Value)
				outCount++
			}
		}

		totalOutputsCount += outCount
		if outCount >= 10 {
			batchTxCount++
		}
		if outCount <= 2 {
			singleOutputTxCnt++
		}
	}

	if len(allInputValues) == 0 || len(allOutputValues) == 0 {
		return result
	}

	avgOutputsPerTx := float64(totalOutputsCount) / float64(len(txs))
	singleOutRatio := float64(singleOutputTxCnt) / float64(len(txs))
	batchRatio := float64(batchTxCount) / float64(len(txs))

	// ANTI-SIGNAL: exchange batch-withdrawal pattern
	if batchRatio >= 0.25 {
		penalty := -0.55 * min1(batchRatio/0.50, 1.0)
		result.Breakdown["exchange_batch_penalty"] = penalty
		result.Notes = append(result.Notes,
			fmt.Sprintf("%.0f%% of txs are batch withdrawals — exchange pattern, not gambling", batchRatio*100))
	}

	// ANTI-SIGNAL: coinbase receipt
	if coinbaseCount > 0 {
		result.Breakdown["coinbase_penalty"] = -0.40
		result.Notes = append(result.Notes,
			fmt.Sprintf("%d coinbase transaction(s) received — rules out gambling", coinbaseCount))
	}

	// RULE 1: Sender diversity (0.25)
	senderRatio := float64(len(uniqueSenders)) / float64(intMax(len(allInputValues), 1))
	if len(uniqueSenders) >= 20 && senderRatio > 0.5 && avgOutputsPerTx < 4 {
		score := min1(float64(len(uniqueSenders))/200.0, 1.0)
		result.Breakdown["sender_diversity"] = 0.25 * score
		result.Notes = append(result.Notes,
			fmt.Sprintf("%d unique depositing addresses (avg %.1f outputs/tx)", len(uniqueSenders), avgOutputsPerTx))
	}

	// RULE 2: Low average input value (0.20)
	avgIn := mean(allInputValues)
	if avgIn > 0 && avgIn < 0.05 {
		score := min1((0.05-avgIn)/0.05, 1.0)
		result.Breakdown["small_deposits"] = 0.20 * score
		result.Notes = append(result.Notes, fmt.Sprintf("avg deposit %.6f BTC", avgIn))
	}

	// RULE 3: Output skew / jackpot pattern (0.25)
	if len(allOutputValues) >= 5 && singleOutRatio >= 0.40 {
		sortedOut := make([]float64, len(allOutputValues))
		copy(sortedOut, allOutputValues)
		sort.Float64s(sortedOut)

		p95 := sortedOut[int(float64(len(sortedOut))*0.95)]
		median := sortedOut[len(sortedOut)/2]

		if median > 0 && p95/median > 10 {
			skewScore := min1((p95/median)/50.0, 1.0)
			result.Breakdown["output_skew"] = 0.25 * skewScore
			result.Notes = append(result.Notes,
				fmt.Sprintf("output skew p95/median=%.1fx with %.0f%% single-output txs (jackpot pattern)",
					p95/median, singleOutRatio*100))
		}
	}

	// RULE 4: High input:output count imbalance (0.20)
	inputOutputRatio := float64(len(allInputValues)) / float64(intMax(len(allOutputValues), 1))
	if inputOutputRatio >= 2.5 && len(allInputValues) >= 20 {
		score := min1((inputOutputRatio-2.5)/7.5, 1.0)
		result.Breakdown["input_output_imbalance"] = 0.20 * score
		result.Notes = append(result.Notes,
			fmt.Sprintf("input:output ratio %.1f:1 (many deposits, few payouts)", inputOutputRatio))
	}

	// RULE 5: High transaction count (0.10)
	if len(txs) >= 50 {
		score := min1(float64(len(txs))/500.0, 1.0)
		result.Breakdown["high_volume"] = 0.10 * score
		result.Notes = append(result.Notes, fmt.Sprintf("%d transactions (high volume)", len(txs)))
	}

	var total float64
	for _, v := range result.Breakdown {
		total += v
	}
	if total < 0 {
		total = 0
	}
	result.Score = min1(total, 1.0)
	result.Flagged = result.Score >= threshold
	return result
}

// ─────────────────────────────────────────────────────────────
// MINING POOL DETECTION
// ─────────────────────────────────────────────────────────────

type MiningResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	Notes     []string           `json:"notes"`
	Breakdown map[string]float64 `json:"breakdown"`
}

const defaultMiningThreshold = 0.55

func IsMiningPoolAddress(txs []TransactionIO, threshold float64) MiningResult {
	if threshold <= 0 {
		threshold = defaultMiningThreshold
	}

	result := MiningResult{
		Breakdown: make(map[string]float64),
		Notes:     []string{},
	}

	if len(txs) == 0 {
		return result
	}

	// RULE 1: Coinbase receipt (0.50)
	coinbaseCount := 0
	for _, tx := range txs {
		if tx.HasCoinbase {
			coinbaseCount++
		}
	}
	if coinbaseCount > 0 {
		coinbaseRatio := float64(coinbaseCount) / float64(len(txs))
		result.Breakdown["coinbase_receipt"] = 0.50 * min1(coinbaseRatio*5, 1.0)
		result.Notes = append(result.Notes,
			fmt.Sprintf("%d coinbase (block reward) transactions received", coinbaseCount))
	}

	// RULE 2: Regular fan-out payouts (0.30)
	fanOutCount := 0
	allPayoutAddrs := make(map[string]struct{})
	for _, tx := range txs {
		if len(tx.Outputs) >= 10 {
			fanOutCount++
		}
		for _, out := range tx.Outputs {
			if out.Address != "" {
				allPayoutAddrs[out.Address] = struct{}{}
			}
		}
	}
	if fanOutCount > 0 {
		fanRatio := float64(fanOutCount) / float64(len(txs))
		result.Breakdown["fan_out_payouts"] = 0.30 * min1(fanRatio*2, 1.0)
		result.Notes = append(result.Notes,
			fmt.Sprintf("%d/%d txs are fan-out payouts to %d unique miners",
				fanOutCount, len(txs), len(allPayoutAddrs)))
	}

	// RULE 3: Uniform payout amounts (0.20)
	var payoutValues []float64
	for _, tx := range txs {
		if len(tx.Outputs) >= 5 {
			for _, out := range tx.Outputs {
				if out.Value > 0.0001 {
					payoutValues = append(payoutValues, out.Value)
				}
			}
		}
	}
	if len(payoutValues) >= 10 {
		sort.Float64s(payoutValues)
		median := payoutValues[len(payoutValues)/2]
		if median > 0 {
			nearMedian := 0
			for _, v := range payoutValues {
				if v >= median*0.25 && v <= median*4 {
					nearMedian++
				}
			}
			uniformRatio := float64(nearMedian) / float64(len(payoutValues))
			if uniformRatio > 0.6 {
				result.Breakdown["uniform_payouts"] = 0.20 * uniformRatio
				result.Notes = append(result.Notes,
					fmt.Sprintf("%.0f%% of payouts near median %.6f BTC", uniformRatio*100, median))
			}
		}
	}

	var total float64
	for _, v := range result.Breakdown {
		total += v
	}
	result.Score = min1(total, 1.0)
	result.Flagged = result.Score >= threshold
	return result
}

// ─────────────────────────────────────────────────────────────
// INTERNAL MATH HELPERS
// ─────────────────────────────────────────────────────────────

func mean(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	var sum float64
	for _, v := range vals {
		sum += v
	}
	return sum / float64(len(vals))
}

func min1(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

// IsClusterLabel returns true when a label matches a known service prefix.
func IsClusterLabel(label string) bool {
	lower := strings.ToLower(label)
	for _, entry := range knownLabels {
		if strings.Contains(lower, entry.needle) {
			return true
		}
	}
	return false
}
