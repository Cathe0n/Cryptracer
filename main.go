package main

import (
	"fmt"
	"log"
	"money-tracer/db"
	"money-tracer/internal/aggregator"
	"money-tracer/internal/bitquery"
	"money-tracer/internal/blockstream"
	"money-tracer/internal/intel"
	"money-tracer/internal/tracer"
	"money-tracer/parser"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

// ─── Runtime config ───────────────────────────────────────────────────────────

var (
	configMutex   sync.RWMutex
	currentConfig struct {
		Neo4jURI      string
		Neo4jUser     string
		Neo4jPass     string
		ChainAbuseKey string
		BitqueryKey   string
	}
	dbInitialized bool
)

type Config struct {
	Neo4jURI      string `json:"neo4j_uri"  binding:"required"`
	Neo4jUser     string `json:"neo4j_user" binding:"required"`
	Neo4jPass     string `json:"neo4j_pass"`
	ChainAbuseKey string `json:"chainabuse_key"`
	BitqueryKey   string `json:"bitquery_key"`
}

// ─── Logging ──────────────────────────────────────────────────────────────────

func logAPI(method, endpoint string, status int, duration time.Duration, details string) {
	emoji := "✅"
	if status >= 400 {
		emoji = "❌"
	} else if status >= 300 {
		emoji = "⚠️"
	}
	log.Printf("%s [API] %s %s - %d (%v) | %s", emoji, method, endpoint, status, duration, details)
}

// ─── Config management ────────────────────────────────────────────────────────

func loadEnv() {
	if err := godotenv.Load(); err != nil {
		log.Println("⚠️  No .env file found — using runtime configuration")
	}

	configMutex.Lock()
	defer configMutex.Unlock()

	currentConfig.Neo4jURI = os.Getenv("NEO4J_URI")
	currentConfig.Neo4jUser = os.Getenv("NEO4J_USER")
	currentConfig.Neo4jPass = os.Getenv("NEO4J_PASS")
	currentConfig.ChainAbuseKey = os.Getenv("CHAINABUSE_KEY")
	currentConfig.BitqueryKey = os.Getenv("BITQUERY_KEY")

	if currentConfig.Neo4jURI != "" && currentConfig.Neo4jUser != "" {
		log.Println("✅ Found credentials in environment, initialising database...")
		if err := db.Init(currentConfig.Neo4jURI, currentConfig.Neo4jUser, currentConfig.Neo4jPass); err != nil {
			log.Printf("❌ Database init failed: %v", err)
		} else {
			dbInitialized = true
			log.Println("✅ Database connected")
		}
	} else {
		log.Println("⚠️  No DB credentials in environment — configure via http://localhost:8080/ui/setup.html")
	}
}

func updateConfig(config Config) (string, error) {
	configMutex.Lock()
	defer configMutex.Unlock()

	if dbInitialized {
		db.Close()
		dbInitialized = false
		log.Println("🔄 Closing existing database connection...")
	}

	currentConfig.Neo4jURI = config.Neo4jURI
	currentConfig.Neo4jUser = config.Neo4jUser
	currentConfig.Neo4jPass = config.Neo4jPass
	currentConfig.ChainAbuseKey = config.ChainAbuseKey
	currentConfig.BitqueryKey = config.BitqueryKey

	log.Printf("🔄 Connecting to Neo4j at %s...", config.Neo4jURI)

	if err := db.Init(config.Neo4jURI, config.Neo4jUser, config.Neo4jPass); err != nil {
		dbInitialized = false
		log.Printf("⚠️  Database connection failed: %v", err)
		return "Neo4j not connected; local DB features will be disabled.", nil
	}

	dbInitialized = true
	log.Println("✅ Database configuration updated and connected")

	if config.ChainAbuseKey != "" {
		log.Println("✅ ChainAbuse API key configured")
	} else {
		log.Println("⚠️  ChainAbuse API key not set — risk scoring disabled")
	}
	if config.BitqueryKey != "" {
		log.Println("✅ Bitquery API key configured")
	} else {
		log.Println("⚠️  Bitquery API key not set — Bitquery enrichment disabled")
	}

	return "Configuration saved and connected.", nil
}

func getConfig() Config {
	configMutex.RLock()
	defer configMutex.RUnlock()
	return Config{
		Neo4jURI:      currentConfig.Neo4jURI,
		Neo4jUser:     currentConfig.Neo4jUser,
		Neo4jPass:     "", // never send the password back to the client
		ChainAbuseKey: currentConfig.ChainAbuseKey,
		BitqueryKey:   currentConfig.BitqueryKey,
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	loadEnv()
	defer func() {
		if dbInitialized {
			db.Close()
		}
	}()

	// CLI import mode
	if len(os.Args) > 1 && os.Args[1] == "--import" {
		if !dbInitialized {
			log.Println("⚠️  Database not configured — DB writes will be skipped.")
		}
		fmt.Println("\n[SYSTEM] 🚀 Starting High-Speed Data Import...")
		parser.ImportData("./data/Blockchair_bitcoin_inputs_20260130.tsv", true)
		parser.ImportData("./data/Blockchair_bitcoin_outputs_20260130.tsv", false)
		return
	}

	r := gin.Default()

	// ── Logging middleware ────────────────────────────────────────────────────
	r.Use(func(c *gin.Context) {
		start := time.Now()
		c.Next()
		logAPI(c.Request.Method, c.Request.URL.Path, c.Writer.Status(), time.Since(start), c.ClientIP())
	})

	r.Static("/ui", "./public")

	// ── Config endpoints ──────────────────────────────────────────────────────

	r.POST("/api/config/test", func(c *gin.Context) {
		var config Config
		if err := c.ShouldBindJSON(&config); err != nil {
			c.JSON(400, gin.H{"success": false, "error": "Invalid configuration format"})
			return
		}
		log.Printf("🔧 [CONFIG] Testing connection to %s (user: %s)", config.Neo4jURI, config.Neo4jUser)
		msg, err := updateConfig(config)
		if err != nil {
			c.JSON(200, gin.H{"success": false, "error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"success": true, "message": msg})
	})

	r.GET("/api/config", func(c *gin.Context) {
		c.JSON(200, gin.H{"config": getConfig(), "initialized": dbInitialized})
	})

	// ── Main forensic graph API ───────────────────────────────────────────────

	r.GET("/api/trace/:id", func(c *gin.Context) {
		start := time.Now()
		id := c.Param("id")

		if !dbInitialized {
			log.Printf("⚠️  Database not configured — local DB queries will be skipped for %s", id)
		}

		log.Printf("\n🔎 [INVESTIGATION] Target: %s", id)

		configMutex.RLock()
		caKey := currentConfig.ChainAbuseKey
		bqKey := currentConfig.BitqueryKey
		configMutex.RUnlock()

		graph := aggregator.BuildVerifiedFTM(c.Request.Context(), id, caKey, bqKey)

		log.Printf("✅ [INVESTIGATION] Complete: %d nodes, %d edges in %v",
			len(graph.Nodes), len(graph.Edges), time.Since(start))

		c.JSON(200, gin.H{"graph": graph})
	})

	// ── Live history ──────────────────────────────────────────────────────────

	r.GET("/api/history/:address", func(c *gin.Context) {
		address := c.Param("address")
		log.Printf("📡 [HISTORY] Fetching live data for: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil || txs == nil {
			log.Printf("⚠️  [HISTORY] No data found for %s", address)
			c.JSON(200, []blockstream.Tx{})
			return
		}
		log.Printf("✅ [HISTORY] Retrieved %d transactions for %s", len(txs), address)
		c.JSON(200, txs)
	})

	// ── Forward path tracer ───────────────────────────────────────────────────

	r.GET("/api/trace-path/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")

		hops := 10
		if h := c.Query("hops"); h != "" {
			if n, err := strconv.Atoi(h); err == nil && n >= 1 && n <= 20 {
				hops = n
			}
		}

		configMutex.RLock()
		caKey := currentConfig.ChainAbuseKey
		configMutex.RUnlock()

		log.Printf("🔍 [TRACE-PATH] Forward tracing from: %s (max %d hops)", address, hops)

		path := tracer.TraceForward(c.Request.Context(), address, caKey, hops)

		log.Printf("✅ [TRACE-PATH] %d hops in %v — stopped: %s", path.TotalHops, time.Since(start), path.StopReason)
		c.JSON(200, gin.H{"path": path})
	})

	// ── Mixer detection endpoint ──────────────────────────────────────────────
	// POST /api/mixer-check/:txid
	// Fetches a live transaction from Blockstream and runs all mixer-detection
	// heuristics against it.  Returns the full MixerResult with breakdown scores.
	//
	// Query params:
	//   threshold  float64  detection threshold 0–1 (default 0.70)
	r.GET("/api/mixer-check/:txid", func(c *gin.Context) {
		start := time.Now()
		txid := c.Param("txid")

		threshold := 0.70
		if t := c.Query("threshold"); t != "" {
			if v, err := strconv.ParseFloat(t, 64); err == nil && v > 0 && v <= 1 {
				threshold = v
			}
		}

		log.Printf("🔀 [MIXER-CHECK] Analysing tx: %s (threshold=%.2f)", txid, threshold)

		tx, err := blockstream.GetTx(txid)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transaction: %v", err)})
			return
		}
		if tx == nil {
			c.JSON(404, gin.H{"error": "Transaction not found"})
			return
		}

		// Build aggregator.TransactionIO from the live blockstream data
		tio := aggregator.TransactionIO{Txid: tx.Txid, Timestamp: tx.Status.BlockTime}
		for _, vin := range tx.Vin {
			if vin.Prevout == nil {
				continue
			}
			tio.Inputs = append(tio.Inputs, aggregator.TxInput{
				Address:  vin.Prevout.ScriptPubKeyAddress,
				Value:    float64(vin.Prevout.Value) / 1e8,
				Sequence: vin.Sequence,
			})
		}
		for _, vout := range tx.Vout {
			tio.Outputs = append(tio.Outputs, aggregator.TxOutput{
				Address:    vout.ScriptPubKeyAddress,
				Value:      float64(vout.Value) / 1e8,
				ScriptType: vout.ScriptPubKeyType,
			})
		}

		result := aggregator.IsCoinMixer(tio, threshold)

		log.Printf("✅ [MIXER-CHECK] %s — score=%.2f flagged=%v type=%s (%v)",
			txid, result.Score, result.Flagged, result.MixerType, time.Since(start))

		c.JSON(200, gin.H{
			"txid":      txid,
			"inputs":    len(tio.Inputs),
			"outputs":   len(tio.Outputs),
			"threshold": threshold,
			"result":    result,
		})
	})

	// ── Exchange detection endpoint ───────────────────────────────────────────
	// GET /api/exchange-check/:address
	// Fetches recent transactions for an address and runs exchange-detection
	// heuristics across all of them.
	r.GET("/api/exchange-check/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")

		log.Printf("🏦 [EXCHANGE-CHECK] Analysing address: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transactions: %v", err)})
			return
		}

		// Convert to aggregator.TransactionIO slice
		tios := make([]aggregator.TransactionIO, 0, len(txs))
		for _, tx := range txs {
			tio := aggregator.TransactionIO{Txid: tx.Txid, Timestamp: tx.Status.BlockTime}
			for _, vin := range tx.Vin {
				if vin.Prevout == nil {
					continue
				}
				tio.Inputs = append(tio.Inputs, aggregator.TxInput{
					Address:  vin.Prevout.ScriptPubKeyAddress,
					Value:    float64(vin.Prevout.Value) / 1e8,
					Sequence: vin.Sequence,
				})
			}
			for _, vout := range tx.Vout {
				tio.Outputs = append(tio.Outputs, aggregator.TxOutput{
					Address:    vout.ScriptPubKeyAddress,
					Value:      float64(vout.Value) / 1e8,
					ScriptType: vout.ScriptPubKeyType,
				})
			}
			tios = append(tios, tio)
		}

		result := aggregator.IsExchangeAddress(tios, 0.60)

		log.Printf("✅ [EXCHANGE-CHECK] %s — score=%.2f flagged=%v (%v)",
			address, result.Score, result.Flagged, time.Since(start))

		c.JSON(200, gin.H{
			"address":  address,
			"tx_count": len(tios),
			"result":   result,
		})
	})

	// ── Debug: raw Bitquery output ────────────────────────────────────────────

	// ── Cluster (co-spend) endpoint ───────────────────────────────────────────
	// GET /api/cluster/:address
	// Returns the wallet cluster that contains `address` — i.e. all Bitcoin
	// addresses that have been proven (via co-spend) to be controlled by the
	// same entity as the given address.
	//
	// Response: { address, cluster_id, member_count, members: []string }
	r.GET("/api/cluster/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")

		log.Printf("🔗 [CLUSTER] Looking up cluster for: %s", address)

		cluster, err := db.GetClusterForAddress(c.Request.Context(), address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Cluster lookup failed: %v", err)})
			return
		}
		if cluster == nil {
			c.JSON(200, gin.H{
				"address":      address,
				"cluster_id":   address,
				"member_count": 1,
				"members":      []string{address},
				"note":         "Database not configured — cluster data unavailable",
			})
			return
		}

		members, _ := cluster["members"].([]interface{})
		memberStrs := make([]string, 0, len(members))
		for _, m := range members {
			if s, ok := m.(string); ok {
				memberStrs = append(memberStrs, s)
			}
		}
		if len(memberStrs) == 0 {
			memberStrs = []string{address}
		}

		log.Printf("✅ [CLUSTER] %s → cluster %s (%d members) in %v",
			address, cluster["cluster_id"], len(memberStrs), time.Since(start))

		c.JSON(200, gin.H{
			"address":      address,
			"cluster_id":   cluster["cluster_id"],
			"member_count": len(memberStrs),
			"members":      memberStrs,
		})
	})

	// ── Gambling detection endpoint ───────────────────────────────────────────
	// GET /api/gambling-check/:address
	r.GET("/api/gambling-check/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")

		log.Printf("🎰 [GAMBLING-CHECK] Analysing address: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transactions: %v", err)})
			return
		}

		tios := make([]aggregator.TransactionIO, 0, len(txs))
		for _, tx := range txs {
			tio := aggregator.TransactionIO{Txid: tx.Txid, Timestamp: tx.Status.BlockTime}
			for _, vin := range tx.Vin {
				if vin.Prevout == nil {
					tio.HasCoinbase = true
					continue
				}
				tio.Inputs = append(tio.Inputs, aggregator.TxInput{
					Address:  vin.Prevout.ScriptPubKeyAddress,
					Value:    float64(vin.Prevout.Value) / 1e8,
					Sequence: vin.Sequence,
				})
			}
			for _, vout := range tx.Vout {
				tio.Outputs = append(tio.Outputs, aggregator.TxOutput{
					Address:    vout.ScriptPubKeyAddress,
					Value:      float64(vout.Value) / 1e8,
					ScriptType: vout.ScriptPubKeyType,
				})
			}
			tios = append(tios, tio)
		}

		result := aggregator.IsGamblingAddress(tios, 0.55)

		log.Printf("✅ [GAMBLING-CHECK] %s — score=%.2f flagged=%v (%v)",
			address, result.Score, result.Flagged, time.Since(start))

		c.JSON(200, gin.H{
			"address":  address,
			"tx_count": len(tios),
			"result":   result,
		})
	})

	// ── Mining pool detection endpoint ────────────────────────────────────────
	// GET /api/mining-check/:address
	r.GET("/api/mining-check/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")

		log.Printf("⛏️  [MINING-CHECK] Analysing address: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transactions: %v", err)})
			return
		}

		tios := make([]aggregator.TransactionIO, 0, len(txs))
		for _, tx := range txs {
			tio := aggregator.TransactionIO{Txid: tx.Txid, Timestamp: tx.Status.BlockTime}
			for _, vin := range tx.Vin {
				if vin.Prevout == nil {
					tio.HasCoinbase = true
					continue
				}
				tio.Inputs = append(tio.Inputs, aggregator.TxInput{
					Address:  vin.Prevout.ScriptPubKeyAddress,
					Value:    float64(vin.Prevout.Value) / 1e8,
					Sequence: vin.Sequence,
				})
			}
			for _, vout := range tx.Vout {
				tio.Outputs = append(tio.Outputs, aggregator.TxOutput{
					Address:    vout.ScriptPubKeyAddress,
					Value:      float64(vout.Value) / 1e8,
					ScriptType: vout.ScriptPubKeyType,
				})
			}
			tios = append(tios, tio)
		}

		result := aggregator.IsMiningPoolAddress(tios, 0.55)

		log.Printf("✅ [MINING-CHECK] %s — score=%.2f flagged=%v (%v)",
			address, result.Score, result.Flagged, time.Since(start))

		c.JSON(200, gin.H{
			"address":  address,
			"tx_count": len(tios),
			"result":   result,
		})
	})

	// ── Debug: raw Bitquery output ────────────────────────────────────────────

	r.GET("/api/debug/bitquery/:address", func(c *gin.Context) {
		address := c.Param("address")

		configMutex.RLock()
		bqKey := currentConfig.BitqueryKey
		configMutex.RUnlock()

		if bqKey == "" {
			c.JSON(400, gin.H{"error": "Bitquery key not configured — add BITQUERY_KEY to .env"})
			return
		}
		flows, err := bitquery.GetWalletFlows(address, bqKey)
		if err != nil {
			c.JSON(500, gin.H{"error": err.Error()})
			return
		}
		c.JSON(200, gin.H{"address": address, "count": len(flows), "flows": flows})
	})

	// ── Per-source live verification endpoint ───────────────────────────────
	// GET /api/verify/:address?source=chainabuse|walletexplorer|blockstream|bitquery
	//
	// Performs a fresh live query against one named intelligence source and
	// returns the raw result so the frontend can display it inline.
	// The address can also be a txid when source=blockstream.
	r.GET("/api/verify/:address", func(c *gin.Context) {
		address := c.Param("address")
		source := c.Query("source")
		isAddr := c.Query("is_address") != "false"

		configMutex.RLock()
		caKey := currentConfig.ChainAbuseKey
		bqKey := currentConfig.BitqueryKey
		configMutex.RUnlock()

		switch source {

		case "chainabuse":
			if caKey == "" {
				c.JSON(200, gin.H{"source": "chainabuse", "ok": false,
					"error": "ChainAbuse API key not configured."})
				return
			}
			riskData := intel.GetChainAbuseRisk(address, caKey)
			if riskData == nil {
				c.JSON(200, gin.H{"source": "chainabuse", "ok": true,
					"found": false, "report_count": 0,
					"summary": "No abuse reports found for this address."})
				return
			}
			if riskData.Error != "" {
				c.JSON(200, gin.H{"source": "chainabuse", "ok": false, "error": riskData.Error})
				return
			}
			score := intel.CalculateRiskScore(riskData)
			c.JSON(200, gin.H{
				"source":       "chainabuse",
				"ok":           true,
				"found":        true,
				"report_count": riskData.ReportCount,
				"risk_score":   score,
				"highest_risk": riskData.HighestRisk,
				"verified":     riskData.IsVerified,
				"categories":   riskData.Categories,
				"summary": fmt.Sprintf("%d report(s), risk score %d/100, highest category: %s",
					riskData.ReportCount, score, riskData.HighestRisk),
			})

		case "walletexplorer":
			label := intel.GetLabel(address)
			if label == "" {
				c.JSON(200, gin.H{"source": "walletexplorer", "ok": true,
					"found": false, "label": "",
					"summary": "No attribution label found. Address is either unknown or post-2016."})
				return
			}
			c.JSON(200, gin.H{
				"source":  "walletexplorer",
				"ok":      true,
				"found":   true,
				"label":   label,
				"summary": fmt.Sprintf("Attributed to: %s", label),
			})

		case "blockstream":
			if isAddr {
				info, err := blockstream.GetAddressInfo(address)
				if err != nil {
					c.JSON(200, gin.H{"source": "blockstream", "ok": false,
						"error": err.Error()})
					return
				}
				cs := info.ChainStats
				balance := cs.FundedTxoSum - cs.SpentTxoSum
				c.JSON(200, gin.H{
					"source":   "blockstream",
					"ok":       true,
					"found":    true,
					"tx_count": cs.TxCount,
					"balance":  balance,
					"received": cs.FundedTxoSum,
					"spent":    cs.SpentTxoSum,
					"summary":  fmt.Sprintf("%d confirmed txs, balance %d sat", cs.TxCount, balance),
				})
			} else {
				tx, err := blockstream.GetTx(address)
				if err != nil {
					c.JSON(200, gin.H{"source": "blockstream", "ok": false,
						"error": err.Error()})
					return
				}
				c.JSON(200, gin.H{
					"source":    "blockstream",
					"ok":        true,
					"found":     true,
					"confirmed": tx.Status.Confirmed,
					"block":     tx.Status.BlockHeight,
					"fee":       tx.Fee,
					"inputs":    len(tx.Vin),
					"outputs":   len(tx.Vout),
					"summary":   fmt.Sprintf("TX %s, fee %d sat, %d in / %d out", tx.Txid, tx.Fee, len(tx.Vin), len(tx.Vout)),
				})
			}

		case "bitquery":
			if bqKey == "" {
				c.JSON(200, gin.H{"source": "bitquery", "ok": false,
					"error": "Bitquery API key not configured."})
				return
			}
			flows, err := bitquery.GetWalletFlows(address, bqKey)
			if err != nil {
				c.JSON(200, gin.H{"source": "bitquery", "ok": false, "error": err.Error()})
				return
			}
			inflows := 0
			outflows := 0
			var totalIn, totalOut float64
			for _, f := range flows {
				if f.Direction == "in" {
					inflows++
					totalIn += f.ValueBTC
				}
				if f.Direction == "out" {
					outflows++
					totalOut += f.ValueBTC
				}
			}
			c.JSON(200, gin.H{
				"source":    "bitquery",
				"ok":        true,
				"found":     len(flows) > 0,
				"total":     len(flows),
				"inflows":   inflows,
				"outflows":  outflows,
				"total_in":  totalIn,
				"total_out": totalOut,
				"summary":   fmt.Sprintf("%d flow edges (%d in / %d out)", len(flows), inflows, outflows),
			})

		default:
			c.JSON(400, gin.H{"error": fmt.Sprintf("Unknown source %q. Valid: chainabuse, walletexplorer, blockstream, bitquery", source)})
		}
	})

	// ── Node auto-enrichment endpoint ──────────────────────────────────────
	// GET /api/enrich-node/:address
	//
	// Lightweight enrichment for nodes discovered via graph expansion.
	// Runs WalletExplorer label lookup, ChainAbuse risk check, and
	// Blockstream address stats in parallel. Returns only the intel fields
	// needed to patch the node in fullGraphData — no full graph rebuild.
	//
	// Called automatically when any non-enriched node is first clicked.
	r.GET("/api/enrich-node/:address", func(c *gin.Context) {
		address := c.Param("address")
		isAddr := c.Query("is_address") != "false"

		configMutex.RLock()
		caKey := currentConfig.ChainAbuseKey
		bqKey := currentConfig.BitqueryKey
		configMutex.RUnlock()

		type result struct {
			Sources    []string                  `json:"sources"`
			Label      string                    `json:"label,omitempty"`
			EntityType string                    `json:"entity_type,omitempty"`
			Risk       int                       `json:"risk"`
			RiskData   *intel.ChainAbuseRiskData `json:"risk_data,omitempty"`
			TxCount    int                       `json:"tx_count"`
			Balance    int64                     `json:"balance_sat"`
		}

		res := result{}
		var mu sync.Mutex
		var wg sync.WaitGroup

		// Always add these sources — they are always queried
		res.Sources = append(res.Sources, "WalletExplorer")
		if caKey != "" {
			res.Sources = append(res.Sources, "ChainAbuse")
		}
		if bqKey != "" {
			res.Sources = append(res.Sources, "Bitquery")
		}

		// WalletExplorer label
		wg.Add(1)
		go func() {
			defer wg.Done()
			label := intel.GetLabel(address)
			if label != "" {
				mu.Lock()
				res.Label = label
				res.EntityType = string(aggregator.ResolveEntityType(label))
				mu.Unlock()
			}
		}()

		// ChainAbuse risk
		if caKey != "" {
			wg.Add(1)
			go func() {
				defer wg.Done()
				rd := intel.GetChainAbuseRisk(address, caKey)
				if rd != nil {
					mu.Lock()
					res.RiskData = rd
					res.Risk = intel.CalculateRiskScore(rd)
					mu.Unlock()
				}
			}()
		}

		// Blockstream address stats (only for address nodes)
		if isAddr {
			wg.Add(1)
			go func() {
				defer wg.Done()
				info, err := blockstream.GetAddressInfo(address)
				if err == nil && info != nil {
					mu.Lock()
					res.TxCount = info.ChainStats.TxCount
					res.Balance = info.ChainStats.FundedTxoSum - info.ChainStats.SpentTxoSum
					// Add Esplora API as a confirmed source
					found := false
					for _, s := range res.Sources {
						if s == "Esplora API" {
							found = true
							break
						}
					}
					if !found {
						res.Sources = append(res.Sources, "Esplora API")
					}
					mu.Unlock()
				}
			}()
		}

		wg.Wait()
		c.JSON(200, res)
	})

	// ─── Boot banner ──────────────────────────────────────────────────────────
	fmt.Println("\n" + strings.Repeat("=", 60)) // Separator line
	fmt.Println("🔓 Cryptrace is READY")
	fmt.Println("🔓 Cryptracer is READY")
	fmt.Println(strings.Repeat("=", 60)) // Separator line

	if dbInitialized {
		fmt.Println("✅ Database:        Connected")
		fmt.Println("🌐 Main App:        http://localhost:8080/ui/index.html")
	} else {
		fmt.Println("⚠️  Database:        Not Configured")
		fmt.Println("🔧 Setup:           http://localhost:8080/ui/setup.html")
	}

	if currentConfig.ChainAbuseKey != "" {
		fmt.Println("🛡️  ChainAbuse:      Enabled")
	} else {
		fmt.Println("⚠️  ChainAbuse:      Disabled (no API key)")
	}
	if currentConfig.BitqueryKey != "" {
		fmt.Println("📡 Bitquery:        Enabled")
	} else {
		fmt.Println("⚠️  Bitquery:        Disabled (no API key)")
	}

	fmt.Println(strings.Repeat("-", 60))
	fmt.Println("📡 Endpoints:")
	fmt.Println("   GET /api/mixer-check/:txid         — mixer analysis")
	fmt.Println("   GET /api/exchange-check/:address  — exchange analysis")
	fmt.Println("   GET /api/gambling-check/:address  — gambling detection")
	fmt.Println("   GET /api/mining-check/:address    — mining pool detection")
	fmt.Println("   GET /api/cluster/:address         — co-spend wallet cluster")
	fmt.Println(strings.Repeat("=", 60) + "\n")

	r.Run(":8080")
}
