package parser

import (
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"money-tracer/db"
	"os"
	"strconv"
)

// ImportData reads a Blockchair TSV export and bulk-inserts it into the DB.
//
// Columns expected (0-indexed): [0] block_id [1] hash [2..3] ... [4] value_satoshi
// [5] ... [6] address
//
// Bug fix: parse errors on the value field are now logged rather than silently
// producing rows with amount=0, which would corrupt the money-flow graph.
func ImportData(path string, isInput bool) {
	f, err := os.Open(path)
	if err != nil {
		log.Printf("❌ [IMPORT] Cannot open %s: %v", path, err)
		return
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.Comma = '\t'
	reader.LazyQuotes = true

	// Skip header row
	if _, err := reader.Read(); err != nil {
		log.Printf("❌ [IMPORT] Cannot read header of %s: %v", path, err)
		return
	}

	var (
		batch     = make([]map[string]interface{}, 0, 2000)
		lineNum   = 1 // 1-based (header = line 0)
		parseErrs = 0
		totalRows = 0
	)

	for {
		line, err := reader.Read()
		lineNum++

		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("⚠️  [IMPORT] CSV read error at line %d in %s: %v", lineNum, path, err)
			parseErrs++
			continue
		}

		if len(line) < 7 || line[6] == "" || line[6] == "null" {
			continue
		}

		satoshis, parseErr := strconv.ParseFloat(line[4], 64)
		if parseErr != nil {
			log.Printf("⚠️  [IMPORT] Bad value %q at line %d in %s: %v — row skipped",
				line[4], lineNum, path, parseErr)
			parseErrs++
			continue
		}

		batch = append(batch, map[string]interface{}{
			"tx_hash": line[1],
			"address": line[6],
			"amount":  satoshis / 100_000_000.0,
		})
		totalRows++

		if len(batch) >= 2000 {
			flushBatch(batch, isInput)
			batch = batch[:0]
		}
	}

	if len(batch) > 0 {
		flushBatch(batch, isInput)
	}

	if parseErrs > 0 {
		log.Printf("⚠️  [IMPORT] %s — %d rows skipped due to parse errors (out of %d total)",
			path, parseErrs, totalRows+parseErrs)
	}
	fmt.Printf("✅ Finished loading %s (%d rows imported)\n", path, totalRows)
}

func flushBatch(batch []map[string]interface{}, isInput bool) {
	if isInput {
		db.SaveInput(batch)
	} else {
		db.SaveOutput(batch)
	}
}
