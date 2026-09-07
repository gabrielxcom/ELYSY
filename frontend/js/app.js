/**
 * Eliz's LRC Generator — Frontend Application
 * ============================================
 * Handles audio upload, waveform display, AI alignment,
 * manual tap mode, LRC preview with real-time highlighting,
 * and export functionality.
 */

// ─── API Configuration ──────────────────────────────────────
const API_BASE = window.location.origin;

// ─── Application State ──────────────────────────────────────
const state = {
  audioLoaded: false,
  audioFile: null,
  audioFilename: '',
  audioDuration: 0,
  lyricsText: '',
  lyricsLines: [],
  alignedData: null,      // Full aligned data from backend
  mode: 'auto',           // 'auto' | 'manual'
  language: 'es',
  useVocalSeparation: true,
  isAligning: false,
  isPlaying: false,
  isTapping: false,
  tapTimestamps: [],
  tapCurrentLine: 0,
  tapStartTime: 0,
  selectedWord: null,     // { lineIdx, wordIdx } — the word currently selected
  isPreviewing: false,    // a short preview window is playing
  scrollLock: false,      // suppress LRC auto-scroll (while editing/previewing a word)
  previewActive: false,   // short audio preview playing
  previewEnd: null,       // stop playback at this time
  wcTarget: null,         // { lineIdx, wordIdx } for word precision controls
  reviewMode: false,      // line-timing review is showing (before AI refine)
  projectName: null,
  projectFolder: null,
  projectDirty: false,
  undoStack: [],          // array of snapshots (references) — current state at the top
  redoStack: [],          // array of snapshots — most recently undone first
  snapshotting: false,    // true while restoring (prevents re-capture during undo/redo)
  selectedLines: new Set(),   // Set of line indices currently selected (multi-select)
  pendingLrcFile: null,   // an .lrc file waiting for audio upload to finish
};

// ─── DOM References ─────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Toast Notifications ────────────────────────────────────

function showToast(message, type = 'info') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ─── Audio Upload ───────────────────────────────────────────

function setupUpload() {
  const zone = $('#upload-zone');
  const input = $('#audio-input');
  const loaded = $('#upload-loaded');
  const fileName = $('#file-name');
  const fileMeta = $('#file-meta');

  // Click to upload
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => handleFileSelect(e.target.files[0]));

  // Drag & drop
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  });
}

async function handleFileSelect(file) {
  if (!file) return;

  const validTypes = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!validTypes.includes(ext)) {
    showToast(`Unsupported format: ${ext}. Use MP3, WAV, FLAC, OGG, or M4A.`, 'error');
    return;
  }

  showToast('Uploading audio...', 'info');

  const formData = new FormData();
  formData.append('audio', file);

  try {
    const res = await fetch(`${API_BASE}/api/upload-audio`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Upload failed');
    }

    const data = await res.json();
    
    state.audioLoaded = true;
    state.audioFile = file;
    state.audioFilename = data.filename;
    state.audioDuration = data.duration_seconds || 0;
    // A freshly uploaded file starts a new (unsaved) session
    state.projectName = null;
    state.projectFolder = null;
    state.projectDirty = false;

    // Update UI
    $('#upload-zone').style.display = 'none';
    const loaded = $('#upload-loaded');
    loaded.classList.add('visible');
    $('#file-name').textContent = data.filename;
    $('#file-meta').textContent = `${formatSize(data.size_bytes)} · ${data.duration_display}`;

    // Load waveform
    await loadWaveform();

    showToast(`Loaded: ${data.filename}`, 'success');
    updateStatusBadge();
    // If an LRC import was pending audio upload, continue with it now
    if (state.pendingLrcFile) {
      const pending = state.pendingLrcFile;
      state.pendingLrcFile = null;
      importLrcFile(pending);
    }
  } catch (err) {
    showToast(`Upload failed: ${err.message}`, 'error');
    console.error(err);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Waveform ───────────────────────────────────────────────

let wavesurfer = null;

async function loadWaveform() {
  if (wavesurfer) {
    wavesurfer.destroy();
    wavesurfer = null;
  }

  const container = $('#waveform');
  $('#waveform-placeholder').style.display = 'none';
  container.innerHTML = '';

  // Check if wavesurfer.js is loaded
  if (typeof WaveSurfer === 'undefined') {
    showToast('WaveSurfer library not loaded. Check your internet connection.', 'warning');
    return;
  }

  wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#2a2a48',
    progressColor: '#ff6b9d',
    cursorColor: '#ff6b9d',
    cursorWidth: 2,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    height: 200,
    normalize: true,
    backend: 'WebAudio',
    mediaControls: false,
  });

  const audioUrl = `${API_BASE}/api/audio/${state.audioFilename}`;
  
  try {
    await wavesurfer.load(audioUrl);
  } catch (err) {
    // Try alternative approach: create object URL from uploaded file
    if (state.audioFile) {
      const objectUrl = URL.createObjectURL(state.audioFile);
      await wavesurfer.load(objectUrl);
    } else {
      showToast('Failed to load audio for waveform', 'error');
      return;
    }
  }

  // Events
  wavesurfer.on('play', () => {
    state.isPlaying = true;
    $('#btn-play').textContent = '⏸️';
    $('#btn-play').classList.add('playing');
  });

  wavesurfer.on('pause', () => {
    state.isPlaying = false;
    $('#btn-play').textContent = '▶️';
    $('#btn-play').classList.remove('playing');
    state.isPreviewing = false;
    state.previewEnd = null;
    if (!state.wcTarget && !state.selectedWord) state.scrollLock = false;
  });

  wavesurfer.on('timeupdate', (currentTime) => {
    updateTimeDisplay(currentTime);
    if (state.alignedData) updateLrcHighlight(currentTime);
    // Stop the short preview window once it's played
    if (state.isPreviewing && state.previewEnd != null && currentTime >= state.previewEnd) {
      state.isPreviewing = false;
      state.previewEnd = null;
      wavesurfer.pause();
      if (!state.wcTarget && !state.selectedWord) state.scrollLock = false;
    }
  });

  wavesurfer.on('seek', (progress) => {
    const time = progress * wavesurfer.getDuration();
    updateTimeDisplay(time);
    if (state.alignedData) {
      updateLrcHighlight(time);
    }
  });

  wavesurfer.on('ready', () => {
    const dur = wavesurfer.getDuration();
    state.audioDuration = dur;
    $('#time-total').textContent = formatTime(dur);
    $('#stat-song-duration').textContent = formatTime(dur);
  });

  updateStatusBadge();
}

function togglePlay() {
  if (!wavesurfer) return;
  wavesurfer.playPause();
}

function seekRelative(seconds) {
  if (!wavesurfer) return;
  const current = wavesurfer.getCurrentTime();
  const target = Math.max(0, current + seconds);
  wavesurfer.setTime(target);
}

function seekToStart() {
  if (!wavesurfer) return;
  // Cancel any word-preview state so playback starts clean from the top
  state.isPreviewing = false;
  state.previewEnd = null;
  wavesurfer.setTime(0);
}

