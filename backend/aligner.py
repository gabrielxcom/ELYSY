"""
Eliz's LRC Generator — AI Alignment Engine
===========================================
Core pipeline: Vocal Separation → Forced Alignment → Lyrics Matching

Supports two modes:
  1. FULL AUTO: Demucs → WhisperX → match to known lyrics → word-level LRC
  2. MANUAL TAP + AI: User taps line boundaries → AI refines to word-level

Languages: Spanish (es), English (en), and any Whisper-supported language.
"""

import os
import sys
import difflib
import subprocess
import logging
import tempfile
import shutil
from typing import List, Dict, Optional

import numpy as np
import torch

logging.basicConfig(level=logging.INFO, format="%(asctime)s │ %(levelname)-7s │ %(message)s")
logger = logging.getLogger("eliz-aligner")

# ─── Configuration ─────────────────────────────────────────────

# Will be set on first use
_WHISPERX_AVAILABLE = None
_DEMUCS_AVAILABLE = None
_DEVICE = None


def _get_device() -> str:
    """Detect best available device: cuda > mps > cpu."""
    global _DEVICE
    if _DEVICE is None:
        if torch.cuda.is_available():
            _DEVICE = "cuda"
            logger.info(f"CUDA detected: {torch.cuda.get_device_name(0)}")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            _DEVICE = "mps"
            logger.info("MPS (Apple Silicon) detected")
        else:
            _DEVICE = "cpu"
            logger.info("No GPU detected, using CPU (slower but works)")
    return _DEVICE


def _check_whisperx():
    """Check if whisperx is installed."""
    global _WHISPERX_AVAILABLE
    if _WHISPERX_AVAILABLE is None:
        try:
            import whisperx
            _WHISPERX_AVAILABLE = True
        except ImportError:
            _WHISPERX_AVAILABLE = False
            logger.error(
                "WhisperX is not installed. Run: pip install whisperx\n"
                "Then install CUDA dependencies if needed."
            )
    return _WHISPERX_AVAILABLE


def _check_demucs():
    """Check if demucs is installed."""
    global _DEMUCS_AVAILABLE
    if _DEMUCS_AVAILABLE is None:
        try:
            import demucs
            _DEMUCS_AVAILABLE = True
        except ImportError:
            _DEMUCS_AVAILABLE = False
            logger.warning(
                "Demucs is not installed. Vocal separation will be skipped.\n"
                "Install with: pip install demucs"
            )
    return _DEMUCS_AVAILABLE

def load_audio_robust(audio_path: str, sample_rate: int = 16000) -> np.ndarray:
    """
    Load audio as a float32 mono numpy array at 16 kHz without requiring
    ffmpeg on PATH. Uses soundfile for WAV/FLAC/OGG, falls back to librosa
    (audioread/ffmpeg) for compressed formats like MP3/M4A.

    Returns:
        np.ndarray of shape (n_samples,) at sample_rate Hz.
    """
    import soundfile as sf
    import librosa

    audio_path = str(audio_path)

    # 1) soundfile: native WAV / FLAC / OGG / AIFF support
    try:
        data, sr = sf.read(audio_path, dtype="float32", always_2d=True)
        data = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    except Exception:
        # 2) librosa fallback (MP3/M4A) — needs ffmpeg/audioread available
        try:
            data, sr = librosa.load(audio_path, sr=None, mono=True)
            data = data.astype("float32")
        except Exception as e:
            raise RuntimeError(
                f"Could not decode audio: {audio_path}. Install FFmpeg "
                f"(winget install Gyan.FFmpeg) and restart, or use a WAV file. ({e})"
            ) from e

    # 3) Resample to the target rate if necessary
    if int(sr) != sample_rate:
        from scipy import signal as scipy_signal
        data = scipy_signal.resample_poly(data, sample_rate, int(sr)).astype("float32")

    if len(data) == 0:
        raise RuntimeError(f"Audio file decoded to an empty buffer: {audio_path}")

    return np.ascontiguousarray(data, dtype=np.float32)

# ─── Step 1: Vocal Separation ──────────────────────────────────

