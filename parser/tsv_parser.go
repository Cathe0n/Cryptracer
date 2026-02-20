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

func ImportData(path string, isInput bool) {
	f, err := os.Open(path)
	if err != nil {
		log.Println(err)
		return
	}
	defer f.Close()

	reader := csv.NewReader(f)
	reader.Comma = '\t'
	reader.Read() // skip header

	batch := make([]map[string]interface{}, 0)
	for {
		line, err := reader.Read()
		if err == io.EOF {
			break
		}
		if len(line) < 7 || line[6] == "" || line[6] == "null" {
			continue
		}

		val, _ := strconv.ParseFloat(line[4], 64)
		batch = append(batch, map[string]interface{}{
			"tx_hash": line[1],
			"address": line[6],
			"amount":  val / 100000000.0,
		})

		if len(batch) >= 2000 {
			if isInput {
				db.SaveInput(batch)
			} else {
				db.SaveOutput(batch)
			}
			batch = batch[:0]
		}
	}
	if len(batch) > 0 {
		if isInput {
			db.SaveInput(batch)
		} else {
			db.SaveOutput(batch)
		}
	}
	fmt.Printf("✅ Finished loading %s\n", path)
}