function updateTimeDisplay(currentTime) {
  $('#time-current').textContent = formatTime(currentTime);
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Mode Switching ─────────────────────────────────────────

function setMode(mode) {
  state.mode = mode;
  
  $$('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Show/hide relevant UI elements
  const tapOverlay = $('#tap-overlay');
  const autoBtn = $('#btn-auto-align');
  const manualBtn = $('#btn-start-tap');

  if (mode === 'auto') {
    tapOverlay.classList.remove('active');
    autoBtn.style.display = '';
    manualBtn.style.display = '';
  } else {
    autoBtn.style.display = 'none';
    manualBtn.style.display = '';
  }
}

// ─── AI Auto-Align ──────────────────────────────────────────

async function runAutoAlign() {
  const lyrics = $('#lyrics-textarea').value.trim();
  
  if (!lyrics) {
    showToast('Please paste the lyrics first', 'warning');
    return;
  }
  if (!state.audioLoaded) {
    showToast('Please upload an audio file first', 'warning');
    return;
  }

  state.lyricsText = lyrics;
  state.lyricsLines = lyrics.split('\n').filter(l => l.trim());

  state.isAligning = true;
  showLoading('Running AI alignment...');
  $('#btn-auto-align').disabled = true;
  updateProgress('Separating vocals...');

  try {
    const res = await fetch(`${API_BASE}/api/align`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lyrics: lyrics,
        language: state.language,
        use_vocal_separation: state.useVocalSeparation,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Alignment failed');
    }

    const data = await res.json();
    state.alignedData = data.aligned_lines;
    clearUndoStacks();
    markProjectDirty();
    applyKaraokeEnds();
    updateLrcPreview();
    updateStats(data.stats);
    showToast(`Aligned ${data.stats.total_words} words (${data.stats.match_rate}% match rate)`, 'success');

  } catch (err) {
    showToast(`Alignment failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    state.isAligning = false;
    hideLoading();
    $('#btn-auto-align').disabled = false;
  }
}

// ─── Sync Aligment ────────────────────────────────────────

async function syncAlignment() {
  if (!state.alignedData) return;
  // Any change synced to the backend is an unsaved edit
  state.projectDirty = true;
  updateProjectStateStat();
  try {
    await fetch(`${API_BASE}/api/sync-alignment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aligned_lines: state.alignedData }),
    });
  } catch (err) { console.warn('Alignment sync failed:', err); }
}

// ─── Manual Tap Mode ────────────────────────────────────────

function startTapMode() {
  const lyrics = $('#lyrics-textarea').value.trim();
  
  if (!lyrics) {
    showToast('Please paste the lyrics first', 'warning');
    return;
  }
  if (!state.audioLoaded || !wavesurfer) {
    showToast('Please upload an audio file first', 'warning');
    return;
  }

  state.lyricsText = lyrics;
  state.lyricsLines = lyrics.split('\n').filter(l => l.trim());
  state.isTapping = true;
  state.tapTimestamps = [];
  state.tapCurrentLine = 0;

  // Show tap overlay
  const overlay = $('#tap-overlay');
  overlay.classList.add('active');
  $('#tap-counter').textContent = `Line 0 / ${state.lyricsLines.length}`;
  $('#tap-current-line-text').textContent = state.lyricsLines[0] || '';
  $('#btn-tap-complete').style.display = 'none';

  // Start playback
  wavesurfer.setTime(0);
  wavesurfer.play();
}

function handleTap() {
  if (!state.isTapping) return;
  if (!wavesurfer) return;

  const currentTime = wavesurfer.getCurrentTime();
  state.tapTimestamps.push(currentTime);
  state.tapCurrentLine++;

  // Update overlay
  $('#tap-counter').textContent = `Line ${state.tapCurrentLine} / ${state.lyricsLines.length}`;
  
  if (state.tapCurrentLine < state.lyricsLines.length) {
    $('#tap-current-line-text').textContent = state.lyricsLines[state.tapCurrentLine];
    // Flash effect
    $('#tap-current-line-text').style.transform = 'scale(1.1)';
    setTimeout(() => {
      $('#tap-current-line-text').style.transform = 'scale(1)';
    }, 100);
  } else {
    $('#tap-current-line-text').textContent = '¡All lines tapped! 🎉';
    $('#btn-tap-complete').style.display = '';
    // Stop playback
    wavesurfer.pause();
    state.isTapping = false;
  }
}

async function completeTapMode() {
  const overlay = $('#tap-overlay');
  overlay.classList.remove('active');
  state.isTapping = false;

  if (state.tapTimestamps.length === 0) {
    showToast('No timestamps captured', 'error');
    return;
  }

  // Show line-timing review BEFORE any AI refinement
  showTapReview();
  showToast('Lines tapped! Adjust timing if needed, then run AI refinement', 'info');
}

// ─── Line Timing Review (before AI refinement) ───────────────

function showTapReview() {
  state.reviewMode = true;
  const container = $('#lrc-preview');
  if (!state.tapTimestamps.length) {
    container.innerHTML = `<div class="lrc-empty"><div class="icon">👆</div><div>No lines tapped.</div></div>`;
    return;
  }

  let html = `
    <div class="tap-review-banner">
      <span>🎬 Line timing review — adjust lines, then run AI word refinement</span>
      <button id="btn-refine-now" class="btn btn-sm btn-primary">✨ Refine Words with AI</button>
    </div>`;

  state.lyricsLines.forEach((line, i) => {
    const ts = (state.tapTimestamps[i] != null) ? formatLrcTime(state.tapTimestamps[i]) : '--:--';
    html += `<div class="lrc-line" data-line="${i}" data-start="${state.tapTimestamps[i] || 0}">`;
    html += `<span class="lrc-timestamp">${ts}</span>`;
    html += `<span class="line-text">${escapeHtml(line)}</span>`;
    html += `<span class="line-actions">`;
    html += `<button class="btn btn-xs" data-action="tnudge" data-nudge="-0.3" title="Line back 0.3s">«</button>`;
    html += `<button class="btn btn-xs" data-action="tnudge" data-nudge="-0.1" title="Line back 0.1s"><</button>`;
    html += `<button class="btn btn-xs" data-action="tnudge" data-nudge="0.1" title="Line forward 0.1s">></button>`;
    html += `<button class="btn btn-xs" data-action="tnudge" data-nudge="0.3" title="Line forward 0.3s">»</button>`;
    html += `<button class="btn btn-xs btn-danger" data-action="tdelete" title="Clear this line's tap">🗑️</button>`;
    html += `</span></div>`;
  });

  container.innerHTML = html;
  document.getElementById('btn-refine-now').addEventListener('click', runRefineNow);
}

function nudgeTapLine(lineIdx, delta) {
  const cur = (state.tapTimestamps[lineIdx] != null) ? state.tapTimestamps[lineIdx] : 0;
  state.tapTimestamps[lineIdx] = Math.max(0, cur + delta);
  showTapReview();
  previewTapLine(lineIdx);
}

function previewTapLine(lineIdx) {
  if (!wavesurfer) return;
  const start = (state.tapTimestamps[lineIdx] != null) ? state.tapTimestamps[lineIdx] : 0;
  state.isPreviewing = true;
  state.previewEnd = start + 0.85;
  state.scrollLock = true;
  try { wavesurfer.setTime(Math.max(0, start)); } catch (e) {}
  try { wavesurfer.play(); } catch (e) {}
}