def separate_vocals(audio_path: str, 
                    output_dir: str = "temp",
                    model: str = "htdemucs") -> Optional[str]:
    """
    Use Demucs to isolate vocals from the full mix.
    
    Args:
        audio_path: Path to the audio file (mp3, wav, flac, etc.)
        output_dir: Directory for temp output
        model: Demucs model name (htdemucs, htdemucs_ft, htdemucs_6s, mdx_extra)
    
    Returns:
        Path to the isolated vocals.wav, or None if separation failed
    """
    if not _check_demucs():
        return None
    
    os.makedirs(output_dir, exist_ok=True)
    audio_path = os.path.abspath(audio_path)
    
    logger.info(f"🎤 Separating vocals from: {os.path.basename(audio_path)}")
    logger.info(f"   Model: {model}")
    
    try:
        # Use subprocess to avoid import issues with demucs
        cmd = [
            sys.executable, "-m", "demucs",
            "--two-stems", "vocals",
            "-n", model,
            "-o", os.path.abspath(output_dir),
            audio_path
        ]
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600  # 10 minute timeout
        )
        
        if result.returncode != 0:
            logger.error(f"Demucs failed:\n{result.stderr[-500:]}")
            return None
        
        # Demucs outputs to: output_dir/{model_name}/{filename}/vocals.wav
        base_name = os.path.splitext(os.path.basename(audio_path))[0]
        vocals_path = os.path.join(os.path.abspath(output_dir), model, base_name, "vocals.wav")
        
        if os.path.exists(vocals_path):
            logger.info(f"✅ Vocals extracted: {vocals_path}")
            return vocals_path
        else:
            logger.error(f"Vocals file not found at expected path: {vocals_path}")
            return None
            
    except subprocess.TimeoutExpired:
        logger.error("Demucs timed out after 10 minutes")
        return None
    except Exception as e:
        logger.error(f"Demucs error: {e}")
        return None


# ─── Step 2: WhisperX Forced Alignment ─────────────────────────

def transcribe_and_align(audio_path: str,
                         language: str = "es",
                         model_size: str = "large-v3",
                         compute_type: str = None) -> List[Dict]:
    """
    Run WhisperX: transcribe audio → forced alignment → word-level timestamps.
    
    Args:
        audio_path: Path to audio file (preferably vocals-only)
        language: Language code (es, en, ja, zh, ko, etc.)
        model_size: Whisper model size (large-v3, large-v2, medium, small)
        compute_type: float16 (GPU), int8 (CPU), or None (auto-detect)
    
    Returns:
        List of word dicts: [{"word": "Hola", "start": 0.5, "end": 0.8, "confidence": 0.9}]
    """
    if not _check_whisperx():
        raise RuntimeError("WhisperX is required but not installed.")
    
    import whisperx
    
    detected_device = _get_device()
    device = "cpu" if detected_device == "mps" else detected_device
    if detected_device == "mps":
        logger.info("WhisperX: using CPU because CTranslate2 does not support MPS")
    
    if compute_type is None:
        compute_type = "float16" if device == "cuda" else "int8"
    
    logger.info(f"🔊 Loading Whisper model: {model_size}")
    logger.info(f"   Device: {device}, Compute: {compute_type}, Language: {language}")
    
    # 1. Load Whisper model
    model = whisperx.load_model(
        model_size, 
        device, 
        compute_type=compute_type,
        language=language
    )
    
    # 2. Load audio (no ffmpeg required for WAV/FLAC/OGG)
    audio = load_audio_robust(audio_path)
    
    # 3. Transcribe with VAD
    logger.info("📝 Transcribing...")
    result = model.transcribe(
        audio,
        batch_size=16 if device == "cuda" else 4,
        language=language,
        chunk_size=30
    )
    
    logger.info(f"   Detected {len(result.get('segments', []))} segments")
    
    # 4. Forced alignment for word-level timestamps
    logger.info("🎯 Running forced alignment (wav2vec2)...")
    
    try:
        model_a, metadata = whisperx.load_align_model(
            language_code=language, 
            device=device
        )
        
        result = whisperx.align(
            result["segments"],
            model_a,
            metadata,
            audio,
            device,
            return_char_alignments=False
        )
    except Exception as e:
        logger.warning(f"Forced alignment model failed ({e}), using base timestamps")
        # Fallback: use Whisper's segment-level timestamps, split evenly
        return _fallback_word_split(result.get("segments", []))
    
    # 5. Extract word-level data
    all_words = []
    for segment in result.get("segments", []):
        words = segment.get("words", [])
        for w in words:
            word_text = w.get("word", "").strip()
            if word_text and "start" in w:
                all_words.append({
                    "word": word_text,
                    "start": w["start"],
                    "end": w.get("end", w["start"] + 0.3),
                    "confidence": w.get("score", w.get("confidence", 0.5))
                })
    
    logger.info(f"✅ Extracted {len(all_words)} words with timestamps")
    return all_words


