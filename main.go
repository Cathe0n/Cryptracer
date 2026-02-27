package main

import (
	"fmt"
	"log"
	"money-tracer/db"
	"money-tracer/internal/aggregator"
	"money-tracer/internal/bitquery"
	"money-tracer/internal/blockstream"
	"money-tracer/parser"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

// Runtime configuration
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
	Neo4jURI      string `json:"neo4j_uri" binding:"required"`
	Neo4jUser     string `json:"neo4j_user" binding:"required"`
	Neo4jPass     string `json:"neo4j_pass"`
	ChainAbuseKey string `json:"chainabuse_key"`
	BitqueryKey   string `json:"bitquery_key"`
}

// API Logging helper
func logAPI(method, endpoint string, status int, duration time.Duration, details string) {
	emoji := "✅"
	if status >= 400 {
		emoji = "❌"
	} else if status >= 300 {
		emoji = "⚠️"
	}
	log.Printf("%s [API] %s %s - %d (%v) | %s", emoji, method, endpoint, status, duration, details)
}

func loadEnv() {
	err := godotenv.Load()
	if err != nil {
		log.Println("⚠️  Warning: .env file not found, will use runtime configuration")
	}

	configMutex.Lock()
	defer configMutex.Unlock()

	currentConfig.Neo4jURI = os.Getenv("NEO4J_URI")
	currentConfig.Neo4jUser = os.Getenv("NEO4J_USER")
	currentConfig.Neo4jPass = os.Getenv("NEO4J_PASS")
	currentConfig.ChainAbuseKey = os.Getenv("CHAINABUSE_KEY")
	currentConfig.BitqueryKey = os.Getenv("BITQUERY_KEY")

	if currentConfig.Neo4jURI != "" && currentConfig.Neo4jUser != "" {
		log.Println("✅ Found credentials in environment, initializing database...")
		err := db.Init(currentConfig.Neo4jURI, currentConfig.Neo4jUser, currentConfig.Neo4jPass)
		if err != nil {
			log.Printf("❌ Failed to initialize database: %v", err)
		} else {
			dbInitialized = true
			log.Println("✅ Database connected successfully")
		}
	} else {
		log.Println("⚠️  No credentials in environment. Configure via web UI at http://localhost:8080/ui/setup.html")
	}
}

func updateConfig(config Config) error {
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

	log.Printf("🔄 Attempting to connect to Neo4j at %s...", config.Neo4jURI)

	err := db.Init(currentConfig.Neo4jURI, currentConfig.Neo4jUser, currentConfig.Neo4jPass)
	if err != nil {
		log.Printf("❌ Database connection failed: %v", err)
		return err
	}

	dbInitialized = true
	log.Println("✅ Database configuration updated and connected")

	if currentConfig.ChainAbuseKey != "" {
		log.Println("✅ ChainAbuse API key configured")
	} else {
		log.Println("⚠️  ChainAbuse API key not set - risk scoring disabled")
	}

	if currentConfig.BitqueryKey != "" {
		log.Println("✅ Bitquery API key configured")
	} else {
		log.Println("⚠️  Bitquery API key not set - Bitquery enrichment disabled")
	}

	return nil
}

func getConfig() Config {
	configMutex.RLock()
	defer configMutex.RUnlock()

	return Config{
		Neo4jURI:      currentConfig.Neo4jURI,
		Neo4jUser:     currentConfig.Neo4jUser,
		Neo4jPass:     "",
		ChainAbuseKey: currentConfig.ChainAbuseKey,
		BitqueryKey:   currentConfig.BitqueryKey,
	}
}

