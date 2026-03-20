#  Cryptracker – Bitcoin Transaction Forensics & Money Flow Analysis

> **Advanced on-chain intelligence platform for Bitcoin transaction tracing, mixer detection, and money flow visualization.**

![Go](https://img.shields.io/badge/Go-1.24-00ADD8?logo=go) ![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?logo=javascript) ![Neo4j](https://img.shields.io/badge/Neo4j-Graph%20Database-008CC1?logo=neo4j) ![License](https://img.shields.io/badge/License-MIT-green)

---
<img width="1600" height="771" alt="image" src="https://github.com/user-attachments/assets/e392b00f-9b63-4e90-8c61-1c5fe252909f" />


## Overview

**Cryptracker** is a research thesis project designed for advanced Bitcoin transaction analysis. It reconstructs money flows on the blockchain by:

1. **Tracing forward transactions** using change-detection heuristics to identify real payments
2. **Detecting coin mixers** through pattern recognition and behavioral analysis
3. **Identifying exchange behavior** using transaction volume and uniformity heuristics
4. **Scoring risk** using the ChainAbuse API to flag illicit addresses
5. **Visualizing relationships** in an interactive D3.js graph with live mempool enrichment

This tool is intended for **academic research**, **compliance investigations**, and **forensic analysis** of Bitcoin transactions.

---

##  Features

###  Core Capabilities

- **Forward Path Tracing**: Follow Bitcoin from a starting address through multiple hops using intelligent heuristics
  - Fresh address detection (addresses not seen in inputs)
  - Round amount identification (intentional payments vs. change)
  - Modern script type prioritization (Taproot > SegWit > P2PKH)
  - Cycle detection (prevents infinite loops)

- **Mixer Detection**: Identifies coin mixing transactions with configurable thresholds
  - Uniform outputs detection (same value outputs)
  - RBF-disabled flagging (Wasabi signature)
  - Script type mixing analysis
  - Confidence scoring (0-100)

- **Exchange Detection**: Flags addresses exhibiting exchange-like behavior
  - High transaction volume analysis
  - Output uniformity patterns
  - Behavioral consistency scoring

- **Rich Risk Scoring**: Integration with ChainAbuse API for verified threat intelligence
  - Report count and verification status
  - Category classification (ransom, fraud, malware, etc.)
  - Confidence scores and historical data

- **Interactive Visualization**: D3.js-powered graph with advanced controls
  - Force-directed layout and hierarchical tree view
  - Zoom, pan, freeze, and recenter controls
  - Node search and history tracking
  - Edge tooltips with transaction amounts and timestamps
  - Dynamic expansion of address nodes in the graph

### Data Integration

- **Blockstream API**: Real-time transaction and address data
- **Mempool.space API**: Live network statistics and fee recommendations
- **Bitquery GraphQL**: Extended transaction flow queries
- **ChainAbuse API**: Comprehensive risk and abuse reporting
- **Neo4j Database**: Local graph storage for large datasets

---

##  Prerequisites

### System Requirements

- **Go** 1.24.0 or later
- **Node.js** (for development; frontend is vanilla JS)
- **Neo4j** 5.x+ (local or remote instance)

### API Keys Required

| Service | Purpose | Free Tier | Getting Started |
|---------|---------|-----------|-----------------|
| **ChainAbuse** | Risk/abuse data |  Yes | [chainabuse.com](https://www.chainabuse.com) |
| **Bitquery** | Extended transaction flows |  Limited | [bitquery.io](https://bitquery.io) |
| **Blockstream** | Real-time blockchain data |  Unlimited | Free public API |
| **Mempool.space** | Live fees & network stats |  Unlimited | Free public API |

### Database

- **Neo4j Community Edition** or higher
  - URI: `bolt://localhost:7687` (adjust for your setup)
  - Default credentials: `neo4j` / `password`

---

##  Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/money-tracer.git
cd money-tracer
```

### 2. Install Go Dependencies

```bash
go mod download
go mod tidy
```

### 3. Build the Application

```bash
go build -o money-tracer.exe main.go
```

Or run directly:

```bash
go run main.go
```

### 4. Access the Application

- **Main Dashboard**: [http://localhost:8080/ui/index.html](http://localhost:8080/ui/index.html)
- **Setup/Configuration**: [http://localhost:8080/ui/setup.html](http://localhost:8080/ui/setup.html)

---

## Configuration

### Environment Variables

Create a `.env` file in the project root:

```env
# Neo4j Database
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASS=your_password_here

# Third-party APIs (optional)
CHAINABUSE_KEY=your_chainabuse_api_key
BITQUERY_KEY=your_bitquery_api_key
```

### Runtime Configuration

Alternatively, configure settings via the web UI:

1. Visit [http://localhost:8080/ui/setup.html](http://localhost:8080/ui/setup.html)
2. Fill in your database connection and API keys
3. Click **Save Configuration**

The application will:
- Test the Neo4j connection
- Validate API keys
- Enable/disable features based on available credentials
- Store configuration in memory (persists while running)

### Startup Messages

```
============================================================
 Cryptracer is READY
============================================================
 Database:        Connected
 Main App:        http://localhost:8080/ui/index.html
 ChainAbuse:      Enabled
 Bitquery:        Enabled
============================================================
```

---

## Usage

### Web Interface

#### 1. **Search for an Address**

- Click the search bar at the top
- Enter a Bitcoin address
- Press **Enter** or click **Search**
- The application reconstructs a transaction graph from live blockchain data

#### 2. **Explore the Graph**

| Action | Control |
|--------|---------|
| **Zoom In/Out** | Scroll wheel or `+` / `-` buttons |
| **Pan** | Click and drag |
| **Center Graph** | Click **Recenter** button |
| **Toggle Labels** | Press **L** or click label button |
| **Toggle Timestamps** | Press **T** or click timestamp button |
| **Freeze Layout** | Click **Freeze** to lock node positions |
| **Switch Layout** | Toggle between **Force** (physics-based) and **Tree** (hierarchical) |
| **View Edge Details** | Hover over edges to see transaction amounts and dates |

#### 3. **Inspect a Node**

- Click any address or transaction node
- A detailed panel opens showing:
  - Balance (total in - total out)
  - Transaction history
  - Risk score (from ChainAbuse)
  - Neighbors (connected addresses/transactions)
- Click **Enrich** to fetch additional mempool.space data

#### 4. **Trace Forward Path**

- In the graph, click the **Trace Path** button next to an address node
- The app will:
  - Follow the most likely payment chain forward
  - Apply change-detection heuristics at each hop
  - Stop on: unspent outputs, high-risk addresses, detected services, or max hops
  - Highlight the path in orange
  - Display detailed hop-by-hop breakdown

#### 5. **Search History**

- Previous searches are tracked
- Click **History** to revisit prior investigations

---

##  Data Import

Import pre-fetched blockchain data from TSV files into Neo4j for offline analysis.

### Command Line

```bash
go run main.go --import
```

### Expected Files

Place TSV files in the `./data/` directory:

- `Blockchair_bitcoin_inputs_20260130.tsv`
- `Blockchair_bitcoin_outputs_20260130.tsv`

### TSV Format

```
index  tx_hash  vout/vin  scriptpubkey_type  value_btc  ...  address
0      abc123   0         p2pkh              0.5        ...  1A1z...
1      def456   0         p2wpkh             1.25       ...  3J98...
```

### Key Modules

| Module | Purpose |
|--------|---------|
| **aggregator** | Constructs FTM (Financial Threat Model) graphs from blockchain data; detects mixers and exchanges |
| **blockstream** | HTTP client for Blockstream API (transactions, addresses, unspent outputs) |
| **bitquery** | GraphQL client for Bitquery wallet flow queries |
| **intel** | Risk scoring and ChainAbuse API integration |
| **tracer** | Implements forward path tracing with heuristics |
| **parser** | Bulk importer for TSV blockchain data into Neo4j |

---

##  Technologies

### Backend

| Technology | Version | Purpose |
|---|---|---|
| **Go** | 1.24.0+ | Core language |
| **Gin** | 1.11.0 | HTTP framework |
| **Neo4j Go Driver** | 5.28.4 | Graph database client |
| **godotenv** | 1.5.1 | Environment variable loading |


### Data Sources

| Source | Data Type |
|---|---|
| **Blockstream API** | Bitcoin transactions, UTXOs, address history |
| **Mempool.space API** | Network fees, block heights, live stats |
| **Bitquery GraphQL** | Extended transaction flows & queries |
| **ChainAbuse API** | Risk scores, abuse reports, verification |
| **Neo4j** | Offline graph storage & querying |

---


**Last Updated:** March 2, 2026  
**Status:** Active Development 🚀