def _fallback_word_split(segments: List[Dict]) -> List[Dict]:
    """Fallback: split segment text into words with even time distribution."""
    words = []
    for seg in segments:
        text = seg.get("text", "").strip()
        seg_words = text.split()
        if not seg_words:
            continue
        
        start = seg.get("start", 0)
        end = seg.get("end", start + len(seg_words) * 0.3)
        duration = end - start
        word_duration = duration / len(seg_words)
        
        for i, w in enumerate(seg_words):
            words.append({
                "word": w,
                "start": start + i * word_duration,
                "end": start + (i + 1) * word_duration,
                "confidence": 0.3  # Low confidence for fallback
            })
    return words


# ─── Step 3: Match WhisperX output to known lyrics ─────────────

def match_to_known_lyrics(whisper_words: List[Dict],
                          lyrics_text: str,
                          language: str = "es") -> List[Dict]:
    """
    Match WhisperX's transcribed words (which may have errors) to the
    user's known, correct lyrics using sequence alignment.

    KEY BEHAVIOUR: EVERY line and EVERY word of the ORIGINAL lyrics is
    preserved in the output — even words the transcriber missed. Words
    that were detected get the real timestamps; words that weren't get
    estimated (interpolated) timestamps and are flagged as low confidence.

    This means the exported LRC always shows the user's exact lyrics,
    never a degraded version of what Whisper happened to hear.

    Args:
        whisper_words: WhisperX output with timestamps
        lyrics_text: The correct lyrics, one line per sentence
        language: Language code for normalization

    Returns:
        Aligned lines — one per lyrics line, all original words present.
    """
    # Parse lyrics into lines and flatten to a word list
    lyrics_lines = [l.strip() for l in lyrics_text.strip().split("\n") if l.strip()]

    all_lyrics_words = []
    word_to_line = []  # flat word index -> line index

    for line_idx, line in enumerate(lyrics_lines):
        for word in line.split():
            all_lyrics_words.append(word)
            word_to_line.append(line_idx)

    if not all_lyrics_words:
        logger.warning("No lyrics words found in input")
        return []

    # Normalize both sequences for comparison
    whisper_norm = [_normalize_word(w["word"], language) for w in whisper_words]
    lyrics_norm = [_normalize_word(w, language) for w in all_lyrics_words]

    # Sequence alignment using difflib
    matcher = difflib.SequenceMatcher(None, whisper_norm, lyrics_norm)
    matching_blocks = matcher.get_matching_blocks()

    # Assign real timestamps to lyrics words that were detected
    assigned = {}  # lyrics word index -> word dict with timestamps
    for block in matching_blocks:
        if block.size == 0:
            continue
        for offset in range(block.size):
            w_idx = block.a + offset  # whisper index
            l_idx = block.b + offset  # lyrics index
            if w_idx < len(whisper_words) and l_idx < len(all_lyrics_words):
                assigned[l_idx] = {
                    "start": whisper_words[w_idx]["start"],
                    "end": whisper_words[w_idx]["end"],
                    "confidence": whisper_words[w_idx].get("confidence", 0.5),
                    "source": "matched",
                }

    matched_count = len(assigned)
    matched_indices = sorted(assigned.keys())

    # Interpolate timestamps for lyrics words the transcriber missed
    for idx in range(len(all_lyrics_words)):
        if idx in assigned:
            continue

        prev_idx = next((j for j in matched_indices if j < idx), None)
        next_idx = next((j for j in matched_indices if j > idx), None)

        if prev_idx is not None and next_idx is not None:
            prev = assigned[prev_idx]
            nxt = assigned[next_idx]
            total_gap = next_idx - prev_idx
            frac = (idx - prev_idx) / total_gap
            start = prev["end"] + (nxt["start"] - prev["end"]) * frac
            end = start + (nxt["start"] - prev["start"]) / total_gap
            assigned[idx] = {
                "start": round(start, 3),
                "end": round(end, 3),
                "confidence": 0.1,
                "source": "interpolated",
            }
        elif prev_idx is not None:
            prev = assigned[prev_idx]
            assigned[idx] = {
                "start": round(prev["end"] + 0.05, 3),
                "end": round(prev["end"] + 0.35, 3),
                "confidence": 0.05,
                "source": "interpolated",
            }
        elif next_idx is not None:
            nxt = assigned[next_idx]
            assigned[idx] = {
                "start": round(max(0.0, nxt["start"] - 0.35), 3),
                "end": round(max(0.0, nxt["start"] - 0.05), 3),
                "confidence": 0.05,
                "source": "interpolated",
            }
        else:
            # Nothing matched anywhere — fall back to even distribution
            assigned[idx] = {
                "start": round(idx * 0.3, 3),
                "end": round((idx + 1) * 0.3, 3),
                "confidence": 0.01,
                "source": "interpolated",
            }
            
    # ── Enforce monotonic (forward-flowing) timestamps ──────────
    # Repeated sections (a chorus sung twice) can confuse difflib and give
    # some words timestamps that jump backward. Walk the lyrics in order and
    # re-estimate any word that lands before its predecessor so the LRC
    # always flows forward in time.
    last_end = 0.0
    reordered = 0
    for idx in range(len(all_lyrics_words)):
        w = assigned[idx]
        if w["start"] < last_end - 1e-6:
            w["start"] = round(last_end + 0.02, 3)
            w["end"] = round(w["start"] + 0.3, 3)
            w["confidence"] = 0.05
            w["source"] = "reordered"
            reordered += 1
        last_end = max(last_end, w["end"])
    if reordered:
        logger.info(f"🔀 Reordered {reordered} out-of-order word(s) from repeated sections")

    # Build output: EVERY line, EVERY word, in original order
    result_lines = []
    current_line_idx = -1
    current_words = []

    for idx in range(len(all_lyrics_words)):
        line_idx = word_to_line[idx]
        word_data = assigned[idx]
        word_data["word"] = all_lyrics_words[idx]  # original lyrics text

        if line_idx != current_line_idx:
            if current_line_idx >= 0 and current_words:
                result_lines.append({
                    "line": lyrics_lines[current_line_idx],
                    "words": current_words,
                })
            current_line_idx = line_idx
            current_words = []

        current_words.append(word_data)

    if current_line_idx >= 0 and current_words:
        result_lines.append({
            "line": lyrics_lines[current_line_idx],
            "words": current_words,
        })

    logger.info(
        f"🔗 Detected {matched_count}/{len(all_lyrics_words)} words; "
        f"{len(result_lines)} lines (all lyrics lines preserved)"
    )
    return result_lines