async function runRefineNow() {
  // Ensure one timestamp per lyrics line (pad missing taps with estimates)
  while (state.tapTimestamps.length < state.lyricsLines.length) {
    const last = state.tapTimestamps.length ? state.tapTimestamps[state.tapTimestamps.length - 1] : 0;
    state.tapTimestamps.push(last + 3);
  }
  const lineTimestamps = state.tapTimestamps.slice(0, state.lyricsLines.length);

  showLoading('Refining word-level timestamps...');
  updateProgress('AI mapping words to your tapped lines...');

  try {
    const res = await fetch(`${API_BASE}/api/refine-words`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lyrics: state.lyricsText,
        line_timestamps: lineTimestamps,
        language: state.language,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Refinement failed');
    }

    const data = await res.json();
    state.alignedData = data.aligned_lines;
    state.reviewMode = false;
    clearUndoStacks();
    markProjectDirty();
    applyKaraokeEnds();
    updateLrcPreview();
    updateStats(data.stats);
    showToast(`Refined ${data.stats.total_words} words across ${data.stats.total_lines} lines`, 'success');
  } catch (err) {
    showToast(`Refinement failed: ${err.message}`, 'error');
  } finally {
    hideLoading();
  }
}

function cancelTapMode() {
  const overlay = $('#tap-overlay');
  overlay.classList.remove('active');
  state.isTapping = false;
  state.tapTimestamps = [];
  if (wavesurfer) wavesurfer.pause();
}

// ─── LRC Preview ────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function updateLrcPreview() {
  hideWordControls();
  const container = $('#lrc-preview');
  if (!state.alignedData || !state.alignedData.length) {
    container.innerHTML = `
      <div class="lrc-empty">
        <div class="icon">📝</div>
        <div>No lyrics aligned yet.</div>
        <div style="margin-top:8px;font-size:0.75rem;">Upload audio, paste lyrics, and click Auto-Align</div>
      </div>`;
    return;
  }

  let html = '';
  state.alignedData.forEach((line, lineIdx) => {
    const words = line.words || [];
    const lineTs = words.length ? formatLrcTime(words[0].start) : '--:--';

    html += `<div class="lrc-line" data-line="${lineIdx}" data-start="${words.length ? words[0].start : 0}">`;
    html += `<span class="lrc-timestamp">${lineTs}</span>`;
    html += `<span class="line-text">`;
    words.forEach((w, wIdx) => {
      const confidence = w.confidence != null ? w.confidence : 1;
      const isSel = state.selectedWord && state.selectedWord.lineIdx === lineIdx && state.selectedWord.wordIdx === wIdx;
      const cls = (confidence < 0.3 ? 'word low-confidence' : 'word') + (isSel ? ' selected' : '');
      html += `<span class="${cls}" data-start="${w.start ?? 0}" data-end="${w.end ?? ((w.start ?? 0) + 0.3)}" data-line="${lineIdx}" data-word="${wIdx}" title="${w.source || ''}">${escapeHtml(w.word)}</span> `;
    });
    html += `</span>`;
    html += `<span class="line-actions">`;
    html += `<button class="btn btn-xs" data-action="nudge" data-nudge="-0.3" title="Line back 0.3s">«</button>`;
    html += `<button class="btn btn-xs" data-action="nudge" data-nudge="-0.1" title="Line back 0.1s"><</button>`;
    html += `<button class="btn btn-xs" data-action="nudge" data-nudge="0.1" title="Line forward 0.1s">></button>`;
    html += `<button class="btn btn-xs" data-action="nudge" data-nudge="0.3" title="Line forward 0.3s">»</button>`;
    html += `<button class="btn btn-xs" data-action="edit" title="Edit this line">✏️</button>`;
    html += `<button class="btn btn-xs" data-action="insert" title="Insert line below">＋</button>`;
    html += `<button class="btn btn-xs btn-danger" data-action="delete" title="Delete this line">🗑️</button>`;
    html += `</span>`;
    html += `</div>`;
  });

  container.innerHTML = html;
}

let wcHoverTimer = null;

function setupLrcPreviewEvents() {
  const container = $('#lrc-preview');

  container.addEventListener('click', (e) => {
    // REVIEW MODE: adjust tapped line timestamps only
    if (state.reviewMode) {
      const btn = e.target.closest('[data-action]');
      if (btn) {
        const lineEl = btn.closest('.lrc-line');
        const lineIdx = parseInt(lineEl.dataset.line, 10);
        if (btn.dataset.action === 'tnudge') nudgeTapLine(lineIdx, parseFloat(btn.dataset.nudge));
        else if (btn.dataset.action === 'tdelete') { state.tapTimestamps[lineIdx] = null; showTapReview(); }
        return;
      }
      const lineEl = e.target.closest('.lrc-line');
      if (lineEl) {
        const lineIdx = parseInt(lineEl.dataset.line, 10);
        previewTapLine(lineIdx);
      }
      return;
    }

    // NORMAL MODE (existing behavior)
    const btn = e.target.closest('[data-action]');
    if (btn) {
      const lineEl = btn.closest('.lrc-line');
      const lineIdx = parseInt(lineEl.dataset.line, 10);
      const action = btn.dataset.action;
      if (action === 'nudge') nudgeLine(lineIdx, parseFloat(btn.dataset.nudge));
      else if (action === 'edit') enterEditMode(lineIdx);
      else if (action === 'insert') insertLine(lineIdx + 1);
      else if (action === 'delete') deleteLine(lineIdx);
      return;
    }

    // Clicking a WORD → select just that word
    const wordEl = e.target.closest('.word');
    if (wordEl) {
      const lineIdx = parseInt(wordEl.dataset.line, 10);
      const wordIdx = parseInt(wordEl.dataset.word, 10);
      selectWord(lineIdx, wordIdx, true);
      return;
    }

    // Clicking the line / timestamp → select & seek the line
    const lineEl = e.target.closest('.lrc-line');
    if (lineEl && !e.target.closest('input,textarea,.word-controls')) {
      const lineIdx = parseInt(lineEl.dataset.line, 10);
      if (e.ctrlKey || e.metaKey) {
        // Toggle multi-select
        if (state.selectedLines.has(lineIdx)) {
          state.selectedLines.delete(lineIdx);
        } else {
          state.selectedLines.add(lineIdx);
        }
        updateLineSelectionVisual();
        return;
      }
      // Plain click → single line, clear any multi-select
      if (state.selectedLines.size > 0) {
        state.selectedLines.clear();
        updateLineSelectionVisual();
      }
      selectLine(lineIdx);
    }
  });

  // Hover a word → show precision controls
  container.addEventListener('mouseover', (e) => {
    const wordEl = e.target.closest('.word');
    if (wordEl) {
      const lineIdx = parseInt(wordEl.dataset.line, 10);
      const wordIdx = parseInt(wordEl.dataset.word, 10);
      clearTimeout(wcHoverTimer);
      wcHoverTimer = setTimeout(() => showWordControls(lineIdx, wordIdx), 120);
    }
  });

  container.addEventListener('mouseleave', () => {
    clearTimeout(wcHoverTimer);
    hideWordControls();
  });
}

function updateLineSelectionVisual() {
  document.querySelectorAll('.lrc-line').forEach(el => {
    const li = parseInt(el.dataset.line, 10);
    el.classList.toggle('line-selected', state.selectedLines.has(li));
  });
}

function batchNudgeLines(delta) {
  if (!state.selectedLines.size) {
    showToast('Select lines first (Ctrl/Cmd + click)', 'info');
    return;
  }
  pushUndo();
  state.selectedLines.forEach(li => {
    const line = state.alignedData[li];
    if (!line) return;
    (line.words || []).forEach(w => {
      const start = (w.start != null) ? w.start : 0;
      w.start = Math.max(0, start + delta);
    });
  });
  applyKaraokeEnds();
  syncAlignment();
  updateLrcPreview();
  updateStats(getLocalStats());
  showToast(`Shifted ${state.selectedLines.size} line(s) by ${delta}s`, 'success');
}

