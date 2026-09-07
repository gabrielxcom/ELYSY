"""
Eliz's LRC Generator — Flask API Server
========================================
Serves the frontend and provides REST endpoints for the AI pipeline.

Endpoints:
  GET  /                          — Serve the web app
  POST /api/upload-audio          — Upload audio file
  POST /api/align                 — Full auto alignment (Demucs → WhisperX → LRC)
  POST /api/refine-words          — Manual line timestamps → word-level refinement
  POST /api/offset                — Shift all timestamps
  POST /api/reset                 — Clear the session (deletes only temp uploads; never saved projects)
  GET  /api/audio/<filename>      — Serve audio file for playback
  GET  /api/export/<format>       — Export aligned data (lrc, enhanced, srt, enhanced_srt, json)
  GET  /api/stats                 — Get alignment quality statistics
  GET  /api/status                — Get current session status
  POST /api/sync-alignment        — Save edited aligned data (so exports match edits)
  POST /api/project/save          — Save current project (audio + lyrics + alignment)
  GET  /api/projects              — List saved projects
  POST /api/project/load          — Load a saved project
  POST /api/import-lrc            — Import an existing .lrc file (standard or enhanced)
  GET  /api/health                — Health check (device, version, timestamp)
"""

import os
import sys
import json
import uuid
import shutil
import tempfile
import logging
import warnings
import socket
import threading
import time
import webbrowser
from datetime import datetime

from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS

# ─── Suppress harmless third-party warnings ──────────────────
# pyannote/torchcodec warning: torchcodec falls back to torchaudio (works fine)
warnings.filterwarnings("ignore", message="torchcodec is not installed correctly")
# expandable_segments is a CUDA allocator hint — not supported on all platforms
warnings.filterwarnings("ignore", message="expandable_segments not supported")
# pyannote TF32 reproducibility warning — informational only
warnings.filterwarnings("ignore", category=UserWarning, module="pyannote")

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lrc_generator import (
    generate_standard_lrc,
    generate_enhanced_lrc,
    export_aligned,
    offset_timestamps,
    parse_lrc_file,
    normalize_karaoke_ends,
    EXPORT_FORMATS,
)
from aligner import (
    full_auto_align,
    refine_with_line_timestamps,
    get_alignment_stats,
    _get_device,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s │ %(levelname)-7s │ %(message)s")
logger = logging.getLogger("eliz-server")

# ─── App Setup ─────────────────────────────────────────────────

app = Flask(
    __name__,
    static_folder="../frontend",
    static_url_path=""
)
CORS(app)

# Configuration
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024  # 100 MB max upload
app.config["UPLOAD_FOLDER"] = os.path.join(tempfile.gettempdir(), "eliz_lrc_uploads")
app.config["AUDIO_CACHE"] = {}  # filename → audio_path

# Session state (in-memory; for production, use a proper session store)
_session = {
    "audio_path": None,
    "audio_filename": None,
    "lyrics_text": None,
    "aligned_data": None,
    "language": "es",
}

os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

# Projects are stored as self-contained folders: <audio> + project.json
PROJECTS_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "projects")
os.makedirs(PROJECTS_FOLDER, exist_ok=True)

# Filename suffix per export format, so multiple exports of the same song
# are easily recognizable
FILENAME_SUFFIXES = {
    "lrc": "standard-LRC",
    "enhanced": "enhanced-LRC",
    "srt": "premiere-SRT",
    "enhanced_srt": "enhanced-SRT",
    "json": "JSON",
}

# ─── Frontend Routes ───────────────────────────────────────────

@app.route("/")
def index():
    """Serve the main application."""
    return send_from_directory(app.static_folder, "index.html")


@app.route("/css/<path:filename>")
def serve_css(filename):
    return send_from_directory(os.path.join(app.static_folder, "css"), filename)


@app.route("/js/<path:filename>")
def serve_js(filename):
    return send_from_directory(os.path.join(app.static_folder, "js"), filename)

# ─── API: Project Save / Load ─────────────────────────────────