def _normalize_word(word: str, language: str) -> str:
    """Normalize word for comparison: lowercase, strip punctuation, strip accents."""
    import unicodedata

    word = word.lower().strip()
    # Remove standalone punctuation
    word = word.strip(",.!?;:…¡¿—\"''()[]«»")
    # Normalize unicode (handle ñ vs n~, etc.)
    word = unicodedata.normalize("NFKD", word)
    # Remove combining diacritical marks so "café" == "cafe"
    word = "".join(c for c in word if not unicodedata.combining(c))
    return word

# ─── Step 4: Manual Tap + AI Word Refinement ───────────────────

def refine_with_line_timestamps(audio_path: str,
                                lyrics_text: str,
                                line_timestamps: List[float],
                                language: str = "es") -> List[Dict]:
    """
    Manual mode: user provides line-level timestamps (from tapping).

    Strategy: run ONE full-song transcription + forced alignment (the same
    proven path as auto mode), then assign the detected words to each tapped
    line window and match them to the known lyrics. This avoids the per-window
    VAD failures of the old approach.

    Args:
        audio_path: Path to audio file
        lyrics_text: Lyrics with one sentence per line
        line_timestamps: Start time (in seconds) for each line (from tapping)
        language: Language code

    Returns:
        Aligned lines with word-level timestamps
    """
    if not _check_whisperx():
        raise RuntimeError("WhisperX is required for word refinement.")

    lyrics_lines = [l.strip() for l in lyrics_text.strip().split("\n") if l.strip()]

    if len(line_timestamps) != len(lyrics_lines):
        logger.warning(
            f"Line count mismatch: {len(line_timestamps)} timestamps vs "
            f"{len(lyrics_lines)} lyrics lines. Using best effort."
        )

    # 1) One full-song transcription + forced alignment (reliable)
    logger.info("🔊 Running full-song transcription for word refinement...")
    whisper_words = transcribe_and_align(audio_path, language=language)

    if not whisper_words:
        logger.warning("Transcription found no words; using even distribution per line window.")

    # 2) Map detected words into each tapped line window
    result_lines = []
    total_words = 0
    min_confidence = 1.0

    for i, line in enumerate(lyrics_lines):
        line_words = line.split()
        if not line_words:
            continue

        # Line window from tapped timestamps
        if i < len(line_timestamps) and line_timestamps[i] is not None:
            line_start = line_timestamps[i]
        else:
            line_start = (line_timestamps[-1] + 1.0) if line_timestamps else 0.0

        if i + 1 < len(line_timestamps) and line_timestamps[i + 1] is not None:
            line_end = line_timestamps[i + 1]
        else:
            line_end = line_start + max(3.0, len(line_words) * 0.3)

        # Whisper words whose start falls inside this window
        window_words = [
            w for w in whisper_words
            if w["start"] >= line_start - 0.05 and w["start"] < line_end + 0.05
        ]

        words_data = _match_line_words(
            window_words, line_words,
            window_start=line_start, window_end=line_end,
        )

        total_words += len(words_data)
        min_confidence = min(min_confidence, min((w["confidence"] for w in words_data), default=0.1))

        result_lines.append({"line": line, "words": words_data})

    logger.info(f"✅ Refined {total_words} words across {len(result_lines)} lines")
    logger.info(f"   Min confidence: {min_confidence:.2f}")
    return result_lines


