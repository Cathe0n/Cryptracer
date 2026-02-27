package blockstream

import (
	"encoding/json"

	"fmt"

	"net/http"

	"time"
)

const BaseURL = "https://blockstream.info/api"

type Status struct {
	Confirmed bool `json:"confirmed"`

	BlockHeight int `json:"block_height"`

	BlockTime int64 `json:"block_time"` // IMPORTANT: Used for the timeline

}

type Vout struct {
	Value int64 `json:"value"`

	ScriptPubKeyAddress string `json:"scriptpubkey_address"`
}

type Vin struct {
	Txid string `json:"txid"`

	Prevout *Vout `json:"prevout"`
}

type Tx struct {
	Txid string `json:"txid"`

	Vin []Vin `json:"vin"`

	Vout []Vout `json:"vout"`

	Status Status `json:"status"`
}

func GetAddressTxs(address string) ([]Tx, error) {

	url := fmt.Sprintf("%s/address/%s/txs", BaseURL, address)

	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(url)

	if err != nil {

		return nil, err

	}

	defer resp.Body.Close()

	var txs []Tx

	json.NewDecoder(resp.Body).Decode(&txs)

	return txs, nil

}
