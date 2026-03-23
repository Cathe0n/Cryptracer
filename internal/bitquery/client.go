package bitquery

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// Bitquery v2 uses OAuth2 bearer tokens, not the old X-API-KEY header.
const (
	tokenEndpoint = "https://oauth2.bitquery.io/oauth2/token"
	gqlEndpoint   = "https://streaming.bitquery.io/graphql"
)

// FlowEdge is kept for backward compatibility with aggregator/main callers.
type FlowEdge struct {
	TxHash    string
	FromAddr  string
	ToAddr    string
	ValueBTC  float64
	Timestamp int64
	Direction string // "in" or "out"
}

// TxIO is a fully hydrated transaction record, letting the aggregator run
// behavioral detectors (mixer, exchange, gambling, mining) on Bitquery data.
type TxIO struct {
	Txid      string
	Timestamp int64
	Inputs    []TxIOSlot
	Outputs   []TxIOSlot
}

type TxIOSlot struct {
	Address string
	Value   float64 // BTC
}

// AddressTransactions is the rich output of GetAddressTransactions.
type AddressTransactions struct {
	Flows    []FlowEdge
	TxIOs    []TxIO
	TotalTxs int
}

// ─── OAuth token cache ────────────────────────────────────────────────────────

var tokenCache struct {
	token   string
	expires time.Time
}

