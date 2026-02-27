package aggregator

import (
	"context"
	"fmt"
	"log"
	"money-tracer/db"
	"money-tracer/internal/bitquery"
	"money-tracer/internal/blockstream"
	"money-tracer/internal/intel"
)

type ProvenanceNode struct {
	ID       string                    `json:"id"`
	Label    string                    `json:"label"`
	Type     string                    `json:"type"`
	Sources  []string                  `json:"sources"`
	Risk     int                       `json:"risk"`
	RiskData *intel.ChainAbuseRiskData `json:"risk_data,omitempty"`
}

type ProvenanceEdge struct {
	Source    string   `json:"source"`
	Target    string   `json:"target"`
	Amount    float64  `json:"amount"`
	Sources   []string `json:"sources"`
	Timestamp int64    `json:"timestamp,omitempty"`
}

type UnifiedGraph struct {
	Nodes map[string]ProvenanceNode `json:"nodes"`
	Edges []ProvenanceEdge          `json:"edges"`
}

func BuildVerifiedFTM(ctx context.Context, id string, caKey string, bqKey string) UnifiedGraph {
	graph := UnifiedGraph{
		Nodes: make(map[string]ProvenanceNode),
		Edges: []ProvenanceEdge{},
	}

	nodeImportance := make(map[string]int)

	// FIX: renamed parameter to nodeID to avoid shadowing the outer `id` variable
	addNode := func(nodeID, label, nType, source string, risk int) {
		if n, ok := graph.Nodes[nodeID]; ok {
			for _, s := range n.Sources {
				if s == source {
					return
				}
			}
			n.Sources = append(n.Sources, source)
			if risk > n.Risk {
				n.Risk = risk
			}
			graph.Nodes[nodeID] = n
		} else {
			graph.Nodes[nodeID] = ProvenanceNode{
				ID:      nodeID,
				Label:   label,
				Type:    nType,
				Sources: []string{source},
				Risk:    risk,
			}
		}

		score := 0
		score += risk * 100
		score += len(graph.Nodes[nodeID].Sources) * 10
		if nodeImportance[nodeID] < score {
			nodeImportance[nodeID] = score
		}
	}

	edgeMap := make(map[string]ProvenanceEdge)
	edgeImportance := make(map[string]float64)

	addEdge := func(src, tgt string, amt float64, source string, timestamp int64) {
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
			edgeMap[key] = ProvenanceEdge{
				Source:    src,
				Target:    tgt,
				Amount:    amt,
				Sources:   []string{source},
				Timestamp: timestamp,
			}
		}
		if edgeImportance[key] < amt {
			edgeImportance[key] = amt
		}
	}

	// 1. Initial target node
	addNode(id, id, "Address", "Initial Query", 0)

	// 2. Local Neo4j
	neoToReal := make(map[string]string)
	if history, err := db.GetMoneyFlow(ctx, id); err == nil && history != nil {
		for eid, node := range history["nodes"].(map[string]interface{}) {
			n := node.(map[string]interface{})
			realID := n["label"].(string)
			neoToReal[eid] = realID
			addNode(realID, realID, n["type"].(string), "Local DB", 0)
		}
		for _, edge := range history["edges"].([]interface{}) {
			e := edge.(map[string]interface{})
			src := neoToReal[e["source"].(string)]
			tgt := neoToReal[e["target"].(string)]
			if src != "" && tgt != "" {
				addEdge(src, tgt, e["amount"].(float64), "Local DB", 0)
			}
		}
	}

	// 3. Live Esplora (Blockstream)
	liveTxs, _ := blockstream.GetAddressTxs(id)
	for _, tx := range liveTxs {
		addNode(tx.Txid, tx.Txid, "Transaction", "Esplora API", 0)

		timestamp := int64(0)
		if tx.Status.Confirmed && tx.Status.BlockTime > 0 {
			timestamp = tx.Status.BlockTime
		}

		for _, vin := range tx.Vin {
			if vin.Prevout != nil && vin.Prevout.ScriptPubKeyAddress != "" {
				addr := vin.Prevout.ScriptPubKeyAddress
				val := float64(vin.Prevout.Value) / 100000000.0
				addNode(addr, addr, "Address", "Esplora API", 0)
				addEdge(addr, tx.Txid, val, "Esplora API", timestamp)
			}
		}
		for _, vout := range tx.Vout {
			if vout.ScriptPubKeyAddress != "" {
				addr := vout.ScriptPubKeyAddress
				val := float64(vout.Value) / 100000000.0
				addNode(addr, addr, "Address", "Esplora API", 0)
				addEdge(tx.Txid, addr, val, "Esplora API", timestamp)
			}
		}
	}

	// 4. Bitquery inflows + outflows
	if bqKey != "" {
		flows, err := bitquery.GetWalletFlows(id, bqKey)
		if err != nil {
			log.Printf("⚠️  [BITQUERY] %v", err)
		} else {
			log.Printf("📡 [BITQUERY] %d flow edges retrieved for %s", len(flows), id)
			for _, flow := range flows {
				addNode(flow.FromAddr, flow.FromAddr, "Address", "Bitquery", 0)
				addNode(flow.ToAddr, flow.ToAddr, "Address", "Bitquery", 0)

				if flow.TxHash != "" {
					addNode(flow.TxHash, flow.TxHash, "Transaction", "Bitquery", 0)
					addEdge(flow.FromAddr, flow.TxHash, flow.ValueBTC, "Bitquery", flow.Timestamp)
					addEdge(flow.TxHash, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp)
				} else {
					addEdge(flow.FromAddr, flow.ToAddr, flow.ValueBTC, "Bitquery", flow.Timestamp)
				}
			}
		}
	}

	// Flush edge map to slice
	for _, e := range edgeMap {
		graph.Edges = append(graph.Edges, e)
	}

	// 5. Intel enrichment (ChainAbuse + WalletExplorer)
	label := intel.GetLabel(id)
	riskData := intel.GetChainAbuseRisk(id, caKey)
	var riskScore int

	if riskData != nil {
		riskScore = intel.CalculateRiskScore(riskData)
		if n, ok := graph.Nodes[id]; ok {
			n.Risk = riskScore
			n.RiskData = riskData
			if label != "" {
				n.Label = label
				n.Sources = append(n.Sources, "WalletExplorer")
			}
			n.Sources = append(n.Sources, "ChainAbuse")
			graph.Nodes[id] = n
			nodeImportance[id] += riskScore * 100
		}
	} else if label != "" {
		if n, ok := graph.Nodes[id]; ok {
			n.Label = label
			n.Sources = append(n.Sources, "WalletExplorer")
			graph.Nodes[id] = n
		}
	}

	return graph
}