func main() {
	loadEnv()

	defer func() {
		if dbInitialized {
			db.Close()
		}
	}()

	if len(os.Args) > 1 && os.Args[1] == "--import" {
		if !dbInitialized {
			log.Fatal("❌ Database not configured. Set environment variables or configure via web UI first.")
		}
		fmt.Println("\n[SYSTEM] 🚀 Starting High-Speed Data Import...")
		parser.ImportData("./data/Blockchair_bitcoin_inputs_20260130.tsv", true)
		parser.ImportData("./data/Blockchair_bitcoin_outputs_20260130.tsv", false)
		return
	}

	r := gin.Default()

	// Logging middleware
	r.Use(func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		c.Next()
		duration := time.Since(start)
		status := c.Writer.Status()
		logAPI(c.Request.Method, path, status, duration, c.ClientIP())
	})

	r.Static("/ui", "./public")

	// ── Config endpoints ──────────────────────────────────────────────────────
	r.POST("/api/config/test", func(c *gin.Context) {
		start := time.Now()
		var config Config

		if err := c.ShouldBindJSON(&config); err != nil {
			logAPI("POST", "/api/config/test", 400, time.Since(start), "Invalid JSON")
			c.JSON(400, gin.H{"success": false, "error": "Invalid configuration format"})
			return
		}

		log.Printf("🔧 [CONFIG] Testing connection to %s with user %s", config.Neo4jURI, config.Neo4jUser)

		err := updateConfig(config)
		if err != nil {
			logAPI("POST", "/api/config/test", 500, time.Since(start), "Connection failed")
			c.JSON(200, gin.H{"success": false, "error": err.Error()})
			return
		}

		logAPI("POST", "/api/config/test", 200, time.Since(start), "Connection successful")
		c.JSON(200, gin.H{
			"success": true,
			"message": "Configuration saved and connection successful",
		})
	})

	r.GET("/api/config", func(c *gin.Context) {
		config := getConfig()
		c.JSON(200, gin.H{"config": config, "initialized": dbInitialized})
	})

	// ── Main Forensic API ─────────────────────────────────────────────────────
	r.GET("/api/trace/:id", func(c *gin.Context) {
		start := time.Now()

		if !dbInitialized {
			logAPI("GET", "/api/trace", 503, time.Since(start), "Database not configured")
			c.JSON(503, gin.H{
				"error": "Database not configured. Please configure at /ui/setup.html",
			})
			return
		}

		id := c.Param("id")

		log.Printf("\n🔎 [INVESTIGATION] Target: %s", id)
		log.Printf("📊 [INVESTIGATION] Querying Neo4j database...")

		configMutex.RLock()
		caKey := currentConfig.ChainAbuseKey
		bqKey := currentConfig.BitqueryKey
		configMutex.RUnlock()

		if caKey != "" {
			log.Printf("🛡️  [INVESTIGATION] ChainAbuse risk scoring enabled")
		}
		if bqKey != "" {
			log.Printf("📡 [INVESTIGATION] Bitquery enrichment enabled")
		}

		graph := aggregator.BuildVerifiedFTM(c.Request.Context(), id, caKey, bqKey)

		nodeCount := len(graph.Nodes)
		edgeCount := len(graph.Edges)
		duration := time.Since(start)

		log.Printf("✅ [INVESTIGATION] Complete: %d nodes, %d edges in %v", nodeCount, edgeCount, duration)
		logAPI("GET", "/api/trace/"+id, 200, duration, fmt.Sprintf("%d nodes, %d edges", nodeCount, edgeCount))

		c.JSON(200, gin.H{"graph": graph})
	})

	// ── Live History API ──────────────────────────────────────────────────────
	r.GET("/api/history/:address", func(c *gin.Context) {
		start := time.Now()
		address := c.Param("address")

		log.Printf("📡 [HISTORY] Fetching live data for: %s", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil || txs == nil {
			logAPI("GET", "/api/history/"+address, 404, time.Since(start), "No data found")
			log.Printf("⚠️  [HISTORY] No data found for %s", address)
			c.JSON(200, []blockstream.Tx{})
			return
		}

		duration := time.Since(start)
		log.Printf("✅ [HISTORY] Retrieved %d transactions in %v", len(txs), duration)
		logAPI("GET", "/api/history/"+address, 200, duration, fmt.Sprintf("%d transactions", len(txs)))

		c.JSON(200, txs)
	})

	// ── Debug: Raw Bitquery output ────────────────────────────────────────────
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

		c.JSON(200, gin.H{
			"address": address,
			"count":   len(flows),
			"flows":   flows,
		})
	})

	fmt.Println("\n" + strings.Repeat("=", 60))
	fmt.Println("🔓 Cryptracker is READY")
	fmt.Println(strings.Repeat("=", 60))

	if dbInitialized {
		fmt.Println("✅ Database:    Connected")
		fmt.Println("🌐 Main App:    http://localhost:8080/ui/index.html")
		if currentConfig.ChainAbuseKey != "" {
			fmt.Println("🛡️  ChainAbuse:  Enabled")
		} else {
			fmt.Println("⚠️  ChainAbuse:  Disabled (no API key)")
		}
		if currentConfig.BitqueryKey != "" {
			fmt.Println("📡 Bitquery:    Enabled")
		} else {
			fmt.Println("⚠️  Bitquery:    Disabled (no API key)")
		}
	} else {
		fmt.Println("⚠️  Database:    Not Configured")
		fmt.Println("🔧 Setup:       http://localhost:8080/ui/setup.html")
	}

	fmt.Println(strings.Repeat("=", 60))
	fmt.Println("\n📊 API calls will be logged below:")
	fmt.Println(strings.Repeat("-", 60))

	r.Run(":8080")
}
