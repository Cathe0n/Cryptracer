package aggregator

import (
	"log"
)

// AdvancedMixerDetectionResult represents comprehensive mixer detection results
type AdvancedMixerDetectionResult struct {
	// Phase 1: Transaction-level results
	Phase1Result    *TransactionLevelMixerIndicators
	IsSuspicious    bool
	SuspiciousScore float64

	// Phase 2: Chain-level validation
	Phase2Result    *ChainLevelMixerIndicators
	ConfirmedMixer  bool
	FinalConfidence float64

	// Address classification
	MixingAddresses   []string // Service addresses
	DirtyAddresses    []string // User input addresses
	CleanAddresses    []string // User output addresses
	AnomaliesDetected int
}

// TransactionLevelMixerIndicators represents transaction-level patterns
type TransactionLevelMixerIndicators struct {
	// Structure patterns
	HasOneInput           bool  // Single input requirement
	HasTwoOutputs         bool  // Exactly 2 outputs
	InputIsP2SH           bool  // P2SH script type
	OutputP2SHCount       int   // Count of P2SH outputs
	InputValueSats        int64 // Input amount in Satoshis
	ExceedsValueThreshold bool  // > 1 BTC

	// Amount fraction pattern
	P2SHOutputValue    int64
	NonP2SHOutputValue int64
	AmountRatio        float64 // P2SH / Non-P2SH ratio
	ExceedsAmountRatio bool    // >= 5x

	// Pattern score
	PatternMatches   int
	TransactionScore float64 // 0-1
}

// ChainLevelMixerIndicators represents chain-level validation patterns
type ChainLevelMixerIndicators struct {
	// Chain structure
	IsSweeperTransaction bool
	SweeperInputCount    int
	ChainLength          int
	MedianTimeInterval   int64 // in seconds
	ChainStartAddress    string

	// Validation against known patterns
	ChainLengthValid  bool // 52 median for mixers vs 10 for wallets
	TimeIntervalValid bool // ~32 min (1920 sec) for mixers vs others
	HasAnomalies      bool
	AnomalyThreshold  int
	AnomalyCount      int

	// Chain score
	ChainScore float64 // 0-1
}

// ================================
// PHASE 1: TRANSACTION-LEVEL DETECTION
// ================================

// Phase1_DetectMixingTransaction performs transaction-level analysis
// Based on withdrawal transaction patterns from the paper
func Phase1_DetectMixingTransaction(tx *TransactionIO) *TransactionLevelMixerIndicators {
	result := &TransactionLevelMixerIndicators{
		PatternMatches: 0,
	}

	if tx == nil {
		return result
	}

	// Pattern 1: Input/Output Structure (1:2)
	result.HasOneInput = len(tx.Inputs) == 1
	result.HasTwoOutputs = len(tx.Outputs) == 2
	if result.HasOneInput && result.HasTwoOutputs {
		result.PatternMatches++
	}

	// Pattern 2: Input Value Threshold (> 1 BTC)
	if len(tx.Inputs) > 0 {
		var totalInputValue int64
		for _, input := range tx.Inputs {
			totalInputValue += input.Value
		}
		result.InputValueSats = totalInputValue
		result.ExceedsValueThreshold = totalInputValue > 100000000
		if result.ExceedsValueThreshold {
			result.PatternMatches++
		}
	}

	// Pattern 3: Output Address Types (XOR: one P2SH, one non-P2SH)
	if len(tx.Outputs) >= 2 {
		p2shCount := 0
		for _, output := range tx.Outputs {
			if isP2SHAddress(output.Address) {
				p2shCount++
				result.P2SHOutputValue = output.Value
			} else {
				result.NonP2SHOutputValue = output.Value
			}
		}
		result.OutputP2SHCount = p2shCount
		// XOR pattern: at least one is P2SH
		if p2shCount >= 1 && p2shCount <= 2 {
			result.PatternMatches++
		}
	}

	// Pattern 4: Amount Fraction Pattern (P2SH output >= 5x non-P2SH)
	if result.NonP2SHOutputValue > 0 {
		result.AmountRatio = float64(result.P2SHOutputValue) / float64(result.NonP2SHOutputValue)
		result.ExceedsAmountRatio = result.AmountRatio >= 5.0
		if result.ExceedsAmountRatio {
			result.PatternMatches++
		}
	}

	// Calculate transaction-level score (0-1)
	// Maximum 4 patterns to match
	result.TransactionScore = float64(result.PatternMatches) / 4.0

	return result
}

