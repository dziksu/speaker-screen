# Speaker Screen — instrukcje dla agentów

Speaker Screen wyświetla oryginał i tłumaczenie mowy na żywo, także w osobnych oknach projekcji. Frontend to HTML, CSS i moduły JavaScript serwowane przez FastAPI. Rozpoznawanie działa lokalnie przez Whisper large-v3-turbo w MLX, a tłumaczenie przez TranslateGemma w Ollama. [README.md](README.md) opisuje obsługę aplikacji i konfigurację sprzętu.

## Uruchamianie i diagnostyka

- Pełna aplikacja wymaga Maca z Apple Silicon, macOS 14 lub nowszego i Pythona 3.11–3.13. Na przygotowanym komputerze uruchom `rtk proxy ./start.sh` z katalogu repozytorium i otwórz `http://localhost:8765/`. Frontend nie ma etapu budowania. Jeśli w środowisku brakuje RTK, wykonaj polecenia bez wrappera.
- Na nowym Macu `rtk proxy ./setup.sh` tworzy `.venv` i pobiera wagi Whispera. Do tłumaczenia uruchom lokalną Ollama, a następnie wykonaj `rtk proxy ./setup-translation.sh`, który pobiera domyślny model `translategemma:4b`. Jeżeli środowisko i modele już istnieją, użyj ich ponownie.
- `GET /api/status` pokazuje stan Whispera, stan tłumacza i pole `busy`. Sprawdź je przed restartem lub testem z audio, żeby nie przerwać aktywnego nasłuchu. W razie potrzeby uruchom testową instancję z `PORT=8766`. Każdy proces serwera ładuje własną kopię wag, więc uruchamiaj pojedynczego workera Uvicorn na instancję.
- Jeśli brakuje wag Whispera, sprawdź `.models/whisper-large-v3-turbo` lub `WHISPER_MODEL_PATH`. Jeśli działa oryginał, ale brak tłumaczenia, sprawdź lokalny proces Ollama i `ollama list`. Domyślny adres Ollama to `http://127.0.0.1:11434`. `OLLAMA_URL` przyjmuje lokalny adres HTTP, a `TRANSLATION_MODEL` zmienia nazwę modelu.

## Mapa kodu

| Obszar | Pliki |
| --- | --- |
| Sterowanie sesją, mikrofon i wygląd | `web/app.js`, `web/index.html`, `web/styles.css` |
| Przesyłanie audio i rozpoznawanie mowy | `web/audio-worklet.js`, `server/app.py`, `server/audio.py`, `server/engine.py` |
| Kolejka tłumaczeń i przypisywanie wyników | `server/translation.py`, `web/captions.js`, `web/app.js` |
| Profil kazania i własny słownik | `server/sermon.py`, `web/sermon.js` |
| Synchronizacja okien projekcji | `web/projection.js`, `web/app.js` |

## Zachowanie, które trzeba zachować przy zmianach

- `/ws` przyjmuje PCM16, mono, 16 kHz. Obsługuj jeden aktywny mikrofon na backend. Domyślny język mowy to `auto`. Błąd tłumacza powinien pozostawić działający oryginał i komunikat przy właściwym fragmencie.
- Nowsza wersja robocza może zastąpić starszą wersję tego samego fragmentu. Końcowe fragmenty zachowuj w kolejności. Spóźnione tłumaczenie przypisz do oryginalnego fragmentu po jego identyfikatorze i rewizji. Stop domyka ostatni fragment i czeka na tłumaczenia w kolejce, zanim serwer wyśle `stopped`.
- Historia zostaje w pamięci karty do wyczyszczenia lub odświeżenia. Zachowaj niezależne rozmiary tekstu oraz proporcjonalne szerokości kolumn na szerokim ekranie. Ekrany projekcji dostają stan i historię z panelu sterowania przez `BroadcastChannel` lub `postMessage`. Działają bez własnego mikrofonu i połączenia z backendem. Zachowaj też ręczne przenoszenie okna na drugi monitor, gdy wykrywanie ekranów jest niedostępne.
- Profil kazania przekazuje wskazówki terminologiczne. Zachowuj sens wypowiedzi, przeczenia i treść parafraz. Nie podstawiaj tekstu wersetu ani nie uzupełniaj cytatu na podstawie wybranego przekładu. Reguły i limity własnego słownika zmieniaj spójnie w `web/sermon.js` i `server/sermon.py`.
- Audio i napisy przetwarzaj lokalnie. Preferencje interfejsu są zapisywane w przeglądarce. Mikrofon w przeglądarce wymaga localhost lub HTTPS. Serwer domyślnie nasłuchuje na `127.0.0.1`.

## Sprawdzanie zmian

```sh
rtk proxy .venv/bin/python -m unittest discover -v
rtk npm test
```

Testy automatyczne nie wymagają GPU, wag ani działającej Ollama. Node.js jest potrzebny do testów JavaScript. Dobierz test do zakresu zmiany, np. `tests/test_app.py` dla protokołu WebSocket, `tests/test_translation.py` dla kolejki lub `tests/projection.test.js` dla synchronizacji okien.

- Interfejs sprawdzaj na działającym localhost. Demo pozwala przejść przez wyświetlanie napisów, tryby projekcji i przewijanie historii bez mikrofonu. Po edycji plików odśwież kartę testową. Odświeżenie panelu operatora usuwa historię i rozłącza projekcje.
- Zmiany w przepływie audio sprawdzaj z działającym serwerem i plikiem WAV w formacie PCM16 mono 16 kHz. Polecenie `rtk proxy .venv/bin/python scripts/smoke_transcription.py /sciezka/do/probki.wav` sprawdza przejście przez `/ws` do końcowej transkrypcji i tłumaczenia. Opcja `--target-language off` pozwala sprawdzić sam Whisper.
- Zmiany podpowiedzi kazania porównaj przez `rtk proxy .venv/bin/python scripts/benchmark_sermon.py` przy działającej Ollama. Skrypt porównuje wyniki na krótkich przykładach tekstowych i zapisuje je w `test-results/`.

## Git

Przed commitem sprawdź `rtk git status --short --branch` i `rtk git diff --check`. Dodawaj jawnie pliki związane z zadaniem. Modele, `.venv/`, `.env` i `test-results/` są lokalne. Gdy użytkownik zleci push na `main`, użyj skonfigurowanego `origin` po SSH i zwykłego `rtk git push origin main`.
