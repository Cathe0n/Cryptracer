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
    isComplete: false
};

/**
 * Extract all unique transaction timestamps from the graph
 * Relies on rawLinks being populated by renderGraph
 */
export function getUniqueTimestamps() {
    const globalRawLinks = window._rawLinks || [];
    const timestamps = new Set();
    
    globalRawLinks.forEach(link => {
        const timestamp = Number(link.timestamp ?? link.ts);
        if (Number.isFinite(timestamp) && timestamp > 0) timestamps.add(timestamp);
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
    const timestamps = playbackState.allTimestamps;
    if (!timestamps.length || !Number.isFinite(Number(timestamp))) return;

    const target = Number(timestamp);
    let low = 0;
    let high = timestamps.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (timestamps[mid] <= target) low = mid + 1;
        else high = mid;
    }
    playbackState.currentIndex = Math.max(0, low - 1);
    playbackState.isComplete = false;
    updatePlaybackDisplay();
    return timestamps[playbackState.currentIndex];
}

/**
 * Set playback to a specific frame index
 */
export function seekToFrame(frameIndex) {
    const total = playbackState.allTimestamps.length;
    if (!total || !Number.isFinite(frameIndex)) return;
    playbackState.currentIndex = Math.max(0, Math.min(total - 1, Math.floor(frameIndex)));
    playbackState.isComplete = false;
    updateTimeSlider();
    updatePlaybackDisplay();
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
    const current = total ? playbackState.currentIndex + 1 : 0;
    const statusText = playbackState.isPlaying
        ? playbackState.isPaused ? '⏸ Paused' : `▶ Playing (${playbackState.speed}x)`
        : playbackState.isComplete ? '✓ Complete' : total ? 'Ready' : 'No dated transactions';
    
    statusEl.textContent = statusText;
    progressEl.textContent = `Frame ${current} / ${total}`;

    const playButton = document.getElementById('playPauseBtn');
    if (playButton) {
        playButton.textContent = playbackState.isPlaying && !playbackState.isPaused ? '⏸' : '▶';
        playButton.title = playbackState.isPlaying && !playbackState.isPaused ? 'Pause playback' : 'Play from the selected date';
        playButton.setAttribute('aria-label', playButton.title);
        playButton.disabled = total === 0;
    }
    const stopButton = document.getElementById('playbackStopBtn');
    if (stopButton) stopButton.disabled = total === 0 || (!playbackState.isPlaying && playbackState.currentIndex === 0);
    const previousButton = document.getElementById('previousFrameBtn');
    if (previousButton) previousButton.disabled = total === 0 || playbackState.currentIndex === 0;
    const nextButton = document.getElementById('nextFrameBtn');
    if (nextButton) nextButton.disabled = total === 0 || playbackState.currentIndex >= total - 1;
    const slowerButton = document.getElementById('decreaseSpeedBtn');
    if (slowerButton) slowerButton.disabled = playbackState.speed <= 0.5;
    const fasterButton = document.getElementById('increaseSpeedBtn');
    if (fasterButton) fasterButton.disabled = playbackState.speed >= 4;
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

    if (playbackState.currentIndex >= playbackState.allTimestamps.length - 1) {
        playbackState.currentIndex = 0;
        updateTimeSlider();
    }
    
    playbackState.isPlaying = true;
    playbackState.isPaused = false;
    playbackState.isComplete = false;
    playbackState.lastFrameTime = null;
    
    updatePlaybackDisplay();
    animatePlayback();
}

/**
 * Pause playback without stopping
 */
export function pausePlayback() {
    if (!playbackState.isPlaying) return;
    playbackState.isPaused = true;
    if (playbackState.animationFrameId !== null) {
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
    playbackState.isComplete = false;
    playbackState.currentIndex = 0;
    playbackState.lastFrameTime = null;
    
    if (playbackState.animationFrameId !== null) {
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
    setPlaybackSpeed(Math.min(4, playbackState.speed + 0.5));
}

/**
 * Decrease playback speed
 */
export function decreaseSpeed() {
    setPlaybackSpeed(Math.max(0.5, playbackState.speed - 0.5));
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
        
        // Calculate frames to advance based on speed
        // Assume ~60fps target; each frame is ~16.67ms
        // Speed multiplier: 1x = 1 frame per ~500ms, 2x = 1 frame per ~250ms, etc.
        const msPerFrame = 500 / playbackState.speed;
        const framesToAdvance = Math.floor(elapsed / msPerFrame);
        
        if (framesToAdvance > 0) {
            playbackState.currentIndex += framesToAdvance;
            playbackState.lastFrameTime += framesToAdvance * msPerFrame;
            
            // Check bounds
            if (playbackState.currentIndex >= playbackState.allTimestamps.length) {
                playbackState.currentIndex = playbackState.allTimestamps.length - 1;
                playbackState.isPlaying = false;
                playbackState.isPaused = false;
                playbackState.animationFrameId = null;
                playbackState.lastFrameTime = null;
                updateTimeSlider();
                playbackState.isComplete = true;
                updatePlaybackDisplay();
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
    seekToFrame(playbackState.currentIndex + 1);
}

/**
 * Go back one frame
 */
export function previousFrame() {
    seekToFrame(playbackState.currentIndex - 1);
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
        isComplete: playbackState.isComplete,
        totalFrames: playbackState.allTimestamps.length,
        progress: playbackState.allTimestamps.length > 1
            ? (playbackState.currentIndex / (playbackState.allTimestamps.length - 1)) * 100
            : playbackState.allTimestamps.length === 1 ? 100 : 0
    };
}

/**
 * Initialize playback with existing timestamps
 * Call this after renderGraph() has populated the data
 */
export function initPlayback() {
    playbackState.allTimestamps = getUniqueTimestamps();
    playbackState.currentIndex = Math.max(0, playbackState.allTimestamps.length - 1);
    playbackState.isPlaying = false;
    playbackState.isPaused = false;
    playbackState.isComplete = false;
    playbackState.lastFrameTime = null;
    if (playbackState.animationFrameId !== null) {
        cancelAnimationFrame(playbackState.animationFrameId);
        playbackState.animationFrameId = null;
    }
    updatePlaybackDisplay();
}

/**
 * Expose playback state for debugging
 */
export function getPlaybackState() {
    return { ...playbackState };
}
