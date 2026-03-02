package blockstream

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const BaseURL = "https://blockstream.info/api"

type Status struct {
	Confirmed   bool  `json:"confirmed"`
	BlockHeight int   `json:"block_height"`
	BlockTime   int64 `json:"block_time"` // IMPORTANT: Used for the timeline
}

// Vout is a transaction output. ScriptPubKeyType is required by the
// mixer-detection heuristic (uniform_scripts rule) in aggregator.IsCoinMixer.
type Vout struct {
	Value               int64  `json:"value"`
	ScriptPubKeyAddress string `json:"scriptpubkey_address"`
	ScriptPubKeyType    string `json:"scriptpubkey_type"` // e.g. p2pkh, p2wpkh, p2sh, p2wsh, p2tr, op_return
}

// Vin is a transaction input. Sequence is required by the RBF-disabled
// heuristic (rbf_disabled rule) in aggregator.IsCoinMixer.
// Wasabi sets nSequence = 0xFFFFFFFE on all inputs.
type Vin struct {
	Txid     string `json:"txid"`
	Vout     uint32 `json:"vout"`
	Sequence uint32 `json:"sequence"` // 0xFFFFFFFD = RBF opt-in, 0xFFFFFFFE/0xFFFFFFFF = no RBF
	Prevout  *Vout  `json:"prevout"`
}

type Tx struct {
	Txid   string `json:"txid"`
	Vin    []Vin  `json:"vin"`
	Vout   []Vout `json:"vout"`
	Status Status `json:"status"`

	// Fee fields — present in the Blockstream API, used by enrichment panels.
	Fee    int64 `json:"fee"`
	Weight int   `json:"weight"`
	Size   int   `json:"size"`
}

// AddressStats holds chain/mempool statistics for a single address.
// Populated by GetAddressInfo.
type AddressStats struct {
	FundedTxoSum int64 `json:"funded_txo_sum"`
	SpentTxoSum  int64 `json:"spent_txo_sum"`
	TxCount      int   `json:"tx_count"`
}

// AddressInfo is the response from /address/:address.
type AddressInfo struct {
	Address      string       `json:"address"`
	ChainStats   AddressStats `json:"chain_stats"`
	MempoolStats AddressStats `json:"mempool_stats"`
}

// UTXO represents an unspent transaction output.
type UTXO struct {
	Txid   string `json:"txid"`
	Vout   uint32 `json:"vout"`
	Value  int64  `json:"value"`
	Status Status `json:"status"`
}

// client is a shared HTTP client with a reasonable timeout.
var client = &http.Client{Timeout: 10 * time.Second}

func get(path string, dst interface{}) error {
	url := BaseURL + path
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("blockstream GET %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 429 {
		return fmt.Errorf("blockstream rate limit reached for %s", path)
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("blockstream HTTP %d for %s", resp.StatusCode, path)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

// GetAddressTxs returns up to 50 recent transactions for an address,
// newest first.  Returns a nil slice (not an error) when the address
// has no transactions.
func GetAddressTxs(address string) ([]Tx, error) {
	var txs []Tx
	err := get(fmt.Sprintf("/address/%s/txs", address), &txs)
	return txs, err
}

// GetAddressInfo returns chain and mempool statistics for an address.
func GetAddressInfo(address string) (*AddressInfo, error) {
	var info AddressInfo
	err := get(fmt.Sprintf("/address/%s", address), &info)
	if err != nil {
		return nil, err
	}
	return &info, nil
}

// GetUTXOs returns all unspent outputs for an address.
func GetUTXOs(address string) ([]UTXO, error) {
	var utxos []UTXO
	err := get(fmt.Sprintf("/address/%s/utxo", address), &utxos)
	return utxos, err
}

// GetTx fetches a single transaction by txid.
func GetTx(txid string) (*Tx, error) {
	var tx Tx
	err := get(fmt.Sprintf("/tx/%s", txid), &tx)
	if err != nil {
		return nil, err
	}
	return &tx, nil
}