// ================================
// PHASE 2: CHAIN-LEVEL VALIDATION
// ================================

// Phase2_ValidateMixingChain performs chain-level analysis
// Validates patterns across transaction sequences to reduce false positives
func Phase2_ValidateMixingChain(
	txChain []TransactionIO,
	timeIntervals []int64,
) *ChainLevelMixerIndicators {
	result := &ChainLevelMixerIndicators{
		AnomalyThreshold: 5, // From paper: Algorithm 1
	}

	if len(txChain) == 0 {
		return result
	}

	result.ChainLength = len(txChain)

	// Pattern 1: Chain Length Validation
	// Paper findings: median 52 for mixers vs 10 for wallets vs higher for exchanges
	const minValidChainLength = 40 // Conservative lower bound

	result.ChainLengthValid = result.ChainLength >= minValidChainLength

	// Pattern 2: Time Interval Validation
	// Paper findings: ~32 min (1920 sec) for mixers vs 10 min for exchanges vs 100+ hrs for wallets
	if len(timeIntervals) > 0 {
		result.MedianTimeInterval = calculateMedian(timeIntervals)
		const minTimeInterval int64 = 600   // At least 10 minutes
		const maxTimeInterval int64 = 10800 // At most 3 hours

		result.TimeIntervalValid = result.MedianTimeInterval >= minTimeInterval &&
			result.MedianTimeInterval <= maxTimeInterval
	}

	// Pattern 3: Sweeper Transaction Detection
	if len(txChain) > 0 {
		firstTx := txChain[0]
		// Sweeper: many inputs, 1-2 outputs
		result.IsSweeperTransaction = len(firstTx.Inputs) > 3 && len(firstTx.Outputs) <= 2
		result.SweeperInputCount = len(firstTx.Inputs)
	}

	// Pattern 4: Anomaly Detection
	// Transactions that deviate from expected patterns
	result.AnomalyCount = detectChainAnomalies(&txChain)
	result.HasAnomalies = result.AnomalyCount > 0

	// Calculate chain-level score (0-1)
	score := 0.0
	if result.ChainLengthValid {
		score += 0.25
	}
	if result.TimeIntervalValid {
		score += 0.25
	}
	if result.IsSweeperTransaction {
		score += 0.25
	}
	if result.AnomalyCount <= result.AnomalyThreshold {
		score += 0.25
	}

	result.ChainScore = score

	return result
}

// ================================
// INTEGRATED TWO-PHASE DETECTION
// ================================

// DetectMixingAdvanced performs comprehensive two-phase mixer detection
// Returns high-confidence mixing detection by combining transaction and chain analysis
func DetectMixingAdvanced(
	tx *TransactionIO,
	txChain []TransactionIO,
	timeIntervals []int64,
) *AdvancedMixerDetectionResult {

	result := &AdvancedMixerDetectionResult{
		MixingAddresses: []string{},
		DirtyAddresses:  []string{},
		CleanAddresses:  []string{},
	}

	// PHASE 1: Transaction-level detection
	phase1 := Phase1_DetectMixingTransaction(tx)
	result.Phase1Result = phase1

	// Threshold for phase 1: score >= 0.5 (at least 2 patterns match)
	const phase1Threshold = 0.5
	result.IsSuspicious = phase1.TransactionScore >= phase1Threshold
	result.SuspiciousScore = phase1.TransactionScore

	if !result.IsSuspicious {
		// Doesn't match basic patterns, not a mixer
		result.ConfirmedMixer = false
		result.FinalConfidence = 0.0
		return result
	}

	// PHASE 2: Chain-level validation (only if phase 1 passes)
	phase2 := Phase2_ValidateMixingChain(txChain, timeIntervals)
	result.Phase2Result = phase2

	// Combine scores from both phases
	// Weighting: Phase 1 (40%) + Phase 2 (60%)
	result.FinalConfidence = (phase1.TransactionScore * 0.4) + (phase2.ChainScore * 0.6)

	// High confidence threshold: 0.65+
	const highConfidenceThreshold = 0.65
	result.ConfirmedMixer = result.FinalConfidence >= highConfidenceThreshold &&
		phase2.ChainLengthValid &&
		phase2.TimeIntervalValid

	// Classify addresses if confirmed as mixer
	if result.ConfirmedMixer {
		result.MixingAddresses, result.CleanAddresses = classifyMixingAddresses(tx)
		result.DirtyAddresses = traceDirtyAddresses(txChain)
	}

	result.AnomaliesDetected = phase2.AnomalyCount

	return result
}

