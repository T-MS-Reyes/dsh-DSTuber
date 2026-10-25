"""Persistent GPT-SoVITS streaming voice worker for dsh-dstuber.

The Host sends one JSON object per line on stdin:
  {"type":"speak","id":"...","text":"...","emotion":"happy","source":"reply"}
  {"type":"cancel"}
  {"type":"shutdown"}

This process owns the local GPT-SoVITS API, streaming WAV parsing, PCM playback
and the future Live2D viseme/level path. It is the only TTS provider.
"""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import queue
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import sounddevice as sd

try:
    import edge_tts
except Exception as exc:  # reported only when Edge TTS is selected
    edge_tts = None
    EDGE_IMPORT_ERROR = str(exc)
else:
    EDGE_IMPORT_ERROR = ""

DEFAULT_SETTINGS = {
    "enabled": True,
    "readMurmurs": "important",
    "provider": "edge",
    "volume": 0.8,
    "edgeVoice": "zh-CN-XiaoyiNeural",
    "edgeRate": 0,
    "edgePitch": 0,
    "ffmpegPath": "",
    "gptSovitsUrl": "http://127.0.0.1:9880",
    "gptWeights": "",
    "sovitsWeights": "",
    "referenceAudio": "",
    "promptText": "",
    "promptLang": "zh",
    "gptSovitsPort": 9880,
    "gptSovitsStreaming": 3,
    "gptSovitsSpeed": 1.0,
    "gptSovitsTextSplit": "cut5",
}

SETTINGS_PATH = Path(
    os.environ.get("DSH_DSTUBER_VOICE_FILE")
    or (Path(__file__).resolve().parent.parent / ".webview2" / "voice.json")
)

jobs: queue.Queue = queue.Queue()
cancel_event = threading.Event()
worker_thread: threading.Thread | None = None
gsv_lock = threading.Lock()
gsv_loaded_pair: tuple[str, str] | None = None
print_lock = threading.Lock()