@app.route("/api/projects", methods=["GET"])
def list_projects():
    """List saved projects."""
    projects = []
    if os.path.isdir(PROJECTS_FOLDER):
        for entry in sorted(os.listdir(PROJECTS_FOLDER)):
            folder = os.path.join(PROJECTS_FOLDER, entry)
            pjson = os.path.join(folder, "project.json")
            if not os.path.isdir(folder) or not os.path.exists(pjson):
                continue
            try:
                with open(pjson, "r", encoding="utf-8") as f:
                    data = json.load(f)
                has_audio = any(
                    fn.lower().startswith("audio.")
                    for fn in os.listdir(folder)
                ) if os.path.isdir(folder) else False
                projects.append({
                    "name": data.get("name", entry),
                    "folder": entry,
                    "updated": data.get("updated"),
                    "created": data.get("created"),
                    "line_count": len(data.get("aligned_data", [])),
                    "word_count": sum(len(l.get("words", [])) for l in data.get("aligned_data", [])),
                    "has_audio": has_audio,
                    "audio_filename": data.get("audio_filename", ""),
                    "language": data.get("language", "es"),
                })
            except Exception as e:
                logger.warning(f"Could not read project {entry}: {e}")
    return jsonify({"projects": projects})


@app.route("/api/project/save", methods=["POST"])
def save_project():
    """
    Save the current project (audio + lyrics + alignment) to a folder.

    Body options:
      name   (str)  — display name for the project
      folder (str)  — optional explicit folder to save into. When provided,
                      the project is written into THAT folder (in-place update)
                      while keeping the display name. Omit to save as a new
                      project folder derived from `name`.
    """
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    folder_override = (data.get("folder") or "").strip()
    if not name:
        name = os.path.splitext(_session.get("audio_filename", "proyecto"))[0]
    lyrics = data.get("lyrics") or _session.get("lyrics_text") or ""
    language = data.get("language") or _session.get("language", "es")
    aligned = data.get("aligned_data") or _session.get("aligned_data") or []

    if not _session.get("audio_path") or not os.path.exists(_session["audio_path"]):
        return jsonify({"error": "No audio loaded to save with the project"}), 400

    # In-place update targets an existing folder; otherwise derive from name
    if folder_override:
        folder_name = _sanitize_project_name(folder_override)
    else:
        folder_name = _sanitize_project_name(name)
    folder = os.path.join(PROJECTS_FOLDER, folder_name)
    os.makedirs(folder, exist_ok=True)

    # Copy the audio into the project folder — skip if it's already there
    # (avoids SameFileError when saving a loaded project in place)
    ext = os.path.splitext(_session["audio_path"])[1].lower() or ".mp3"
    audio_dest = os.path.join(folder, f"audio{ext}")
    src_abs = os.path.abspath(_session["audio_path"])
    dest_abs = os.path.abspath(audio_dest)
    if os.path.normcase(src_abs) != os.path.normcase(dest_abs):
        try:
            shutil.copyfile(src_abs, dest_abs)
        except Exception as e:
            return jsonify({"error": f"Could not save audio: {e}"}), 500

    now = datetime.now().isoformat(timespec="seconds")
    project_data = {
        "name": name,
        "folder": folder_name,
        "language": language,
        "lyrics": lyrics,
        "audio_filename": _session.get("audio_filename", ""),
        "aligned_data": aligned,
        "created": _session.get("project_created") or now,
        "updated": now,
        "version": 2,
    }
    try:
        with open(os.path.join(folder, "project.json"), "w", encoding="utf-8") as f:
            json.dump(project_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return jsonify({"error": f"Could not write project file: {e}"}), 500

    _session["project_created"] = project_data["created"]
    _session["project_name"] = folder_name

    logger.info(f"💾 Project saved: {name} ({len(aligned)} lines) -> {folder_name}")
    return jsonify({"success": True, "name": name, "folder": folder_name})


@app.route("/api/project/load", methods=["POST"])
def load_project():
    """Load a saved project and restore the session (audio + lyrics + alignment)."""
    data = request.get_json(silent=True) or {}
    folder_name = data.get("name") or data.get("folder") or ""
    if not folder_name:
        return jsonify({"error": "No project name provided"}), 400

    folder_name = _sanitize_project_name(folder_name)
    folder = os.path.join(PROJECTS_FOLDER, folder_name)
    pjson = os.path.join(folder, "project.json")
    if not os.path.exists(pjson):
        return jsonify({"error": f"Project not found: {folder_name}"}), 404

    try:
        with open(pjson, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return jsonify({"error": f"Could not read project: {e}"}), 500

    # Locate the project's audio file
    audio_path = None
    if os.path.isdir(folder):
        for fn in os.listdir(folder):
            if fn.lower().startswith("audio."):
                audio_path = os.path.join(folder, fn)
                break
    if not audio_path or not os.path.exists(audio_path):
        return jsonify({"error": "Project audio file is missing"}), 404

    # Restore the session
    _session["audio_path"] = audio_path
    _session["audio_filename"] = data.get("audio_filename") or os.path.basename(audio_path)
    _session["lyrics_text"] = data.get("lyrics", "")
    _session["aligned_data"] = data.get("aligned_data", [])
    _session["language"] = data.get("language", "es")
    _session["project_name"] = folder_name
    _session["project_created"] = data.get("created")

    logger.info(f"📂 Project loaded: {data.get('name')} ({len(_session['aligned_data'])} lines)")

    return jsonify({
        "success": True,
        "name": data.get("name", folder_name),
        "folder": folder_name,
        "language": data.get("language", "es"),
        "lyrics": data.get("lyrics", ""),
        "audio_filename": _session["audio_filename"],
        "aligned_data": data.get("aligned_data", []),
        "has_alignment": bool(data.get("aligned_data")),
    })

# ─── API: Import LRC ──────────────────────────────────────────

@app.route("/api/import-lrc", methods=["POST"])
def import_lrc():
    """
    Import an existing .lrc file (Standard or Enhanced) into the session.
    Body: { "lrc_content": "..." } — the raw text of the .lrc file.
    Returns the parsed aligned data (words + timestamps) and a
    reconstructed lyrics text.
    """
    data = request.get_json(silent=True) or {}
    lrc_content = (data.get("lrc_content") or "").strip()

    if not lrc_content:
        return jsonify({"error": "No LRC content provided"}), 400

    try:
        aligned_lines = parse_lrc_file(lrc_content)
    except Exception as e:
        logger.error(f"Could not parse LRC: {e}")
        return jsonify({"error": f"Could not parse LRC file: {e}"}), 400

    if not aligned_lines:
        return jsonify({
            "error": "No timestamped lines found in the LRC file. It may be empty or not contain valid [MM:SS.xx] timestamps."
        }), 400

    # Store in session so exports reflect the imported data
    _session["aligned_data"] = aligned_lines

    # Reconstruct a lyrics text (one line per aligned line)
    lyrics_lines = [ln.get("line", " ".join(w["word"] for w in ln.get("words", []))) for ln in aligned_lines]
    lyrics_text = "\n".join(lyrics_lines)
    _session["lyrics_text"] = lyrics_text

    stats = get_alignment_stats(aligned_lines)

    logger.info(f"📥 Imported LRC: {len(aligned_lines)} lines, {stats['total_words']} words")

    return jsonify({
        "success": True,
        "aligned_lines": aligned_lines,
        "lyrics": lyrics_text,
        "stats": stats,
        "has_word_timestamps": bool(stats["total_words"] > len(aligned_lines)),
    })

# ─── API: Upload Audio ─────────────────────────────────────────

@app.route("/api/upload-audio", methods=["POST"])
def upload_audio():
    """
    Upload an audio file for processing.
    Accepts: multipart/form-data with 'audio' field.
    Returns: { "filename": "...", "size": 12345, "duration_hint": "~3:45" }
    """
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    file = request.files["audio"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    # Generate unique filename to avoid collisions
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma"):
        return jsonify({"error": f"Unsupported format: {ext}. Use MP3, WAV, FLAC, OGG, or M4A."}), 400

    safe_name = f"{uuid.uuid4().hex}{ext}"
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], safe_name)
    file.save(save_path)

    # Clean up previous audio (only temp uploads; never saved project files)
    _safe_remove_audio(_session.get("audio_path"))

    _session["audio_path"] = save_path
    _session["audio_filename"] = file.filename
    _session["aligned_data"] = None  # Reset alignment

    # Try to get duration
    duration = _get_audio_duration(save_path)

    logger.info(f"📁 Uploaded: {file.filename} ({os.path.getsize(save_path) / 1024 / 1024:.1f} MB)")

    return jsonify({
        "success": True,
        "filename": file.filename,
        "safe_filename": safe_name,
        "size_bytes": os.path.getsize(save_path),
        "duration_seconds": duration,
        "duration_display": _format_duration(duration) if duration else "unknown",
    })


# ─── API: Full Auto Alignment ──────────────────────────────────

@app.route("/api/align", methods=["POST"])
def align():
    """
    Run the full automatic alignment pipeline.

    Request body (JSON):
      {
        "lyrics": "Line 1\nLine 2\nLine 3",
        "language": "es" | "en",
        "use_vocal_separation": true | false,
        "demucs_model": "htdemucs" | "mdx_extra"
      }

    Returns aligned data + quality stats.
    """
    if not _session["audio_path"] or not os.path.exists(_session["audio_path"]):
        return jsonify({"error": "No audio file uploaded. Upload audio first."}), 400

    data = request.get_json(silent=True) or {}
    lyrics = data.get("lyrics", "").strip()
    language = data.get("language", "es")
    use_vocal_sep = data.get("use_vocal_separation", True)
    demucs_model = data.get("demucs_model", "htdemucs")

    if not lyrics:
        return jsonify({"error": "No lyrics provided"}), 400

    if language not in ("es", "en", "ja", "zh", "ko", "ru", "fr", "de", "it", "pt"):
        return jsonify({"error": f"Language '{language}' may not be fully supported. Use es, en, ja, zh, ko, ru, fr, de, it, or pt."}), 400

    _session["lyrics_text"] = lyrics
    _session["language"] = language

    device = _get_device()

    logger.info(f"🚀 Starting full auto alignment | Language: {language} | Device: {device}")

    try:
        aligned = full_auto_align(
            audio_path=_session["audio_path"],
            lyrics_text=lyrics,
            language=language,
            use_vocal_separation=use_vocal_sep,
            demucs_model=demucs_model,
        )

        aligned = normalize_karaoke_ends(aligned)

        _session["aligned_data"] = aligned
        stats = get_alignment_stats(aligned)

        # Generate preview LRC
        enhanced_lrc = generate_enhanced_lrc(aligned)
        standard_lrc = generate_standard_lrc(aligned)

        logger.info(f"✅ Alignment complete: {stats['total_words']} words, {stats['match_rate']:.1f}% match rate")

        return jsonify({
            "success": True,
            "aligned_lines": aligned,
            "stats": stats,
            "preview_enhanced_lrc": enhanced_lrc,
            "preview_standard_lrc": standard_lrc,
            "device_used": device,
        })

    except Exception as e:
        logger.error(f"Alignment failed: {e}", exc_info=True)
        return jsonify({
            "error": str(e),
            "hint": "Try disabling vocal separation or check that the audio and lyrics match."
        }), 500


# ─── API: Manual Tap → Word Refinement ────────────────────────

@app.route("/api/refine-words", methods=["POST"])
def refine_words():
    """
    User tapped line boundaries manually. AI refines to word-level.

    Request body (JSON):
      {
        "lyrics": "Line 1\nLine 2",
        "line_timestamps": [1.23, 4.56, 8.90],
        "language": "es"
      }

    Returns word-level aligned data.
    """
    if not _session["audio_path"] or not os.path.exists(_session["audio_path"]):
        return jsonify({"error": "No audio file uploaded."}), 400

    data = request.get_json(silent=True) or {}
    lyrics = data.get("lyrics", "").strip()
    line_timestamps = data.get("line_timestamps", [])
    language = data.get("language", _session.get("language", "es"))

    if not lyrics:
        return jsonify({"error": "No lyrics provided"}), 400
    if not line_timestamps:
        return jsonify({"error": "No line timestamps provided"}), 400

    _session["lyrics_text"] = lyrics

    logger.info(f"🎯 Refining words from {len(line_timestamps)} line timestamps")

    try:
        aligned = refine_with_line_timestamps(
            audio_path=_session["audio_path"],
            lyrics_text=lyrics,
            line_timestamps=line_timestamps,
            language=language,
        )

        aligned = normalize_karaoke_ends(aligned)

        _session["aligned_data"] = aligned
        stats = get_alignment_stats(aligned)

        enhanced_lrc = generate_enhanced_lrc(aligned)

        return jsonify({
            "success": True,
            "aligned_lines": aligned,
            "stats": stats,
            "preview_enhanced_lrc": enhanced_lrc,
        })

    except Exception as e:
        logger.error(f"Refinement failed: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


# ─── API: Offset Timestamps ────────────────────────────────────

@app.route("/api/offset", methods=["POST"])
def offset():
    """
    Shift all timestamps by a given offset (in seconds).
    Positive = later, negative = earlier.

    Request: { "offset_seconds": 0.5 }
    """
    if not _session["aligned_data"]:
        return jsonify({"error": "No alignment data to offset. Run alignment first."}), 400

    data = request.get_json(silent=True) or {}
    offset_sec = data.get("offset_seconds", 0)

    _session["aligned_data"] = offset_timestamps(_session["aligned_data"], offset_sec)

    enhanced = generate_enhanced_lrc(_session["aligned_data"])

    return jsonify({
        "success": True,
        "offset_applied": offset_sec,
        "aligned_lines": _session["aligned_data"],
        "preview_enhanced_lrc": enhanced,
    })


# ─── API: Export ───────────────────────────────────────────────

@app.route("/api/export/<format_type>", methods=["GET"])
def export_format(format_type):
    """
    Export aligned lyrics in the requested format.

    Supported formats:
      - lrc       → Standard LRC (line-level timestamps)
      - enhanced  → Enhanced LRC (word-level timestamps)
      - srt       → SRT subtitle format
      - json      → Raw JSON data
    """
    if not _session["aligned_data"]:
        return jsonify({"error": "No alignment data. Run alignment first."}), 400

    if format_type not in EXPORT_FORMATS:
        return jsonify({
            "error": f"Unknown format: {format_type}",
            "available": list(EXPORT_FORMATS.keys())
        }), 400

    try:
        content = export_aligned(_session["aligned_data"], format_type)

        # Derive filename from original audio + format suffix for recognition
        base_name = os.path.splitext(_session.get("audio_filename", "lyrics"))[0]
        _, _, ext = EXPORT_FORMATS[format_type]
        suffix = FILENAME_SUFFIXES.get(format_type, format_type)
        download_name = f"{base_name}_{suffix}{ext}"

        # Write to temp file and send
        tmp_path = os.path.join(app.config["UPLOAD_FOLDER"], download_name)
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(content)

        return send_file(
            tmp_path,
            mimetype="text/plain; charset=utf-8",
            as_attachment=True,
            download_name=download_name,
        )

    except Exception as e:
        logger.error(f"Export failed: {e}")
        return jsonify({"error": str(e)}), 500


# ─── API: Audio Playback ──────────────────────────────────────

@app.route("/api/audio/<filename>")
def serve_audio(filename):
    """
    Serve uploaded audio for frontend playback.
    Uses range requests for seeking support.
    """
    if not _session["audio_path"] or not os.path.exists(_session["audio_path"]):
        return jsonify({"error": "No audio available"}), 404

    return send_file(
        _session["audio_path"],
        mimetype="audio/mpeg" if _session["audio_path"].endswith(".mp3") else "audio/wav",
        conditional=True,  # Support range requests
    )


# ─── API: Status & Stats ───────────────────────────────────────

@app.route("/api/stats", methods=["GET"])
def stats():
    """Get alignment quality statistics."""
    if not _session["aligned_data"]:
        return jsonify({"error": "No alignment data"}), 404

    return jsonify(get_alignment_stats(_session["aligned_data"]))


@app.route("/api/status", methods=["GET"])
def status():
    """Get current session status."""
    return jsonify({
        "audio_loaded": _session["audio_path"] is not None and os.path.exists(_session["audio_path"]),
        "audio_filename": _session.get("audio_filename"),
        "lyrics_loaded": bool(_session.get("lyrics_text")),
        "alignment_ready": _session["aligned_data"] is not None,
        "language": _session.get("language", "es"),
        "device": _get_device(),
        "aligned_lines_count": len(_session["aligned_data"]) if _session["aligned_data"] else 0,
    })

@app.route("/api/reset", methods=["POST"])
def reset_session():
    """Clear the current session (audio, lyrics, alignment).

    Only temp uploads are removed from disk. Saved project files are
    NEVER deleted — they are the user's saved work.
    """
    _safe_remove_audio(_session.get("audio_path"))
    _session.update({
        "audio_path": None,
        "audio_filename": None,
        "lyrics_text": None,
        "aligned_data": None,
        "language": "es",
        "project_name": None,
        "project_created": None,
    })
    logger.info("🗑️ Session reset")
    return jsonify({"success": True})

@app.route("/api/sync-alignment", methods=["POST"])
def sync_alignment():
    """Save the frontend's edited aligned data so exports reflect the edits."""
    data = request.get_json(silent=True) or {}
    lines = data.get("aligned_lines")
    if lines is None:
        return jsonify({"error": "No aligned_lines provided"}), 400
    if not isinstance(lines, list):
        return jsonify({"error": "aligned_lines must be a list"}), 400
    _session["aligned_data"] = lines
    logger.info(f"💾 Synced {len(lines)} aligned lines from frontend")
    return jsonify({"success": True, "count": len(lines)})

@app.route("/api/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "ok",
        "device": _get_device(),
        "timestamp": datetime.now().isoformat(),
        "app": "ELYSY | Eliz's Lyrics Synchronizer",
        "version": "1.1.0",
    })


# ─── Error Handlers ────────────────────────────────────────────

@app.errorhandler(413)
def too_large(e):
    return jsonify({"error": "File too large. Maximum is 100 MB."}), 413


@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
def server_error(e):
    return jsonify({"error": "Internal server error"}), 500


# ─── Helpers ───────────────────────────────────────────────────

def _get_audio_duration(filepath: str) -> float:
    """Get audio duration in seconds, if possible."""
    try:
        import subprocess
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", filepath],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass

    # Fallback: try mutagen
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(filepath)
        if audio and hasattr(audio, "info") and hasattr(audio.info, "length"):
            return audio.info.length
    except Exception:
        pass

    return 0.0


def _format_duration(seconds: float) -> str:
    """Format seconds as M:SS or H:MM:SS."""
    if seconds < 60:
        return f"0:{int(seconds):02d}"
    elif seconds < 3600:
        return f"{int(seconds // 60)}:{int(seconds % 60):02d}"
    else:
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        s = int(seconds % 60)
        return f"{h}:{m:02d}:{s:02d}"

def _safe_remove_audio(path: str) -> None:
    """Delete an audio file ONLY if it lives in the temp upload folder.
    Never delete files that belong to a saved project."""
    if not path or not os.path.exists(path):
        return
    try:
        upload_dir = os.path.abspath(app.config["UPLOAD_FOLDER"])
        audio_abs = os.path.abspath(path)
        if os.path.commonpath([audio_abs, upload_dir]) == upload_dir:
            os.remove(path)
            logger.debug(f"Removed temp audio: {path}")
    except Exception:
        pass

def _sanitize_project_name(name: str) -> str:
    """Make a string safe to use as a folder name on Windows/macOS/Linux."""
    name = name.strip()
    for ch in '<>:"/\\|?*':
        name = name.replace(ch, "_")
    name = name.strip(" .")
    if not name:
        name = "proyecto"
    return name[:80]

# ─── Main ──────────────────────────────────────────────────────

# ─── Main ──────────────────────────────────────────────────────

def _open_browser_when_ready(host: str, port: int) -> None:
    """Open the app in the default browser once the port is listening."""
    def _open():
        url = f"http://{host}:{port}"
        for _ in range(100):  # up to ~30s of waiting
            try:
                with socket.create_connection((host, port), timeout=0.3):
                    break
            except OSError:
                time.sleep(0.3)
        try:
            webbrowser.open(url)
        except Exception:
            pass  # never crash the server over a browser launch
    threading.Thread(target=_open, daemon=True).start()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="ELYSY | Eliz's Lyrics Synchronizer")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open the browser")
    args = parser.parse_args()

    print()
    print("=" * 60)
    print("  ELYSY | Eliz's Lyrics Synchronizer")
    print("  AI-powered word-by-word LRC / subtitle generator")
    print()
    print(f"  Open:  http://{args.host}:{args.port}")
    print(f"  Device: {_get_device()}")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)
    print()

    if not args.no_browser:
        _open_browser_when_ready(args.host, args.port)

    app.run(host=args.host, port=args.port, debug=args.debug)