// ================================
// HELPER FUNCTIONS
// ================================

// isP2SHAddress checks if an address is P2SH format
// P2SH addresses on Bitcoin typically start with '3' (mainnet)
func isP2SHAddress(addr string) bool {
	if len(addr) == 0 {
		return false
	}
	// Bitcoin P2SH addresses start with '3'
	return addr[0] == '3'
}

// calculateMedian computes median of int64 slice
func calculateMedian(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}

	// Create a copy to avoid modifying original
	sorted := make([]int64, len(values))
	copy(sorted, values)

	// Simple bubble sort for small datasets
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j] < sorted[i] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}

	if len(sorted)%2 == 0 {
		return (sorted[len(sorted)/2-1] + sorted[len(sorted)/2]) / 2
	}
	return sorted[len(sorted)/2]
}

// detectChainAnomalies identifies deviations from expected patterns in chain
func detectChainAnomalies(txChain *[]TransactionIO) int {
	anomalyCount := 0

	for i, tx := range *txChain {
		// Anomaly 1: Unexpected output count changes
		if len(tx.Outputs) > 5 && i > 0 {
			anomalyCount++
		}

		// Anomaly 2: Value spikes unexpectedly
		if i > 0 {
			var prevTotal int64
			var currTotal int64
			for _, o := range (*txChain)[i-1].Outputs {
				prevTotal += o.Value
			}
			for _, o := range tx.Outputs {
				currTotal += o.Value
			}
			if currTotal > 0 && prevTotal > 0 {
				ratio := float64(currTotal) / float64(prevTotal)
				if ratio > 1.5 || ratio < 0.5 {
					// Rare value spikes indicate anomalies
				}
			}
		}

		// Anomaly 3: Input/Output structure deviates significantly
		inputCount := len(tx.Inputs)
		outputCount := len(tx.Outputs)
		// Intermediate transactions should be ~1:2, sweepers many:1-2
		if inputCount != 1 || outputCount != 2 {
			if i > 0 && i < len(*txChain)-1 {
				anomalyCount++
			}
		}
	}

	return anomalyCount
}

// classifyMixingAddresses identifies mixing service and clean addresses
func classifyMixingAddresses(tx *TransactionIO) ([]string, []string) {
	mixingAddrs := []string{}
	cleanAddrs := []string{}

	if tx == nil || len(tx.Outputs) < 2 {
		return mixingAddrs, cleanAddrs
	}

	// Identify P2SH and non-P2SH outputs
	var p2shOutputs []TxOutput
	var nonP2SHOutputs []TxOutput

	for _, output := range tx.Outputs {
		if isP2SHAddress(output.Address) {
			p2shOutputs = append(p2shOutputs, output)
		} else {
			nonP2SHOutputs = append(nonP2SHOutputs, output)
		}
	}

	// Mixing service: higher-value P2SH output
	if len(p2shOutputs) > 0 {
		maxVal := p2shOutputs[0].Value
		maxAddr := p2shOutputs[0].Address
		for _, o := range p2shOutputs {
			if o.Value > maxVal {
				maxVal = o.Value
				maxAddr = o.Address
			}
		}
		mixingAddrs = append(mixingAddrs, maxAddr)
	}

	// Clean money: non-P2SH or lower-value outputs
	for _, output := range nonP2SHOutputs {
		cleanAddrs = append(cleanAddrs, output.Address)
	}

	// If all P2SH, use amount as criterion (lower = clean)
	if len(nonP2SHOutputs) == 0 && len(p2shOutputs) >= 2 {
		minVal := p2shOutputs[0].Value
		minAddr := p2shOutputs[0].Address
		for _, o := range p2shOutputs {
			if o.Value < minVal {
				minVal = o.Value
				minAddr = o.Address
			}
		}
		cleanAddrs = append(cleanAddrs, minAddr)
		// Reassign to mixing (the other high-value one)
		mixingAddrs = []string{}
		for _, o := range p2shOutputs {
			if o.Address != minAddr {
				mixingAddrs = append(mixingAddrs, o.Address)
			}
		}
	}

	return mixingAddrs, cleanAddrs
}

