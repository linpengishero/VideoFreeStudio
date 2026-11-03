"""Objective media scans that anchor video QA in measurements, not impressions.

Run from run_root so output paths stay relative. Modes:

  video <media> --out <rel.json>   dense YDIF frame-diff curve, scene cuts,
                                   silence spans, loudness, stereo balance
  audio <media> --out <rel.json>   loudness, balance, silence (final acceptance)

The gate verifies the attachment's media_sha256 equals the reviewed artifact and
that every framediff outlier carries a reviewed conclusion in the QA report.
"""

import argparse
import hashlib
import json
import math
import re
import statistics
import subprocess
from datetime import datetime, timezone
from pathlib import Path

SCENE_THRESHOLD = 0.30
OUTLIER_RATIO = 4.0          # >= ratio * median (plus floor) and 70% of the clip max
OUTLIER_ABS_FLOOR = 1.0      # YDIF noise floor on near-static footage
OUTLIER_MERGE_SEC = 0.30     # consecutive outlier frames describe one event
MAX_OUTLIERS = 60
SILENCE_NOISE_DB = -35
SILENCE_MIN_SEC = 0.35


def run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {(proc.stderr or proc.stdout or '')[-400:]}")
    return (proc.stdout or "") + "\n" + (proc.stderr or "")


def media_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def duration(path):
    text = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)])
    return float(text.strip())


def framediff(path):
    """Per-frame YDIF (mean absolute luma difference to the previous frame) via one decode pass."""
    text = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf", "signalstats,metadata=print", "-an", "-f", "null", "-"])
    samples = []
    pending_t = None
    for line in text.splitlines():
        stamp = re.search(r"pts_time:([0-9.]+)", line)
        if stamp:
            pending_t = float(stamp.group(1))
            continue
        diff = re.search(r"lavfi\.signalstats\.YDIF=(-?[0-9.eE+]+)", line)
        if diff and pending_t is not None:
            try:
                value = float(diff.group(1))
            except ValueError:
                continue
            if math.isfinite(value):
                samples.append((pending_t, value))
            pending_t = None
    if not samples:
        raise RuntimeError("no YDIF samples parsed; is this a decodable video?")
    values = [v for _, v in samples]
    median = statistics.median(values)
    peak = max(values)
    threshold = max(OUTLIER_RATIO * median + 0.5, 0.7 * peak, OUTLIER_ABS_FLOOR)
    events = []
    for t, value in samples:
        if value < threshold:
            continue
        if events and t - events[-1]["t"] <= OUTLIER_MERGE_SEC and value <= events[-1]["value"]:
            continue
        if events and t - events[-1]["t"] <= OUTLIER_MERGE_SEC:
            events[-1] = {"t": round(t, 3), "value": round(value, 3)}
        else:
            events.append({"t": round(t, 3), "value": round(value, 3)})
    events = sorted(events, key=lambda e: e["value"], reverse=True)[:MAX_OUTLIERS]
    events.sort(key=lambda e: e["t"])
    last = samples[-1][0] or 1.0
    return {"frames": len(samples), "fps_est": round(len(samples) / last, 3), "median": round(median, 3),
            "max": round(peak, 3), "threshold": round(threshold, 3), "outliers": events}


def scene_cuts(path):
    text = run(["ffmpeg", "-hide_banner", "-i", str(path), "-vf",
                f"select='gt(scene,{SCENE_THRESHOLD})',metadata=print", "-an", "-f", "null", "-"])
    cuts = [round(float(v), 3) for v in re.findall(r"pts_time:([0-9.]+)", text)]
    return {"threshold": SCENE_THRESHOLD, "cut_timestamps": cuts}


def loudness(path):
    text = run(["ffmpeg", "-hide_banner", "-i", str(path), "-af", "volumedetect", "-vn", "-f", "null", "-"])
    def grab(name):
        found = re.search(rf"{name}: (-?[0-9.]+) dB", text)
        if not found:
            raise RuntimeError(f"{name} missing from volumedetect output")
        return float(found.group(1))
    return {"mean_db": grab("mean_volume"), "max_db": grab("max_volume")}


def balance(path):
    text = run(["ffmpeg", "-hide_banner", "-i", str(path), "-af",
                "astats=measure_perchannel=RMS_level:measure_overall=RMS_level", "-vn", "-f", "null", "-"])
    channels, current = {}, None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped in ("Overall", "Channel 1", "Channel 2"):
            current = stripped
        elif current and stripped.startswith("RMS level dB:"):
            channels[current] = float(stripped.split(":", 1)[1])
    result = {"overall_rms_db": channels.get("Overall"), "left_rms_db": channels.get("Channel 1"),
              "right_rms_db": channels.get("Channel 2")}
    if result["left_rms_db"] is not None and result["right_rms_db"] is not None:
        result["delta_db"] = round(abs(result["left_rms_db"] - result["right_rms_db"]), 2)
    else:
        result["delta_db"] = None
    return result


def silence(path):
    text = run(["ffmpeg", "-hide_banner", "-i", str(path), "-af",
                f"silencedetect=n={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_SEC}", "-vn", "-f", "null", "-"])
    starts = [float(v) for v in re.findall(r"silence_start: (-?[0-9.]+)", text)]
    ends = [float(v) for v in re.findall(r"silence_end: (-?[0-9.]+)", text)]
    spans = [[round(s, 3), round(e, 3)] for s, e in zip(starts, ends)]
    return {"noise_db": SILENCE_NOISE_DB, "min_sec": SILENCE_MIN_SEC, "spans": spans,
            "total_sec": round(sum(e - s for s, e in spans), 3)}


def scan(mode, media, out, root):
    path = Path(media)
    if not path.is_file():
        raise SystemExit(f"media file missing: {path}")
    result = {"schema_version": 1, "mode": mode, "media_sha256": media_hash(path),
              "duration_sec": round(duration(path), 3),
              "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "ffmpeg": run(["ffmpeg", "-version"]).splitlines()[0]}
    result["scans"] = {
        "loudness": loudness(path),
        "balance": balance(path),
        "silence": silence(path),
        "scene": framediff_scene(mode, path),
        "framediff": framediff_diff(mode, path),
    }
    target = Path(out)
    resolved = target if target.is_absolute() else (root / target).resolve()
    if not target.is_absolute() and not resolved.is_relative_to(root):
        raise SystemExit("relative output must stay inside run_root")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    rel = resolved.relative_to(root).as_posix() if resolved.is_relative_to(root) else str(resolved)
    outliers = result["scans"]["framediff"].get("outliers", [])
    print(json.dumps({"path": rel, "sha256": result["media_sha256"], "duration_sec": result["duration_sec"],
                      "scene_cuts": len(result["scans"]["scene"].get("cut_timestamps", [])),
                      "framediff_outliers": len(outliers),
                      "silence_spans": len(result["scans"]["silence"]["spans"]),
                      "loudness": result["scans"]["loudness"]}, ensure_ascii=False))


def framediff_scene(mode, path):
    return scene_cuts(path) if mode == "video" else {"skipped": True}


def framediff_diff(mode, path):
    return framediff(path) if mode == "video" else {"skipped": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("video", "audio"))
    parser.add_argument("media")
    parser.add_argument("--out", required=True, help="scan JSON path, relative to run_root")
    parser.add_argument("--root", default=".", help="run_root for relative paths")
    args = parser.parse_args()
    scan(args.mode, args.media, args.out, Path(args.root).resolve())


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as exc:
        print(json.dumps({"status": "BLOCKED", "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
