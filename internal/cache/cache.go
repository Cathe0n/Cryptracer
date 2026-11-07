// Package cache provides a small in-memory TTL cache with singleflight
// semantics: concurrent fetches for the same key share a single underlying
// call, and successful results are served from memory until they expire.
// Errors are never cached.
package cache

import (
	"sync"
	"time"
)

type entry struct {
	value   any
	expires time.Time
}

type call struct {
	done chan struct{}
	val  any
	err  error
}

// Cache is safe for concurrent use.
type Cache struct {
	mu         sync.Mutex
	entries    map[string]entry
	inflight   map[string]*call
	maxEntries int
}

// New returns a cache holding at most maxEntries items. When the cap is
// reached, expired entries are evicted first, then arbitrary victims.
func New(maxEntries int) *Cache {
	if maxEntries <= 0 {
		maxEntries = 1024
	}
	return &Cache{
		entries:    make(map[string]entry),
		inflight:   make(map[string]*call),
		maxEntries: maxEntries,
	}
}

// Fetch returns the cached value for key. On a miss it calls fetch — exactly
// once even when several goroutines race on the same key — and stores the
// result for ttl. Errors are returned to every waiter but not stored, so a
// later call can retry.
func Fetch[T any](c *Cache, key string, ttl time.Duration, fetch func() (T, error)) (T, error) {
	if v, ok := c.get(key); ok {
		return v.(T), nil
	}

	c.mu.Lock()
	if cl, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-cl.done
		var zero T
		if cl.err != nil {
			return zero, cl.err
		}
		return cl.val.(T), nil
	}
	cl := &call{done: make(chan struct{})}
	c.inflight[key] = cl
	c.mu.Unlock()

	// This goroutine won the race: it runs the fetch, everyone else waits
	// on cl.done. Writes to cl.val/cl.err happen-before the close, so the
	// reads above are safe.
	val, err := fetch()
	if err == nil {
		c.set(key, val, ttl)
	}
	cl.val, cl.err = any(val), err

	c.mu.Lock()
	delete(c.inflight, key)
	c.mu.Unlock()
	close(cl.done)
	return val, err
}

func (c *Cache) get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.expires) {
		delete(c.entries, key)
		return nil, false
	}
	return e.value, true
}

func (c *Cache) set(key string, value any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) >= c.maxEntries {
		c.evictLocked()
	}
	c.entries[key] = entry{value: value, expires: time.Now().Add(ttl)}
}

// evictLocked drops expired entries first, then arbitrary victims until the
// cache is back under its cap. Caller must hold c.mu.
func (c *Cache) evictLocked() {
	now := time.Now()
	for k, e := range c.entries {
		if now.After(e.expires) {
			delete(c.entries, k)
		}
	}
	for k := range c.entries {
		if len(c.entries) < c.maxEntries {
			break
		}
		delete(c.entries, k)
	}
}