// traceDirtyAddresses traces back through sweeper transactions to find user input addresses
func traceDirtyAddresses(txChain []TransactionIO) []string {
	dirtyAddrs := []string{}

	if len(txChain) == 0 {
		return dirtyAddrs
	}

	// First transaction should be sweeper (many inputs, 1-2 outputs)
	firstTx := txChain[0]
	if len(firstTx.Inputs) > 3 && len(firstTx.Outputs) <= 2 {
		// These input addresses are from mixing service users
		for _, input := range firstTx.Inputs {
			dirtyAddrs = append(dirtyAddrs, input.Address)
		}
	}

	return dirtyAddrs
}

// ================================
// LOGGING & REPORTING
// ================================

// LogAdvancedDetectionResult logs comprehensive detection results
func LogAdvancedDetectionResult(result *AdvancedMixerDetectionResult, txID string) {
	if result == nil {
		return
	}

	log.Printf("\n=== ADVANCED MIXER DETECTION REPORT ===")
	log.Printf("Transaction: %s", txID)
	log.Printf("\n--- PHASE 1: TRANSACTION-LEVEL ---")
	if result.Phase1Result != nil {
		p1 := result.Phase1Result
		log.Printf("1:2 Structure: %v (In:%v Out:%v)", p1.HasOneInput && p1.HasTwoOutputs, p1.HasOneInput, p1.HasTwoOutputs)
		log.Printf("Input Value: %.4f BTC (Threshold: %v)", float64(p1.InputValueSats)/1e8, p1.ExceedsValueThreshold)
		log.Printf("P2SH Outputs: %d", p1.OutputP2SHCount)
		log.Printf("Amount Ratio: %.2f:1 (Valid: %v)", p1.AmountRatio, p1.ExceedsAmountRatio)
		log.Printf("Pattern Matches: %d/4", p1.PatternMatches)
		log.Printf("Score: %.2f", p1.TransactionScore)
	}

	log.Printf("\n--- PHASE 2: CHAIN-LEVEL ---")
	log.Printf("Suspicious (Phase 1): %v (Score: %.2f)", result.IsSuspicious, result.SuspiciousScore)

	if result.Phase2Result != nil {
		p2 := result.Phase2Result
		log.Printf("Chain Length: %d (Valid: %v)", p2.ChainLength, p2.ChainLengthValid)
		log.Printf("Median Time Interval: %d sec ~%d min (Valid: %v)",
			p2.MedianTimeInterval, p2.MedianTimeInterval/60, p2.TimeIntervalValid)
		log.Printf("Sweeper Transaction: %v (Inputs: %d)", p2.IsSweeperTransaction, p2.SweeperInputCount)
		log.Printf("Anomalies: %d/%d", p2.AnomalyCount, p2.AnomalyThreshold)
		log.Printf("Score: %.2f", p2.ChainScore)
	}

	log.Printf("\n--- FINAL RESULT ---")
	log.Printf("Confirmed Mixer: %v", result.ConfirmedMixer)
	log.Printf("Final Confidence: %.2f%%", result.FinalConfidence*100)
	log.Printf("Anomalies Detected: %d", result.AnomaliesDetected)

	if result.ConfirmedMixer {
		log.Printf("\n--- ADDRESS CLASSIFICATION ---")
		log.Printf("Mixing Service Addresses: %v", result.MixingAddresses)
		log.Printf("Dirty-Side (User) Addresses: %v", result.DirtyAddresses)
		log.Printf("Clean-Side Addresses: %v", result.CleanAddresses)
	}
	log.Printf("=====================================\n")
}
