"""
Bandit Local Whisper & Speaker Diarization Microservice
Runs faster-whisper with 'small' model (int8 quantization) on CPU/GPU.
Provides OpenAI-compatible /v1/audio/transcriptions endpoint with word timestamps
and auto-detection of up to 4 speakers with 0.8s minimum segment threshold.
"""

import os
import tempfile
import time
from typing import Optional, List, Dict, Any
import numpy as np

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse
import soundfile as sf
from scipy.signal import find_peaks

# Configure model options
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
MAX_SPEAKERS_DEFAULT = int(os.environ.get("WHISPER_MAX_SPEAKERS", "4"))
MIN_SEGMENT_SEC_DEFAULT = float(os.environ.get("WHISPER_MIN_SEGMENT_SEC", "0.8"))

app = FastAPI(title="Bandit Whisper STT Service", version="1.0.0")

# Lazy-loaded model instance
whisper_model = None


def get_model():
    global whisper_model
    if whisper_model is None:
        from faster_whisper import WhisperModel
        print(f"[WhisperService] Loading faster-whisper model '{WHISPER_MODEL}' ({WHISPER_DEVICE}, {WHISPER_COMPUTE_TYPE})...")
        whisper_model = WhisperModel(
            WHISPER_MODEL,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
            download_root=os.environ.get("WHISPER_DOWNLOAD_ROOT", "/root/.cache/whisper")
        )
        print("[WhisperService] Model loaded and ready for inference.")
    return whisper_model


def extract_acoustic_features(audio_data: np.ndarray, sr: int, start_sec: float, end_sec: float) -> np.ndarray:
    """Extract acoustic pitch and spectral centroid features for a segment."""
    start_sample = max(0, int(start_sec * sr))
    end_sample = min(len(audio_data), int(end_sec * sr))
    if end_sample - start_sample < int(0.2 * sr):
        return np.array([0.0, 0.0, 0.0])

    chunk = audio_data[start_sample:end_sample]
    if chunk.ndim > 1:
        chunk = chunk[:, 0]

    # Normalize
    chunk = chunk - np.mean(chunk)
    energy = np.sqrt(np.mean(chunk**2)) + 1e-9

    # FFT for spectral centroid
    fft_vals = np.abs(np.fft.rfft(chunk))
    freqs = np.fft.rfftfreq(len(chunk), 1.0 / sr)
    spectral_centroid = np.sum(freqs * fft_vals) / (np.sum(fft_vals) + 1e-9)

    # Autocorrelation for pitch estimation (F0)
    corr = np.correlate(chunk, chunk, mode="full")
    corr = corr[len(corr) // 2:]
    d = np.diff(corr)
    start_idx = np.where(d > 0)[0]
    pitch = 120.0  # fallback
    if len(start_idx) > 0:
        peak_idx = np.argmax(corr[start_idx[0]:]) + start_idx[0]
        if peak_idx > 0:
            pitch = sr / peak_idx
            if pitch < 60 or pitch > 450:
                pitch = 120.0

    return np.array([pitch, spectral_centroid, energy])


def perform_diarization(segments: List[Dict[str, Any]], audio_path: str, max_speakers: int = 4, min_segment_sec: float = 0.8) -> List[Dict[str, Any]]:
    """
    Cluster speech segments into up to max_speakers (default 4).
    Enforces min_segment_sec threshold (0.8s) so transients/clicks merge into adjacent speaker turns.
    """
    if not segments:
        return segments

    try:
        data, sr = sf.read(audio_path)
    except Exception as e:
        print(f"[Diarization Warning] Could not read audio for acoustic clustering: {e}")
        # Default all to Speaker 1
        for seg in segments:
            seg["speaker"] = "Speaker 1"
            for w in seg.get("words", []):
                w["speaker"] = "Speaker 1"
        return segments

    # Extract acoustic feature vector per segment
    features = []
    for seg in segments:
        dur = seg["end"] - seg["start"]
        feat = extract_acoustic_features(data, sr, seg["start"], seg["end"])
        features.append((dur, feat))

    # Cluster segments into up to max_speakers based on pitch and spectral centroid
    speaker_labels = []
    centroids: List[np.ndarray] = []

    for idx, (dur, feat) in enumerate(features):
        if not centroids:
            centroids.append(feat)
            speaker_labels.append(1)
            continue

        # Compute distance to known centroids
        dists = [np.linalg.norm(feat[:2] - c[:2]) for c in centroids]
        min_dist_idx = int(np.argmin(dists))

        # Threshold for branching new speaker (distance > 350 Hz combined metric)
        if dists[min_dist_idx] > 350.0 and len(centroids) < max_speakers:
            centroids.append(feat)
            speaker_labels.append(len(centroids))
        else:
            speaker_labels.append(min_dist_idx + 1)
            # Update centroid
            centroids[min_dist_idx] = 0.8 * centroids[min_dist_idx] + 0.2 * feat

    # Apply 0.8s minimum segment duration threshold smoothing
    smoothed_labels = list(speaker_labels)
    for i in range(len(segments)):
        dur = segments[i]["end"] - segments[i]["start"]
        if dur < min_segment_sec:
            # Merge with previous speaker if available, otherwise next
            if i > 0:
                smoothed_labels[i] = smoothed_labels[i - 1]
            elif i + 1 < len(segments):
                smoothed_labels[i] = smoothed_labels[i + 1]

    # Assign speaker tags
    for i, seg in enumerate(segments):
        speaker_name = f"Speaker {smoothed_labels[i]}"
        seg["speaker"] = speaker_name
        for w in seg.get("words", []):
            w["speaker"] = speaker_name

    return segments


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "bandit-whisper",
        "model": WHISPER_MODEL,
        "device": WHISPER_DEVICE,
        "compute_type": WHISPER_COMPUTE_TYPE,
        "max_speakers_supported": 4,
        "min_segment_sec": 0.8
    }