// ─── Undo / Redo engine ──────────────────────────────────────

function clearUndoStacks() {
  state.undoStack = [];
  state.redoStack = [];
}

function markProjectDirty() {
  state.projectDirty = true;
  updateProjectStateStat();
}

function snapshotState() {
  return state.alignedData;
}

function pushUndo() {
  // Save a snapshot of the CURRENT state before an edit
  state.undoStack.push(snapshotState());
  if (state.undoStack.length > 50) state.undoStack.shift(); // cap at 50
  state.redoStack = []; // new edit clears redo history
}

function restoreSnapshot(snap, toRedo) {
  state.snapshotting = true;
  // Deep-clone so we don't mutate the stored snapshot
  state.alignedData = JSON.parse(JSON.stringify(snap));
  if (toRedo) state.redoStack.pop();
  syncAlignment();
  updateLrcPreview();
  updateStats(getLocalStats());
  state.snapshotting = false;
}

function undo() {
  if (!state.undoStack.length) {
    showToast('Nothing to undo', 'info');
    return;
  }
  hideWordControls(); 
  const prev = state.undoStack.pop();       // the state before the last edit
  state.redoStack.push(snapshotState());    // current (edited) state → redo stack
  restoreSnapshot(prev, false);
  showToast('Undo', 'info');
}

function redo() {
  if (!state.redoStack.length) {
    showToast('Nothing to redo', 'info');
    return;
  }
  hideWordControls();
  const next = state.redoStack[state.redoStack.length - 1];
  state.undoStack.push(snapshotState());    // current state → undo stack
  restoreSnapshot(next, true);
  showToast('Redo', 'info');
}

// ─── Word & line precision controls ──────────────────────────

function showWordControls(lineIdx, wordIdx) {
  hideWordControls();
  const el = document.querySelector(`.word[data-line="${lineIdx}"][data-word="${wordIdx}"]`);
  if (!el) return;

  state.selectedWord = { lineIdx, wordIdx };
  state.wcTarget = { lineIdx, wordIdx };
  state.scrollLock = true; // editing a word → pause auto-scroll

  const container = $('#lrc-preview');
  const pop = document.createElement('div');
  pop.className = 'word-controls';
  pop.innerHTML = `
    <button class="wc-btn" data-nudge="-0.3" title="Back 0.3s">«</button>
    <button class="wc-btn" data-nudge="-0.1" title="Back 0.1s"><</button>
    <span class="wc-time"></span>
    <button class="wc-btn" data-nudge="0.1" title="Forward 0.1s">></button>
    <button class="wc-btn" data-nudge="0.3" title="Forward 0.3s">»</button>
    <button class="wc-btn wc-play" title="Preview">▶</button>
    <button class="wc-btn wc-close" title="Close">×</button>
  `;
  container.appendChild(pop);

  const word = state.alignedData[lineIdx].words[wordIdx];
  const timeEl = pop.querySelector('.wc-time');
  timeEl.textContent = formatLrcTimeWord(word.start);

  pop.querySelectorAll('[data-nudge]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      nudgeWord(parseFloat(btn.dataset.nudge));
    });
  });
  pop.querySelector('.wc-play').addEventListener('click', (e) => {
    e.stopPropagation();
    previewWord(word);
  });
  pop.querySelector('.wc-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hideWordControls();
  });

  positionWordControls(el, pop);
  updateWordSelectionVisual();
}

function hideWordControls() {
  const pop = document.querySelector('.word-controls');
  if (pop) pop.remove();
  state.wcTarget = null;
  state.selectedWord = null;
  if (!state.isPreviewing) state.scrollLock = false;
  document.querySelectorAll('.word.selected').forEach(w => w.classList.remove('selected'));
}

function selectLine(lineIdx) {
  hideWordControls();
  const line = state.alignedData[lineIdx];
  const start = (line && line.words && line.words.length && line.words[0].start != null)
    ? line.words[0].start : 0;
  if (wavesurfer && start != null) wavesurfer.setTime(start);
}

function selectWord(lineIdx, wordIdx, seek) {
  const line = state.alignedData[lineIdx];
  if (!line || !line.words[wordIdx]) return;
  state.selectedWord = { lineIdx, wordIdx };
  state.scrollLock = true;
  showWordControls(lineIdx, wordIdx);
  if (seek !== false && wavesurfer) {
    const word = line.words[wordIdx];
    const start = word.start;
    if (start != null) {
      wavesurfer.setTime(start);
      // Play the short preview right at the word so the user hears where it stands
      previewWord(word);
    }
  }
  updateWordSelectionVisual();
}

function updateWordSelectionVisual() {
  document.querySelectorAll('.word.selected').forEach(w => w.classList.remove('selected'));
  if (state.selectedWord) {
    const el = document.querySelector(`.word[data-line="${state.selectedWord.lineIdx}"][data-word="${state.selectedWord.wordIdx}"]`);
    if (el) el.classList.add('selected');
  }
}

function positionWordControls(el, pop) {
  const container = $('#lrc-preview');
  const cRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();

  let left = elRect.left - cRect.left + container.scrollLeft;
  let top = elRect.bottom - cRect.top + container.scrollTop + 6;

  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const maxLeft = container.clientWidth - pop.offsetWidth - 8;
  if (left > maxLeft) pop.style.left = maxLeft + 'px';
  if (left < 8) pop.style.left = '8px';

  // If below overflows the viewport, place above the word instead
  if (top + pop.offsetHeight - container.scrollTop > container.clientHeight - 4) {
    const above = elRect.top - cRect.top + container.scrollTop - pop.offsetHeight - 6;
    if (above >= container.scrollTop + 4) pop.style.top = above + 'px';
  }
}

function nudgeWord(delta) {
  if (!state.wcTarget) return;
  const { lineIdx, wordIdx } = state.wcTarget;
  const line = state.alignedData[lineIdx];
  if (!line) return;
  const w = line.words[wordIdx];
  if (!w) return;
  pushUndo();

  const start = (w.start != null) ? w.start : 0;
  w.start = Math.max(0, start + delta);
  w.source = (w.source === 'matched') ? 'matched' : 'edited';

  applyKaraokeEnds();  // word's end = next word's start

  syncAlignment();
  updateLrcPreview();
  showWordControls(lineIdx, wordIdx);
  previewWord(w);
}

function applyKaraokeEnds() {
  // Karaoke-style: every word's end = the start of the next word, so
  // highlighting is contiguous and no word "flashes" with no end.
  state.alignedData.forEach((line, li) => {
    const words = line.words || [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = (i + 1 < words.length) ? words[i + 1] : null;
      const nextLine = (i + 1 === words.length && li + 1 < state.alignedData.length && state.alignedData[li + 1].words.length)
        ? state.alignedData[li + 1].words[0] : null;
      const nextStart = (next && next.start != null) ? next.start
        : (nextLine && nextLine.start != null ? nextLine.start : null);

      if (nextStart != null) {
        w.end = Math.max(w.start + 0.01, nextStart);
      } else {
        // Last word overall — keep a minimum duration
        if (w.end == null || w.end <= w.start) w.end = w.start + 0.3;
      }
    }
  });
}

