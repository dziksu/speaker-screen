import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from server.app import app, engine, translator
from tests.test_audio import tone


class WebsocketTests(unittest.TestCase):
    def setUp(self):
        engine.state = 'ready'
        preparation = patch.object(engine, 'prepare', new_callable=AsyncMock)
        shutdown = patch.object(engine.executor, 'shutdown')
        preparation.start()
        shutdown.start()
        self.addCleanup(preparation.stop)
        self.addCleanup(shutdown.stop)
        for method in ('prepare', 'check', 'close'):
            mocked = patch.object(translator, method, new_callable=AsyncMock, return_value={'state': 'ready'})
            mocked.start()
            self.addCleanup(mocked.stop)

    def test_stop_drains_last_audio_and_releases_microphone(self):
        async def recognize(audio, language):
            await asyncio.sleep(0.01)
            return {'text': 'To jest test.', 'language': language, 'elapsed_ms': 10}

        with patch.object(engine, 'transcribe', side_effect=recognize), TestClient(app) as client:
            engine.state = 'ready'
            with client.websocket_connect('/ws') as ws:
                ws.send_json({'language': 'pl', 'target_language': 'off', 'threshold': 0.008})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                data = (tone() * 32767).astype('<i2').tobytes()
                for _ in range(6):
                    ws.send_bytes(data)
                ws.send_json({'type': 'stop'})
                result = ws.receive_json()
                self.assertEqual(result['text'], 'To jest test.')
                self.assertTrue(result['final'])
                self.assertEqual(ws.receive_json()['type'], 'stopped')
            self.assertFalse(client.get('/api/status').json()['busy'])

    def test_other_origin_is_rejected(self):
        from starlette.websockets import WebSocketDisconnect
        with TestClient(app) as client:
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/ws', headers={'origin': 'https://unrelated.example'}):
                    pass

    def test_sermon_profile_reaches_asr_and_translation_without_forcing_language(self):
        from server.sermon import SermonProfile
        config = {'enabled': True, 'polish_edition': 'ubg', 'english_edition': 'mkjv', 'names': 'Habakuk', 'glossary': 'przymierze = covenant'}
        with patch.object(engine, 'transcribe', new_callable=AsyncMock, return_value={'text': 'Przymierze.', 'language': 'pl', 'elapsed_ms': 1}) as recognize, patch.object(translator, 'translate', new_callable=AsyncMock, return_value={'text': 'Covenant.', 'elapsed_ms': 1}) as translate, TestClient(app) as client:
            with client.websocket_connect('/ws') as ws:
                ws.send_json({'language': 'auto', 'target_language': 'en', 'sermon': config})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                for _ in range(6):
                    ws.send_bytes((tone() * 32767).astype('<i2').tobytes())
                ws.send_json({'type': 'stop'})
                self.assertEqual(ws.receive_json()['type'], 'transcript')
                self.assertEqual(ws.receive_json()['text'], 'Covenant.')
                self.assertEqual(ws.receive_json()['type'], 'stopped')
            self.assertEqual(recognize.call_args.args[1], 'auto')
            self.assertIn('Habakuk', recognize.call_args.kwargs['initial_prompt'])
            translate.assert_awaited_once_with('Przymierze.', 'pl', 'en', profile=SermonProfile.from_config(config))

    def test_invalid_sermon_profile_is_reported_before_starting(self):
        with TestClient(app) as client:
            with client.websocket_connect('/ws') as ws:
                ws.send_json({'sermon': {'enabled': True, 'glossary': 'bad entry'}})
                event = ws.receive_json()
                self.assertEqual(event['type'], 'error')
                self.assertIn('słownika', event['message'])

    def test_invalid_audio_is_reported(self):
        with TestClient(app) as client:
            engine.state = 'ready'
            with client.websocket_connect('/ws') as ws:
                ws.send_json({'language': 'pl', 'target_language': 'off'})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                ws.send_bytes(b'odd')
                self.assertEqual(ws.receive_json()['type'], 'error')

    def test_stop_waits_for_final_translation_without_delaying_original(self):
        async def recognize(audio, language):
            return {'text': 'Pierwsze zdanie. To jest ostatnie zdanie.', 'language': 'pl', 'elapsed_ms': 1}

        async def translate(text, source, target):
            await asyncio.sleep(0.02)
            return {'text': 'First sentence. This is the last sentence.', 'elapsed_ms': 20}

        with patch.object(engine, 'transcribe', side_effect=recognize), patch.object(translator, 'translate', side_effect=translate) as call, TestClient(app) as client:
            engine.state = 'ready'
            with client.websocket_connect('/ws') as ws:
                ws.send_json({'language': 'auto', 'target_language': 'en'})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                data = (tone() * 32767).astype('<i2').tobytes()
                for _ in range(6):
                    ws.send_bytes(data)
                ws.send_json({'type': 'stop'})
                original = ws.receive_json()
                self.assertEqual(original['type'], 'transcript')
                self.assertEqual(original['sentences'][-1], 'To jest ostatnie zdanie.')
                translated = ws.receive_json()
                self.assertEqual(translated['type'], 'translation')
                self.assertEqual(translated['sentence_index'], 0)
                self.assertEqual(translated['source_text'], original['text'])
                self.assertTrue(translated['final'])
                self.assertEqual(ws.receive_json()['type'], 'stopped')
                call.assert_awaited_once_with('Pierwsze zdanie. To jest ostatnie zdanie.', 'pl', 'en')

    def test_translation_failure_preserves_original_and_finishes_session(self):
        from server.translation import TranslationUnavailable
        async def recognize(audio, language):
            return {'text': 'Test napisów.', 'language': 'pl', 'elapsed_ms': 1}

        with patch.object(engine, 'transcribe', side_effect=recognize), patch.object(translator, 'translate', new_callable=AsyncMock, side_effect=TranslationUnavailable('Ollama offline')), TestClient(app) as client:
            engine.state = 'ready'
            with client.websocket_connect('/ws') as ws:
                ws.send_json({'target_language': 'en'})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                for _ in range(6):
                    ws.send_bytes((tone() * 32767).astype('<i2').tobytes())
                ws.send_json({'type': 'stop'})
                self.assertEqual(ws.receive_json()['text'], 'Test napisów.')
                self.assertEqual(ws.receive_json()['type'], 'translation_error')
                self.assertEqual(ws.receive_json()['type'], 'stopped')


if __name__ == '__main__':
    unittest.main()