@app.post("/v1/audio/transcriptions")
async def transcribe_audio(
    file: UploadFile = File(...),
    model: str = Form(WHISPER_MODEL),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    response_format: str = Form("verbose_json"),
    temperature: float = Form(0.0),
    max_speakers: int = Form(MAX_SPEAKERS_DEFAULT),
    min_segment_sec: float = Form(MIN_SEGMENT_SEC_DEFAULT)
):
    """
    Transcribe audio file with word timestamps and speaker diarization.
    """
    ext = os.path.splitext(file.filename or "")[1] or ".mp3"
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as temp_file:
        temp_path = temp_file.name
        content = await file.read()
        temp_file.write(content)

    start_time = time.time()
    try:
        model_instance = get_model()
        lang_arg = language if language and language != "auto" else None

        segments_iter, info = model_instance.transcribe(
            temp_path,
            language=lang_arg,
            initial_prompt=prompt,
            temperature=temperature,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400)
        )

        segments_list = []
        full_text_parts = []

        for seg_idx, seg in enumerate(segments_iter):
            full_text_parts.append(seg.text.strip())
            words_data = []
            if seg.words:
                for w in seg.words:
                    words_data.append({
                        "word": w.word.strip(),
                        "start": round(w.start, 2),
                        "end": round(w.end, 2),
                        "probability": round(w.probability, 3)
                    })

            segments_list.append({
                "id": seg_idx,
                "seek": seg.seek,
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
                "avg_logprob": round(seg.avg_logprob, 3),
                "no_speech_prob": round(seg.no_speech_prob, 3),
                "words": words_data
            })

        # Apply Speaker Diarization (up to 4 speakers, 0.8s minimum segment threshold)
        capped_speakers = max(1, min(max_speakers, 4))
        diarized_segments = perform_diarization(segments_list, temp_path, capped_speakers, min_segment_sec)

        # Compute speaker breakdown statistics
        speaker_seconds: Dict[str, float] = {}
        total_speech_sec = 0.0
        for seg in diarized_segments:
            dur = max(0.0, seg["end"] - seg["start"])
            spk = seg.get("speaker", "Speaker 1")
            speaker_seconds[spk] = speaker_seconds.get(spk, 0.0) + dur
            total_speech_sec += dur

        speaker_breakdown = {}
        for spk, secs in speaker_seconds.items():
            ratio = round(secs / total_speech_sec, 3) if total_speech_sec > 0 else 1.0
            speaker_breakdown[spk] = {
                "seconds": round(secs, 1),
                "ratio": ratio,
                "percentage": f"{round(ratio * 100, 1)}%"
            }

        duration = round(info.duration, 2) if hasattr(info, "duration") and info.duration else round(time.time() - start_time, 2)
        full_text = " ".join(full_text_parts)

        return JSONResponse({
            "task": "transcribe",
            "language": info.language if hasattr(info, "language") else "en",
            "language_probability": round(info.language_probability, 3) if hasattr(info, "language_probability") else 1.0,
            "duration": duration,
            "text": full_text,
            "speakers": sorted(list(speaker_seconds.keys())),
            "speaker_breakdown": speaker_breakdown,
            "segments": diarized_segments
        })

    except Exception as e:
        print(f"[WhisperService Error] Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)