function nudgeLine(lineIdx, delta) {
  const line = state.alignedData[lineIdx];
  if (!line) return;
  hideWordControls();
  pushUndo();
  (line.words || []).forEach(w => {
    const start = (w.start != null) ? w.start : 0;
    w.start = Math.max(0, start + delta);
  });
  applyKaraokeEnds();
  syncAlignment();
  updateLrcPreview();
  updateStats(getLocalStats());
  const first = line.words[0];
  if (first) previewWord(first);
}

function previewWord(word) {
  if (!wavesurfer) return;
  const start = (word.start != null) ? word.start : 0;
  const end = (word.end != null) ? word.end : start + 0.3;
  const previewEnd = start + Math.min(Math.max(0.15, end - start) + 0.25, 0.85);
  state.isPreviewing = true;
  state.previewEnd = previewEnd;
  state.scrollLock = true;
  try { wavesurfer.setTime(start); } catch (e) {}
  try { wavesurfer.play(); } catch (e) {}
}

function formatLrcTimeWord(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  const sec = (s % 60);
  return `${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

function enterEditMode(lineIdx) {
  const line = state.alignedData[lineIdx];
  const lineEl = document.querySelector(`.lrc-line[data-line="${lineIdx}"]`);
  if (!lineEl || !line) return;

  const textEl = lineEl.querySelector('.line-text');
  const actionsEl = lineEl.querySelector('.line-actions');
  if (!textEl || !actionsEl) return;

  const ta = document.createElement('textarea');
  ta.className = 'line-edit-textarea';
  ta.value = (line.words || []).map(w => w.word).join(' ');
  textEl.replaceWith(ta);

  actionsEl.innerHTML = `
    <button class="btn btn-xs btn-primary" data-edit-save>Save</button>
    <button class="btn btn-xs" data-edit-cancel>Cancel</button>
  `;
  actionsEl.querySelector('[data-edit-save]').addEventListener('click', () => saveLineEdit(lineIdx, ta.value));
  actionsEl.querySelector('[data-edit-cancel]').addEventListener('click', () => updateLrcPreview());
  ta.focus();
}

function saveLineEdit(lineIdx, newText) {
  const line = state.alignedData[lineIdx];
  if (!line) return;
  pushUndo();

  const prevStart = (lineIdx > 0 && state.alignedData[lineIdx - 1].words.length)
    ? state.alignedData[lineIdx - 1].words[0].start : 0;
  const nextStart = (lineIdx < state.alignedData.length - 1 && state.alignedData[lineIdx + 1].words.length)
    ? state.alignedData[lineIdx + 1].words[0].start : null;

  rewordLine(line, newText, prevStart, nextStart);
  applyKaraokeEnds();
  syncAlignment();
  updateLrcPreview();
  updateStats(getLocalStats());
  showToast('Line updated', 'success');
}

function rewordLine(lineData, newText, prevStart, nextStart) {
  const oldWords = lineData.words || [];
  const newTokens = newText.trim().split(/\s+/);
  if (!newTokens.length) return;

  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const used = new Set();
  const result = new Array(newTokens.length).fill(null);

  // Pass 1: keep timestamps for words that still exist (by normalized text)
  for (let i = 0; i < newTokens.length; i++) {
    const n = norm(newTokens[i]);
    if (!n) continue;
    for (let j = 0; j < oldWords.length; j++) {
      if (used.has(j)) continue;
      if (norm(oldWords[j].word) === n) {
        result[i] = {
          word: newTokens[i],
          start: oldWords[j].start,
          end: oldWords[j].end,
          confidence: oldWords[j].confidence,
          source: oldWords[j].source || 'matched',
        };
        used.add(j);
        break;
      }
    }
  }

  // Pass 2: interpolate timestamps for new words
  let anchors = result.map((w, i) => w ? { i, start: w.start, end: w.end } : null).filter(Boolean);
  const round = v => Math.round(v * 1000) / 1000;

  for (let i = 0; i < newTokens.length; i++) {
    if (result[i]) continue;
    let prev = null, next = null;
    for (const a of anchors) {
      if (a.i < i) prev = a;
      else if (a.i > i) { next = a; break; }
    }
    let start, end;
    if (prev && next) {
      const total = next.start - prev.end;
      const frac = (i - prev.i) / (next.i - prev.i);
      start = prev.end + total * frac;
      end = prev.end + total * (frac + 0.6 / Math.max(1, next.i - prev.i));
    } else if (prev) {
      start = prev.end + 0.1;
      end = prev.end + 0.35;
    } else if (next) {
      start = Math.max(0, next.start - 0.35);
      end = Math.max(0, next.start - 0.05);
    } else if (prevStart != null) {
      // Brand-new line: spread across the gap between neighbor lines
      const lo = prevStart, hi = nextStart != null ? nextStart : prevStart + newTokens.length * 0.3;
      const span = Math.max(0.3, hi - lo);
      const step = span / Math.max(1, newTokens.length);
      start = lo + i * step;
      end = lo + (i + 1) * step;
    } else {
      start = i * 0.3;
      end = (i + 1) * 0.3;
    }
    result[i] = {
      word: newTokens[i],
      start: round(start),
      end: round(Math.max(start + 0.05, end)),
      confidence: 0.1,
      source: 'edited',
    };
    anchors.push({ i, start: result[i].start, end: result[i].end });
    anchors.sort((a, b) => a.i - b.i);
  }

  lineData.words = result;
  lineData.line = newTokens.join(' ');
}

function insertLine(afterIdx) {
  state.alignedData.splice(afterIdx, 0, { line: '', words: [] });
  syncAlignment();
  updateLrcPreview();
  enterEditMode(afterIdx);
}

function deleteLine(lineIdx) {
  if (!confirm('Delete this line?')) return;
  pushUndo();
  state.alignedData.splice(lineIdx, 1);
  syncAlignment();
  updateLrcPreview();
  updateStats(getLocalStats());
  showToast('Line removed', 'info');
}

function getLocalStats() {
  let totalWords = 0, matched = 0, interpolated = 0, fallback = 0;
  let firstStart = null, lastEnd = null;
  state.alignedData.forEach(l => {
    (l.words || []).forEach(w => {
      totalWords++;
      const src = w.source || 'unknown';
      if (src === 'matched') matched++;
      else if (src === 'interpolated' || src === 'edited') interpolated++;
      else fallback++;
      if (firstStart === null && w.start != null) firstStart = w.start;
      if (w.end != null) lastEnd = w.end;
    });
  });
  return {
    total_words: totalWords,
    total_lines: state.alignedData.length,
    match_rate: totalWords ? Math.round(matched / totalWords * 1000) / 10 : 0,
    duration_seconds: (firstStart != null && lastEnd != null) ? Math.round((lastEnd - firstStart) * 10) / 10 : 0,
  };
}

let lastScrolledLine = null;

function updateLrcHighlight(currentTime) {
  if (!state.alignedData || !state.alignedData.length) return;

  const duration = wavesurfer ? wavesurfer.getDuration() : (state.audioDuration || Infinity);

  // During a word preview: highlight ONLY the target word, never scroll,
  // so you're not pulled away from the word you're editing.
  if (state.isPreviewing && state.wcTarget) {
    const { lineIdx, wordIdx } = state.wcTarget;
    const line = state.alignedData[lineIdx];
    document.querySelectorAll('.word.highlight').forEach(x => x.classList.remove('highlight'));
    document.querySelectorAll('.lrc-line.active').forEach(x => x.classList.remove('active'));
    if (line && line.words[wordIdx]) {
      const lineEl = document.querySelector(`.lrc-line[data-line="${lineIdx}"]`);
      if (lineEl) lineEl.classList.add('active');
      const wordEl = document.querySelector(`.word[data-line="${lineIdx}"][data-word="${wordIdx}"]`);
      if (wordEl) wordEl.classList.add('highlight');
    }
    return;
  }

  const lines = document.querySelectorAll('.lrc-line');

  // Find the active line from data — the LAST line whose start time is at or before the playhead
  let activeIndex = -1;
  for (let i = 0; i < state.alignedData.length; i++) {
    const words = state.alignedData[i].words || [];
    const start = (words.length && words[0].start != null) ? words[0].start : Infinity;
    if (currentTime >= start) activeIndex = i;
  }

  // Range check — the active line must actually contain the playhead
  if (activeIndex >= 0) {
    const line = state.alignedData[activeIndex];
    const words = line.words || [];
    const start = (words.length && words[0].start != null) ? words[0].start : -Infinity;
    const next = state.alignedData[activeIndex + 1];
    const nextStart = (next && next.words && next.words.length && next.words[0].start != null)
      ? next.words[0].start : duration;
    if (currentTime < start || currentTime >= nextStart) activeIndex = -1;
  }

  let activeLine = null;
  lines.forEach((el, i) => {
    if (i === activeIndex) {
      el.classList.add('active');
      activeLine = el;
    } else {
      el.classList.remove('active');
    }
  });

  // Word-level highlight inside the active line
  document.querySelectorAll('.word.highlight').forEach(w => w.classList.remove('highlight'));
  if (activeLine) {
    activeLine.querySelectorAll('.word').forEach(word => {
      const wStart = parseFloat(word.dataset.start);
      const wEnd = parseFloat(word.dataset.end);
      if (currentTime >= wStart && currentTime < wEnd) {
        word.classList.add('highlight');
      }
    });
  }

  // Auto-scroll only on line CHANGE and only when not locked (editing/previewing)
  if (activeLine && activeLine !== lastScrolledLine && !state.scrollLock) {
    activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
    lastScrolledLine = activeLine;
  }
}

function formatLrcTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2);
  return `${m.toString().padStart(2, '0')}:${s.padStart(5, '0')}`;
}

// ─── Statistics ─────────────────────────────────────────────

function updateStats(stats) {
  if (!stats) return;

  $('#stat-total-words').textContent = stats.total_words || 0;
  $('#stat-lines').textContent = stats.total_lines || 0;
  $('#stat-match-rate').textContent = `${stats.match_rate || 0}%`;

  // Vocal duration = the span actually covered by the aligned words
  $('#stat-vocal-duration').textContent = formatTime(stats.duration_seconds || 0);

  // Song duration = full track length
  $('#stat-song-duration').textContent = formatTime(getSongDuration());

  // Color-code match rate
  const rate = stats.match_rate || 0;
  const rateEl = $('#stat-match-rate');
  rateEl.className = 'stat-value ' + (rate >= 80 ? 'good' : rate >= 50 ? 'warn' : 'bad');

  updateProjectStateStat();
}

// ─── Export ─────────────────────────────────────────────────

async function exportLRC(format) {
  if (!state.alignedData) {
    showToast('No alignment data to export', 'warning');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/export/${format}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Export failed');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Distinct filename per export type so multiple exports are recognizable
    const baseName = state.audioFilename.replace(/\.[^.]+$/, '') || 'lyrics';
    const extMap = { enhanced: '.lrc', lrc: '.lrc', srt: '.srt', json: '.json', enhanced_srt: '.srt' };
    const suffixMap = { enhanced: 'enhanced-LRC', lrc: 'standard-LRC', srt: 'premiere-SRT', json: 'JSON', enhanced_srt: 'enhanced-SRT' };
    const ext = extMap[format] || ('.' + format);
    const suffix = suffixMap[format] || format;
    a.download = `${baseName}_${suffix}${ext}`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported as ${format.toUpperCase()}`, 'success');
  } catch (err) {
    showToast(`Export failed: ${err.message}`, 'error');
  }
}

