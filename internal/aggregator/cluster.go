package aggregator

import (
	"fmt"
	"sort"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// UNION-FIND (DISJOINT SET)
// ─────────────────────────────────────────────────────────────

// unionFind implements a path-compressed, union-by-rank disjoint-set
// structure. Used exclusively for co-spend address clustering.
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

// find returns the canonical representative for x, with path compression.
func (uf *unionFind) find(x string) string {
	if _, ok := uf.parent[x]; !ok {
		uf.parent[x] = x
		uf.rank[x] = 0
	}
	if uf.parent[x] != x {
		uf.parent[x] = uf.find(uf.parent[x]) // path compression
	}
	return uf.parent[x]
}

// union merges the sets containing x and y using union-by-rank.
func (uf *unionFind) union(x, y string) {
	rx, ry := uf.find(x), uf.find(y)
	if rx == ry {
		return
	}
	// Attach smaller rank tree under larger rank tree
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

// ClusterResult holds the output of co-spend clustering.
type ClusterResult struct {
	// AddrToCluster maps each address to its canonical cluster ID.
	AddrToCluster map[string]string
	// Clusters maps each cluster ID to all member addresses.
	Clusters map[string][]string
}

// ─────────────────────────────────────────────────────────────
// CO-SPEND HEURISTIC
// ─────────────────────────────────────────────────────────────

// BuildClusters applies the co-spend heuristic across a set of transactions:
//
//	"If multiple addresses appear as inputs in the same transaction,
//	 they are controlled by the same entity (wallet)."
//
// This is the most fundamental and reliable clustering technique in
// blockchain forensics. It is conservative by design — it only merges
// addresses when there is direct on-chain evidence of co-ownership.
//
// Returns a ClusterResult for all addresses observed in the input set.
func BuildClusters(txs []TransactionIO) ClusterResult {
	uf := newUnionFind()

	for _, tx := range txs {
		if len(tx.Inputs) < 2 {
			// A single-input transaction gives no clustering signal.
			// We still add the address to the union-find so it appears
			// in the result with a singleton cluster.
			if len(tx.Inputs) == 1 && tx.Inputs[0].Address != "" {
				uf.find(tx.Inputs[0].Address) // initialise singleton
			}
			continue
		}

		// Co-spend: union every input address together.
		// We skip empty addresses (coinbase or unresolved scripts).
		first := ""
		for _, inp := range tx.Inputs {
			if inp.Address == "" {
				continue
			}
			if first == "" {
				first = inp.Address
				uf.find(first) // ensure the node exists
				continue
			}
			uf.union(first, inp.Address)
		}
	}

	// ── Build result maps ──────────────────────────────────────
	addrToCluster := make(map[string]string, len(uf.parent))
	clusters := make(map[string][]string)

	for addr := range uf.parent {
		root := uf.find(addr)
		// Use a stable, human-readable cluster ID so the frontend can
		// construct a deterministic display name without backend knowledge.
		cid := clusterID(root)
		addrToCluster[addr] = cid
		clusters[cid] = append(clusters[cid], addr)
	}

	// Sort member lists for deterministic output
	for cid := range clusters {
		sort.Strings(clusters[cid])
	}

	return ClusterResult{
		AddrToCluster: addrToCluster,
		Clusters:      clusters,
	}
}

// clusterID builds a short, stable identifier for a cluster from the
// canonical representative address. Uses the first 8 and last 6 chars.
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

// GamblingResult holds the output of gambling-site behaviour analysis.
type GamblingResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	Notes     []string           `json:"notes"`
	Breakdown map[string]float64 `json:"breakdown"`
}

const defaultGamblingThreshold = 0.55

// IsGamblingAddress detects behavioural patterns consistent with
// a gambling/gaming service:
//
//   - Many small, frequent inputs from diverse addresses (player deposits)
//   - Occasional larger, irregular outputs (payouts / jackpots)
//   - High input diversity (many unique sender addresses)
//   - Output value distribution skewed toward a few large payouts
//
// This heuristic is intentionally conservative; gambling sites can
// look superficially similar to exchange hot wallets at small scale.
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

	// ── Collect metrics ───────────────────────────────────────
	var allInputValues []float64
	var allOutputValues []float64
	uniqueSenders := make(map[string]struct{})

	for _, tx := range txs {
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
			}
		}
	}

	if len(allInputValues) == 0 || len(allOutputValues) == 0 {
		return result
	}

	// ── RULE 1: Sender Diversity  (0.30) ──────────────────────
	// Gambling sites receive from hundreds of distinct depositing wallets.
	senderRatio := float64(len(uniqueSenders)) / float64(max(len(allInputValues), 1))
	if len(uniqueSenders) >= 20 && senderRatio > 0.5 {
		score := min1(float64(len(uniqueSenders))/200.0, 1.0)
		result.Breakdown["sender_diversity"] = 0.30 * score
		result.Notes = append(result.Notes,
			fmt.Sprintf("%d unique depositing addresses", len(uniqueSenders)))
	}

	// ── RULE 2: Low Average Input Value  (0.25) ───────────────
	// Player deposits are typically small amounts.
	avgIn := mean(allInputValues)
	if avgIn > 0 && avgIn < 0.05 { // < 0.05 BTC average deposit
		score := min1((0.05-avgIn)/0.05, 1.0)
		result.Breakdown["small_deposits"] = 0.25 * score
		result.Notes = append(result.Notes,
			fmt.Sprintf("avg deposit %.6f BTC", avgIn))
	}

	// ── RULE 3: Output Skew (Jackpot Pattern)  (0.25) ────────
	// A few large payouts among many small withdrawals.
	if len(allOutputValues) >= 5 {
		sortedOut := make([]float64, len(allOutputValues))
		copy(sortedOut, allOutputValues)
		sort.Float64s(sortedOut)

		// Top-5% of outputs vs median
		p95 := sortedOut[int(float64(len(sortedOut))*0.95)]
		median := sortedOut[len(sortedOut)/2]

		if median > 0 && p95/median > 10 {
			skewScore := min1((p95/median)/50.0, 1.0)
			result.Breakdown["output_skew"] = 0.25 * skewScore
			result.Notes = append(result.Notes,
				fmt.Sprintf("output skew p95/median=%.1fx (jackpot pattern)", p95/median))
		}
	}

	// ── RULE 4: High Transaction Count  (0.20) ────────────────
	// Active gambling sites process enormous transaction volumes.
	if len(txs) >= 50 {
		score := min1(float64(len(txs))/500.0, 1.0)
		result.Breakdown["high_volume"] = 0.20 * score
		result.Notes = append(result.Notes,
			fmt.Sprintf("%d transactions (high volume)", len(txs)))
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
// MINING POOL DETECTION
// ─────────────────────────────────────────────────────────────

// MiningResult holds the output of mining pool behaviour analysis.
type MiningResult struct {
	Score     float64            `json:"score"`
	Flagged   bool               `json:"flagged"`
	Notes     []string           `json:"notes"`
	Breakdown map[string]float64 `json:"breakdown"`
}

const defaultMiningThreshold = 0.55

// IsMiningPoolAddress detects patterns consistent with a Bitcoin mining pool:
//
//   - Receives coinbase transactions (newly minted BTC from block rewards)
//   - Makes regular fan-out payouts to many addresses (miner payments)
//   - PPLNS / PPS reward patterns: fixed-interval, same-denominated outputs
//
// Note: HasCoinbase must be set on TransactionIO structs for this to work.
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

	// ── RULE 1: Coinbase Receipt  (0.50) ──────────────────────
	// The strongest signal: only mining infrastructure receives coinbase.
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

	// ── RULE 2: Regular Fan-Out Payouts  (0.30) ───────────────
	// Mining pools distribute to many miner wallets simultaneously.
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

	// ── RULE 3: Uniform Payout Amounts  (0.20) ────────────────
	// PPLNS pools pay proportional amounts; PPS pools pay fixed rates.
	// In both cases many output amounts cluster around similar values.
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
		// Check what fraction fall within 2x of the median
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

// IsClusterLabel returns true when a label suggests a well-known service
// label prefix — used to name clusters intelligently.
func IsClusterLabel(label string) bool {
	lower := strings.ToLower(label)
	for _, entry := range knownLabels {
		if strings.Contains(lower, entry.needle) {
			return true
		}
	}
	return false
}
