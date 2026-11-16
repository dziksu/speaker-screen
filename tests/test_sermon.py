import unittest
from unittest.mock import patch
import sys

import numpy as np

from server.engine import WhisperEngine
from server.sermon import SermonProfile


class SermonTests(unittest.TestCase):
    def test_book_and_employment_hints_do_not_collide(self):
        profile = SermonProfile(enabled=True)
        self.assertIn('Księga Hioba', profile.translation_hints('Turn to Job, chapter three.', 'en', 'pl'))
        self.assertNotIn('Hioba', profile.translation_hints('He lost his job.', 'en', 'pl'))
        self.assertNotIn('covenant', profile.translation_hints('He lost his job.', 'en', 'pl'))

    def test_custom_terminology_reverses_direction_and_takes_precedence(self):
        profile = SermonProfile.from_config({'enabled': True, 'glossary': 'pokuta = repentance'})
        en = profile.translation_hints('A call to repentance.', 'en', 'pl')
        self.assertIn('"repentance" -> "pokuta"', en)
        self.assertNotIn('upamiętanie', en)
        pl = profile.translation_hints('Pokuta jest tematem kazania.', 'pl', 'en')
        self.assertIn('"pokuta" -> "repentance"', pl)
        self.assertNotIn('pokuta', profile.translation_hints('A call to repentance.', 'en', 'de'))

    def test_selection_is_a_target_language_reference_and_not_a_scripture_substitution(self):
        profile = SermonProfile.from_config({'enabled': True, 'polish_edition': 'ubg', 'english_edition': 'mkjv'})
        self.assertIn('UBG', profile.translation_hints('Hello', 'en', 'pl'))
        self.assertIn('Modern King James Version', profile.translation_hints('Witaj', 'pl', 'en'))
        self.assertIn('Do not add or complete Bible quotations', profile.translation_hints('Hello', 'en', 'pl'))
        off = SermonProfile()
        self.assertIsNone(off.asr_prompt('auto'))
        self.assertEqual(off.translation_hints('covenant', 'en', 'pl'), '')

    def test_config_rejects_invalid_and_unbounded_inputs(self):
        for value in [[], {'enabled': 'true'}, {'polish_edition': []}, {'english_edition': 'unknown'}, {'names': 'a' * 241}, {'glossary': 'missing separator'}, {'glossary': '\n'.join(['a = b'] * 13)}, {'glossary': 'a = ' + 'b' * 61}]:
            with self.subTest(config=value), self.assertRaises(ValueError):
                SermonProfile.from_config(value)

    def test_asr_hints_preserve_automatic_language_and_do_not_enable_previous_text(self):
        profile = SermonProfile.from_config({'enabled': True, 'names': 'Melchizedek, Habakuk'})
        fake = type('MLX', (), {'transcribe': lambda *args, **kwargs: None})()
        engine = WhisperEngine()
        try:
            with patch.dict(sys.modules, {'mlx_whisper': fake}), patch.object(fake, 'transcribe', return_value={'segments': [], 'language': 'pl'}) as transcribe:
                engine._transcribe(np.zeros(1600), 'auto', profile.asr_prompt('auto'))
                self.assertIsNone(transcribe.call_args.kwargs['language'])
                self.assertFalse(transcribe.call_args.kwargs['condition_on_previous_text'])
                self.assertIn('Habakuk', transcribe.call_args.kwargs['initial_prompt'])
        finally:
            engine.executor.shutdown()