// ─── Project Reset / New Project ─────────────────────────────

async function createNewProject() {
  if (!confirm('Create a new project? This will clear the audio, lyrics, and alignment.')) return;
  await resetBackendSession();
  resetFrontend(true);
  showToast('New project created', 'success');
}

async function resetProject() {
  if (!confirm('Reset this project? This clears the alignment but keeps your audio and lyrics.')) return;
  await resetBackendSession();
  resetFrontend(false);
  showToast('Project reset — ready to re-align', 'info');
}

async function resetBackendSession() {
  try {
    await fetch(`${API_BASE}/api/reset`, { method: 'POST' });
  } catch (err) {
    console.warn('Backend reset failed (server may be off):', err);
  }
}

function resetFrontend(full) {
  // Stop + destroy waveform
  if (wavesurfer) {
    try { wavesurfer.destroy(); } catch (e) {}
    wavesurfer = null;
  }
  $('#waveform').innerHTML = '';
  $('#waveform-placeholder').style.display = '';
  $('#time-current').textContent = '0:00';
  $('#time-total').textContent = '0:00';

  // Alignment data
  state.alignedData = null;
  state.tapTimestamps = [];
  state.tapCurrentLine = 0;
  state.isTapping = false;
  state.isPlaying = false;
  state.reviewMode = false;
  state.undoStack = [];
  state.redoStack = [];
  state.snapshotting = false;

  // Hide overlays
  $('#tap-overlay').classList.remove('active');
  $('#loading-overlay').classList.remove('active');

  if (full) {
    // Full wipe: audio + lyrics + project state too
    state.audioLoaded = false;
    state.audioFile = null;
    state.audioFilename = '';
    state.audioDuration = 0;
    state.lyricsText = '';
    state.lyricsLines = [];
    state.projectName = null;
    state.projectFolder = null;
    state.projectDirty = false;
    $('#lyrics-textarea').value = '';
    $('#lyrics-line-count').textContent = '0 lines';
    $('#upload-zone').style.display = '';
    const loaded = $('#upload-loaded');
    loaded.classList.remove('visible');
  } else {
    // Partial reset (Reset Project): alignment cleared.
    // If a project is tied to this session, its saved state is now stale →
    // mark it dirty. If there was never a project, stay "Not saved".
    if (state.projectName) {
      state.projectDirty = true;
    }
  }

  resetStats();
  updateLrcPreview();
  updateStatusBadge();
}

function resetStats() {
  $('#stat-total-words').textContent = '—';
  $('#stat-lines').textContent = '—';
  $('#stat-match-rate').textContent = '—';
  $('#stat-match-rate').className = 'stat-value';
  $('#stat-vocal-duration').textContent = '—';
  $('#stat-song-duration').textContent = state.audioLoaded ? formatTime(getSongDuration()) : '—';
  updateProjectStateStat();
}

function getSongDuration() {
  if (wavesurfer) {
    const d = wavesurfer.getDuration();
    if (d && d > 0) return d;
  }
  return state.audioDuration || 0;
}

function updateProjectStateStat() {
  const el = $('#stat-project-state');
  if (!el) return;
  if (state.projectDirty) {
    el.textContent = 'Unsaved';
    el.className = 'stat-value bad';       // red — save your work!
    el.title = state.projectName ? `Unsaved changes to: ${state.projectName}` : 'You have unsaved changes';
  } else if (state.projectName) {
    el.textContent = 'Saved';
    el.className = 'stat-value good';      // green
    el.title = `Project: ${state.projectName}`;
  } else {
    el.textContent = 'Not saved';
    el.className = 'stat-value warn';      // amber — neutral nudge
    el.title = '';
  }
}

