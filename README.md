# 🔓 Cryptracker – Bitcoin Transaction Forensics & Money Flow Analysis

> **Advanced on-chain intelligence platform for Bitcoin transaction tracing, mixer detection, and money flow visualization.**

![Go](https://img.shields.io/badge/Go-1.24-00ADD8?logo=go) ![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?logo=javascript) ![Neo4j](https://img.shields.io/badge/Neo4j-Graph%20Database-008CC1?logo=neo4j) ![License](https://img.shields.io/badge/License-MIT-green)

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Data Import](#data-import)
- [Project Structure](#project-structure)
- [Technologies](#technologies)
- [Contributing](#contributing)

---

## 🎯 Overview

**Cryptracker** is a research thesis project designed for advanced Bitcoin transaction analysis. It reconstructs money flows on the blockchain by:

1. **Tracing forward transactions** using change-detection heuristics to identify real payments
2. **Detecting coin mixers** through pattern recognition and behavioral analysis
3. **Identifying exchange behavior** using transaction volume and uniformity heuristics
4. **Scoring risk** using the ChainAbuse API to flag illicit addresses
5. **Visualizing relationships** in an interactive D3.js graph with live mempool enrichment

This tool is intended for **academic research**, **compliance investigations**, and **forensic analysis** of Bitcoin transactions.

---

## ✨ Features

### 🔍 Core Capabilities

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

### 📊 Data Integration

- **Blockstream API**: Real-time transaction and address data
- **Mempool.space API**: Live network statistics and fee recommendations
- **Bitquery GraphQL**: Extended transaction flow queries
- **ChainAbuse API**: Comprehensive risk and abuse reporting
- **Neo4j Database**: Local graph storage for large datasets

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (Public)                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ D3.js Graph Visualization | Mempool.space API        │  │
│  │ Interactive Dashboard     | Live Network Stats       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              ↓ HTTP/JSON ↓
┌─────────────────────────────────────────────────────────────┐
│                  Backend (Go + Gin)                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Config Management    | Trace API Endpoints           │  │
│  │ Runtime Updates      | Mixer/Exchange Detection      │  │
│  │ API Key Management   | Risk Scoring                  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         ↓          ↓            ↓           ↓
    ┌─────────┬──────────┬──────────────┬────────────┐
    │          │          │              │            │
   Neo4j   Blockstream Bitquery    ChainAbuse   Mempool
  Database     API        API           API         API
```

---

## 📦 Prerequisites

### System Requirements

- **Go** 1.24.0 or later
- **Node.js** (for development; frontend is vanilla JS)
- **Neo4j** 5.x+ (local or remote instance)

### API Keys Required

| Service | Purpose | Free Tier | Getting Started |
|---------|---------|-----------|-----------------|
| **ChainAbuse** | Risk/abuse data | ✅ Yes | [chainabuse.com](https://www.chainabuse.com) |
| **Bitquery** | Extended transaction flows | ✅ Limited | [bitquery.io](https://bitquery.io) |
| **Blockstream** | Real-time blockchain data | ✅ Unlimited | Free public API |
| **Mempool.space** | Live fees & network stats | ✅ Unlimited | Free public API |

### Database

- **Neo4j Community Edition** or higher
  - URI: `bolt://localhost:7687` (adjust for your setup)
  - Default credentials: `neo4j` / `password`

---

## 🚀 Installation

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

## ⚙️ Configuration

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
🔓 Cryptracker is READY
============================================================
✅ Database:        Connected
🌐 Main App:        http://localhost:8080/ui/index.html
🛡️  ChainAbuse:      Enabled
📡 Bitquery:        Enabled
============================================================
```

---

## 📖 Usage

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

## 🔌 API Reference

### Base URL
```
http://localhost:8080/api
```

### Endpoints

#### 1. **POST /api/config/test**

Test and save configuration.

**Request:**
```json
{
  "neo4j_uri": "bolt://localhost:7687",
  "neo4j_user": "neo4j",
  "neo4j_pass": "password",
  "chainabuse_key": "your_key",
  "bitquery_key": "your_key"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configuration saved and connected."
}
```

---

#### 2. **GET /api/config**

Get current configuration (passwords omitted).

**Response:**
```json
{
  "config": {
    "neo4j_uri": "bolt://localhost:7687",
    "neo4j_user": "neo4j",
    "neo4j_pass": "",
    "chainabuse_key": "***",
    "bitquery_key": "***"
  },
  "initialized": true
}
```

---

#### 3. **GET /api/trace/:id**

Reconstruct a complete transaction graph for a Bitcoin address using verified on-chain data and risk intelligence.

**Parameters:**
- `id` (string, required): Bitcoin address

**Query Params:**
- None

**Response:**
```json
{
  "graph": {
    "nodes": {
      "addr_1": {
        "id": "addr_1",
        "type": "Address",
        "label": "1A1z...",
        "risk": 15.5,
        "risk_data": {
          "report_count": 2,
          "is_verified": true,
          "categories": ["fraud"],
          "confidence_score": 0.85
        }
      },
      "tx_1": {
        "id": "tx_1",
        "type": "Transaction",
        "label": "abc123...",
        "timestamp": 1704067200
      }
    },
    "edges": [
      {
        "source": "addr_1",
        "target": "tx_1",
        "amount": 0.5,
        "label": "SENT_TO"
      }
    ]
  }
}
```

---

#### 4. **GET /api/trace-path/:address**

Trace forward from an address using change-detection heuristics.

**Parameters:**
- `address` (string, required): Starting Bitcoin address

**Query Params:**
- `hops` (int, optional): Maximum hops to trace (1-20, default: 10)

**Response:**
```json
{
  "path": {
    "start_address": "1A1z...",
    "final_address": "3J98...",
    "total_hops": 5,
    "stop_reason": "utxo",
    "hops": [
      {
        "hop_index": 0,
        "current_address": "1A1z...",
        "tx_hash": "abc123...",
        "next_address": "3J98...",
        "amount_btc": 0.5,
        "confidence": 0.95
      }
    ]
  }
}
```

---

#### 5. **GET /api/history/:address**

Fetch recent transactions for an address from Blockstream.

**Parameters:**
- `address` (string, required): Bitcoin address

**Response:**
```json
[
  {
    "txid": "abc123...",
    "status": {
      "confirmed": true,
      "block_height": 842000,
      "block_time": 1704067200
    },
    "vin": [...],
    "vout": [...]
  }
]
```

---

#### 6. **GET /api/mixer-check/:txid**

Analyze a transaction for coin mixer signatures.

**Parameters:**
- `txid` (string, required): Transaction ID (hex)

**Query Params:**
- `threshold` (float, optional): Detection threshold (0-1, default: 0.70)

**Response:**
```json
{
  "txid": "abc123...",
  "inputs": 3,
  "outputs": 8,
  "threshold": 0.70,
  "result": {
    "flagged": true,
    "score": 0.82,
    "mixer_type": "uniform_outputs",
    "breakdown": {
      "uniform_scripts": 0.75,
      "rbf_disabled": 0.90,
      "round_amounts": 0.80
    }
  }
}
```

---

#### 7. **GET /api/exchange-check/:address**

Detect if an address exhibits exchange-like behavior.

**Parameters:**
- `address` (string, required): Bitcoin address

**Response:**
```json
{
  "address": "1A1z...",
  "tx_count": 127,
  "result": {
    "flagged": true,
    "score": 0.68,
    "indicators": {
      "high_volume": true,
      "output_uniformity": 0.72,
      "behavior_consistency": 0.65
    }
  }
}
```

---

#### 8. **GET /api/debug/bitquery/:address**

(Debug endpoint) Fetch raw Bitquery wallet flows.

**Parameters:**
- `address` (string, required): Bitcoin address

**Requires:** `BITQUERY_KEY` configured

**Response:**
```json
{
  "address": "1A1z...",
  "count": 15,
  "flows": [
    {
      "tx_hash": "abc123...",
      "from_addr": "...",
      "to_addr": "...",
      "value_btc": 0.5,
      "timestamp": 1704067200,
      "direction": "in"
    }
  ]
}
```

---

## 📥 Data Import

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

### Batch Processing

The importer processes data in 2,000-row batches:

```
✅ Finished loading ./data/Blockchair_bitcoin_inputs_20260130.tsv
✅ Finished loading ./data/Blockchair_bitcoin_outputs_20260130.tsv
```

---

## 📁 Project Structure

```
money-tracer/
├── main.go                          # Entry point, Gin server, API routes
├── go.mod                           # Go module dependencies
├── .env                             # Environment configuration (not tracked)
├── .gitignore                       # Git ignore rules
│
├── db/
│   └── neo4j.go                     # Neo4j driver, graph operations
│
├── internal/
│   ├── aggregator/
│   │   └── aggregator.go            # FTM building, mixer & exchange detection
│   ├── blockstream/
│   │   └── client.go                # Blockstream API wrapper
│   ├── bitquery/
│   │   └── client.go                # Bitquery GraphQL client
│   ├── intel/
│   │   └── intel.go                 # ChainAbuse risk scoring
│   └── tracer/
│       └── tracer.go                # Forward path tracing logic
│
├── parser/
│   └── tsv_parser.go                # TSV file importer for Neo4j
│
├── public/                          # Frontend (vanilla JS + D3.js)
│   ├── index.html                   # Main dashboard
│   ├── setup.html                   # Configuration wizard
│   ├── main.js                      # Module entry point
│   ├── graph.js                     # D3.js graph renderer & controls
│   ├── api.js                       # Mempool.space API client
│   ├── ui.js                        # Panel rendering & enrichment
│   ├── tracer.js                    # Forward trace panel
│   ├── state.js                     # Global state & constants
│   └── utils.js                     # Formatting utilities
│
└── data/                            # TSV/CSV data files (gitignored)
    └── THIS IS WHERE THE TSV AND CSV FILE IS STORED.txt
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

## 🛠️ Technologies

### Backend

| Technology | Version | Purpose |
|---|---|---|
| **Go** | 1.24.0+ | Core language |
| **Gin** | 1.11.0 | HTTP framework |
| **Neo4j Go Driver** | 5.28.4 | Graph database client |
| **godotenv** | 1.5.1 | Environment variable loading |

### Frontend

| Technology | Purpose |
|---|---|
| **D3.js v7** | Graph visualization & physics simulation |
| **Tailwind CSS 2.2.19** | Utility-first styling |
| **JetBrains Mono** | Monospace font |
| **Vanilla JavaScript (ES6)** | No frameworks; modular imports |

### Data Sources

| Source | Data Type |
|---|---|
| **Blockstream API** | Bitcoin transactions, UTXOs, address history |
| **Mempool.space API** | Network fees, block heights, live stats |
| **Bitquery GraphQL** | Extended transaction flows & queries |
| **ChainAbuse API** | Risk scores, abuse reports, verification |
| **Neo4j** | Offline graph storage & querying |

---

## 🔐 Security Considerations

### API Keys

- **Never commit `.env` to version control** (already gitignored)
- Keys are stored in memory only; restart to clear
- Passwords are never returned to the client
- Configure keys at startup or via the setup UI

### Database

- Use strong credentials for Neo4j
- Restrict network access to the database
- Consider running Neo4j locally or behind a firewall

### Client-Side

- All frontend code is vanilla JavaScript (no transpilation)
- No sensitive data is stored in localStorage without encryption
- Session data is lost on page reload

---

## 🐛 Troubleshooting

### Database Connection Failed

```
❌ Database connection failed: dial tcp: lookup neo4j...
```

**Solution:**
1. Verify Neo4j is running: `telnet localhost 7687`
2. Check credentials in `.env`
3. Use the setup UI to reconfigure: [http://localhost:8080/ui/setup.html](http://localhost:8080/ui/setup.html)

### API Key Errors

```
⚠️ ChainAbuse API key not set — risk scoring disabled
```

**Solution:**
Add keys to `.env` or configure via the setup UI. Features gracefully degrade if keys are missing.

### Out of Memory on Large Graphs

D3.js graphs with >5,000 nodes may slow down. Consider:
- Reducing the scope of the initial query
- Filtering nodes by risk score
- Using the "Freeze" button to disable physics simulation

### No Transactions Found

```
⚠️ Database not configured
```

**Solution:**
1. Run `go run main.go --import` to load TSV data
2. Configure Neo4j in setup UI
3. Ensure TSV files exist in `./data/`

---

## 📄 License

This project is released under the **MIT License**. See [LICENSE](LICENSE) for details.

---

## 🤝 Contributing

Contributions are welcome! To contribute:

1. **Fork** the repository
2. **Create a feature branch**: `git checkout -b feature/your-feature`
3. **Commit changes**: `git commit -m "Add your feature"`
4. **Push to branch**: `git push origin feature/your-feature`
5. **Submit a pull request**

### Development Setup

```bash
# Install dependencies
go mod download

# Run with Go directly
go run main.go

# Or build and run
go build -o money-tracer.exe main.go
./money-tracer.exe
```

### Code Style

- Follow Go conventions (gofmt, golint)
- Use clear variable names
- Add comments for complex logic
- Test API changes

---

## 📞 Support

For issues, questions, or feature requests:

- **Create an Issue** on GitHub
- **Email**: your-email@example.com
- **Documentation**: See inline code comments

---

## 🎓 Academic Citation

If you use Cryptracker in research, please cite:

```bibtex
@misc{cryptracker2026,
  title={Cryptracker: Advanced Bitcoin Transaction Forensics and Money Flow Analysis},
  author={Your Name},
  year={2026},
  howpublished={\url{https://github.com/yourusername/money-tracer}},
  note={Research Thesis Project}
}
```

---

## 📈 Roadmap

- [ ] WebSocket support for real-time graph updates
- [ ] Multi-address batch analysis
- [ ] Automated mixer detection reporting
- [ ] Integration with additional blockchain APIs (Ethereum, Monero)
- [ ] Machine learning-based address clustering
- [ ] PDF report generation
- [ ] Mobile-responsive UI improvements

---

**Last Updated:** March 2, 2026  
**Status:** Active Development 🚀