def log(message: str) -> None:
    print(f"[voice] {message}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    with print_lock:
        print(json.dumps(payload, ensure_ascii=False), flush=True)


_last_level_at = 0.0


def emit_level(job_id: str, pcm) -> None:
    """Publish a throttled speech level for the Live2D stage's lip sync.

    The 10ms envelope already drives the mouth, so this coarse level is only a
    fallback (and for stages that miss envelopes). 4Hz keeps the stream cheap.
    """
    global _last_level_at
    now = time.monotonic()
    if now - _last_level_at < 0.25:
        return
    _last_level_at = now
    try:
        if pcm.size == 0:
            return
        rms = float(np.sqrt(np.mean(np.square(pcm))))
    except Exception:
        return
    # Speech RMS usually sits around 0.03-0.25; curve it so quiet syllables
    # still open the mouth a little and loud ones do not clamp instantly.
    level = min(1.0, (rms / 0.18) ** 0.6)
    emit({"type": "level", "id": job_id, "value": round(level, 3)})


class EnvelopeTracker:
    """Turn decoded PCM into an indexed 10ms RMS envelope.

    The stage replays the envelope against its own playback timestamp, so mouth
    motion follows syllable detail instead of depending on when each network
    frame happens to arrive. Chunks are published ahead of playback.
    """

    WINDOW_MS = 10

    def __init__(self, job_id: str, sample_rate: int):
        self.job_id = job_id
        self.sample_rate = sample_rate
        self.window = max(1, int(sample_rate * self.WINDOW_MS / 1000))
        self.pending = np.zeros(0, dtype=np.float32)
        self.samples: list[float] = []
        self.sent = 0

    def feed(self, pcm) -> None:
        if pcm is None or pcm.size == 0:
            return
        self.pending = np.concatenate((self.pending, np.asarray(pcm, dtype=np.float32).ravel()))
        count = self.pending.size // self.window
        if count <= 0:
            return
        usable = self.pending[: count * self.window].reshape(count, self.window)
        rms = np.sqrt(np.mean(np.square(usable), axis=1))
        self.samples.extend(float(value) for value in rms)
        self.pending = self.pending[count * self.window:]
        self.publish()

    def publish(self, force: bool = False) -> None:
        ready = len(self.samples) - self.sent
        if ready < 15 and not (force and ready > 0):
            return
        chunk = self.samples[self.sent:self.sent + ready]
        # TTS audio is loud and normalized, so a plain RMS*1.5 saturates the
        # mouth almost immediately. Gate the noise floor and curve it so quiet
        # syllables close the mouth and loud ones reach ~1.0 (official style,
        # adapted to normalized speech).
        values = []
        for value in chunk:
            normalized = max(0.0, min(1.0, (value - 0.015) / 0.3))
            values.append(round(normalized ** 0.75, 3))
        emit({
            "type": "envelope",
            "id": self.job_id,
            "offsetMs": self.sent * self.WINDOW_MS,
            "windowMs": self.WINDOW_MS,
            "samples": values,
        })
        self.sent += ready


def read_settings() -> dict:
    value = dict(DEFAULT_SETTINGS)
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            value.update(data)
    except Exception:
        pass
    value["enabled"] = value.get("enabled") is not False
    provider = str(value.get("provider") or "edge").strip().lower()
    value["provider"] = provider if provider in ("edge", "gpt-sovits") else "edge"
    value["edgeVoice"] = str(value.get("edgeVoice") or "zh-CN-XiaoyiNeural").strip()
    value["edgeRate"] = max(-50, min(50, int(value.get("edgeRate") or 0)))
    value["edgePitch"] = max(-100, min(100, int(value.get("edgePitch") or 0)))
    for key in (
        "ffmpegPath",
        "gptSovitsUrl",
        "gptWeights",
        "sovitsWeights",
        "referenceAudio",
        "promptText",
        "promptLang",
        "gptSovitsTextSplit",
    ):
        value[key] = str(value.get(key) or "").strip()
    value["gptSovitsUrl"] = value["gptSovitsUrl"] or "http://127.0.0.1:9880"
    value["promptLang"] = value["promptLang"] or "zh"
    value["gptSovitsTextSplit"] = value["gptSovitsTextSplit"] or "cut5"
    value["gptSovitsPort"] = max(1, min(65535, int(value.get("gptSovitsPort") or 9880)))
    value["gptSovitsStreaming"] = max(0, min(3, int(value.get("gptSovitsStreaming") or 3)))
    value["gptSovitsSpeed"] = max(0.5, min(2.0, float(value.get("gptSovitsSpeed") or 1.0)))
    value["volume"] = max(0.0, min(1.0, float(value.get("volume") or 0)))
    return value


def _gsv_endpoint(base: str) -> tuple[str, int]:
    raw = str(base or "").strip()
    if not raw:
        raw = "http://127.0.0.1:9880"
    if "://" not in raw:
        raw = "http://" + raw
    parsed = urlparse(raw)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 9880
    return host, port


def _gsv_request(base: str, method: str, path: str, payload: dict | None = None, timeout: float = 5.0):
    host, port = _gsv_endpoint(base)
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    headers = {}
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def _gsv_ready(base: str) -> bool:
    try:
        status, _ = _gsv_request(base, "GET", "/docs", timeout=1.5)
        return status == 200
    except Exception:
        return False


def _wav_format(header: bytes):
    if len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
        return None, None
    position = 12
    fmt = None
    while position + 8 <= len(header):
        chunk_id = header[position:position + 4]
        size = struct.unpack_from("<I", header, position + 4)[0]
        if chunk_id == b"fmt " and size >= 16 and position + 24 <= len(header):
            fmt = struct.unpack_from("<HHIIHH", header, position + 8)
        if chunk_id == b"data":
            return fmt, position + 8
        position += 8 + size + (size & 1)
    return fmt, None


def ensure_gsv(settings: dict) -> str:
    """Reuse the already-running GPT-SoVITS HTTP service and load the pair.

    This follows the Shinsekai model: the TTS engine is an external local
    service configured by URL; the DSH plugin only adapts HTTP streaming to
    playback. Engine startup/install belongs to the future engine manager.
    """
    global gsv_loaded_pair
    base = settings["gptSovitsUrl"] or "http://127.0.0.1:9880"
    gpt = Path(settings["gptWeights"])
    sovits = Path(settings["sovitsWeights"])
    reference = Path(settings["referenceAudio"])
    for label, path in (
        ("GPT 权重", gpt),
        ("SoVITS 权重", sovits),
        ("参考音频", reference),
    ):
        if not path.exists():
            raise RuntimeError(f"{label}不存在: {path}")

    with gsv_lock:
        if not _gsv_ready(base):
            raise RuntimeError(
                f"GPT-SoVITS 服务未启动：{base}。"
                "请先启动本地 GPT-SoVITS API（api_v2.py），再让桌宠说话。"
            )

        pair = (str(gpt), str(sovits))
        if gsv_loaded_pair != pair:
            for endpoint, path in (
                ("/set_gpt_weights", gpt),
                ("/set_sovits_weights", sovits),
            ):
                query = urllib.parse.quote(str(path), safe="")
                status, body = _gsv_request(
                    base, "GET", f"{endpoint}?weights_path={query}", timeout=180
                )
                if status != 200:
                    raise RuntimeError(
                        f"切换 GPT-SoVITS 权重失败 ({endpoint}): "
                        f"{body.decode('utf-8', 'replace')}"
                    )
            gsv_loaded_pair = pair
            log(f"GPT-SoVITS loaded GPT={gpt.name} SoVITS={sovits.name}")
        return base


def stop_gsv() -> None:
    # The service is external and owned by the user/engine manager; do not
    # kill it when the DSH voice worker restarts.
    return


def prewarm_gsv() -> None:
    try:
        settings = read_settings()
        if settings["provider"] != "gpt-sovits":
            return
        ensure_gsv(settings)
        log("GPT-SoVITS warm and ready")
    except Exception as exc:
        log(f"GPT-SoVITS prewarm failed: {exc}")


def _resolve_ffmpeg(settings: dict) -> str:
    candidates = [
        settings.get("ffmpegPath"),
        shutil.which("ffmpeg"),
        r"D:\modelscope\tools\ffmpeg\ffmpeg.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    raise RuntimeError("找不到 FFmpeg，无法解码 Edge TTS 音频")


def edge_speak(text: str, settings: dict, job_id: str) -> None:
    if edge_tts is None:
        raise RuntimeError(f"edge-tts 不可用: {EDGE_IMPORT_ERROR}")
    ffmpeg = _resolve_ffmpeg(settings)
    voice = settings["edgeVoice"] or "zh-CN-XiaoyiNeural"
    rate = int(settings["edgeRate"])
    pitch = int(settings["edgePitch"])
    communicate = edge_tts.Communicate(
        text,
        voice,
        rate=f"{rate:+d}%",
        volume="+0%",
        pitch=f"{pitch:+d}Hz",
    )
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    decoder = subprocess.Popen(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "24000",
            "pipe:1",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    write_error: list[Exception] = []

    def pump():
        try:
            async def run():
                async for chunk in communicate.stream():
                    if cancel_event.is_set():
                        break
                    if chunk.get("type") == "audio":
                        data = chunk.get("data") or b""
                        if data and decoder.stdin:
                            decoder.stdin.write(data)
            asyncio.run(run())
        except Exception as exc:
            write_error.append(exc)
        finally:
            try:
                if decoder.stdin:
                    decoder.stdin.close()
            except Exception:
                pass

    writer = threading.Thread(target=pump, name="edge-tts-pump", daemon=True)
    writer.start()
    try:
        env = EnvelopeTracker(job_id, 24000)
        prebuffer = []
        buffered_samples = 0
        prebuffer_target = int(24000 * 0.3)
        # Buffer a little audio first so the envelope is published ahead of the
        # sound; the mouth then follows the playback clock, not the network.
        while buffered_samples < prebuffer_target:
            if cancel_event.is_set():
                return
            chunk = decoder.stdout.read(4096) if decoder.stdout else b""
            if not chunk:
                break
            even = len(chunk) - (len(chunk) % 2)
            if even <= 0:
                continue
            pcm = np.frombuffer(chunk[:even], dtype="<i2").astype(np.float32) / 32768.0
            env.feed(pcm)
            prebuffer.append(pcm)
            buffered_samples += pcm.size

        with sd.OutputStream(
            samplerate=24000,
            channels=1,
            dtype="float32",
            blocksize=1024,
            latency="low",
        ) as stream:
            emit({"type": "play", "id": job_id, "text": text, "streaming": True, "rate": 24000})
            for pcm in prebuffer:
                if cancel_event.is_set():
                    return
                stream.write(np.clip(pcm * settings["volume"], -1.0, 1.0))
            while True:
                if cancel_event.is_set():
                    return
                chunk = decoder.stdout.read(4096) if decoder.stdout else b""
                if not chunk:
                    break
                even = len(chunk) - (len(chunk) % 2)
                if even:
                    pcm = np.frombuffer(chunk[:even], dtype="<i2").astype(np.float32) / 32768.0
                    env.feed(pcm)
                    emit_level(job_id, pcm)
                    stream.write(np.clip(pcm * settings["volume"], -1.0, 1.0))
            env.publish(force=True)
        writer.join(timeout=2)
        if write_error and not cancel_event.is_set():
            raise write_error[0]
    finally:
        if decoder.poll() is None:
            try:
                decoder.kill()
            except Exception:
                pass
        writer.join(timeout=1)


def gsv_speak(text: str, settings: dict, job_id: str) -> None:
    base = ensure_gsv(settings)
    host, port = _gsv_endpoint(base)
    payload = {
        "text": text,
        "text_lang": settings["promptLang"] or "zh",
        "ref_audio_path": settings["referenceAudio"],
        "prompt_text": settings["promptText"],
        "prompt_lang": settings["promptLang"] or "zh",
        "text_split_method": settings["gptSovitsTextSplit"],
        "batch_size": 1,
        "media_type": "wav",
        "streaming_mode": int(settings["gptSovitsStreaming"]),
        "speed_factor": float(settings["gptSovitsSpeed"]),
        "parallel_infer": True,
        "repetition_penalty": 1.35,
    }
    connection = http.client.HTTPConnection(host, port, timeout=180)
    try:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        connection.request(
            "POST",
            "/tts",
            body=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        response = connection.getresponse()
        if response.status != 200:
            detail = response.read().decode("utf-8", "replace")
            raise RuntimeError(f"GPT-SoVITS TTS 失败 ({response.status}): {detail}")

        header = b""
        fmt = None
        data_offset = None
        while data_offset is None:
            chunk = response.read(4096)
            if not chunk:
                raise RuntimeError("GPT-SoVITS 返回的 WAV 没有 data 段")
            header += chunk
            fmt, data_offset = _wav_format(header)
            if len(header) > 2 * 1024 * 1024:
                raise RuntimeError("GPT-SoVITS WAV 头异常")
        if fmt is None:
            raise RuntimeError("GPT-SoVITS 返回的 WAV 缺少 fmt 段")
        _, channels, rate, _, _, bits = fmt
        if bits != 16:
            raise RuntimeError(f"不支持的 GPT-SoVITS 位深: {bits}")
        if channels not in (1, 2):
            raise RuntimeError(f"不支持的 GPT-SoVITS 声道数: {channels}")

        pending = header[data_offset:]
        env = EnvelopeTracker(job_id, rate)
        prebuffer = []
        buffered_frames = 0
        prebuffer_target = int(rate * 0.3)
        while buffered_frames < prebuffer_target:
            if not pending:
                chunk = response.read(4096)
                if not chunk:
                    break
                pending += chunk
                continue
            even = len(pending) - (len(pending) % 2)
            if even <= 0:
                break
            pcm = np.frombuffer(pending[:even], dtype="<i2").astype(np.float32) / 32768.0
            if channels > 1:
                pcm = pcm.reshape(-1, channels)
            env.feed(pcm.ravel())
            prebuffer.append(pcm)
            buffered_frames += pcm.shape[0]
            pending = pending[even:]

        with sd.OutputStream(
            samplerate=rate,
            channels=channels,
            dtype="float32",
            blocksize=1024,
            latency="low",
        ) as stream:
            emit({"type": "play", "id": job_id, "text": text, "streaming": True, "rate": rate})
            for pcm in prebuffer:
                if cancel_event.is_set():
                    return
                stream.write(np.clip(pcm * settings["volume"], -1.0, 1.0))
            while True:
                if cancel_event.is_set():
                    return
                if pending:
                    even = len(pending) - (len(pending) % 2)
                    if even:
                        pcm = np.frombuffer(pending[:even], dtype="<i2").astype(np.float32) / 32768.0
                        if channels > 1:
                            pcm = pcm.reshape(-1, channels)
                        env.feed(pcm.ravel())
                        emit_level(job_id, pcm)
                        stream.write(np.clip(pcm * settings["volume"], -1.0, 1.0))
                    pending = pending[even:]
                chunk = response.read(4096)
                if not chunk:
                    break
                pending += chunk
            env.publish(force=True)
    finally:
        connection.close()


def worker() -> None:
    while True:
        job = jobs.get()
        if job is None:
            return
        cancel_event.clear()
        try:
            # A murmur that waited behind a long reply queue is no longer worth
            # saying; drop it instead of speaking stale chatter.
            ttl = job.get("ttl")
            queued_at = job.get("queuedAt")
            if (
                isinstance(ttl, (int, float))
                and ttl > 0
                and isinstance(queued_at, (int, float))
                and time.time() * 1000 - queued_at > ttl
            ):
                emit({"type": "skipped", "id": job.get("id"), "reason": "expired"})
                continue
            settings = read_settings()
            if not settings["enabled"]:
                emit({"type": "skipped", "id": job.get("id"), "reason": "disabled"})
                continue
            if job.get("source") == "quip":
                scope = settings.get("readMurmurs", "important")
                if scope == "off" or (scope == "important" and job.get("priority") != "high"):
                    emit({"type": "skipped", "id": job.get("id"), "reason": "murmur-scope"})
                    continue
            emit({"type": "start", "id": job.get("id"), "text": job.get("text", "")})
            if settings["provider"] == "gpt-sovits":
                gsv_speak(job.get("text", ""), settings, str(job.get("id") or ""))
            else:
                edge_speak(job.get("text", ""), settings, str(job.get("id") or ""))
            if not cancel_event.is_set():
                emit({"type": "end", "id": job.get("id")})
        except Exception as exc:
            if not cancel_event.is_set():
                log(f"speak failed: {exc}")
                emit({"type": "error", "id": job.get("id"), "message": str(exc)})


def clear_jobs() -> None:
    while True:
        try:
            jobs.get_nowait()
        except queue.Empty:
            return


def main() -> None:
    global worker_thread
    worker_thread = threading.Thread(target=worker, name="voice-worker", daemon=True)
    worker_thread.start()
    settings = read_settings()
    emit({
        "type": "ready",
        "provider": settings["provider"],
        "edge": edge_tts is not None,
        "settings": str(SETTINGS_PATH),
    })
    threading.Thread(target=prewarm_gsv, name="gsv-prewarm", daemon=True).start()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except Exception:
                log("invalid JSON on stdin")
                continue
            kind = message.get("type")
            if kind == "speak":
                # Only the first sentence of a new reply interrupts the
                # previous speech. Later sentences are queued and play in
                # order; cancelling here made the pet speak only the last one.
                if message.get("interrupt") is True:
                    cancel_event.set()
                    try:
                        sd.stop()
                    except Exception:
                        pass
                    clear_jobs()
                emit({"type": "queued", "id": message.get("id")})
                jobs.put(message)
            elif kind == "cancel":
                cancel_event.set()
                clear_jobs()
                try:
                    sd.stop()
                except Exception:
                    pass
            elif kind == "shutdown":
                cancel_event.set()
                clear_jobs()
                try:
                    sd.stop()
                except Exception:
                    pass
                jobs.put(None)
                break
    finally:
        stop_gsv()
    worker_thread.join(timeout=3)


if __name__ == "__main__":
    main()