// ─── Project Save / Load ─────────────────────────────────────

async function saveProject() {
  if (!state.audioLoaded) {
    showToast('Upload audio before saving a project', 'warning');
    return;
  }
  // No project attached yet → behave like "Save As"
  if (!state.projectFolder) {
    saveProjectAs();
    return;
  }
  showToast('Saving project...', 'info');
  try {
    const res = await fetch(`${API_BASE}/api/project/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.projectName,          // keep the display name
        folder: state.projectFolder,      // save INTO the same folder (in place)
        lyrics: $('#lyrics-textarea').value,
        language: state.language,
        aligned_data: state.alignedData || [],
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Save failed');
    }
    const data = await res.json();
    state.projectName = data.name;
    state.projectFolder = data.folder;
    state.projectDirty = false;
    updateProjectStateStat();
    showToast(`Project saved: ${data.name}`, 'success');
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

async function saveProjectAs() {
  if (!state.audioLoaded) {
    showToast('Upload audio before saving a project', 'warning');
    return;
  }
  const defaultName = state.projectName || (state.audioFilename || 'project').replace(/\.[^.]+$/, '');
  const name = prompt('Save as new project — project name:', defaultName);
  if (!name) return; // cancelled
  showToast('Saving project as new...', 'info');
  try {
    const res = await fetch(`${API_BASE}/api/project/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,                       // new folder derived from this name
        lyrics: $('#lyrics-textarea').value,
        language: state.language,
        aligned_data: state.alignedData || [],
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Save failed');
    }
    const data = await res.json();
    state.projectName = data.name;
    state.projectFolder = data.folder;
    state.projectDirty = false;
    updateProjectStateStat();
    showToast(`Project saved as: ${data.name}`, 'success');
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

async function loadProject() {
  try {
    const res = await fetch(`${API_BASE}/api/projects`);
    if (!res.ok) throw new Error('Could not list projects');
    const data = await res.json();
    const projects = data.projects || [];
    if (!projects.length) {
      showToast('No saved projects found', 'info');
      return;
    }
    showProjectListModal(projects);
  } catch (err) {
    showToast(`Load failed: ${err.message}`, 'error');
  }
}

async function loadProjectByName(name) {
  if (state.audioLoaded && !confirm('Load this project? Unsaved changes will be lost.')) return;

  try {
    const res = await fetch(`${API_BASE}/api/project/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Load failed');
    }
    const data = await res.json();

    hideProjectModal();
    hideWordControls();

    // Restore state
    state.audioLoaded = true;
    state.audioFilename = data.audio_filename;
    state.lyricsText = data.lyrics || '';
    state.lyricsLines = (data.lyrics || '').split('\n').filter(l => l.trim());
    state.alignedData = data.aligned_data || null;
    state.language = data.language || 'es';
    state.projectName = data.name;
    state.projectFolder = data.folder;
    state.projectDirty = false;
    clearUndoStacks();
    state.selectedWord = null;
    state.wcTarget = null;
    state.scrollLock = false;

    // Restore UI
    $('#lyrics-textarea').value = state.lyricsText;
    $('#lyrics-line-count').textContent = `${state.lyricsLines.length} lines`;
    $('#language-select').value = state.language;
    $('#upload-zone').style.display = 'none';
    const loaded = $('#upload-loaded');
    loaded.classList.add('visible');
    $('#file-name').textContent = data.audio_filename;

    // Load waveform + preview
    await loadWaveform();
    updateLrcPreview();
    updateStats(getLocalStats());
    updateStatusBadge();
    showToast(`Project loaded: ${data.name}`, 'success');
  } catch (err) {
    hideProjectModal();
    showToast(`Load failed: ${err.message}`, 'error');
  }
}

// ─── Import LRC ──────────────────────────────────────────────

function setupLrcImport() {
  const btn = document.getElementById('btn-import-lrc');
  const input = document.getElementById('lrc-file-input');
  if (!btn || !input) return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    importLrcFile(file);
    // Reset input so the same file can be re-selected later
    e.target.value = '';
  });
}

async function importLrcFile(file) {
  // Guard: require audio first (soft prompt)
  if (!state.audioLoaded) {
    const proceed = confirm(
      'No audio is loaded. You can still view and edit the imported lyrics, ' +
      'but preview/seek will need audio.\n\n' +
      'Click OK to upload audio first (recommended), or Cancel to continue without audio.'
    );
    if (proceed) {
      document.getElementById('audio-input').click(); // open the audio file picker
      // Store the pending LRC file; after upload completes, we'll import it
      state.pendingLrcFile = file;
      return;
    }
    // Continue without audio — import anyway (view/edit text only)
  }

  try {
    const text = await file.text();
    const res = await fetch(`${API_BASE}/api/import-lrc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lrc_content: text }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Import failed');
    }
    const data = await res.json();
    applyImportedLrc(data, file);
  } catch (err) {
    showToast(`Import failed: ${err.message}`, 'error');
  }
}

function handleLrcFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  importLrcFile(file);
  input.value = ''; // allow re-selecting the same file later
}

function applyImportedLrc(data, file) {
  // Set project identity from the file name (so Save works)
  const baseName = (file ? file.name : 'imported').replace(/\.lrc$/i, '').replace(/\.[^.]+$/, '');
  state.projectName = baseName;
  state.projectFolder = null; // not a saved project folder yet
  state.projectDirty = true;  // imported → unsaved changes

  // Lyrics text
  const lyrics = data.lyrics || '';
  state.lyricsText = lyrics;
  state.lyricsLines = lyrics.split('\n').filter(l => l.trim());
  $('#lyrics-textarea').value = lyrics;
  $('#lyrics-line-count').textContent = `${state.lyricsLines.length} lines`;
  $('#language-select').value = state.language;

  // Alignment data
  state.alignedData = data.aligned_lines || [];
  clearUndoStacks();

  // If standard LRC (no word timestamps), offer option C: split evenly
  if (!data.has_word_timestamps) {
    offerSplitWords();
  } else {
    applyKaraokeEnds();
    updateLrcPreview();
    updateStats(getLocalStats());
    updateStatusBadge();
    showToast(`Imported ${data.aligned_lines.length} lines from ${file ? file.name : 'LRC'}`, 'success');
  }
}

function offerSplitWords() {
  const doSplit = confirm(
    'This LRC file has line-level timing only (no per-word timing).\n\n' +
    'Click OK to split each line into evenly-spaced words (rough estimate, editable), ' +
    'or Cancel to keep line-level only.'
  );
  if (doSplit) {
    splitWordsEvenly();
  } else {
    applyKaraokeEnds();
    updateLrcPreview();
    updateStats(getLocalStats());
    updateStatusBadge();
    showToast('Imported (line-level only)', 'success');
  }
}

function splitWordsEvenly() {
  if (!state.alignedData) return;
  state.alignedData.forEach(line => {
    const words = line.words || [];
    if (!words.length) {
      const lineStart = line.start != null ? line.start : 0;
      const lineEnd = line.end != null ? line.end : lineStart + 3;
      const tokens = (line.line || '').trim().split(/\s+/).filter(Boolean);
      if (tokens.length) {
        const dur = (lineEnd - lineStart) / tokens.length;
        line.words = tokens.map((t, i) => ({
          word: t,
          start: round2(lineStart + i * dur),
          end: round2(lineStart + (i + 1) * dur),
          confidence: 0.05,
          source: 'imported-split',
        }));
      }
    }
  });
  applyKaraokeEnds();
  updateLrcPreview();
  updateStats(getLocalStats());
  updateStatusBadge();
  showToast('Imported — words split evenly across each line', 'success');
}

