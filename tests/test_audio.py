import unittest
import numpy as np

from server.audio import AudioJob, JobQueue, SAMPLE_RATE, Segmenter


def tone(duration=0.1):
    return (np.sin(np.arange(round(SAMPLE_RATE * duration)) * (2 * np.pi * 220 / SAMPLE_RATE)) * 0.1).astype(np.float32)


class SegmentationTests(unittest.TestCase):
    def test_silence_does_not_trigger_whisper(self):
        segmenter = Segmenter()
        for _ in range(1000):
            self.assertEqual(segmenter.push(np.zeros(1600, dtype=np.float32)), [])
        self.assertEqual(segmenter.flush(), [])
        self.assertLessEqual(len(segmenter.preroll), 3)

    def test_pause_finalizes_and_resets(self):
        segmenter = Segmenter()
        jobs = []
        for _ in range(18):
            jobs.extend(segmenter.push(tone()))
        for _ in range(8):
            jobs.extend(segmenter.push(np.zeros(1600, dtype=np.float32)))
        self.assertTrue(any(not j.final for j in jobs))
        self.assertTrue(jobs[-1].final)
        self.assertEqual(jobs[-1].id, 1)
        self.assertEqual(len(jobs[-1].audio), 41600)
        for _ in range(5):
            segmenter.push(tone())
        self.assertEqual(segmenter.flush()[0].id, 2)

    def test_stop_flushes_unfinished_speech_but_not_a_click(self):
        segmenter = Segmenter()
        segmenter.push(tone())
        self.assertEqual(segmenter.flush(), [])
        for _ in range(6):
            segmenter.push(tone())
        self.assertTrue(segmenter.flush()[0].final)
        self.assertEqual(segmenter.flush(), [])

    def test_uninterrupted_speech_is_bounded(self):
        segmenter = Segmenter(max_seconds=3)
        jobs = []
        for _ in range(100):
            jobs.extend(segmenter.push(tone()))
        finals = [j for j in jobs if j.final]
        self.assertEqual(len(finals), 3)
        self.assertTrue(all(len(j.audio) <= 3 * SAMPLE_RATE for j in finals))

    def test_dc_offset_does_not_open_gate(self):
        segmenter = Segmenter()
        for _ in range(20):
            self.assertEqual(segmenter.push(np.full(1600, 0.5, dtype=np.float32)), [])

    def test_queue_coalesces_drafts_and_preserves_finals(self):
        queue = JobQueue(limit=2)
        data = tone()
        queue.put(AudioJob(1, 1, data, False))
        queue.put(AudioJob(1, 2, data, False))
        queue.put(AudioJob(1, 3, data, True))
        queue.put(AudioJob(2, 1, data, False))
        self.assertEqual(len(queue.items), 2)
        self.assertTrue(queue.pop().final)
        queue.put(AudioJob(3, 1, data, True))
        with self.assertRaises(OverflowError):
            queue.put(AudioJob(4, 1, data, True))


if __name__ == '__main__':
    unittest.main()
