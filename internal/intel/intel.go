package intel

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type WalletLabel struct {
	Label string `json:"label"`
}

// ChainAbuse API Response structures
type ChainAbuseReport struct {
	ID              int      `json:"id"`
	Address         string   `json:"address"`
	Category        string   `json:"category"`
	Subcategory     string   `json:"subcategory"`
	Reporter        string   `json:"reporter"`
	Description     string   `json:"description"`
	CreatedAt       string   `json:"created_at"`
	Amount          float64  `json:"amount"`
	Blockchain      string   `json:"blockchain"`
	IsVerified      bool     `json:"is_verified"`
	ConfidenceScore float64  `json:"confidence_score"`
	Tags            []string `json:"tags"`
}

type ChainAbuseRiskData struct {
	ReportCount     int                `json:"report_count"`
	TotalAmount     float64            `json:"total_amount"`
	HighestRisk     string             `json:"highest_risk_category"`
	IsVerified      bool               `json:"has_verified_reports"`
	ConfidenceScore float64            `json:"avg_confidence_score"`
	Reports         []ChainAbuseReport `json:"reports"`
	Categories      map[string]int     `json:"categories"`
	Error           string             `json:"error,omitempty"`
}

// ChainAbuseV0Response defines the wrapper for the v0 API response.
// It now correctly expects a `count` and `reports` field.
type ChainAbuseV0Response struct {
	Count   int                  `json:"count"`
	Reports []ChainAbuseV0Report `json:"reports"`
}

// ChainAbuseV0Report defines the structure of a single report from the v0 API.
// It now correctly includes the `description` field which can be optional.
type ChainAbuseV0Report struct {
	ScamCategory string `json:"scamCategory"`
	Trusted      bool   `json:"trusted"`
	Description  string `json:"description,omitempty"`
	CreatedAt    string `json:"createdAt"`
}

func GetLabel(addr string) string {
	url := fmt.Sprintf("http://www.walletexplorer.com/api/1/address-lookup?address=%s&caller=research-tool", addr)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	var res WalletLabel
	json.NewDecoder(resp.Body).Decode(&res)
	return res.Label
}

// Legacy function - kept for backward compatibility
func GetAbuseScore(addr string, apiKey string) int {
	riskData := GetChainAbuseRisk(addr, apiKey)
	if riskData == nil {
		return 0
	}
	return riskData.ReportCount
}

