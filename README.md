<p align="center">
  <img width="200" height="200" alt="Cryptrace Logo" src="https://github.com/user-attachments/assets/1c1db906-b595-4fd0-959c-e45e3b3bd3bb" />
</p>

<h1 align="center">Cryptracer</h1>
<h3 align="center"><b>Bitcoin transaction forensics & money flow analysis dashboard</b></h3>

<p align="center">
  <b>Advanced on-chain intelligence platform for automated transaction tracing, coin mixer fingerprinting, and interactive graph visualisations.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.24-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="Go Engine" />
  <img src="https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JS Frontend" />
  <img src="https://img.shields.io/badge/Neo4j-Graph%20Database-008CC1?style=for-the-badge&logo=neo4j&logoColor=white" alt="Neo4j Layer" />
  <img src="https://img.shields.io/badge/License-GPLv3-blue?style=for-the-badge&logo=gnu&logoColor=white" alt="GPLv3 License" />
  <a href="https://discord.com/users/604615480891670530">
    <img src="https://img.shields.io/badge/Discord-DM%20%40cathe0n-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord Support" />
</p>

<p align="center">
  <a href="https://github.com/Cathe0n/Cryptrace/releases">
    <img src="https://img.shields.io/github/v/release/Cathe0n/Cryptrace?style=for-the-badge&label=Download&color=success" alt="Download Latest Release" />
  </a>
</p>

---

<h3 align="center">Project Activity</h3>

<div align="center">
  <table align="center">
    <thead>
      <tr>
        <th align="center">Development Status</th>
        <th align="center">Last Code Commit</th>
        <th align="center">Open Issues</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td align="center"><img src="https://img.shields.io/badge/Status-Active%20Development-rocket?style=flat-square&color=2ecc71" alt="Status" /></td>
        <td align="center"><img src="https://img.shields.io/github/last-commit/Cathe0n/Cryptrace?style=flat-square&color=3498db" alt="Last Commit" /></td>
        <td align="center"><img src="https://img.shields.io/github/issues/Cathe0n/Cryptrace?style=flat-square&color=e74c3c" alt="Issues" /></td>
      </tr>
    </tbody>
  </table>
</div>

---

<p align="center">
  <img width="1920" height="951" alt="image" src="https://github.com/user-attachments/assets/fc8e7183-8d8a-4891-87b3-22d503c35355" />

</p>

---

## Overview | "Just a short description hehe" (^.^)

**Cryptracer** is a project designed for advanced Bitcoin transaction analysis. It reconstructs money flows on the blockchain by:

1. **Tracing forward transactions** using change-detection heuristics to identify real payments
2. **Detecting coin mixers** through pattern recognition and behavioral analysis
3. **Identifying exchange behavior** using transaction volume and uniformity heuristics
4. **Scoring risk** using the ChainAbuse API to flag illicit addresses
5. **Visualising relationships** in an interactive D3.js graph with live mempool enrichment

This tool is intended for **forensic analysis** of Bitcoin transactions.

---

##  Features

  **Forward Path Tracing**: Follow Bitcoin from a starting address through multiple hops using intelligent heuristics
  - Fresh address detection (addresses not seen in inputs)
  - Round amount identification (intentional payments vs. change)
  - Modern script type prioritization (Taproot > SegWit > P2PKH)
  - Cycle detection (prevents infinite loops)

  **Mixer Detection**: Identifies coin mixing transactions with configurable thresholds
  - Uniform outputs detection (same value outputs)
  - RBF-disabled flagging (Wasabi signature)
  - Script type mixing analysis
  - Confidence scoring (0-100)

  **Exchange Detection**: Flags addresses exhibiting exchange-like behavior
  - High transaction volume analysis
  - Output uniformity patterns
  - Behavioral consistency scoring

  **Rich Risk Scoring**: Integration with ChainAbuse API for verified threat intelligence
  - Report count and verification status
  - Category classification (ransom, fraud, malware, etc.)
  - Confidence scores and historical data

  **Interactive Visualization**: D3.js-powered graph with advanced controls
  - Force-directed layout and hierarchical tree view
  - Zoom, pan, freeze, and recenter controls
  - Node search and history tracking
  - Edge tooltips with transaction amounts and timestamps
  - Dynamic expansion of address nodes in the graph
    
---

## Data Sources

- **Mempool.space API**: Primary source for live mempool state, block history, and mining pool identification.
- **Blockstream (Esplora) API**: Fallback for address history and UTXO verification.
- **WalletExplorer API**: Entity attribution for historical identification of exchanges and services.
- **Bitquery GraphQL**: Historical flow analysis and multi-hop transaction reconstruction.
- **ChainAbuse API**: Community threat intelligence and risk categorization.
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
| **Blockstream** | Real-time blockchain data |  Unlimited | Free public API |
| **Mempool.space** | Live fees & network stats |  Unlimited | Free public API |
| **Mempool.guide** | Live data fallback | Unlimited | Free public API |
| **WalletExplorer.com** | Entity Attribution and cross valifation |  Unlimited | Free public API |

### Database

  - **Neo4j Community Edition** or higher
  - URI: `bolt://localhost:7687` (adjust for your setup)
  - Default credentials: `neo4j` / `password`

---


## Installation for Windows 11/10 | "Should be easy as I've compiled it for you" ^-^

