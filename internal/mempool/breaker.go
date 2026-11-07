package mempool

import (
	"errors"
	"strconv"
	"sync"
	"time"
)

// HTTPStatusError marks a non-200 response so the provider breaker can tell
// request-specific failures (bad address → 4xx) from provider failures
// (rate limiting → 429, server errors → 5xx). Only the latter put a base
// URL on cooldown.
type HTTPStatusError struct{ Code int }

func (e HTTPStatusError) Error() string { return "HTTP " + strconv.Itoa(e.Code) }

// baseCooldown is how long a failing provider is skipped before being
// retried. Long enough to stop paying a request timeout per call during an
// outage, short enough to recover quickly once the provider is back.
const baseCooldown = 45 * time.Second

var (
	breakerMu  sync.Mutex
	breakerHit = map[string]time.Time{} // base URL → earliest retry time
)

// BaseCooling reports whether base failed recently and should be skipped.
func BaseCooling(base string) bool {
	breakerMu.Lock()
	defer breakerMu.Unlock()
	t, ok := breakerHit[base]
	return ok && time.Now().Before(t)
}

// MarkBaseResult updates the breaker after a fetch attempt against base:
// successes clear any cooldown; provider-level failures start one.
func MarkBaseResult(base string, err error) {
	breakerMu.Lock()
	defer breakerMu.Unlock()
	if err == nil {
		delete(breakerHit, base)
		return
	}
	var se HTTPStatusError
	if errors.As(err, &se) && se.Code != 429 && se.Code < 500 {
		return // request-specific failure — not the provider's fault
	}
	breakerHit[base] = time.Now().Add(baseCooldown)
}
