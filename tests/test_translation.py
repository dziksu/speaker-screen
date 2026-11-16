import asyncio
import json
import unittest
from unittest.mock import AsyncMock

import httpx

from server.translation import OllamaTranslator, TranslationJob, TranslationPipeline, TranslationUnavailable, display_sentences


class TranslationTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_api_prompt_response_and_bounded_context(self):
        requests = []
        def handle(request):
            requests.append(request)
            if request.url.path == '/api/tags':
                return httpx.Response(200, json={'models': [{'name': 'translategemma:4b'}]})
            payload = json.loads(request.content)
            self.assertEqual(payload['options']['num_ctx'], 2048)
            self.assertFalse(payload['stream'])
            self.assertIn('Polish (pl) to English (en)', payload['messages'][0]['content'])
            self.assertTrue(payload['messages'][0]['content'].endswith('\n\n\nDzień dobry.'))
            return httpx.Response(200, json={'message': {'content': 'Good morning.'}, 'done_reason': 'stop'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url='http://localhost:11434') as client:
            translator = OllamaTranslator(client)
            result = await translator.translate('Dzień dobry.', 'pl', 'en')
            self.assertEqual(result['text'], 'Good morning.')
            self.assertEqual(len(requests), 2)

    async def test_same_language_skips_inference_even_when_service_is_offline(self):
        translator = OllamaTranslator()
        translator.check = AsyncMock(side_effect=AssertionError('No request expected'))
        self.assertEqual((await translator.translate('Hello.', 'en', 'en'))['text'], 'Hello.')

    async def test_missing_model_is_actionable(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'models': []})), base_url='http://localhost:11434') as client:
            translator = OllamaTranslator(client)
            with self.assertRaisesRegex(TranslationUnavailable, 'ollama pull'):
                await translator.translate('Dzień dobry.', 'pl', 'en')

    async def test_pipeline_coalesces_drafts_and_drains_final(self):
        entered, release = asyncio.Event(), asyncio.Event()
        seen, output = [], []
        async def translate(text, source, target):
            seen.append(text)
            if len(seen) == 1:
                entered.set()
                await release.wait()
            return {'text': text.upper(), 'elapsed_ms': 1}
        translator = type('Translator', (), {'translate': AsyncMock(side_effect=translate)})()
        async def send(event):
            output.append(event)
        pipeline = TranslationPipeline(translator, send, min_interval=0)
        pipeline.submit(TranslationJob(1, 0, 1, 'pierwsze zdanie jest w trakcie', 'pl', 'en', False))
        worker = asyncio.create_task(pipeline.run())
        await entered.wait()
        for revision in range(2, 30):
            pipeline.submit(TranslationJob(1, 0, revision, f'pomijana wersja numer {revision}', 'pl', 'en', False))
        pipeline.submit(TranslationJob(1, 1, 30, 'ostateczne zdanie', 'pl', 'en', True))
        pipeline.finish()
        release.set()
        await worker
        self.assertEqual(seen, ['pierwsze zdanie jest w trakcie', 'ostateczne zdanie'])
        self.assertTrue(output[-1]['final'])
        self.assertEqual(output[-1]['sentence_index'], 1)

    async def test_every_final_fragment_is_translated_when_speaker_gets_ahead(self):
        entered, release = asyncio.Event(), asyncio.Event()
        output = []
        async def translate(text, source, target):
            entered.set()
            await release.wait()
            return {'text': text.upper(), 'elapsed_ms': 1}
        translator = type('Translator', (), {'translate': AsyncMock(side_effect=translate)})()
        async def send(event):
            output.append(event)
        pipeline = TranslationPipeline(translator, send, min_interval=0)
        pipeline.submit(TranslationJob(1, 0, 1, 'Pierwszy fragment. Drugie zdanie.', 'pl', 'en', True))
        worker = asyncio.create_task(pipeline.run())
        await entered.wait()
        for index in range(2, 9):
            pipeline.submit(TranslationJob(index, 0, 1, f'Fragment {index}.', 'pl', 'en', True))
        pipeline.finish()
        release.set()
        await worker
        self.assertEqual([event['id'] for event in output], list(range(1, 9)))
        self.assertEqual(output[0]['source_text'], 'Pierwszy fragment. Drugie zdanie.')
        self.assertTrue(all(event['final'] for event in output))

    def test_display_rows_match_translation_index_with_long_and_cjk_text(self):
        self.assertEqual(display_sentences('To pierwsze. To drugie!'), ['To pierwsze.', 'To drugie!'])
        self.assertEqual(display_sentences('你好。世界！'), ['你好。', '世界！'])
        self.assertEqual(len(display_sentences(' '.join(['słowo'] * 60))), 3)