[![Download Latest Release](https://img.shields.io/github/v/release/Cathe0n/Cryptrace?style=for-the-badge&label=Download&color=success)](https://github.com/Cathe0n/Cryptrace/releases)




##  Installation from Source code | "Woah, I like you already" o.o

### 1. Clone the Repository

```bash
git clone <https://github.com/Cathe0n/Cryptracer.git>
cd Cryptracer
```

### 2. Install Go Dependencies | "I love Golang" :3

```bash
go mod download
go mod tidy
```

### 3. Build the Application

```bash
go build -o Cryptracer.exe
```

Or "run directly...Terminals, yay... " '-'

```bash
go run main.go
```

---

### 4. Access the Application | "Uhh use Waterfox...Or Something, Chrome is poopoo" q('.')q 

- **Main Dashboard**: [http://localhost:8080/ui/index.html](http://localhost:8080/ui/index.html)
- **Setup/Configuration**: [http://localhost:8080/ui/setup.html](http://localhost:8080/ui/setup.html) "This is where you configure your API keys, Cryptracer can still work but there'll be no reputation check for the Bitcoin address." <.<

---

### Runtime Configuration | "Neo4J integration is not fully optimised yet, if you wish to save your session do so with the save session feature" [!] ＼(o_ｏ)／ 

1. Open [http://localhost:8080/ui/setup.html](http://localhost:8080/ui/setup.html)
2. Fill in your database connection and API keys
3. Click **Save Configuration**

The application will:
- Test the Neo4j connection
- Validate API keys
- Enable/disable features based on available credentials
- Store configuration in memory (persists while running)

---

## Usage

### Web Interface

#### 1. **Search for an Address**

- Click the search bar at the top
- Enter a Bitcoin address
- Press **Enter** or click **Search**
- The application reconstructs a transaction graph from live blockchain data

#### 2. **Explore Cryptracer** "Should be easy...Right?" (｡-.-)

| Action | Control |
|--------|---------|
| **Zoom In/Out** | Scroll wheel or `+` / `-` buttons |
| **Pan** | Click and drag workspace |
| **Center Graph** | Click **Recenter** button |
| **Toggle Labels** | Hide/Show Labels — "Simplicity" (‾◡‾)  | 
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

"There's other features as well hehe" (‾◡‾)

#### 3. **Inspect a Node & Entity Intelligence** 

- **Forensic Panel**: Clicking any node opens a panel showing balance, transaction counts, and risk classification.
- **Cross-Validation**: Verify identities in real-time across all APIs
- **Custom Annotations**: Add custom nicknames or change node colors directly in the panel to highlight key actors in your investigation.
- **Domain Expansion**: Use the "Expand" tools on any address to dynamically load its neighbors into the existing graph without a full reload. "No, it's not a damn curse technique." '-' 

#### 4. **Forward Trace & Peeling Heuristics**

- **Peeling Chain Detection**: The tracer automatically identifies and follows "peeling" behavior (one small payment + one large change output) to find the primary stack of funds.
- **Heuristic Scoring**: Each hop is evaluated based on script type priority (Taproot > SegWit), round amount identification, and address age.
- **Automated Halting**: The trace stops when funds reach a **Mixer** (Wasabi, Whirlpool, JoinMarket), a **Known Service** (Exchange), or a high-risk flagged address.
- **Interactive Timeline**: Traced paths are highlighted in orange with a glowing destination ring, and are fully integrated into the sidebar hop-by-hop breakdown.

#### 5. **Investigation Management & Persistence**

- **Global Search**: Instantly locate any address, transaction, or labeled entity (e.g., "Huobi") currently present in the graph using the top-left search tool.
- **Persistent History**: The sidebar tracks all investigated targets in the current session, displaying their risk score and graph complexity for quick switching.
- **Forensic Session Files**: Export your entire investigation including the graph layout, all custom labels, and trace results as a `.ctk` file to resume later or share with other investigators. "Very Useful!!" 'o'
---

##  Data Import | "This is for offline analysis but you need to know which Bitcoin block you need to get, I use Blockchair as they have an extensive list!"＼('_')／ 

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
| **bitquery** | GraphQL implementation for historical flow analysis. |
| **intel** | Centralised intelligence hub for ChainAbuse risk and WalletExplorer labels. |
| **tracer** | Forward pathfinder using heuristic scoring and change-output detection. |
| **db** | Neo4j driver wrapper for persistence and co-spend wallet clustering. |
| **parser** | TSV ingestor for importing massive offline forensic datasets. |

---

### Backend

| Technology | Version | Purpose |
|---|---|---|
| **Go** | 1.24.0+ | Core language |
| **Gin** | 1.11.0 | HTTP framework |
| **Neo4j Go Driver** | 5.28.4 | Graph database client |

---

<p align="center">
  🌻 <b>Thank you for checking out Cryptracer!</b> 🌻
  <br />
  If you encounter any issues or have feature requests feel free to drop a DM!
</p>

<p align="center">
  <a href="https://discord.com/users/604615480891670530">
    <img src="https://img.shields.io/badge/Discord-DM%20%40cathe0n-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord Support" />
  </a>
</p>



## License

This project is licensed under the **GNU General Public License v3.0** - see the [LICENSE](LICENSE) file for details.

> **Open Source Protection:** You are completely free to copy, modify, and distribute this software. However, under the copyleft terms of the **GPLv3**, any derivative projects or closed-source commercial applications utilizing this engine **must** also open-source their entire codebase under the exact same license terms.
