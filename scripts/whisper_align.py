#!/usr/bin/env python3
"""
whisper_align.py — retroactively align a cached .wav with faster-whisper
Usage: python3 whisper_align.py <wav_path> <json_path>

Writes [{word, start, end}, ...] to <json_path>.
"""
import sys
import json
from faster_whisper import WhisperModel

wav_path  = sys.argv[1]
json_path = sys.argv[2]

model = WhisperModel('base', device='cpu', compute_type='int8')
segments, _ = model.transcribe(wav_path, word_timestamps=True, language='en')

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

print(f'Aligned {len(word_timings)} words -> {json_path}')
