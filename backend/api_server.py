# api_server.py
import os
import subprocess
import threading
import time
import zipfile
import logging
from pathlib import Path

from fastapi import FastAPI, File as FastAPIFile, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend import (
    CorridorKeyService,
    GPUJob,
    InferenceParams,
    JobType,
)
from backend.ffmpeg_tools import probe_video, read_video_metadata
from clip_manager import organize_clips

logger = logging.getLogger(__name__)

app = FastAPI()
service = CorridorKeyService()
queue = service.job_queue
service.detect_device()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class InferenceRequest(BaseModel):
    clip_name: str
    params: dict = {}


class ClipJobRequest(BaseModel):
    clip_name: str


def _serialize_job(job: GPUJob) -> dict:
    return {
        "job_id": job.id,
        "clip_name": job.clip_name,
        "job_type": job.job_type.value,
        "status": job.status.value,
        "current_frame": job.current_frame,
        "total_frames": job.total_frames,
        "error_message": job.error_message,
        "is_cancelled": job.is_cancelled,
    }


def _serialize_clip(clip) -> dict:
    input_frames = clip.input_asset.frame_count if clip.input_asset else 0
    alpha_frames = clip.alpha_asset.frame_count if clip.alpha_asset else 0
    mask_frames = clip.mask_asset.frame_count if clip.mask_asset else 0
    return {
        "name": clip.name,
        "state": clip.state.value,
        "input_frames": input_frames,
        "alpha_frames": alpha_frames,
        "has_alpha_frames": alpha_frames > 0,
        "mask_frames": mask_frames,
        "has_mask_frames": mask_frames > 0,
        "has_outputs": bool(getattr(clip, "has_outputs", False)),
    }


def _get_clip_or_404(clip_name: str):
    clip = clips_cache.get(clip_name)
    if clip is None:
        raise HTTPException(status_code=404, detail=f"Unknown clip: {clip_name}. Call /scan first.")
    return clip


def _output_root_for_clip(clip_name: str) -> Path:
    clip = _get_clip_or_404(clip_name)
    return Path(clip.root_path) / "Output"

clips_cache = {}  # clip_name -> ClipEntry (refresh via /scan)

SEQUENCE_IMAGE_EXTS = {".exr", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}


def _sequence_image_files(files: list[Path]) -> list[Path]:
    return [p for p in files if p.suffix.lower() in SEQUENCE_IMAGE_EXTS]


def _dir_has_files(path: Path) -> bool:
    return path.exists() and path.is_dir() and any(path.iterdir())


def _cache_dir_for_clip(clip_name: str) -> Path:
    output_root = _output_root_for_clip(clip_name)
    cache_dir = output_root / "low_res_preview"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _preview_fps_for_clip(clip_name: str, default_fps: float = 12.0) -> float:
    clip = _get_clip_or_404(clip_name)

    # 1) Prefer persisted metadata written during extraction.
    try:
        meta = read_video_metadata(clip.root_path)
        if meta:
            fps = float(meta.get("fps", 0) or 0)
            if fps > 0:
                return max(1.0, min(120.0, fps))
    except Exception:
        pass

    # 2) Fall back to probing the current input video asset if present.
    try:
        input_asset = getattr(clip, "input_asset", None)
        if input_asset is not None and getattr(input_asset, "asset_type", "") == "video":
            info = probe_video(input_asset.path)
            fps = float(info.get("fps", 0) or 0)
            if fps > 0:
                return max(1.0, min(120.0, fps))
    except Exception:
        pass

    return default_fps


def _latest_mtime(files: list[Path]) -> float:
    if not files:
        return 0.0
    return max(f.stat().st_mtime for f in files)


def _is_sequence(files: list[Path]) -> tuple[bool, str]:
    if not files:
        return False, ""
    ext = files[0].suffix.lower()
    if ext not in SEQUENCE_IMAGE_EXTS:
        return False, ext
    if any(f.suffix.lower() != ext for f in files):
        return False, ext
    return len(files) > 1, ext


