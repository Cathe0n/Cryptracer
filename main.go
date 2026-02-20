package main

import (
	"fmt"
	"log"
	"money-tracer/db"
	"money-tracer/internal/aggregator"
	"money-tracer/internal/blockstream"
	"money-tracer/parser"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

// These will be loaded from environment variables
var (
	Neo4jURI      string
	Neo4jUser     string
	Neo4jPass     string
	ChainAbuseKey string
)

func loadEnv() {
	err := godotenv.Load()
	if err != nil {
		log.Println("Warning: .env file not found, using environment variables from OS")
	}

	Neo4jURI = os.Getenv("NEO4J_URI")
	Neo4jUser = os.Getenv("NEO4J_USER")
	Neo4jPass = os.Getenv("NEO4J_PASS")
	ChainAbuseKey = os.Getenv("CHAINABUSE_KEY")

	if Neo4jURI == "" || Neo4jUser == "" {
		log.Fatal("FATAL: NEO4J_URI and NEO4J_USER must be set in your environment")
	}
}

func main() {
	loadEnv()
	db.Init(Neo4jURI, Neo4jUser, Neo4jPass)
	defer db.Close()

	if len(os.Args) > 1 && os.Args[1] == "--import" {
		fmt.Println("\n[SYSTEM] 🚀 Starting High-Speed Data Import...")
		parser.ImportData("./data/Blockchair_bitcoin_inputs_20260130.tsv", true)
		parser.ImportData("./data/Blockchair_bitcoin_outputs_20260130.tsv", false)
		return
	}

	r := gin.Default()
	r.Static("/ui", "./public")

	// Main Forensic API
	r.GET("/api/trace/:id", func(c *gin.Context) {
		id := c.Param("id")
		start := time.Now()

		fmt.Printf("\n[INVESTIGATION] 🔎 Received request for: %s\n", id)

		graph := aggregator.BuildVerifiedFTM(c.Request.Context(), id, ChainAbuseKey)

		fmt.Printf("[SUCCESS] ✅ Trace complete for %s. Response sent in %v\n", id, time.Since(start))
		c.JSON(200, gin.H{"graph": graph})
	})

	// Live History API
	r.GET("/api/history/:address", func(c *gin.Context) {
		address := c.Param("address")
		fmt.Printf("[HISTORY] 📡 Fetching live transaction list for: %s\n", address)

		txs, err := blockstream.GetAddressTxs(address)
		if err != nil || txs == nil {
			fmt.Printf("[WARN] ⚠️ No live history found for %s\n", address)
			c.JSON(200, []blockstream.Tx{})
			return
		}

		fmt.Printf("[HISTORY] ✅ Successfully retrieved %d transactions\n", len(txs))
		c.JSON(200, txs)
	})

	fmt.Println("\n--------------------------------------------------")
	fmt.Println("🔓 Forensic Consensus Tool is READY")
	fmt.Println("🌐 URL: http://localhost:8080/ui/index.html")
	fmt.Println("--------------------------------------------------")
	r.Run(":8080")
}
