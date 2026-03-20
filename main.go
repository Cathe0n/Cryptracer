package main

import (
	"fmt"
	"log"
	"money-tracer/db"
	"money-tracer/internal/aggregator"
	"money-tracer/internal/bitquery"
	"money-tracer/internal/blockstream"
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

// configMutex guards both currentConfig and dbInitialized. All reads and
// writes to either field must be performed while holding this lock.
var (
	configMutex   sync.RWMutex
	currentConfig struct {
		Neo4jURI      string
		Neo4jUser     string
		Neo4jPass     string
		ChainAbuseKey string
		BitqueryKey   string
	}
	dbInitialized bool // guarded by configMutex
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

// getConfig returns a safe copy of the current config. The password is never
// sent back to the client.
func getConfig() Config {
	configMutex.RLock()
	defer configMutex.RUnlock()
	return Config{
		Neo4jURI:      currentConfig.Neo4jURI,
		Neo4jUser:     currentConfig.Neo4jUser,
		Neo4jPass:     "", // never expose the password
		ChainAbuseKey: currentConfig.ChainAbuseKey,
		BitqueryKey:   currentConfig.BitqueryKey,
	}
}

// isDBInitialized returns the current dbInitialized value under a read lock.
func isDBInitialized() bool {
	configMutex.RLock()
	defer configMutex.RUnlock()
	return dbInitialized
}

// readKeys returns caKey and bqKey under a single read lock.
func readKeys() (caKey, bqKey string) {
	configMutex.RLock()
	defer configMutex.RUnlock()
	return currentConfig.ChainAbuseKey, currentConfig.BitqueryKey
}

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	loadEnv()
	defer func() {
		if isDBInitialized() {
			db.Close()
		}
	}()

	// CLI import mode — paths passed as arguments, not hard-coded.
	if len(os.Args) > 1 && os.Args[1] == "--import" {
		if !isDBInitialized() {
			log.Println("⚠️  Database not configured — DB writes will be skipped.")
		}
		inputPath := "./data/Blockchair_bitcoin_inputs.tsv"
		outputPath := "./data/Blockchair_bitcoin_outputs.tsv"
		if len(os.Args) > 2 {
			inputPath = os.Args[2]
		}
		if len(os.Args) > 3 {
			outputPath = os.Args[3]
		}
		fmt.Println("\n[SYSTEM] 🚀 Starting High-Speed Data Import...")
		parser.ImportData(inputPath, true)
		parser.ImportData(outputPath, false)
		return
	}

	r := gin.Default()

	// ── Logging middleware ────────────────────────────────────────────────
	r.Use(func(c *gin.Context) {
		start := time.Now()
		c.Next()
		logAPI(c.Request.Method, c.Request.URL.Path, c.Writer.Status(), time.Since(start), c.ClientIP())
	})

	r.Static("/ui", "./public")

	// ── Config endpoints ──────────────────────────────────────────────────

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
		c.JSON(200, gin.H{"config": getConfig(), "initialized": isDBInitialized()})
	})

	// ── Main forensic graph API ───────────────────────────────────────────

	r.GET("/api/trace/:id", func(c *gin.Context) {
		start := time.Now()
		id := c.Param("id")

		if !isDBInitialized() {
			log.Printf("⚠️  Database not configured — local DB queries will be skipped for %s", id)
		}
		log.Printf("\n🔎 [INVESTIGATION] Target: %s", id)

		caKey, bqKey := readKeys()
		graph := aggregator.BuildVerifiedFTM(c.Request.Context(), id, caKey, bqKey)

		log.Printf("✅ [INVESTIGATION] Complete: %d nodes, %d edges in %v",
			len(graph.Nodes), len(graph.Edges), time.Since(start))
		c.JSON(200, gin.H{"graph": graph})
	})

	// ── Live history ──────────────────────────────────────────────────────

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

	// ── Forward path tracer ───────────────────────────────────────────────

	r.GET("/api/trace-path/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")

		hops := 10
		if h := c.Query("hops"); h != "" {
			if n, err := strconv.Atoi(h); err == nil && n >= 1 && n <= 20 {
				hops = n
			}
		}

		caKey, _ := readKeys()
		log.Printf("🔍 [TRACE-PATH] Forward tracing from: %s (max %d hops)", address, hops)

		path := tracer.TraceForward(c.Request.Context(), address, caKey, hops)

		log.Printf("✅ [TRACE-PATH] %d hops in %v — stopped: %s", path.TotalHops, time.Since(start), path.StopReason)
		c.JSON(200, gin.H{"path": path})
	})

	// ── Mixer detection ───────────────────────────────────────────────────

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
		sweeper := aggregator.IsSweeperTransaction(tio)

		log.Printf("✅ [MIXER-CHECK] %s — score=%.2f flagged=%v type=%s sweeper=%v (%v)",
			txid, result.Score, result.Flagged, result.MixerType, sweeper.IsSweeper, time.Since(start))

		c.JSON(200, gin.H{
			"txid":      txid,
			"inputs":    len(tio.Inputs),
			"outputs":   len(tio.Outputs),
			"threshold": threshold,
			"result":    result,
			"sweeper":   sweeper,
		})
	})

	// ── Exchange detection ────────────────────────────────────────────────

	r.GET("/api/exchange-check/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")
		log.Printf("🏦 [EXCHANGE-CHECK] Analysing address: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transactions: %v", err)})
			return
		}

		tios := buildTIOs(txs)
		result := aggregator.IsExchangeAddress(tios, 0.60)

		log.Printf("✅ [EXCHANGE-CHECK] %s — score=%.2f flagged=%v (%v)",
			address, result.Score, result.Flagged, time.Since(start))
		c.JSON(200, gin.H{"address": address, "tx_count": len(tios), "result": result})
	})

	// ── Cluster (co-spend) endpoint ───────────────────────────────────────

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

	// ── Gambling detection ────────────────────────────────────────────────

	r.GET("/api/gambling-check/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")
		log.Printf("🎰 [GAMBLING-CHECK] Analysing address: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transactions: %v", err)})
			return
		}
		tios := buildTIOsWithCoinbase(txs)
		result := aggregator.IsGamblingAddress(tios, 0.55)

		log.Printf("✅ [GAMBLING-CHECK] %s — score=%.2f flagged=%v (%v)",
			address, result.Score, result.Flagged, time.Since(start))
		c.JSON(200, gin.H{"address": address, "tx_count": len(tios), "result": result})
	})

	// ── Mining pool detection ─────────────────────────────────────────────

	r.GET("/api/mining-check/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")
		log.Printf("⛏️  [MINING-CHECK] Analysing address: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transactions: %v", err)})
			return
		}
		tios := buildTIOsWithCoinbase(txs)
		result := aggregator.IsMiningPoolAddress(tios, 0.55)

		log.Printf("✅ [MINING-CHECK] %s — score=%.2f flagged=%v (%v)",
			address, result.Score, result.Flagged, time.Since(start))
		c.JSON(200, gin.H{"address": address, "tx_count": len(tios), "result": result})
	})

	// ── Debug: raw Bitquery output ────────────────────────────────────────

	r.GET("/api/debug/bitquery/:address", func(c *gin.Context) {
		address := c.Param("address")

		_, bqKey := readKeys()
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

	// ── Address mixer check (all 3 layers) ────────────────────────────────

	r.GET("/api/mixer-check-address/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")
		log.Printf("🔀 [MIXER-ADDR] Analysing address: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to fetch transactions: %v", err)})
			return
		}
		tios := buildTIOsWithCoinbase(txs)

		score, flagged, notes := aggregator.CombinedMixingScore(address, tios, 0)
		addrResult := aggregator.IsMixingAddress(address, tios, 0)

		log.Printf("✅ [MIXER-ADDR] %s — combined=%.2f flagged=%v (%v)",
			address, score, flagged, time.Since(start))
		c.JSON(200, gin.H{
			"address":        address,
			"tx_count":       len(tios),
			"combined_score": score,
			"flagged":        flagged,
			"top_notes":      notes,
			"features":       addrResult.Features,
			"breakdown":      addrResult.Breakdown,
		})
	})

	// ─── Boot banner ──────────────────────────────────────────────────────
	fmt.Println("\n" + strings.Repeat("=", 60))
	fmt.Println("🔓 Cryptracer is READY")
	fmt.Println(strings.Repeat("=", 60))

	if isDBInitialized() {
		fmt.Println("✅ Database:        Connected")
		fmt.Println("🌐 Main App:        http://localhost:8080/ui/index.html")
	} else {
		fmt.Println("⚠️  Database:        Not Configured")
		fmt.Println("🔧 Setup:           http://localhost:8080/ui/setup.html")
	}

	caKey, bqKey := readKeys()
	if caKey != "" {
		fmt.Println("🛡️  ChainAbuse:      Enabled")
	} else {
		fmt.Println("⚠️  ChainAbuse:      Disabled (no API key)")
	}
	if bqKey != "" {
		fmt.Println("📡 Bitquery:        Enabled")
	} else {
		fmt.Println("⚠️  Bitquery:        Disabled (no API key)")
	}

	fmt.Println(strings.Repeat("-", 60))
	fmt.Println("📡 Endpoints:")
	fmt.Println("   GET /api/mixer-check/:txid              — per-tx mixer analysis")
	fmt.Println("   GET /api/mixer-check-address/:address   — full 3-layer mixer analysis")
	fmt.Println("   GET /api/exchange-check/:address        — exchange analysis")
	fmt.Println("   GET /api/gambling-check/:address        — gambling detection")
	fmt.Println("   GET /api/mining-check/:address          — mining pool detection")
	fmt.Println("   GET /api/cluster/:address               — co-spend wallet cluster")
	fmt.Println("   GET /api/trace-path/:address            — forward hop tracer")
	fmt.Println(strings.Repeat("=", 60) + "\n")

	r.Run(":8080")
}

// ─── Shared TX conversion helpers ────────────────────────────────────────────

// buildTIOs converts blockstream.Tx slices into aggregator.TransactionIO slices
// without coinbase detection (used by exchange-check).
func buildTIOs(txs []blockstream.Tx) []aggregator.TransactionIO {
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
	return tios
}

// buildTIOsWithCoinbase is like buildTIOs but also sets HasCoinbase when a
// coinbase input (nil Prevout) is detected. Used by gambling and mining checks.
func buildTIOsWithCoinbase(txs []blockstream.Tx) []aggregator.TransactionIO {
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
	return tios
}
