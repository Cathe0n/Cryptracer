package bitquery

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const endpoint = "https://graphql.bitquery.io"

// FlowEdge represents a single inflow or outflow transaction
type FlowEdge struct {
	TxHash    string
	FromAddr  string
	ToAddr    string
	ValueBTC  float64
	Timestamp int64
	Direction string // "in" or "out"
}

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

// GetWalletFlows fetches inflows and outflows for a Bitcoin address from Bitquery
func GetWalletFlows(address, apiKey string) ([]FlowEdge, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("bitquery API key not set")
	}

	query := `
	query($address: String!) {
	  bitcoin {
	    inputs(
	      inputAddress: {is: $address}
	      options: {limit: 100, desc: "block.timestamp.unixtime"}
	    ) {
	      transaction { hash }
	      value
	      block { timestamp { unixtime } }
	      inputAddress { address }
	      outputAddress { address }
	    }
	    outputs(
	      outputAddress: {is: $address}
	      options: {limit: 100, desc: "block.timestamp.unixtime"}
	    ) {
	      transaction { hash }
	      value
	      block { timestamp { unixtime } }
	      inputAddress { address }
	      outputAddress { address }
	    }
	  }
	}`

	body, _ := json.Marshal(gqlRequest{
		Query:     query,
		Variables: map[string]interface{}{"address": address},
	})

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-KEY", apiKey)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 429 {
		return nil, fmt.Errorf("bitquery rate limit reached")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("bitquery returned status %d", resp.StatusCode)
	}

	var gqlResp gqlResponse
	if err := json.NewDecoder(resp.Body).Decode(&gqlResp); err != nil {
		return nil, err
	}
	if len(gqlResp.Errors) > 0 {
		return nil, fmt.Errorf("bitquery error: %s", gqlResp.Errors[0].Message)
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

	if err := json.Unmarshal(gqlResp.Data, &parsed); err != nil {
		return nil, err
	}

	var edges []FlowEdge

	// Inflows: money coming INTO address (address is the recipient/output)
	for _, inp := range parsed.Bitcoin.Inputs {
		from := inp.InputAddress.Address
		if from == "" {
			from = "coinbase"
		}
		edges = append(edges, FlowEdge{
			TxHash:    inp.Transaction.Hash,
			FromAddr:  from,
			ToAddr:    address,
			ValueBTC:  inp.Value,
			Timestamp: inp.Block.Timestamp.Unixtime,
			Direction: "in",
		})
	}

	// Outflows: money going OUT from address (address is the sender/input)
	for _, out := range parsed.Bitcoin.Outputs {
		to := out.OutputAddress.Address
		if to == "" {
			to = "unknown"
		}
		edges = append(edges, FlowEdge{
			TxHash:    out.Transaction.Hash,
			FromAddr:  address,
			ToAddr:    to,
			ValueBTC:  out.Value,
			Timestamp: out.Block.Timestamp.Unixtime,
			Direction: "out",
		})
	}

	return edges, nil
}