def _ensure_sequence_preview(clip_name: str, subdir: str, files: list[Path]) -> Path | None:
    """Create/update an mp4 preview for an image sequence with ffmpeg."""
    if not files:
        return None

    cache_dir = _cache_dir_for_clip(clip_name)
    preview_path = cache_dir / f"{subdir.lower()}_preview.mp4"
    inputs_mtime = _latest_mtime(files)
    if preview_path.exists() and preview_path.stat().st_mtime >= inputs_mtime:
        return preview_path

    list_path = cache_dir / f"{subdir.lower()}_ffmpeg_inputs.txt"
    # concat demuxer keeps deterministic ordering and works for non-pattern filenames.
    # Write explicit per-frame durations so output clips always have non-zero length.
    fps = _preview_fps_for_clip(clip_name, default_fps=12.0)
    frame_duration = 1.0 / fps
    with list_path.open("w", encoding="utf-8") as f:
        sorted_files = sorted(files)
        for frame in sorted_files:
            safe_frame = str(frame).replace("\\", "\\\\").replace("'", "\\'")
            f.write(f"file '{safe_frame}'\n")
            f.write(f"duration {frame_duration:.6f}\n")
        # Concat demuxer requires the final file repeated for last duration to apply.
        if sorted_files:
            last_safe = str(sorted_files[-1]).replace("\\", "\\\\").replace("'", "\\'")
            f.write(f"file '{last_safe}'\n")

    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-vf",
        "scale=640:-2:flags=lanczos,format=yuv420p",
        "-r",
        str(int(fps)),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "30",
        str(preview_path),
    ]

    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as exc:
        logger.warning(
            "Preview generation failed for %s/%s: %s",
            clip_name,
            subdir,
            exc.stderr.decode("utf-8", errors="ignore") if exc.stderr else "ffmpeg error",
        )
        return None
    except FileNotFoundError:
        logger.warning("Preview generation unavailable for %s/%s: ffmpeg not found", clip_name, subdir)
        return None

    return preview_path if preview_path.exists() else None


def _ensure_sequence_zip(clip_name: str, subdir: str, files: list[Path]) -> Path:
    cache_dir = _cache_dir_for_clip(clip_name)
    zip_path = cache_dir / f"{subdir.lower()}_sequence.zip"
    inputs_mtime = _latest_mtime(files)
    if zip_path.exists() and zip_path.stat().st_mtime >= inputs_mtime:
        return zip_path

    with zipfile.ZipFile(zip_path, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for frame in sorted(files):
            zf.write(frame, arcname=frame.name)
    return zip_path


def _warm_sequence_previews(clip_name: str, subdirs: list[str] | None = None) -> dict[str, bool]:
    if subdirs is None:
        subdirs = ["FG", "Matte", "Comp", "Processed"]

    output_root = _output_root_for_clip(clip_name)
    result: dict[str, bool] = {}
    for subdir in subdirs:
        folder = output_root / subdir
        if not folder.exists() or not folder.is_dir():
            result[subdir] = False
            continue

        files = sorted([p for p in folder.iterdir() if p.is_file()])
        image_files = sorted(_sequence_image_files(files))
        sequence, _ = _is_sequence(image_files)
        if not sequence:
            result[subdir] = False
            continue

        preview = _ensure_sequence_preview(clip_name, subdir, image_files)
        result[subdir] = bool(preview and preview.exists())

    return result


def _detect_capabilities() -> dict:
    root = Path(__file__).resolve().parents[1]
    gvm_weights = root / "gvm_core" / "weights"
    videomama_ft = root / "VideoMaMaInferenceModule" / "checkpoints" / "VideoMaMa"
    videomama_base = root / "VideoMaMaInferenceModule" / "checkpoints" / "stable-video-diffusion-img2vid-xt"

    return {
        "gvm_installed": _dir_has_files(gvm_weights),
        "videomama_installed": _dir_has_files(videomama_ft) and _dir_has_files(videomama_base),
    }


def _build_tree(path: Path, depth: int, max_entries: int = 200) -> list[dict]:
    if not path.exists() or not path.is_dir() or depth <= 0:
        return []

    entries = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))[:max_entries]
    tree: list[dict] = []
    for entry in entries:
        node = {
            "name": entry.name,
            "kind": "dir" if entry.is_dir() else "file",
        }
        if entry.is_dir():
            node["children"] = _build_tree(entry, depth=depth - 1, max_entries=max_entries)
        tree.append(node)
    return tree