// Enhanced function - returns full risk data
func GetChainAbuseRisk(addr string, apiKey string) *ChainAbuseRiskData {
	if apiKey == "" {
		return nil
	}

	client := &http.Client{Timeout: 10 * time.Second}
	// The v1 endpoint appears to be missing some reports. Using v0 which has better data coverage for some addresses.
	url := fmt.Sprintf("https://api.chainabuse.com/v0/reports?address=%s", addr)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil
	}
	// The v0 API also accepts the v1 API key for authentication.
	req.SetBasicAuth(apiKey, "")

	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode == 429 {
		return &ChainAbuseRiskData{Error: "ChainAbuse API Rate Limit Reached"}
	}

	if resp.StatusCode != 200 {
		return nil
	}

	// The v0 API has a different response structure.
	var v0Response ChainAbuseV0Response
	if err := json.NewDecoder(resp.Body).Decode(&v0Response); err != nil {
		return nil
	}

	// If no reports, return nil
	if v0Response.Count == 0 || len(v0Response.Reports) == 0 {
		return nil
	}

	// Convert v0 reports to the application's internal ChainAbuseReport format.
	reports := make([]ChainAbuseReport, len(v0Response.Reports))
	for i, v0Report := range v0Response.Reports {
		reports[i] = ChainAbuseReport{
			// v0 does not provide a numeric ID, amount, or confidence score.
			// We will have to work with what we have and set sensible defaults.
			ID:          i,
			Address:     addr,
			Category:    mapV0Category(v0Report.ScamCategory),
			Description: v0Report.Description,
			CreatedAt:   v0Report.CreatedAt,
			IsVerified:  v0Report.Trusted,
			Amount:      0, // Not provided by v0
			// Assume medium confidence since the API doesn't provide it.
			// This is better than 0, which would penalize the risk score.
			ConfidenceScore: 0.5,
		}
	}

	// Analyze reports
	riskData := &ChainAbuseRiskData{
		ReportCount: len(reports),
		Reports:     reports,
		Categories:  make(map[string]int),
	}

	var totalConfidence float64
	var verifiedCount int
	var highestRiskCategory string
	var highestRiskPriority int

	// Risk priority (higher = more severe)
	riskPriority := map[string]int{
		"ransomware":          10,
		"darknet market":      9,
		"terrorist financing": 9,
		"child abuse":         9,
		"hack":                8,
		"scam":                7,
		"phishing":            7,
		"ponzi scheme":        6,
		"blackmail":           6,
		"theft":               5,
		"fraud":               5,
		"mixer":               4,
		"sanctions":           8,
		"other":               3,
	}

	for _, report := range reports {
		// Track total amount lost
		riskData.TotalAmount += report.Amount

		// Track confidence scores
		totalConfidence += report.ConfidenceScore

		// Track verified reports
		if report.IsVerified {
			verifiedCount++
		}

		// Count by category
		riskData.Categories[report.Category]++

		// Find highest risk category
		priority := riskPriority[report.Category]
		if priority > highestRiskPriority {
			highestRiskPriority = priority
			highestRiskCategory = report.Category
		}
	}

	// Calculate averages
	riskData.ConfidenceScore = totalConfidence / float64(len(reports))
	riskData.IsVerified = verifiedCount > 0
	riskData.HighestRisk = highestRiskCategory

	return riskData
}

// mapV0Category converts categories from the ChainAbuse v0 API to the internal format.
func mapV0Category(v0cat string) string {
	cat := strings.ToLower(v0cat)
	switch cat {
	case "investment_scam", "giveaway_scam", "impersonation", "fake_ico", "mining_pool_scam", "fake_returns":
		return "scam"
	case "sextortion", "other_blackmail":
		return "blackmail"
	case "malware":
		return "hack" // Or "other", but "hack" seems closer in spirit
	case "unknown":
		return "other"
	case "phishing", "ransomware":
		return cat // These map directly
	default:
		// For any other cases, just use the lowercase version.
		return cat
	}
}

// Calculate risk score (0-100) based on ChainAbuse data
func CalculateRiskScore(riskData *ChainAbuseRiskData) int {
	if riskData == nil {
		return 0
	}

	score := 0

	// Base score from report count (max 30 points)
	reportScore := riskData.ReportCount * 5
	if reportScore > 30 {
		reportScore = 30
	}
	score += reportScore

	// Confidence score (max 20 points)
	score += int(riskData.ConfidenceScore * 20)

	// Verified reports bonus (15 points)
	if riskData.IsVerified {
		score += 15
	}

	// Category severity (max 25 points)
	severityMap := map[string]int{
		"ransomware":          25,
		"darknet market":      25,
		"terrorist financing": 25,
		"child abuse":         25,
		"hack":                20,
		"scam":                15,
		"phishing":            15,
		"ponzi scheme":        15,
		"blackmail":           15,
		"theft":               10,
		"fraud":               10,
		"mixer":               5,
		"sanctions":           20,
		"other":               5,
	}

	if severity, ok := severityMap[riskData.HighestRisk]; ok {
		score += severity
	}

	// Amount lost factor (max 10 points)
	if riskData.TotalAmount > 10000 {
		score += 10
	} else if riskData.TotalAmount > 1000 {
		score += 7
	} else if riskData.TotalAmount > 100 {
		score += 5
	} else if riskData.TotalAmount > 10 {
		score += 3
	}

	// Cap at 100
	if score > 100 {
		score = 100
	}

	return score
}
