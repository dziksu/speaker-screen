"""Send a 16 kHz PCM16 mono WAV in real time through the actual WebSocket API."""
import argparse
import asyncio
import json
import time
import wave

from websockets.asyncio.client import connect


async def run(path, url, language, target_language):
    with wave.open(path, 'rb') as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
            raise ValueError('Wymagane WAV PCM16, mono, 16000 Hz.')
        frames = audio.readframes(audio.getnframes())
    async with connect(url) as ws:
        await ws.send(json.dumps({'type': 'start', 'language': language, 'target_language': target_language, 'threshold': 0.008}))
        ready = json.loads(await ws.recv())
        if ready['type'] != 'ready':
            raise RuntimeError(ready)
        started = time.perf_counter()
        final_text = []
        runtimes = []
        translations = []
        final_ids = set()

        async def receive():
            async for raw in ws:
                result = json.loads(raw)
                if result['type'] == 'error':
                    raise RuntimeError(result['message'])
                if result['type'] == 'stopped':
                    return
                if result['type'] == 'transcript':
                    print(json.dumps({'received_after_s': round(time.perf_counter() - started, 2), **result}, ensure_ascii=False), flush=True)
                    runtimes.append(result['elapsed_ms'])
                    if result['final']:
                        final_text.append(result['text'])
                        if result['text']:
                            final_ids.add(result['id'])
                elif result['type'] in {'translation', 'translation_error'}:
                    print(json.dumps({'received_after_s': round(time.perf_counter() - started, 2), **result}, ensure_ascii=False), flush=True)
                    if result['type'] == 'translation':
                        translations.append(result)

        collector = asyncio.create_task(receive())
        # Respect the audio clock, including the final sub-100ms packet.
        for offset in range(0, len(frames), 3200):
            await ws.send(frames[offset:offset + 3200])
            await asyncio.sleep(len(frames[offset:offset + 3200]) / 32000)
        await ws.send(json.dumps({'type': 'stop'}))
        await asyncio.wait_for(collector, timeout=60)
        print(json.dumps({'final_text': ' '.join(final_text), 'mean_inference_ms': round(sum(runtimes) / max(1, len(runtimes))), 'last_translation': translations[-1]['text'] if translations else None}, ensure_ascii=False))
        if not any(final_text):
            raise RuntimeError('Brak rozpoznanego tekstu.')
        translated_ids = {result['id'] for result in translations if result['final']}
        if target_language != 'off' and not final_ids.issubset(translated_ids):
            raise RuntimeError(f'Brak końcowego tłumaczenia fragmentów: {final_ids - translated_ids}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('wav')
    parser.add_argument('--url', default='ws://localhost:8765/ws')
    parser.add_argument('--language', default='auto')
    parser.add_argument('--target-language', default='en')
    args = parser.parse_args()
    asyncio.run(run(args.wav, args.url, args.language, args.target_language))