def _dedupe_destination_path(dest_dir: Path, filename: str) -> Path:
    base_name = os.path.basename(filename)
    stem = Path(base_name).stem
    suffix = Path(base_name).suffix
    candidate = dest_dir / base_name
    i = 1
    while candidate.exists():
        candidate = dest_dir / f"{stem}_{i}{suffix}"
        i += 1
    return candidate


def _ensure_clip_output_scaffold(clip_root: Path) -> None:
    for rel in [
        "AlphaHint",
        "VideoMamaMaskHint",
        "Output",
        "Output/FG",
        "Output/Matte",
        "Output/Comp",
        "Output/Processed",
        "Output/low_res_preview",
    ]:
        (clip_root / rel).mkdir(parents=True, exist_ok=True)

def worker_loop():
    while True:
        job = queue.next_job()
        if not job:
            time.sleep(0.2)
            continue

        queue.start_job(job)
        try:
            clip = clips_cache.get(job.clip_name)
            if clip is None:
                raise RuntimeError(f"Unknown clip: {job.clip_name}")

            if job.job_type == JobType.INFERENCE:
                p = InferenceParams.from_dict(job.params)
                service.run_inference(clip, p, job=job, on_progress=queue.report_progress, on_warning=queue.report_warning)
                # Warm previews immediately after inference so Section 3 has media without extra user actions.
                _warm_sequence_previews(job.clip_name)
            elif job.job_type == JobType.GVM_ALPHA:
                service.run_gvm(clip, job=job, on_progress=queue.report_progress, on_warning=queue.report_warning)
            elif job.job_type == JobType.VIDEOMAMA_ALPHA:
                service.run_videomama(clip, job=job, on_progress=queue.report_progress, on_warning=queue.report_warning)

            queue.complete_job(job)
        except Exception as e:
            if job.is_cancelled:
                queue.mark_cancelled(job)
            else:
                queue.fail_job(job, str(e))

@app.on_event("startup")
def startup():
    t = threading.Thread(target=worker_loop, daemon=True)
    t.start()

@app.get("/health")
def health():
    return {"ok": True, "device": service.detect_device()}


@app.get("/capabilities")
def capabilities():
    return _detect_capabilities()

@app.post("/scan")
def scan(clips_dir: str):
    clips = service.scan_clips(clips_dir)
    clips_cache.clear()
    for c in clips:
        clips_cache[c.name] = c
    return [_serialize_clip(c) for c in clips]


@app.post("/organize")
def organize(clips_dir: str):
    """Apply clip_manager wizard-style organization to clip folders."""
    organize_clips(clips_dir)
    clips = service.scan_clips(clips_dir)
    clips_cache.clear()
    for c in clips:
        clips_cache[c.name] = c
    return {
        "clips_dir": clips_dir,
        "organized": True,
        "clip_count": len(clips),
    }


@app.get("/clips")
def get_clips(clips_dir: str = Query(..., description="Path to clips root, e.g. /app/ClipsForInference")):
    return scan(clips_dir)


@app.get("/clips/tree")
def get_clips_tree(
    clips_dir: str = Query(..., description="Path to clips root, e.g. /app/ClipsForInference"),
    depth: int = Query(3, ge=1, le=6),
):
    root = Path(clips_dir)
    root.mkdir(parents=True, exist_ok=True)
    return {
        "clips_dir": clips_dir,
        "tree": _build_tree(root, depth=depth),
    }