def _match_line_words(whisper_words: List[Dict],
                      line_words: List[str],
                      window_start: float = 0.0,
                      window_end: float = None) -> List[Dict]:
    """
    Match WhisperX words within a single line window to the known lyrics words.
    Uses the actual window bounds for fallback/interpolation, so even a line
    with no detected words gets sensible timing inside the tapped window.
    """
    if window_end is None or window_end <= window_start:
        window_end = window_start + max(3.0, len(line_words) * 0.3)

    # No words detected at all → even distribution across the real window
    if not whisper_words:
        dur = (window_end - window_start) / max(1, len(line_words))
        return [
            {"word": w, "start": round(window_start + i * dur, 3),
             "end": round(window_start + (i + 1) * dur, 3),
             "confidence": 0.1, "source": "even-distribution"}
            for i, w in enumerate(line_words)
        ]

    whisper_texts = [w["word"].lower().strip(",.!?;:") for w in whisper_words]
    lyrics_texts = [w.lower().strip(",.!?;:") for w in line_words]

    matcher = difflib.SequenceMatcher(None, whisper_texts, lyrics_texts)
    blocks = matcher.get_matching_blocks()

    result = []
    lyrics_used = set()

    for block in blocks:
        if block.size == 0:
            continue
        for offset in range(block.size):
            w_idx = block.a + offset
            l_idx = block.b + offset
            if w_idx < len(whisper_words) and l_idx < len(line_words):
                result.append({
                    "word": line_words[l_idx],
                    "start": whisper_words[w_idx]["start"],
                    "end": whisper_words[w_idx]["end"],
                    "confidence": whisper_words[w_idx].get("confidence", 0.5),
                    "source": "matched",
                })
                lyrics_used.add(l_idx)

    anchors = sorted(lyrics_used)

    # Interpolate unmatched words within the window using real anchors
    for i, word in enumerate(line_words):
        if i in lyrics_used:
            continue

        prev = max((j for j in anchors if j < i), default=None)
        nxt = min((j for j in anchors if j > i), default=None)

        if prev is not None and nxt is not None:
            p = next(r for r in result if r["word"] == line_words[prev])
            n = next(r for r in result if r["word"] == line_words[nxt])
            frac = (i - prev) / (nxt - prev)
            start = p["end"] + (n["start"] - p["end"]) * frac
            end = p["end"] + (n["start"] - p["end"]) * (frac + 1 / max(1, nxt - prev))
            result.append({"word": word, "start": round(start, 3), "end": round(end, 3),
                           "confidence": 0.15, "source": "interpolated"})
        elif prev is not None:
            p = next(r for r in result if r["word"] == line_words[prev])
            start = p["end"] + 0.05
            result.append({"word": word, "start": round(start, 3), "end": round(start + 0.3, 3),
                           "confidence": 0.1, "source": "extrapolated"})
        elif nxt is not None:
            n = next(r for r in result if r["word"] == line_words[nxt])
            start = max(window_start, n["start"] - 0.35)
            result.append({"word": word, "start": round(start, 3), "end": round(n["start"] - 0.05, 3),
                           "confidence": 0.1, "source": "extrapolated"})
        else:
            # No anchors at all → even distribution inside the window
            dur = (window_end - window_start) / max(1, len(line_words))
            start = window_start + i * dur
            result.append({"word": word, "start": round(start, 3), "end": round(start + dur, 3),
                           "confidence": 0.05, "source": "even-distribution"})

    result.sort(key=lambda x: x["start"])
    return result


