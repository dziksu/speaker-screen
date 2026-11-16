"""Compare local prompts on authored text, without recording or model downloads."""

import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.sermon import SermonProfile
from server.translation import OllamaTranslator


CASES = [
    ("en", "pl", "Let us turn to Job, chapter three."),
    ("en", "pl", "He lost his job, yet he continued to trust God."),
    ("en", "pl", "Justification and sanctification are not interchangeable terms."),
    ("en", "pl", "The new covenant is not the same as the old covenant."),
    ("pl", "en", "Otwórzmy Dzieje Apostolskie, rozdział drugi."),
    ("pl", "en", "Odkupienie i przebłaganie to dwa różne pojęcia."),
    ("pl", "en", "Zbawienie z łaski nie oznacza zgody na grzech."),
    ("pl", "en", "Nie twierdzę, że ten fragment jest obietnicą bogactwa."),
]


async def main():
    translator = OllamaTranslator()
    rows = []
    try:
        await translator.prepare()
        for source, target, text in CASES:
            baseline = await translator.translate(text, source, target)
            sermon = await translator.translate(text, source, target, profile=SermonProfile(enabled=True))
            row = {"source": source, "target": target, "input": text, "baseline": baseline, "sermon": sermon}
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
        path = Path(__file__).resolve().parent.parent / "test-results" / "sermon-production-benchmark.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
    finally:
        await translator.close()


if __name__ == "__main__":
    asyncio.run(main())
