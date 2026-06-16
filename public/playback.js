/**
 * Time-Travel Animation / Playback Module
 * Enables chronological animation of transaction flows through the graph
 * 
 * Features:
 * - Play/Pause/Stop controls
 * - Speed adjustment (0.5x to 4x)
 * - Scrubbing through time
 * - Frame-by-frame progression through transaction timestamps
 */

// ─── Playback State ───────────────────────────────────────────────────────────

let playbackState = {
    isPlaying: false,
    isPaused: false,
    speed: 1.0,  // 0.5x to 4x
    allTimestamps: [],  // sorted unique timestamps from graph
    currentIndex: 0,  // index into allTimestamps
    animationFrameId: null,
    lastFrameTime: null,
    startIndex: 0,  // where playback started (for scrubbing)
    direction: 1  // 1 for forward, -1 for backward
};

/**
 * Extract all unique transaction timestamps from the graph
 * Relies on rawLinks being populated by renderGraph
 */
export function getUniqueTimestamps() {
    const globalRawLinks = window._rawLinks || [];
    const timestamps = new Set();
    
    globalRawLinks.forEach(link => {
        if (link.timestamp && link.timestamp > 0) {
            timestamps.add(link.timestamp);
        }
    });
    
    return Array.from(timestamps).sort((a, b) => a - b);
}

/**
 * Get the current playback timestamp
 */
export function getCurrentTimestamp() {
    if (playbackState.allTimestamps.length === 0) return null;
    return playbackState.allTimestamps[playbackState.currentIndex];
}

/**
 * Set playback to a specific timestamp
 */
export function seekToTimestamp(timestamp) {
    const idx = playbackState.allTimestamps.indexOf(timestamp);
    if (idx !== -1) {
        playbackState.currentIndex = idx;
        updateTimeSlider();
    }
}

/**
 * Set playback to a specific frame index
 */
export function seekToFrame(frameIndex) {
    if (frameIndex >= 0 && frameIndex < playbackState.allTimestamps.length) {
        playbackState.currentIndex = frameIndex;
        updateTimeSlider();
    }
}

/**
 * Update the time slider to the current playback position
 */
function updateTimeSlider() {
    const slider = document.getElementById('timeSlider');
    if (!slider) return;
    
    const ts = getCurrentTimestamp();
    if (ts !== null) {
        slider.value = ts;
        if (typeof slider.oninput === 'function') {
            slider.oninput();
        }
    }
}

/**
 * Update the playback progress display
 */
function updatePlaybackDisplay() {
    const progressEl = document.getElementById('playbackProgress');
    const statusEl = document.getElementById('playbackStatus');
    
    if (!progressEl || !statusEl) return;
    
    const total = playbackState.allTimestamps.length;
    const current = playbackState.currentIndex + 1;
    
    let statusText = '';
    if (playbackState.isPlaying && !playbackState.isPaused) {
        statusText = `▶ Playing (${playbackState.speed}x)`;
    } else if (playbackState.isPaused) {
        statusText = `⏸ Paused`;
    } else if (playbackState.isPlaying) {
        statusText = `▶ Playing (${playbackState.speed}x)`;
    } else {
        statusText = `Stopped`;
    }
    
    statusEl.textContent = statusText;
    progressEl.textContent = `Frame ${current} / ${total}`;
}

/**
 * Start playback from current position
 */
export function startPlayback() {
    if (playbackState.allTimestamps.length === 0) {
        playbackState.allTimestamps = getUniqueTimestamps();
        if (playbackState.allTimestamps.length === 0) {
            console.warn('Playback: No timestamps available in graph');
            return;
        }
    }
    
    playbackState.isPlaying = true;
    playbackState.isPaused = false;
    playbackState.lastFrameTime = null;
    playbackState.startIndex = playbackState.currentIndex;
    
    updatePlaybackDisplay();
    animatePlayback();
}

/**
 * Pause playback without stopping
 */
export function pausePlayback() {
    if (!playbackState.isPlaying) return;
    playbackState.isPaused = true;
    if (playbackState.animationFrameId) {
        cancelAnimationFrame(playbackState.animationFrameId);
        playbackState.animationFrameId = null;
    }
    updatePlaybackDisplay();
}

/**
 * Resume playback from pause
 */
export function resumePlayback() {
    if (!playbackState.isPlaying || !playbackState.isPaused) return;
    playbackState.isPaused = false;
    playbackState.lastFrameTime = null;
    updatePlaybackDisplay();
    animatePlayback();
}

/**
 * Stop playback and reset
 */