@app.post("/uploads")
async def upload_clips(
    clips_dir: str = Query(..., description="Path to clips root, e.g. /app/ClipsForInference"),
    files: list[UploadFile] = FastAPIFile(...),
):
    root = Path(clips_dir)
    root.mkdir(parents=True, exist_ok=True)

    saved: list[dict] = []
    for file in files:
        if not file.filename:
            continue

        dest = _dedupe_destination_path(root, file.filename)
        content = await file.read()
        dest.write_bytes(content)
        saved.append({
            "original_name": file.filename,
            "saved_name": dest.name,
            "size_bytes": len(content),
        })

    # Organize immediately so uploads appear as clips and required dirs exist.
    organize_clips(clips_dir)
    clips = service.scan_clips(clips_dir)
    clips_cache.clear()
    for c in clips:
        _ensure_clip_output_scaffold(Path(c.root_path))
        clips_cache[c.name] = c

    return {
        "clips_dir": clips_dir,
        "uploaded_count": len(saved),
        "files": saved,
        "clip_count": len(clips),
    }

@app.post("/jobs/inference")
def enqueue_inference(req: InferenceRequest):
    _get_clip_or_404(req.clip_name)
    job = GPUJob(job_type=JobType.INFERENCE, clip_name=req.clip_name, params=req.params)
    if not queue.submit(job):
        raise HTTPException(status_code=409, detail="Duplicate job")
    return _serialize_job(job)


@app.post("/jobs/gvm")
def enqueue_gvm(req: ClipJobRequest):
    caps = _detect_capabilities()
    if not caps["gvm_installed"]:
        raise HTTPException(
            status_code=400,
            detail="GVM is not installed. Download weights to gvm_core/weights first.",
        )
    _get_clip_or_404(req.clip_name)
    job = GPUJob(job_type=JobType.GVM_ALPHA, clip_name=req.clip_name)
    if not queue.submit(job):
        raise HTTPException(status_code=409, detail="Duplicate job")
    return _serialize_job(job)


@app.post("/jobs/videomama")
def enqueue_videomama(req: ClipJobRequest):
    _get_clip_or_404(req.clip_name)
    job = GPUJob(job_type=JobType.VIDEOMAMA_ALPHA, clip_name=req.clip_name)
    if not queue.submit(job):
        raise HTTPException(status_code=409, detail="Duplicate job")
    return _serialize_job(job)


@app.get("/jobs")
def list_jobs():
    current = queue.current_job
    queued = queue.queue_snapshot
    history = queue.history_snapshot
    return {
        "current": _serialize_job(current) if current else None,
        "queued": [_serialize_job(j) for j in queued],
        "history": [_serialize_job(j) for j in history],
    }


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = queue.find_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return _serialize_job(job)

