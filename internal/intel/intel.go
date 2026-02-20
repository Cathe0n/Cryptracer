package intel

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type WalletLabel struct {
	Label string `json:"label"`
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

func GetAbuseScore(addr string, apiKey string) int {
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("https://api.chainabuse.com/v1/reports?address=%s", addr)
	req, _ := http.NewRequest("GET", url, nil)
	req.SetBasicAuth(apiKey, "")
	resp, err := client.Do(req)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()

	var reports []interface{}
	json.NewDecoder(resp.Body).Decode(&reports)
	return len(reports)
}
