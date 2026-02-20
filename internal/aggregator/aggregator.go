package aggregator

import (
	"context"
	"fmt"
	"money-tracer/db"
	"money-tracer/internal/blockstream"
	"money-tracer/internal/intel"
)

type ProvenanceNode struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Type    string   `json:"type"`
	Sources []string `json:"sources"`
	Risk    int      `json:"risk"`
}

type ProvenanceEdge struct {
	Source  string   `json:"source"`
	Target  string   `json:"target"`
	Amount  float64  `json:"amount"`
	Sources []string `json:"sources"`
}

type UnifiedGraph struct {
	Nodes map[string]ProvenanceNode `json:"nodes"`
	Edges []ProvenanceEdge          `json:"edges"`
}

func BuildVerifiedFTM(ctx context.Context, id string, caKey string) UnifiedGraph {
	graph := UnifiedGraph{
		Nodes: make(map[string]ProvenanceNode),
		Edges: []ProvenanceEdge{},
	}

	// Helper: Merge data into graph
	addNode := func(id, label, nType, source string) {
		if n, ok := graph.Nodes[id]; ok {
			for _, s := range n.Sources {
				if s == source {
					return
				}
			}
			n.Sources = append(n.Sources, source)
			graph.Nodes[id] = n
		} else {
			graph.Nodes[id] = ProvenanceNode{ID: id, Label: label, Type: nType, Sources: []string{source}}
		}
	}

	edgeMap := make(map[string]ProvenanceEdge)
	addEdge := func(src, tgt string, amt float64, source string) {
		key := fmt.Sprintf("%s|%s|%.8f", src, tgt, amt)
		if e, ok := edgeMap[key]; ok {
			for _, s := range e.Sources {
				if s == source {
					return
				}
			}
			e.Sources = append(e.Sources, source)
			edgeMap[key] = e
		} else {
			edgeMap[key] = ProvenanceEdge{Source: src, Target: tgt, Amount: amt, Sources: []string{source}}
		}
	}

	// 1. Initial Target node
	addNode(id, id, "Address", "Initial Query")

	// 2. Local Neo4j
	neoToReal := make(map[string]string)
	if history, err := db.GetMoneyFlow(ctx, id); err == nil && history != nil {
		for eid, node := range history["nodes"].(map[string]interface{}) {
			n := node.(map[string]interface{})
			realID := n["label"].(string)
			neoToReal[eid] = realID
			addNode(realID, realID, n["type"].(string), "Local DB")
		}
		for _, edge := range history["edges"].([]interface{}) {
			e := edge.(map[string]interface{})
			src := neoToReal[e["source"].(string)]
			tgt := neoToReal[e["target"].(string)]
			if src != "" && tgt != "" {
				addEdge(src, tgt, e["amount"].(float64), "Local DB")
			}
		}
	}

	// 3. Live Esplora
	liveTxs, _ := blockstream.GetAddressTxs(id)
	for _, tx := range liveTxs {
		addNode(tx.Txid, tx.Txid, "Transaction", "Esplora API")
		for _, vin := range tx.Vin {
			if vin.Prevout != nil && vin.Prevout.ScriptPubKeyAddress != "" {
				addr := vin.Prevout.ScriptPubKeyAddress
				val := float64(vin.Prevout.Value) / 100000000.0
				addNode(addr, addr, "Address", "Esplora API")
				addEdge(addr, tx.Txid, val, "Esplora API")
			}
		}
		for _, vout := range tx.Vout {
			if vout.ScriptPubKeyAddress != "" {
				addr := vout.ScriptPubKeyAddress
				val := float64(vout.Value) / 100000000.0
				addNode(addr, addr, "Address", "Esplora API")
				addEdge(tx.Txid, addr, val, "Esplora API")
			}
		}
	}

	for _, e := range edgeMap {
		graph.Edges = append(graph.Edges, e)
	}

	// 4. Intel Enrichment
	label := intel.GetLabel(id)
	risk := intel.GetAbuseScore(id, caKey)
	if n, ok := graph.Nodes[id]; ok {
		if label != "" {
			n.Label = label
			n.Sources = append(n.Sources, "WalletExplorer")
		}
		if risk > 0 {
			n.Risk = risk
			n.Sources = append(n.Sources, "Chainabuse")
		}
		graph.Nodes[id] = n
	}

	return graph
}
