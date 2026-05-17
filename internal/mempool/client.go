package mempool

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const BaseURL = "https://mempool.space/api"

// Status holds confirmation metadata for a transaction.
// BlockHash is included so the aggregator can look up which pool
// mined the block — see GetBlockPool below.
type Status struct {
	Confirmed   bool   `json:"confirmed"`
	BlockHeight int    `json:"block_height"`
	BlockHash   string `json:"block_hash"` // ← NEW: needed for pool lookup
	BlockTime   int64  `json:"block_time"` // IMPORTANT: Used for the timeline
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

	// Fee fields — present in the Mempool.space API, used by enrichment panels.
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

// ─── Mining pool types ────────────────────────────────────────────────────────

// PoolInfo is the pool attribution returned inside a block's extras field.
// The Name field is the canonical human-readable pool name (e.g. "Foundry USA",
// "Binance Pool", "F2Pool") and is suitable for display directly in the graph.
type PoolInfo struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// blockExtras wraps the optional pool attribution that mempool.space attaches
// to every confirmed block via its internal tagging system.
type blockExtras struct {
	Pool *PoolInfo `json:"pool"`
}

// blockSummary is the minimal subset of the /v1/block/:hash response we need.
type blockSummary struct {
	ID     string      `json:"id"`
	Height int         `json:"height"`
	Extras blockExtras `json:"extras"`
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

// client is a shared HTTP client with a reasonable timeout.
var client = &http.Client{Timeout: 30 * time.Second}

func get(path string, dst interface{}) error {
	url := BaseURL + path
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("mempool.space GET %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 429 {
		return fmt.Errorf("mempool.space rate limit reached for %s", path)
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("mempool.space HTTP %d for %s", resp.StatusCode, path)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

// ─── Address endpoints ────────────────────────────────────────────────────────

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

// ─── Mining pool lookup ───────────────────────────────────────────────────────

// GetBlockPool returns the mining pool that produced the block with blockHash.
// The pool attribution is taken from mempool.space's /v1/block/:hash endpoint
// which tags every block against its known pool fingerprints.
//
// Returns (nil, nil) — not an error — when:
//   - The block has no pool attribution (rare for recent blocks, common for
//     very old blocks mined before pools were widely used).
//   - The extras field is missing from the response.
//
// Callers should cache results keyed by blockHash to avoid redundant lookups —
// many transactions in one graph often share the same block.
func GetBlockPool(blockHash string) (*PoolInfo, error) {
	if blockHash == "" {
		return nil, nil
	}
	var blk blockSummary
	if err := get(fmt.Sprintf("/v1/block/%s", blockHash), &blk); err != nil {
		return nil, err
	}
	return blk.Extras.Pool, nil
}
