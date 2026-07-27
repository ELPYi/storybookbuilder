#!/usr/bin/env python3
"""
tts_batch.py — synthesize all pages in one Python process (load model once)
Usage: python tts_batch.py <jobs.json>
jobs.json: [{"text": "...", "voice": "...", "output": "path/to/tts_NN.wav"}, ...]
Each job writes <output>.wav and <output>.json (word timings).
"""
import sys
import json
import os
import re
import numpy as np
import soundfile as sf
from kokoro import KPipeline
from faster_whisper import WhisperModel

SAMPLE_RATE = 24000

jobs_path = sys.argv[1]
with open(jobs_path, 'r', encoding='utf-8') as f:
    jobs = json.load(f)

_pronounce_path = os.path.join(os.path.dirname(__file__), '..', 'input', 'pronounce.json')
_pronounce_map = {}
if os.path.exists(_pronounce_path):
    with open(_pronounce_path, 'r', encoding='utf-8') as f:
        _pronounce_map = json.load(f)

def apply_pronunciations(text):
    for word, replacement in sorted(_pronounce_map.items(), key=lambda x: -len(x[0])):
        text = re.sub(r'\b' + re.escape(word) + r'\b', replacement, text, flags=re.IGNORECASE)
    return text

print(f'Loading models...', flush=True)
pipeline = KPipeline(lang_code='a', trf=True, device='cuda')
whisper  = WhisperModel('base', device='cuda', compute_type='float16')
print(f'Models ready. Synthesizing {len(jobs)} page(s)...', flush=True)

for i, job in enumerate(jobs):
    text        = apply_pronunciations(job['text'].replace('\n', ' ').strip())
    voice       = job['voice']
    output_path = job['output']
    json_path   = os.path.splitext(output_path)[0] + '.json'

    print(f'  Page {i + 1}/{len(jobs)} — TTS...', end=' ', flush=True)

    if not text:
        sf.write(output_path, np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump([], f)
        print('(empty)', flush=True)
        continue

    chunks = [np.array(audio) for _, _, audio in pipeline(text, voice=voice, speed=0.75)]

    if not chunks:
        sf.write(output_path, np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump([], f)
        print('(no output)', flush=True)
        continue

    audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
    peak = np.max(np.abs(audio))
    if peak > 0:
        audio = audio / peak * 0.95
    sf.write(output_path, audio, SAMPLE_RATE)

    print('aligning...', end=' ', flush=True)
    segments, _ = whisper.transcribe(output_path, word_timestamps=True, language='en')
    word_timings = [
        {'word': w.word.strip(), 'start': round(w.start, 3), 'end': round(w.end, 3)}
        for seg in segments for w in (seg.words or [])
    ]
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(word_timings, f, ensure_ascii=False)
    print('done', flush=True)

print('Batch TTS complete.', flush=True)
