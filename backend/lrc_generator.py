"""
Eliz's LRC Generator — LRC Format Engine
=========================================
Generates Standard LRC and Enhanced LRC (word-level) files
from aligned lyrics data.

Enhanced LRC format (A2 extension):
  [00:12.34]<00:12.34>Word1 <00:13.00>Word2 <00:13.50>Word3

Standard LRC format:
  [00:12.34]Word1 Word2 Word3
"""

import re
from typing import List, Dict, Optional, Tuple


def format_timestamp(seconds: float, enhanced: bool = False) -> str:
    """
    Convert seconds to LRC timestamp format.
    
    Standard:  [MM:SS.xx]  (centiseconds)
    Enhanced: <MM:SS.xxx> (milliseconds, for word-level)
    """
    minutes = int(seconds // 60)
    secs = seconds % 60
    
    if enhanced:
        # Millisecond precision for word-level: MM:SS.xxx
        return f"{minutes:02d}:{secs:06.3f}"
    else:
        # Centisecond precision for line-level: MM:SS.xx
        return f"{minutes:02d}:{secs:05.2f}"


def parse_timestamp(ts: str) -> float:
    """Parse LRC timestamp [MM:SS.xx] or <MM:SS.xxx> to seconds."""
    ts = ts.strip("[]<>")
    parts = ts.replace(",", ".").split(":")
    if len(parts) == 2:
        minutes = int(parts[0])
        seconds = float(parts[1])
        return minutes * 60 + seconds
    return 0.0

def _srt_ts(seconds: float) -> str:
    """Format seconds as an SRT timestamp: HH:MM:SS,mmm"""
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms == 1000:
        ms = 0
        s += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def generate_standard_lrc(aligned_lines: List[Dict]) -> str:
    """
    Generate Standard LRC with line-level timestamps only.
    
    Args:
        aligned_lines: List of {"line": str, "words": [{"word": str, "start": float, "end": float}]}
    
    Returns:
        String in Standard LRC format
    """
    output = []
    
    for line_data in aligned_lines:
        words = line_data.get("words", [])
        if not words:
            continue
        
        line_start = words[0]["start"]
        line_text = " ".join(w["word"] for w in words)
        
        ts = format_timestamp(line_start)
        output.append(f"[{ts}]{line_text}")
    
    return "\n".join(output)


def generate_enhanced_lrc(aligned_lines: List[Dict], 
                          include_line_tags: bool = True) -> str:
    """
    Generate Enhanced LRC with word-level timestamps.
    
    Format: [line_ts]<word1_ts>Word1 <word2_ts>Word2 <word3_ts>Word3
    
    Args:
        aligned_lines: List of aligned line data
        include_line_tags: Include [MM:SS.xx] line timestamps (for compatibility)
    
    Returns:
        String in Enhanced LRC format
    """
    output = []
    
    for line_data in aligned_lines:
        words = line_data.get("words", [])
        if not words:
            continue
        
        parts = []
        
        # Optional line-level timestamp in square brackets
        if include_line_tags and words:
            line_ts = format_timestamp(words[0]["start"], enhanced=False)
            parts.append(f"[{line_ts}]")
        
        # Word-level timestamps in angle brackets
        for w in words:
            w_ts = format_timestamp(w["start"], enhanced=True)
            # Don't add space before punctuation
            word_text = w["word"]
            if word_text in ",.!?;:…¡¿—\"\"''" or word_text.startswith("'"):
                parts.append(f"<{w_ts}>{word_text}")
            else:
                # Add space before this word (except first word)
                prefix = "" if len(parts) <= (1 if include_line_tags else 0) else " "
                parts.append(f"{prefix}<{w_ts}>{word_text}")
        
        output.append("".join(parts))
    
    return "\n".join(output)


def generate_srt(aligned_lines: List[Dict]) -> str:
    """
    Generate SRT subtitle format from aligned lyrics.
    Useful for video editors like Premiere.
    
    Args:
        aligned_lines: List of aligned line data
    
    Returns:
        String in SRT format
    """
    output = []
    
    for i, line_data in enumerate(aligned_lines, 1):
        words = line_data.get("words", [])
        if not words:
            continue
        
        start_sec = words[0]["start"]
        end_sec = words[-1]["end"]
        line_text = " ".join(w["word"] for w in words)
        
        # SRT timestamp format: HH:MM:SS,mmm
        def srt_ts(s):
            h = int(s // 3600)
            m = int((s % 3600) // 60)
            sec = s % 60
            return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")
        
        output.append(f"{i}")
        output.append(f"{srt_ts(start_sec)} --> {srt_ts(end_sec)}")
        output.append(line_text)
        output.append("")  # Blank line between entries
    
    return "\n".join(output)

def generate_enhanced_srt(aligned_lines: List[Dict]) -> str:
    """
    Generate word-by-word SRT subtitles (Enhanced SRT).
    Each word becomes its own caption with its own timeline, so video
    editors (Premiere, CapCut, DaVinci) can import karaoke-style,
    word-by-word captions.

    SRT format (comma = SRT standard for milliseconds):
        1
        00:00:15,021 --> 00:00:15,260
        Otro

    Args:
        aligned_lines: List of aligned line data

    Returns:
        String in SRT format (one caption per word)
    """
    output = []
    caption_index = 1

    for line_data in aligned_lines:
        for w in line_data.get("words", []):
            word_text = w.get("word", "").strip()
            if not word_text:
                continue
            start = w.get("start", 0)
            end = w.get("end", start + 0.3)
            if end <= start:
                end = start + 0.3

            output.append(str(caption_index))
            output.append(f"{_srt_ts(start)} --> {_srt_ts(end)}")
            output.append(word_text)
            output.append("")
            caption_index += 1

    return "\n".join(output)

def generate_json(aligned_lines: List[Dict]) -> str:
    """
    Generate JSON representation of aligned lyrics.
    Useful for programmatic use or further processing.
    """
    import json
    return json.dumps(aligned_lines, indent=2, ensure_ascii=False)


def parse_lrc_file(lrc_text: str) -> List[Dict]:
    """
    Parse an existing LRC file (Standard or Enhanced) back into
    aligned line data structure for editing.
    
    Args:
        lrc_text: Raw LRC file content
    
    Returns:
        List of aligned line dicts
    """
    lines = []
    
    for raw_line in lrc_text.strip().split("\n"):
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        
        # Skip metadata tags like [ti:Title], [ar:Artist], etc.
        if raw_line.startswith("[") and ":" in raw_line[:10]:
            tag_match = re.match(r"^\[([a-z]+):(.*)\]$", raw_line, re.IGNORECASE)
            if tag_match:
                continue  # Skip metadata tags
        
        # Extract line-level timestamp
        line_ts_match = re.match(r"^\[(\d{2}:\d{2}\.\d{2,3})\](.*)", raw_line)
        if not line_ts_match:
            continue
        
        line_ts = parse_timestamp(line_ts_match.group(1))
        rest = line_ts_match.group(2)
        
        # Check for word-level timestamps
        word_matches = re.findall(r"<(\d{2}:\d{2}\.\d{2,3})>([^<\[]*)", rest)
        
        if word_matches:
            # Enhanced LRC: extract word-level timestamps
            words = []
            for w_ts_str, w_text in word_matches:
                w_text = w_text.strip()
                if w_text:
                    words.append({
                        "word": w_text,
                        "start": parse_timestamp(w_ts_str),
                        "end": None  # We don't have end times in LRC format
                    })
            # Fill in end times
            for i, w in enumerate(words):
                if i + 1 < len(words):
                    w["end"] = words[i + 1]["start"]
                else:
                    w["end"] = w["start"] + 1.0  # rough estimate
            
            if words:
                lines.append({
                    "line": " ".join(w["word"] for w in words),
                    "words": words
                })
        else:
            # Standard LRC: just line text
            line_text = rest.strip()
            if line_text:
                lines.append({
                    "line": line_text,
                    "words": []  # No word-level data
                })
    
    return lines


def offset_timestamps(aligned_lines: List[Dict], offset_seconds: float) -> List[Dict]:
    """
    Shift all timestamps by a given offset (can be negative).
    Useful for correcting sync drift.
    
    Args:
        aligned_lines: Aligned line data
        offset_seconds: Seconds to add (negative to shift earlier)
    
    Returns:
        New aligned data with shifted timestamps
    """
    import copy
    result = copy.deepcopy(aligned_lines)
    
    for line_data in result:
        for word in line_data.get("words", []):
            if "start" in word and word["start"] is not None:
                word["start"] = max(0, word["start"] + offset_seconds)
            if "end" in word and word["end"] is not None:
                word["end"] = max(0, word["end"] + offset_seconds)
    
    return result


# ─── Export helpers ────────────────────────────────────────────

EXPORT_FORMATS = {
    "lrc": ("Standard LRC", generate_standard_lrc, ".lrc"),
    "enhanced": ("Enhanced LRC (word-level)", generate_enhanced_lrc, ".lrc"),
    "srt": ("SRT Subtitles (line-level)", generate_srt, ".srt"),
    "enhanced_srt": ("Enhanced SRT (word-by-word)", generate_enhanced_srt, ".srt"),
    "json": ("JSON (raw data)", generate_json, ".json"),
}


def export_aligned(aligned_lines: List[Dict], format_type: str = "enhanced") -> str:
    """
    Export aligned lyrics in the requested format.
    
    Args:
        aligned_lines: Aligned line data
        format_type: "lrc", "enhanced", "srt", or "json"
    
    Returns:
        Formatted string
    """
    if format_type not in EXPORT_FORMATS:
        raise ValueError(f"Unknown format: {format_type}. Choose from: {list(EXPORT_FORMATS.keys())}")
    
    _, generator, _ = EXPORT_FORMATS[format_type]
    return generator(aligned_lines)

# ─── Normilize Karaoke Ends ────────────────────────────────────────────

def normalize_karaoke_ends(aligned_lines: List[Dict]) -> List[Dict]:
    """
    Make word highlighting contiguous (karaoke style): each word's end
    becomes the start of the next word (or, for the final word of a line,
    the first word of the next line). The very last word keeps a small
    minimum duration.
    """
    import copy
    lines = copy.deepcopy(aligned_lines)
    for li, line in enumerate(lines):
        words = line.get("words", [])
        for wi, w in enumerate(words):
            start = w.get("start", 0)
            if wi + 1 < len(words):
                end = words[wi + 1]["start"]
            elif li + 1 < len(lines) and lines[li + 1].get("words"):
                end = lines[li + 1]["words"][0]["start"]
            else:
                end = start + 0.3
            w["end"] = max(start + 0.01, end)
    return lines