function round2(v) { return Math.round(v * 100) / 100; }

// ─── Project list modal ──────────────────────────────────────

function showProjectListModal(projects) {
  let listHtml = '';
  projects.forEach(p => {
    const lines = p.line_count || 0;
    const words = p.word_count || 0;
    const updated = p.updated ? new Date(p.updated).toLocaleString() : '?';
    const audioNote = p.has_audio ? '' : ' <span style="color:var(--warning);">(no audio)</span>';
    listHtml += `
      <div class="project-item">
        <div class="project-item-info">
          <div class="project-item-name">${escapeHtml(p.name)}${audioNote}</div>
          <div class="project-item-meta">${lines} lines · ${words} words · updated ${escapeHtml(updated)}</div>
        </div>
        <button class="btn btn-xs btn-primary project-open" data-name="${escapeHtml(p.folder)}">Open</button>
      </div>`;
  });
  document.getElementById('project-list').innerHTML = listHtml;
  document.getElementById('project-modal').classList.add('active');
}

function hideProjectModal() {
  const modal = document.getElementById('project-modal');
  if (modal) modal.classList.remove('active');
}

function setupProjectModal() {
  const modal = document.getElementById('project-modal');
  if (!modal) return;
  modal.addEventListener('click', (e) => {
    if (e.target === modal) { hideProjectModal(); return; }
    const btn = e.target.closest('.project-open');
    if (btn) loadProjectByName(btn.dataset.name);
  });
  const closeBtn = document.getElementById('project-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', hideProjectModal);
}

// ─── Offset Control ─────────────────────────────────────────

async function applyOffset(seconds) {
  if (!state.alignedData) {
    showToast('No alignment data to offset', 'warning');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/offset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset_seconds: parseFloat(seconds) }),
    });

    if (!res.ok) throw new Error('Offset failed');

    const data = await res.json();
    state.alignedData = data.aligned_lines;
    updateLrcPreview();
    showToast(`Timestamps shifted by ${seconds > 0 ? '+' : ''}${seconds}s`, 'success');
  } catch (err) {
    showToast(`Offset failed: ${err.message}`, 'error');
  }
}

// ─── Keyboard Shortcuts ─────────────────────────────────────

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
      return;
    }

    switch (e.code) {
      case 'KeyZ':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) redo(); else undo();
        }
        break;
      case 'KeyY':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          redo();
        }
        break;
      case 'Space':
        e.preventDefault();
        if (state.isTapping) {
          handleTap();
        } else {
          togglePlay();
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekRelative(-3);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekRelative(3);
        break;
      case 'ArrowUp':
        e.preventDefault();
        seekRelative(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        seekRelative(1);
        break;
      case 'Enter':
        if (state.mode === 'auto' && !state.isAligning) {
          e.preventDefault();
          runAutoAlign();
        }
        break;
      case 'Escape':
        if (state.isTapping) {
          cancelTapMode();
        }
        break;
    }
  });
}

// ─── Loading Overlay ────────────────────────────────────────

function showLoading(message) {
  const overlay = $('#loading-overlay');
  $('#loading-text').textContent = message;
  overlay.classList.add('active');
}

function hideLoading() {
  $('#loading-overlay').classList.remove('active');
}

function updateProgress(message) {
  $('#loading-text').textContent = message;
}

// ─── Status Badge ───────────────────────────────────────────

function updateStatusBadge() {
  const dot = $('#status-dot');
  const text = $('#status-text');

  if (state.audioLoaded && state.alignedData && state.alignedData.length) {
    dot.className = 'dot';
    text.textContent = `${state.alignedData.length} lines aligned`;
  } else if (state.audioLoaded) {
    dot.className = 'dot';
    text.textContent = 'Audio loaded';
  } else {
    dot.className = 'dot offline';
    text.textContent = 'Ready';
  }
}

// ─── Health Check ───────────────────────────────────────────

async function checkServerHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    const data = await res.json();
    $('#device-info').textContent = `Device: ${data.device}`;
  } catch (err) {
    $('#device-info').textContent = 'Server disconnected';
    $('#status-dot').className = 'dot offline';
  }
}

// ─── Initialization ─────────────────────────────────────────

function init() {
  setupUpload();
  setupKeyboard();
  setupLrcPreviewEvents();
  setupLrcImport();
  
  // Mode buttons
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Play button
  $('#btn-play').addEventListener('click', togglePlay);

  // Auto-align button
  $('#btn-auto-align').addEventListener('click', runAutoAlign);

  // Manual tap buttons
  $('#btn-start-tap').addEventListener('click', startTapMode);
  $('#btn-tap-complete').addEventListener('click', completeTapMode);
  $('#btn-tap-cancel').addEventListener('click', cancelTapMode);

  // Project buttons
  $('#btn-create-project').addEventListener('click', createNewProject);
  $('#btn-reset-project').addEventListener('click', resetProject);

  // Project save/load
  $('#btn-save-project').addEventListener('click', saveProject);
  $('#btn-save-project').addEventListener('click', saveProject);
  $('#btn-save-project-as').addEventListener('click', saveProjectAs);
  $('#btn-load-project').addEventListener('click', loadProject);
  setupProjectModal();

  // Export buttons
  $('#btn-export-enhanced').addEventListener('click', () => exportLRC('enhanced'));
  $('#btn-export-lrc').addEventListener('click', () => exportLRC('lrc'));
  $('#btn-export-srt').addEventListener('click', () => exportLRC('srt'));
  $('#btn-export-json').addEventListener('click', () => exportLRC('json'));
  $('#btn-export-enhanced-srt').addEventListener('click', () => exportLRC('enhanced_srt'));

  // Language select
  $('#language-select').addEventListener('change', (e) => {
    state.language = e.target.value;
  });

  // Vocal separation toggle
  $('#vocal-sep-toggle').addEventListener('change', (e) => {
    state.useVocalSeparation = e.target.checked;
  });

  // Offset controls
  $('#btn-offset-minus').addEventListener('click', () => {
    const val = parseFloat($('#offset-input').value) || 0;
    applyOffset(-Math.abs(val));
  });
  $('#btn-offset-plus').addEventListener('click', () => {
    const val = parseFloat($('#offset-input').value) || 0;
    applyOffset(Math.abs(val));
  });

  // Lyrics textarea change
  $('#lyrics-textarea').addEventListener('input', () => {
    const lines = $('#lyrics-textarea').value.split('\n').filter(l => l.trim());
    $('#lyrics-line-count').textContent = `${lines.length} lines`;
  });

  // Initial mode
  setMode('auto');

  // Check server
  checkServerHealth();
  
  // Periodic status check
  setInterval(updateStatusBadge, 5000);

  console.log('🎵 Eliz\'s LRC Generator ready!');
  console.log('   Mode: Auto-align + Manual tap');
  console.log('   Shortcuts: Space=Play/Pause, ←→=Seek, Enter=Align, Esc=Cancel tap');
}

// Start when DOM is ready
document.addEventListener('DOMContentLoaded', init);