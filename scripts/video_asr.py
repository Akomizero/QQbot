"""Bounded local speech transcription. No network, cookies or model API keys."""
import argparse
import json
import wave
import numpy as np
from pathlib import Path
from faster_whisper import WhisperModel

parser = argparse.ArgumentParser()
parser.add_argument("audio")
parser.add_argument("--model", required=True)
args = parser.parse_args()
model = WhisperModel(str(Path(args.model).resolve()), device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)
with wave.open(args.audio, "rb") as wav:
    if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2 or wav.getnframes() > 16000 * 1801:
        raise ValueError("Expected bounded 16 kHz mono PCM")
    audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
segments, info = model.transcribe(audio, beam_size=3, vad_filter=True, condition_on_previous_text=False,
                                 no_speech_threshold=0.6, log_prob_threshold=-1.0,
                                 compression_ratio_threshold=2.4, hallucination_silence_threshold=2)
result = []
characters = 0
for segment in segments:
    text = segment.text.strip()
    if not text or segment.no_speech_prob > 0.6 or segment.avg_logprob < -1.0:
        continue
    characters += len(text)
    if characters > 40000:
        break
    result.append({"from": round(segment.start, 2), "to": round(segment.end, 2), "content": text})
print(json.dumps({"language": info.language, "segments": result}, ensure_ascii=False))
