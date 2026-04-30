#!/usr/bin/env python3
"""
Kokoro TTS helper — called by build-video.js
Usage: python3 tts.py <text> <voice> <output.wav>

Outputs:
  <output.wav>   — synthesized audio
  <output>.json  — word-level timing sidecar: [{word, start, end}, ...]
"""
import sys
import json
import os
import re
import numpy as np
import soundfile as sf
from kokoro import KPipeline

SAMPLE_RATE = 24000

text        = sys.argv[1].replace('\n', ' ').strip()  # flatten newlines for natural reading
voice       = sys.argv[2]
output_path = sys.argv[3]

# ── Pronunciation substitutions ────────────────────────────────────────────────
# Load input/pronounce.json (next to input/book.txt) and replace words that the
# TTS mispronounces with phonetic equivalents before synthesis.
# Each replacement must be a single word (no spaces) so word-count stays the
# same and karaoke highlight alignment remains correct.
_pronounce_path = os.path.join(os.path.dirname(__file__), '..', 'input', 'pronounce.json')
if os.path.exists(_pronounce_path):
    with open(_pronounce_path, 'r', encoding='utf-8') as _f:
        _pronounce_map = json.load(_f)
    for _word, _replacement in sorted(_pronounce_map.items(), key=lambda x: -len(x[0])):
        text = re.sub(r'\b' + re.escape(_word) + r'\b', _replacement, text, flags=re.IGNORECASE)
json_path   = os.path.splitext(output_path)[0] + '.json'

# Write silence + empty timing if there is no text to speak
if not text:
    sf.write(output_path, np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump([], f)
    sys.exit(0)

pipeline = KPipeline(lang_code='a', trf=False)  # trf=False reduces memory usage

chunks = []
for gs, _, audio in pipeline(text, voice=voice, speed=0.75):
    chunks.append(np.array(audio))

if not chunks:
    sf.write(output_path, np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump([], f)
    sys.exit(0)

audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

# Normalize to 95% of max amplitude so it's as loud as possible without clipping
peak = np.max(np.abs(audio))
if peak > 0:
    audio = audio / peak * 0.95

sf.write(output_path, audio, SAMPLE_RATE)

# ── Word-level alignment via faster-whisper ─────────────────────────────────────
from faster_whisper import WhisperModel

model = WhisperModel('base', device='cpu', compute_type='int8')
segments, _ = model.transcribe(output_path, word_timestamps=True, language='en')

word_timings = []
for segment in segments:
    for word in (segment.words or []):
        word_timings.append({
            'word':  word.word.strip(),
            'start': round(word.start, 3),
            'end':   round(word.end,   3),
        })

with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(word_timings, f, ensure_ascii=False)
