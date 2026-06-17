#  Cryptrace – Bitcoin Transaction Forensics & Money Flow Analysis

> **Advanced on-chain intelligence platform for Bitcoin transaction tracing, mixer detection, and money flow visualization.**

![Go](https://img.shields.io/badge/Go-1.24-00ADD8?logo=go) ![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?logo=javascript) ![Neo4j](https://img.shields.io/badge/Neo4j-Graph%20Database-008CC1?logo=neo4j) ![License](https://img.shields.io/badge/License-MIT-green)

---
<img width="1920" height="951" alt="brave_bStgR9AnRg" src="https://github.com/user-attachments/assets/bb251e7d-397e-42ce-945f-768d3026f573" />



## Overview

**Cryptrace** is a project designed for advanced Bitcoin transaction analysis. It reconstructs money flows on the blockchain by:

1. **Tracing forward transactions** using change-detection heuristics to identify real payments
2. **Detecting coin mixers** through pattern recognition and behavioral analysis
3. **Identifying exchange behavior** using transaction volume and uniformity heuristics
4. **Scoring risk** using the ChainAbuse API to flag illicit addresses
5. **Visualizing relationships** in an interactive D3.js graph with live mempool enrichment

This tool is intended for **Bitcoin investigations**, and **forensic analysis** of Bitcoin transactions. 

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

- **Mempool.space API**: Primary source for live mempool state, block history, and mining pool identification.
- **Blockstream (Esplora) API**: High-reliability fallback for address history and UTXO verification.
- **WalletExplorer API**: Entity attribution for historical identification of exchanges and services.
- **Bitquery GraphQL**: Deep historical flow analysis and multi-hop transaction reconstruction.
- **ChainAbuse API**: Real-time community threat intelligence and risk categorization.
- **Neo4j Graph DB**: Persistent storage for investigation history and co-spend cluster computation.

---

##  Prerequisites

### System Requirements

- **Go** 1.24.0 or later
- **Node.js** (for development; frontend is vanilla JS)
- **Neo4j** 5.x+ (local or remote instance)

### API Keys Required

| Service | Purpose | Free Tier | API Status|
|---------|---------|-----------|-----------------|
| **ChainAbuse** | Risk/abuse data |  Yes | [chainabuse.com](https://www.chainabuse.com) |
| **Bitquery** | Extended transaction flows |  Limited | [bitquery.io](https://bitquery.io) |

### Database

- **Neo4j Community Edition** or higher
  - URI: `bolt://localhost:7687` (Or other localhost IP :3)
  - Default credentials: `neo4j` / `password` "Change this!!" <-< 

---

##  Installation


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
 Cryptrace is READY
============================================================
 Main App:        http://localhost:8080/ui/index.html

 Good luck! And stay vigilant :3
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
| **Pan** | Click and drag workspace background |
| **Center Graph** | Click **Recenter** button |
| **Toggle Labels** | Hide/Show Labels — "Simplicity" (‾◡‾) |
| **Toggle Info** | Click **[INFO]** to show amount + time on edges |
| **Freeze Layout** | Click **[FREEZE]** to lock/unlock node positions |
| **Switch Layout** | Toggle between **Force** (physics) and **Tree** (hierarchy) |
| **Wallet View** | Toggle **[WALLET VIEW]** to collapse co-spend clusters |
| **Mining Filter** | Toggle **[MINING]** to isolate/hide mining pool noise |
| **Flow Filters** | Toggle **Incoming** or **Outgoing** for directionality |
| **Timeline Control** | Use time slider or **Calendar** to filter by date |
| **View Edge Details** | Hover over edges (Requires **[TOOLTIPS]** active) |
| **Search & Jump** | Use search bar (Top Right) to find IDs, Labels, or Entities |
| **Expand Graph** | Use **Expand neighbors** or **⚡ Expand All** |
| **Save Session** | Click **Save Session** to export a `.ctk` forensic file |

#### 3. **Inspect a Node & Entity Intelligence**

- **Forensic Panel**: Clicking any node opens a deep-dive panel showing balance, transaction counts, and risk classification.
- **Cross-Validation**: Verify identities in real-time across **ChainAbuse** (abuse reports), **WalletExplorer** (historical service labels), **Bitquery** (flow volume), and **Mempool.space** (live UTXO state).
- **Custom Annotations**: Add custom nicknames or change node colors directly in the panel to highlight key actors in your investigation.
- **Sub-graph Expansion**: Use the "Expand" tools on any address to dynamically load its neighbors into the existing graph without a full reload.

#### 4. **Forward Trace & Peeling Heuristics**

- **Peeling Chain Detection**: The tracer automatically identifies and follows "peeling" behavior (one small payment + one large change output) to find the primary stack of funds.
- **Heuristic Scoring**: Each hop is evaluated based on script type priority (Taproot > SegWit), round amount identification, and address age.
- **Automated Halting**: The trace intelligently stops when funds reach a **Mixer** (Wasabi, Whirlpool, JoinMarket), a **Known Service** (Exchange), or a high-risk flagged address.
- **Interactive Timeline**: Traced paths are highlighted in orange with a glowing destination ring, and are fully integrated into the sidebar hop-by-hop breakdown.

#### 5. **Investigation Management & Persistence**

- **Global Search**: Instantly locate any address, transaction, or labeled entity (e.g., "Huobi") currently present in the graph using the top-right search tool.
- **Persistent History**: The sidebar tracks all investigated targets in the current session, displaying their risk score and graph complexity for quick switching.
- **Forensic Session Files**: Export your entire investigation—including the graph layout, all custom labels, and trace results—as a `.ctk` file to resume later or share with other investigators.

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
| **aggregator** | Core engine for graph construction and behavioral forensics (Mixer, Exchange, Gambling, Mining, and Peeling Chains). |
| **mempool** | Primary data client for Mempool.space (address/tx info, fees, and block-level pool metadata). |
| **blockstream** | Fallback client for Esplora API ensuring data consistency during network outages. |
| **bitquery** | GraphQL implementation for high-volume historical flow analysis. |
| **intel** | Centralized intelligence hub for ChainAbuse risk and WalletExplorer labels. |
| **tracer** | Forward pathfinder using heuristic scoring and change-output detection. |
| **db** | Neo4j driver wrapper for persistence and co-spend wallet clustering. |
| **parser** | Optimized TSV ingestor for importing massive offline forensic datasets. |

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
| **Mempool.space** | Live mempool, fees, block mining pool attribution, and pending TXs. |
| **Blockstream (Esplora)** | Redundant address history, confirmed balances, and script validation. |
| **Bitquery** | Historical transaction volume, deep multi-hop flows, and historical entity scoring. |
| **ChainAbuse** | Scam reports, ransomware flagging, and community-verified threat intelligence. |
| **WalletExplorer** | Historical attribution database for exchanges, mixers, and mining pools. |
| **Neo4j** | Local graph persistence, pattern matching, and entity clustering. |

---


**Last Updated:** March 2, 2026  
**Status:** Active Development 🚀
