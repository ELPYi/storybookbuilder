#!/usr/bin/env python3
"""
whisper_align.py — align a .wav to lyrics using stable-ts forced alignment
Usage: python3 whisper_align.py <wav_path> <json_path> [lyrics_text]

When lyrics_text is provided, uses forced alignment (much more accurate for
unusual words and repeated sections). Falls back to plain transcription if no
lyrics are given.

Writes [{word, start, end}, ...] to <json_path>.
"""
import sys
import json
import stable_whisper

wav_path    = sys.argv[1]
json_path   = sys.argv[2]
lyrics_text = sys.argv[3] if len(sys.argv) > 3 else None

model = stable_whisper.load_faster_whisper('base', device='cuda', compute_type='float16')

if lyrics_text:
    result = model.align(wav_path, lyrics_text, language='en')
else:
    result = model.transcribe(wav_path, word_timestamps=True, language='en')

word_timings = []
for segment in result.segments:
    for word in (segment.words or []):
        word_timings.append({
            'word':  word.word.strip(),
            'start': round(word.start, 3),
            'end':   round(word.end,   3),
        })

with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(word_timings, f, ensure_ascii=False)

print(f'Aligned {len(word_timings)} words -> {json_path}')
