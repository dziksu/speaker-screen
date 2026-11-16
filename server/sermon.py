"""Small, immutable session hints; never substitute scripture for spoken words."""

from dataclasses import dataclass
import json
import re


POLISH_EDITIONS = {"bw": "Biblia Warszawska", "ubg": "Uwspółcześniona Biblia Gdańska (UBG)"}
ENGLISH_EDITIONS = {"kjv": "King James Version", "mkjv": "Modern King James Version"}

# Only matching terms enter the prompt. These are hints, not text replacements.
# Polish stems handle common inflected forms without rewriting the transcript.
TERMS = (
    (r"\bjustification\b", r"\busprawiedliwieni\w*", "justification", "usprawiedliwienie"),
    (r"\bsanctification\b", r"\buświęceni\w*", "sanctification", "uświęcenie"),
    (r"\bcovenants?\b", r"\bprzymierz\w*", "covenant", "przymierze"),
    (r"\bredemption\b", r"\bodkupieni\w*", "redemption", "odkupienie"),
    (r"\bpropitiation\b", r"\bprzebłagani\w*", "propitiation", "przebłaganie"),
    (r"\bresurrection\b", r"\bzmartwychwstani\w*", "resurrection", "zmartwychwstanie"),
    (r"\brepentance\b", r"\bupamiętani\w*", "repentance", "upamiętanie"),
    (r"\bHoly Spirit\b", r"\bDuch\w* Święt\w*", "Holy Spirit", "Duch Święty"),
    (r"\bgrace\b", r"\błask\w*", "grace", "łaska"),
    (r"\bsalvation\b", r"\bzbawieni\w*", "salvation", "zbawienie"),
    (r"\b(?:book of Job|Job[ ,:]+chapter|turn to Job)\b", r"\bHiob\w*", "Book of Job", "Księga Hioba"),
    (r"\b(?:book of Acts|Acts[ ,:]+chapter|turn to Acts)\b", r"\bDziej\w* Apostolsk\w*", "Book of Acts", "Dzieje Apostolskie"),
)


@dataclass(frozen=True)
class SermonProfile:
    enabled: bool = False
    polish_edition: str = "bw"
    english_edition: str = "kjv"
    names: str = ""
    glossary: tuple = ()  # (Polish, English) pairs, independent of translation direction.

    @classmethod
    def from_config(cls, config):
        if config is None:
            return cls()
        if not isinstance(config, dict) or not isinstance(config.get("enabled", False), bool):
            raise ValueError("Nieprawidłowy profil kazania.")
        polish = config.get("polish_edition", "bw")
        english = config.get("english_edition", "kjv")
        if not isinstance(polish, str) or polish not in POLISH_EDITIONS or not isinstance(english, str) or english not in ENGLISH_EDITIONS:
            raise ValueError("Wybierz obsługiwany przekład Biblii.")
        names = config.get("names", "")
        raw = config.get("glossary", "")
        if not isinstance(names, str) or len(names) > 240 or not isinstance(raw, str) or len(raw) > 1000:
            raise ValueError("Podpowiedzi kazania są zbyt długie (nazwy: 240 znaków, słownik: 1000).")
        pairs = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            parts = [part.strip() for part in line.split("=", 1)]
            if len(parts) != 2 or any(not part or len(part) > 60 for part in parts):
                raise ValueError("Każdy wpis słownika powinien mieć postać: polski termin = English term (do 60 znaków na termin).")
            pairs.append(tuple(parts))
        if len(pairs) > 12:
            raise ValueError("Słownik kazania może zawierać maksymalnie 12 wpisów.")
        return cls(config.get("enabled", False), polish, english, " ".join(names.split()), tuple(pairs))

    def asr_prompt(self, language):
        if not self.enabled:
            return None
        hints = {
            "pl": "Kazanie. Biblia, Jezus Chrystus, Duch Święty, Hiob, Izajasz, apostoł Paweł.",
            "en": "Sermon. Bible, Jesus Christ, Holy Spirit, Job, Isaiah, apostle Paul.",
        }
        # Auto stays automatic; this prompt does not force Whisper's language.
        base = hints.get(language, hints["pl"] + " " + hints["en"] if language == "auto" else "")
        return (base + " " + self.names).strip() or None

    def translation_hints(self, text, source, target):
        if not self.enabled:
            return ""
        edition = POLISH_EDITIONS[self.polish_edition] if target == "pl" else ENGLISH_EDITIONS[self.english_edition] if target == "en" else None
        hints = "This is a spoken Christian sermon. Preserve negation and the speaker's claims. Do not add or complete Bible quotations. "
        if edition:
            hints += f"Terminology reference: {edition}; keep non-quoted speech natural. "
        terms = []
        if (source, target) in {("en", "pl"), ("pl", "en")}:
            for en_pattern, pl_pattern, en, pl in TERMS:
                if re.search(en_pattern if source == "en" else pl_pattern, text, re.IGNORECASE):
                    terms.append((en, pl) if source == "en" else (pl, en))
            # Custom preferences come last and override the default term hint.
            for pl, en in self.glossary:
                left, right = (en, pl) if source == "en" else (pl, en)
                if re.search(r"(?<!\w)" + re.escape(left) + r"(?!\w)", text, re.IGNORECASE):
                    terms = [pair for pair in terms if pair[0].casefold() != left.casefold()]
                    terms.append((left, right))
        if terms:
            # JSON quotes preserve the boundary between term data and instructions.
            glossary = "; ".join(f"{json.dumps(a, ensure_ascii=False)} -> {json.dumps(b, ensure_ascii=False)}" for a, b in terms)
            hints += f"Use this terminology where relevant, with natural grammatical inflection: {glossary}. "
        return hints