func getBearer(apiKey string) (string, error) {
	if tokenCache.token != "" && time.Now().Before(tokenCache.expires) {
		return tokenCache.token, nil
	}

	body := []byte(fmt.Sprintf(
		"grant_type=client_credentials&client_id=%s&client_secret=%s&scope=api",
		apiKey, apiKey,
	))
	req, _ := http.NewRequest("POST", tokenEndpoint, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	cl := &http.Client{Timeout: 15 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		// Fall back to using key as bearer directly (v1 API keys work this way)
		log.Printf("⚠️  [BITQUERY] OAuth failed, using key as bearer: %v", err)
		return apiKey, nil
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		log.Printf("⚠️  [BITQUERY] OAuth HTTP %d — using key as bearer", resp.StatusCode)
		return apiKey, nil
	}

	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &tok); err != nil || tok.AccessToken == "" {
		return apiKey, nil
	}

	tokenCache.token = tok.AccessToken
	tokenCache.expires = time.Now().Add(time.Duration(tok.ExpiresIn-60) * time.Second)
	return tokenCache.token, nil
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────

type gqlRequest struct {
	Query     string                 `json:"query"`
	Variables map[string]interface{} `json:"variables"`
}

type gqlResponse struct {
	Data   json.RawMessage `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

func gqlQuery(apiKey, query string, variables map[string]interface{}) (json.RawMessage, error) {
	bearer, err := getBearer(apiKey)
	if err != nil {
		return nil, fmt.Errorf("bitquery auth: %w", err)
	}

	body, _ := json.Marshal(gqlRequest{Query: query, Variables: variables})
	req, err := http.NewRequest("POST", gqlEndpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("X-API-KEY", apiKey) // fallback for v1-style keys

	cl := &http.Client{Timeout: 30 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bitquery request: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		tokenCache.token = "" // invalidate so next call re-auths
		return nil, fmt.Errorf("bitquery auth failed (HTTP %d) — check API key in Settings", resp.StatusCode)
	}
	if resp.StatusCode == 429 {
		return nil, fmt.Errorf("bitquery rate limit reached")
	}
	if resp.StatusCode != 200 {
		preview := raw
		if len(preview) > 200 {
			preview = preview[:200]
		}
		return nil, fmt.Errorf("bitquery HTTP %d: %s", resp.StatusCode, string(preview))
	}

	var gr gqlResponse
	if err := json.Unmarshal(raw, &gr); err != nil {
		return nil, fmt.Errorf("bitquery decode: %w", err)
	}
	if len(gr.Errors) > 0 {
		return nil, fmt.Errorf("bitquery error: %s", gr.Errors[0].Message)
	}
	return gr.Data, nil
}

// ─── Address transaction query ────────────────────────────────────────────────

// GetAddressTransactions fetches up to limit inflows and outflows for a Bitcoin
// address using the Bitquery v2 Bitcoin endpoint. Returns both flat FlowEdges
// (for graph edges) and fully-hydrated TxIO records (for behavioral detection).
func GetAddressTransactions(address, apiKey string, limit int) (*AddressTransactions, error) {
	if limit <= 0 {
		limit = 200
	}

	query := `
	query($address: String!, $limit: Int!) {
	  bitcoin {
	    inputs(
	      inputAddress: {is: $address}
	      options: {limit: $limit, desc: "block.timestamp.unixtime"}
	    ) {
	      transaction { hash }
	      value
	      block { timestamp { unixtime } }
	      inputAddress  { address }
	      outputAddress { address }
	    }
	    outputs(
	      outputAddress: {is: $address}
	      options: {limit: $limit, desc: "block.timestamp.unixtime"}
	    ) {
	      transaction { hash }
	      value
	      block { timestamp { unixtime } }
	      inputAddress  { address }
	      outputAddress { address }
	    }
	  }
	}`

	data, err := gqlQuery(apiKey, query, map[string]interface{}{
		"address": address,
		"limit":   limit,
	})
	if err != nil {
		return nil, err
	}

	var parsed struct {
		Bitcoin struct {
			Inputs []struct {
				Transaction struct{ Hash string } `json:"transaction"`
				Value       float64               `json:"value"`
				Block       struct {
					Timestamp struct{ Unixtime int64 } `json:"timestamp"`
				} `json:"block"`
				InputAddress  struct{ Address string } `json:"inputAddress"`
				OutputAddress struct{ Address string } `json:"outputAddress"`
			} `json:"inputs"`
			Outputs []struct {
				Transaction struct{ Hash string } `json:"transaction"`
				Value       float64               `json:"value"`
				Block       struct {
					Timestamp struct{ Unixtime int64 } `json:"timestamp"`
				} `json:"block"`
				InputAddress  struct{ Address string } `json:"inputAddress"`
				OutputAddress struct{ Address string } `json:"outputAddress"`
			} `json:"outputs"`
		} `json:"bitcoin"`
	}

	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("bitquery parse: %w", err)
	}

	result := &AddressTransactions{}

	type txRec struct {
		ts      int64
		inputs  []TxIOSlot
		outputs []TxIOSlot
	}
	txMap := make(map[string]*txRec)
	ensureTx := func(hash string, ts int64) *txRec {
		if r, ok := txMap[hash]; ok {
			return r
		}
		r := &txRec{ts: ts}
		txMap[hash] = r
		return r
	}

	for _, inp := range parsed.Bitcoin.Inputs {
		from := inp.InputAddress.Address
		if from == "" {
			from = "coinbase"
		}
		ts := inp.Block.Timestamp.Unixtime
		result.Flows = append(result.Flows, FlowEdge{
			TxHash: inp.Transaction.Hash, FromAddr: from, ToAddr: address,
			ValueBTC: inp.Value, Timestamp: ts, Direction: "in",
		})
		if h := inp.Transaction.Hash; h != "" {
			r := ensureTx(h, ts)
			r.inputs = append(r.inputs, TxIOSlot{Address: from, Value: inp.Value})
			r.outputs = append(r.outputs, TxIOSlot{Address: address, Value: inp.Value})
		}
	}

	for _, out := range parsed.Bitcoin.Outputs {
		to := out.OutputAddress.Address
		if to == "" {
			to = "unknown"
		}
		ts := out.Block.Timestamp.Unixtime
		result.Flows = append(result.Flows, FlowEdge{
			TxHash: out.Transaction.Hash, FromAddr: address, ToAddr: to,
			ValueBTC: out.Value, Timestamp: ts, Direction: "out",
		})
		if h := out.Transaction.Hash; h != "" {
			r := ensureTx(h, ts)
			r.inputs = append(r.inputs, TxIOSlot{Address: address, Value: out.Value})
			r.outputs = append(r.outputs, TxIOSlot{Address: to, Value: out.Value})
		}
	}

	for hash, rec := range txMap {
		result.TxIOs = append(result.TxIOs, TxIO{
			Txid: hash, Timestamp: rec.ts,
			Inputs: rec.inputs, Outputs: rec.outputs,
		})
	}
	result.TotalTxs = len(txMap)

	log.Printf("📡 [BITQUERY] %d flows (%d unique txs) for %s",
		len(result.Flows), result.TotalTxs, address)
	return result, nil
}

// GetWalletFlows is the backward-compatible wrapper used by existing callers.
func GetWalletFlows(address, apiKey string) ([]FlowEdge, error) {
	res, err := GetAddressTransactions(address, apiKey, 200)
	if err != nil {
		return nil, err
	}
	return res.Flows, nil
}