export function stopPlayback() {
    playbackState.isPlaying = false;
    playbackState.isPaused = false;
    playbackState.currentIndex = playbackState.startIndex;
    
    if (playbackState.animationFrameId) {
        cancelAnimationFrame(playbackState.animationFrameId);
        playbackState.animationFrameId = null;
    }
    
    updateTimeSlider();
    updatePlaybackDisplay();
}

/**
 * Set playback speed (0.5 to 4.0 in 0.5x increments)
 */
export function setPlaybackSpeed(speed) {
    speed = Math.max(0.5, Math.min(4, speed));
    playbackState.speed = speed;
    updatePlaybackDisplay();
    
    // Update speed display
    const speedEl = document.getElementById('playbackSpeed');
    if (speedEl) {
        speedEl.textContent = speed.toFixed(1) + 'x';
    }
}

/**
 * Increase playback speed
 */
export function increaseSpeed() {
    let newSpeed = playbackState.speed + 0.5;
    if (newSpeed > 4) newSpeed = 0.5;  // wrap around
    setPlaybackSpeed(newSpeed);
}

/**
 * Decrease playback speed
 */
export function decreaseSpeed() {
    let newSpeed = playbackState.speed - 0.5;
    if (newSpeed < 0.5) newSpeed = 4;  // wrap around
    setPlaybackSpeed(newSpeed);
}

/**
 * Main animation loop using requestAnimationFrame
 * Advances through frames based on elapsed time and speed
 */
function animatePlayback() {
    const animate = (currentTime) => {
        if (!playbackState.isPlaying || playbackState.isPaused) return;
        
        // Initialize frame time on first call
        if (playbackState.lastFrameTime === null) {
            playbackState.lastFrameTime = currentTime;
        }
        
        const elapsed = currentTime - playbackState.lastFrameTime;
        playbackState.lastFrameTime = currentTime;
        
        // Calculate frames to advance based on speed
        // Assume ~60fps target; each frame is ~16.67ms
        // Speed multiplier: 1x = 1 frame per ~500ms, 2x = 1 frame per ~250ms, etc.
        const msPerFrame = 500 / playbackState.speed;
        const framesToAdvance = Math.floor(elapsed / msPerFrame);
        
        if (framesToAdvance > 0) {
            playbackState.currentIndex += framesToAdvance;
            playbackState.lastFrameTime = currentTime;
            
            // Check bounds
            if (playbackState.currentIndex >= playbackState.allTimestamps.length) {
                // Playback complete
                playbackState.currentIndex = playbackState.allTimestamps.length - 1;
                stopPlayback();
                return;
            }
            
            updateTimeSlider();
            updatePlaybackDisplay();
        }
        
        // Continue animation
        playbackState.animationFrameId = requestAnimationFrame(animate);
    };
    
    playbackState.animationFrameId = requestAnimationFrame(animate);
}

/**
 * Toggle play/pause state
 */
export function togglePlayback() {
    if (!playbackState.isPlaying) {
        startPlayback();
    } else if (playbackState.isPaused) {
        resumePlayback();
    } else {
        pausePlayback();
    }
}

/**
 * Advance one frame forward
 */
export function nextFrame() {
    if (playbackState.currentIndex < playbackState.allTimestamps.length - 1) {
        playbackState.currentIndex++;
        updateTimeSlider();
        updatePlaybackDisplay();
    }
}

/**
 * Go back one frame
 */
export function previousFrame() {
    if (playbackState.currentIndex > 0) {
        playbackState.currentIndex--;
        updateTimeSlider();
        updatePlaybackDisplay();
    }
}

/**
 * Get playback stats for UI display
 */
export function getPlaybackStats() {
    return {
        isPlaying: playbackState.isPlaying,
        isPaused: playbackState.isPaused,
        speed: playbackState.speed,
        currentIndex: playbackState.currentIndex,
        currentTimestamp: getCurrentTimestamp(),
        totalFrames: playbackState.allTimestamps.length,
        progress: playbackState.allTimestamps.length > 0 
            ? (playbackState.currentIndex / (playbackState.allTimestamps.length - 1)) * 100 
            : 0
    };
}

/**
 * Initialize playback with existing timestamps
 * Call this after renderGraph() has populated the data
 */
export function initPlayback() {
    playbackState.allTimestamps = getUniqueTimestamps();
    playbackState.currentIndex = 0;
    updatePlaybackDisplay();
}

/**
 * Expose playback state for debugging
 */
export function getPlaybackState() {
    return { ...playbackState };
}
