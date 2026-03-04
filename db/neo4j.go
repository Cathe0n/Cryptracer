package db

import (
	"context"
	"fmt"
	"log"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

var driver neo4j.DriverWithContext
var enabled bool

func Init(uri, user, pass string) error {
	var err error
	driver, err = neo4j.NewDriverWithContext(uri, neo4j.BasicAuth(user, pass, ""))
	if err != nil {
		return fmt.Errorf("failed to create Neo4j driver: %w", err)
	}

	ctx := context.Background()
	err = driver.VerifyConnectivity(ctx)
	if err != nil {
		driver.Close(ctx)
		return fmt.Errorf("failed to connect to Neo4j: %w", err)
	}

	enabled = true
	log.Println("✅ Neo4j Connected")
	return nil
}

func Close() {
	_ = driver.Close(context.Background())
	enabled = false
}

func SaveOutput(data []map[string]interface{}) {
	if !enabled {
		return
	}
	ctx := context.Background()
	session := driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
	defer session.Close(ctx)
	query := `UNWIND $rows AS row MERGE (a:Address {id: row.address}) MERGE (t:Transaction {hash: row.tx_hash}) MERGE (t)-[r:PAID_TO]->(a) SET r.amount = row.amount`
	_, _ = session.Run(ctx, query, map[string]interface{}{"rows": data})
}

func SaveInput(data []map[string]interface{}) {
	if !enabled {
		return
	}
	ctx := context.Background()
	session := driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
	defer session.Close(ctx)
	query := `UNWIND $rows AS row MERGE (a:Address {id: row.address}) MERGE (t:Transaction {hash: row.tx_hash}) MERGE (a)-[r:SENT_TO]->(t) SET r.amount = row.amount`
	_, _ = session.Run(ctx, query, map[string]interface{}{"rows": data})
}

// SaveCluster persists co-spend cluster relationships to Neo4j.
// Each row maps an address to a cluster_id via a BELONGS_TO relationship
// to a Wallet node:  (Address)-[:BELONGS_TO]->(Wallet)
//
// This is idempotent — MERGE ensures re-running won't create duplicates.
func SaveCluster(data []map[string]interface{}) {
	if !enabled {
		return
	}
	ctx := context.Background()
	session := driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
	defer session.Close(ctx)

	query := `
	UNWIND $rows AS row
	MERGE (a:Address {id: row.address})
	MERGE (w:Wallet  {id: row.cluster_id})
	MERGE (a)-[:BELONGS_TO]->(w)
	SET   w.cluster_id = row.cluster_id`

	if _, err := session.Run(ctx, query, map[string]interface{}{"rows": data}); err != nil {
		log.Printf("⚠️  [CLUSTER] SaveCluster failed: %v", err)
	}
}

// GetClusterForAddress returns the cluster_id and all member addresses for
// the wallet cluster that contains `address`. Returns nil if the address
// is not in any cluster (singleton) or if the DB is not enabled.
func GetClusterForAddress(ctx context.Context, address string) (map[string]interface{}, error) {
	if !enabled {
		return nil, nil
	}
	session := driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
	defer session.Close(ctx)

	// Find the Wallet node for this address and all its member addresses
	query := `
	MATCH (a:Address {id: $address})-[:BELONGS_TO]->(w:Wallet)
	MATCH (member:Address)-[:BELONGS_TO]->(w)
	RETURN w.id AS cluster_id, collect(member.id) AS members`

	res, err := session.Run(ctx, query, map[string]interface{}{"address": address})
	if err != nil {
		return nil, err
	}

	if res.Next(ctx) {
		rec := res.Record()
		clusterID, _ := rec.Get("cluster_id")
		members, _ := rec.Get("members")
		return map[string]interface{}{
			"cluster_id": clusterID,
			"members":    members,
		}, nil
	}

	// Address is a singleton — not in any cluster
	return map[string]interface{}{
		"cluster_id": address,
		"members":    []string{address},
	}, nil
}

func GetMoneyFlow(ctx context.Context, id string) (map[string]interface{}, error) {
	if !enabled {
		return nil, nil
	}
	session := driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
	defer session.Close(ctx)

	query := `MATCH (n) WHERE n.id = $id OR n.hash = $id OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 50`
	res, err := session.Run(ctx, query, map[string]interface{}{"id": id})
	if err != nil {
		return nil, err
	}

	nodesMap := make(map[string]interface{})
	edges := make([]interface{}, 0)

	for res.Next(ctx) {
		rec := res.Record()
		if nVal, ok := rec.Get("n"); ok && nVal != nil {
			n := nVal.(neo4j.Node)
			nodesMap[n.ElementId] = map[string]interface{}{"label": getLbl(n), "type": safeLabel(n)}
		}
		if mVal, ok := rec.Get("m"); ok && mVal != nil {
			m := mVal.(neo4j.Node)
			nodesMap[m.ElementId] = map[string]interface{}{"label": getLbl(m), "type": safeLabel(m)}
		}
		if rVal, ok := rec.Get("r"); ok && rVal != nil {
			r := rVal.(neo4j.Relationship)
			edges = append(edges, map[string]interface{}{
				"source": r.StartElementId, "target": r.EndElementId,
				"amount": r.Props["amount"], "type": r.Type,
			})
		}
	}
	return map[string]interface{}{"nodes": nodesMap, "edges": edges}, nil
}

func getLbl(n neo4j.Node) string {
	if v, ok := n.Props["id"]; ok {
		return v.(string)
	}
	if v, ok := n.Props["hash"]; ok {
		return v.(string)
	}
	return n.ElementId
}

func safeLabel(n neo4j.Node) string {
	if len(n.Labels) > 0 {
		return n.Labels[0]
	}
	return "Unknown"
}