@app.post("/jobs/{job_id}/cancel")
def cancel(job_id: str):
    job = queue.find_job_by_id(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    queue.cancel_job(job)
    return {"job_id": job_id, "status": "cancel_requested"}


@app.get("/outputs/{clip_name}")
def list_outputs(clip_name: str):
    output_root = _output_root_for_clip(clip_name)
    if not output_root.exists():
        return {"clip_name": clip_name, "outputs": []}

    outputs = []
    for subdir in ["FG", "Matte", "Comp", "Processed"]:
        folder = output_root / subdir
        if not folder.exists():
            continue
        files = sorted([p for p in folder.iterdir() if p.is_file()])
        image_files = sorted(_sequence_image_files(files))
        if not files and not image_files:
            continue

        sequence, ext = _is_sequence(image_files)
        size_bytes = sum(p.stat().st_size for p in (image_files if image_files else files))

        if sequence:
            preview_path = _ensure_sequence_preview(clip_name, subdir, image_files)
            outputs.append(
                {
                    "type": subdir.lower(),
                    "filename": f"{subdir.lower()}_sequence.zip",
                    "size_bytes": size_bytes,
                    "frame_count": len(image_files),
                    "extension": ext,
                    "is_sequence": True,
                    "preview_url": f"/outputs/{clip_name}/preview?subdir={subdir}" if preview_path else None,
                    "download_url": f"/outputs/{clip_name}/download-sequence?subdir={subdir}",
                }
            )
            continue

        p = image_files[0] if image_files else files[0]
        outputs.append(
            {
                "type": subdir.lower(),
                "filename": p.name,
                "size_bytes": p.stat().st_size,
                "frame_count": 1,
                "extension": p.suffix.lower(),
                "is_sequence": False,
                "preview_url": None,
                "download_url": f"/outputs/{clip_name}/download?subdir={subdir}&filename={p.name}",
            }
        )
    return {"clip_name": clip_name, "outputs": outputs}


@app.post("/outputs/{clip_name}/generate-preview")
def generate_output_preview(clip_name: str, subdir: str | None = None):
    if subdir is not None:
        safe_subdir = subdir.strip()
        if safe_subdir not in {"FG", "Matte", "Comp", "Processed"}:
            raise HTTPException(status_code=400, detail="Invalid output subdir")
        result = _warm_sequence_previews(clip_name, [safe_subdir])
    else:
        result = _warm_sequence_previews(clip_name)

    return {
        "clip_name": clip_name,
        "generated": result,
        "any_generated": any(result.values()),
    }


@app.get("/outputs/{clip_name}/preview")
def get_output_preview(clip_name: str, subdir: str):
    safe_subdir = subdir.strip()
    if safe_subdir not in {"FG", "Matte", "Comp", "Processed"}:
        raise HTTPException(status_code=400, detail="Invalid output subdir")

    folder = _output_root_for_clip(clip_name) / safe_subdir
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(status_code=404, detail="Output folder not found")

    files = sorted([p for p in folder.iterdir() if p.is_file()])
    image_files = sorted(_sequence_image_files(files))
    sequence, _ = _is_sequence(image_files)
    if not sequence:
        raise HTTPException(status_code=404, detail="No sequence preview available")

    preview_path = _ensure_sequence_preview(clip_name, safe_subdir, image_files)
    if not preview_path or not preview_path.exists():
        raise HTTPException(status_code=404, detail="Preview generation unavailable")

    return FileResponse(path=str(preview_path), filename=preview_path.name, media_type="video/mp4")


@app.get("/outputs/{clip_name}/download-sequence")
def download_output_sequence(clip_name: str, subdir: str):
    safe_subdir = subdir.strip()
    if safe_subdir not in {"FG", "Matte", "Comp", "Processed"}:
        raise HTTPException(status_code=400, detail="Invalid output subdir")

    folder = _output_root_for_clip(clip_name) / safe_subdir
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(status_code=404, detail="Output folder not found")

    files = sorted([p for p in folder.iterdir() if p.is_file()])
    image_files = sorted(_sequence_image_files(files))
    sequence, _ = _is_sequence(image_files)
    if not sequence:
        raise HTTPException(status_code=400, detail="Output is not a frame sequence")

    zip_path = _ensure_sequence_zip(clip_name, safe_subdir, image_files)
    if not zip_path.exists():
        raise HTTPException(status_code=500, detail="Failed to prepare sequence archive")

    return FileResponse(path=str(zip_path), filename=f"{safe_subdir.lower()}_sequence.zip", media_type="application/zip")


@app.get("/outputs/{clip_name}/download")
def download_output(clip_name: str, subdir: str, filename: str):
    safe_subdir = subdir.strip()
    if safe_subdir not in {"FG", "Matte", "Comp", "Processed"}:
        raise HTTPException(status_code=400, detail="Invalid output subdir")

    # Prevent path traversal.
    if filename != os.path.basename(filename):
        raise HTTPException(status_code=400, detail="Invalid filename")

    file_path = _output_root_for_clip(clip_name) / safe_subdir / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Output file not found")

    return FileResponse(path=str(file_path), filename=filename)