# ─── Full Pipeline ─────────────────────────────────────────────

def full_auto_align(audio_path: str,
                    lyrics_text: str,
                    language: str = "es",
                    use_vocal_separation: bool = True,
                    demucs_model: str = "htdemucs") -> List[Dict]:
    """
    Run the complete automatic alignment pipeline:
    Demucs → WhisperX → Match → Aligned LRC data
    
    Args:
        audio_path: Path to the audio file
        lyrics_text: Lyrics text, one line per sentence
        language: 'es' for Spanish, 'en' for English, etc.
        use_vocal_separation: Run Demucs to isolate vocals first
        demucs_model: Demucs model to use
    
    Returns:
        Aligned lines for LRC generation
    """
    logger.info("=" * 60)
    logger.info("🎵 ELIZ'S LRC GENERATOR — Full Auto Alignment")
    logger.info(f"   File: {os.path.basename(audio_path)}")
    logger.info(f"   Language: {language}")
    logger.info(f"   Vocal separation: {use_vocal_separation}")
    logger.info("=" * 60)
    
    # Step 1: Vocal separation (optional)
    align_audio = audio_path
    temp_dir = None
    
    if use_vocal_separation:
        temp_dir = tempfile.mkdtemp(prefix="eliz_lrc_")
        vocals = separate_vocals(audio_path, output_dir=temp_dir, model=demucs_model)
        if vocals:
            align_audio = vocals
        else:
            logger.warning("Vocal separation failed, using original audio")
    
    try:
        # Step 2: WhisperX forced alignment
        whisper_words = transcribe_and_align(align_audio, language=language)
        
        if not whisper_words:
            raise RuntimeError("No words detected by WhisperX")
        
        # Step 3: Match to known lyrics
        aligned = match_to_known_lyrics(whisper_words, lyrics_text, language)
        
        # Step 4: Calculate quality metrics
        matched_count = sum(
            1 for line in aligned
            for w in line["words"]
            if w.get("source") == "matched"
        )
        total_count = sum(len(line["words"]) for line in aligned)
        
        if total_count > 0:
            match_rate = matched_count / total_count * 100
            logger.info(f"📊 Match rate: {matched_count}/{total_count} words ({match_rate:.1f}%)")
        
        logger.info("✅ Alignment complete!")
        return aligned
        
    finally:
        # Cleanup temp dir
        if temp_dir and os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
            except Exception:
                pass


# ─── Utility ───────────────────────────────────────────────────

def get_alignment_stats(aligned_lines: List[Dict]) -> Dict:
    """Get statistics about the alignment quality."""
    total_words = 0
    matched = 0
    interpolated = 0
    fallback = 0
    total_confidence = 0.0
    first_start = None
    last_end = None

    for line in aligned_lines:
        for w in line.get("words", []):
            total_words += 1
            source = w.get("source", "unknown")
            if source == "matched":
                matched += 1
            elif source in ("interpolated", "extrapolated"):
                interpolated += 1
            else:
                fallback += 1
            total_confidence += w.get("confidence", 0)

            s = w.get("start")
            e = w.get("end")
            if s is not None:
                first_start = s if first_start is None else min(first_start, s)
            if e is not None:
                last_end = e if last_end is None else max(last_end, e)

    duration = 0.0
    if first_start is not None and last_end is not None:
        duration = max(0.0, last_end - first_start)

    return {
        "total_words": total_words,
        "matched": matched,
        "interpolated": interpolated,
        "fallback": fallback,
        "match_rate": round(matched / total_words * 100, 1) if total_words > 0 else 0,
        "avg_confidence": round(total_confidence / total_words, 3) if total_words > 0 else 0,
        "total_lines": len(aligned_lines),
        "duration_seconds": round(duration, 1),
    }