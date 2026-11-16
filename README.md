# Speaker Screen

Lokalny prototyp napisów i tłumaczenia na żywo dla publiczności, która nie zna języka mówcy. Główny obszar pokazuje duże, białe tłumaczenie na czarnym tle. Na szerokim ekranie oryginał jest po lewej, a tłumaczenie po prawej, w dwóch wysokich kolumnach rozdzielonych subtelną linią. Na wąskich ekranach sekcje układają się jedna pod drugą. Kolejne fragmenty są dopisywane w obu obszarach; wcześniejszy tekst jest delikatnie szary i pozostaje w przewijanej historii. Tylko najnowsze zdanie w każdym obszarze jest białe. Odstępy między akapitami są kompaktowe.

Frontend to aplikacja webowa bez frameworka i bez budowania. Backend działa natywnie w Pythonie: FastAPI, WebSocket i **MLX na Apple Silicon**. Ciężkie obliczenia wykonuje Whisper na GPU przez MLX, na jednym osobnym wątku. Przeglądarka przesyła surowe PCM16 (16 kHz, mono); nie kodujemy audio do WebM i nie uruchamiamy ffmpeg dla kolejnych fragmentów.

## Uruchomienie

Wymagania: Mac z Apple Silicon, macOS 14 lub nowszy, Python 3.11–3.13 oraz aktualna przeglądarka (Chrome/Edge zalecane do pełnego ekranu). Zależności MLX muszą obsługiwać używaną wersję systemu/Pythona. Do tłumaczenia potrzebna jest również lokalna Ollama z modelem TranslateGemma 4B. Na tym komputerze środowisko i oba modele są już przygotowane.

```sh
./start.sh
```

Otwórz **http://localhost:8765**, zaczekaj na zielony status modelu, kliknij **Rozpocznij nasłuch** i udostępnij mikrofon przeglądarce. Pierwsze ładowanie modelu do GPU może potrwać kilkanaście sekund.

Na nowym Macu wykonaj jednorazowo:

```sh
./setup.sh
./start.sh
```

Setup tworzy `.venv`, instaluje zależności i pobiera model (~1,61 GB) do `.models/whisper-large-v3-turbo`. Na instalację, cache i model warto przeznaczyć kilka GB wolnego miejsca. Kolejne uruchomienia korzystają z lokalnych wag; transkrypcja nie potrzebuje internetu, klucza API ani konta. Backend wymusza tryb offline dla Hugging Face. Frontend nie korzysta z zewnętrznych fontów, CDN ani analityki.

## Tłumaczenie lokalne

Whisper rozpoznaje oryginał, a **TranslateGemma 4B przez Ollama** tłumaczy go na wybrany język. Wykrywanie języka źródłowego pozostaje automatyczne. Audio i tekst trafiają wyłącznie do lokalnych procesów na tym komputerze.

Na nowym komputerze zainstaluj [Ollama](https://ollama.com/download), a następnie:

```sh
./setup-translation.sh
./start.sh
```

Skrypt pobiera `translategemma:4b` (około 3,3 GB). Po pobraniu tłumaczenie działa offline. Jeśli Ollama nie działa, uruchom aplikację Ollama albo `ollama serve`. Jej brak nie zatrzymuje oryginalnych napisów; widok pokazuje informację o niedostępnym tłumaczu.

Każdy fragment mowy jest tłumaczony w całości, także kiedy zawiera kilka zdań. Wersje robocze tego samego fragmentu mogą być zastępowane nowszym kontekstem. Kolejka zachowuje wszystkie różne fragmenty w kolejności i nigdy nie zastępuje zakończonego fragmentu późniejszą wypowiedzią. Stop zwalnia mikrofon i czeka na dokończenie oczekujących tłumaczeń. Jedna operacja tłumaczenia ma limit czasu; błędy pozostają widoczne przy właściwym fragmencie. Kolejka ma limit 64 fragmentów — przeciążenie zgłasza błąd zamiast po cichu pomijać tekst.

Wywołania modeli współdzielą GPU. Tłumaczenie pojawia się z opóźnieniem i może poprawiać aktualny, roboczy akapit. Zamknięte akapity zostają do czytania. Nie jest to gwarancja tłumaczenia bezbłędnego ani bez opóźnień. Długie sesje przechowują historię w pamięci karty; przeładowanie strony ją usuwa.

W teście z nagraniem po polsku (8,39 s, auto → English) pierwszy wynik tłumaczenia przyszedł po 5,65 s, a kompletne tłumaczenie po 11,74 s od początku nagrania. Ostatnie rozpoznawanie zajęło 2,08 s, a końcowe tłumaczenie 0,79 s. To krótki pomiar na M1 Pro 32 GB, z równoległym użyciem MLX i Ollama, nie obietnica opóźnienia dla dowolnego nagrania.

## Obsługa

- **Spacja** — start / stop. Zatrzymanie domyka ostatni fragment przed zakończeniem sesji.
- **F** — pełny ekran / powrót. **Esc** także opuszcza pełny ekran.
- W trybie projekcji pasek narzędzi znika po chwili. Ruch myszą lub dotknięcie ekranu pokazuje go ponownie.
- Wybierz mikrofon i język przed startem. Domyślnie język jest wykrywany automatycznie. Dostępny jest również ręczny wybór kilkunastu języków.
- Wybierz język tłumaczenia przed startem (domyślnie English, dostępne także Polski, Deutsch i inne). Opcja „Wyłączone” zostawia sam oryginał.
- Domyślnie obie kolumny mają tę samą wielkość czcionki (44 px). Rozmiary oryginału i tłumaczenia można zmieniać niezależnie. Na szerokim ekranie szerokości kolumn mają tę samą proporcję co rozmiary ich czcionek: np. oryginał 40 px i tłumaczenie 60 px dają podział dostępnej szerokości 40% / 60% (po odjęciu odstępu między kolumnami). Przy równych czcionkach podział wynosi 50% / 50%. W ustawieniach można także zmienić próg mikrofonu. Tekst nie zmniejsza się automatycznie w miarę dopisywania.
- Oba obszary mają historię. Ręczne przewinięcie w górę zatrzymuje śledzenie końca danego obszaru. „Wstrzymaj przewijanie” zatrzymuje oba widoki, podczas gdy nowe wypowiedzi i tłumaczenia nadal przychodzą. „Wróć do najnowszych” przywraca śledzenie.
- Ikona kosza jawnie czyści oryginał i tłumaczenie. Podczas nagrywania bieżący rozpoznany fragment jest pomijany do rozpoczęcia następnego; nasłuch trwa dalej. Stop i ponowny start mikrofonu zachowują wcześniejszy tekst.
- **Zobacz, jak to działa** uruchamia wyraźnie oznaczony podgląd z przykładowym tekstem, bez mikrofonu.

## Kazania i terminologia biblijna

Ikona książki otwiera **Kazanie i terminologia**. Profil jest domyślnie włączony; można go wyłączyć. Przed nasłuchem wybierz osobno polski przekład (Biblia Warszawska albo UBG) i angielski (King James Version albo Modern King James Version). Domyślne wskazówki to BW i KJV. Preferencje oraz własne podpowiedzi są zapisywane lokalnie w przeglądarce. Ustawienia profilu są stałe podczas danej sesji; nie zmieniają już wyświetlonych tłumaczeń. Język mowy nadal domyślnie wykrywamy automatycznie.

Whisper dostaje krótkie podpowiedzi nazw biblijnych. W **Nazwy na dziś** można podać do 240 znaków, np. trudne imiona i księgi występujące w kazaniu, w języku mówcy. Jest to `initial_prompt`, a nie wymuszanie rozpoznanego tekstu. Jego wpływ na jakość trzeba ocenić na rzeczywistym nagraniu z używanego mikrofonu.

Tłumacz dostaje informację o kazaniu, wybraną wskazówkę przekładu oraz dopasowane terminy, np. justification → usprawiedliwienie, sanctification → uświęcenie, covenant → przymierze. Podpowiedzi nazw ksiąg są kontekstowe: „Job, chapter three” może dostać wskazówkę „Księga Hioba”, ale samo „lost his job” jej nie dostaje. Nie stosujemy mechanicznej podmiany słów w wyniku. Przekazujemy tylko pasujące hasła, zamiast całego słownika przy każdym fragmencie.

**Własny słownik PL = EN** pozwala doprecyzować do 12 par terminów, po jednej na wiersz, np. `upamiętanie = repentance`. Wpis działa w obu kierunkach PL ↔ EN i ma pierwszeństwo przed odpowiadającą mu domyślną podpowiedzią. Własne hasła są dopasowywane do pełnej frazy, bez automatycznego rozpoznawania odmiany; w razie potrzeby wpisz formę występującą w mowie. Maksymalnie 60 znaków na każdą stronę pary i 1000 znaków łącznie. Dla innych par języków pozostaje ogólny kontekst kazania, bez słownika PL/EN.

Wybór BW/UBG/KJV/MKJV jest wskazówką terminologii, nie bazą tekstu tych przekładów ani gwarancją cytowania słowo w słowo. Instrukcja tłumacza wymaga zachowania negacji i twierdzeń mówcy oraz zabrania dopisywania lub uzupełniania wersetów. Model nadal może popełnić błąd. Do wyświetlania dosłownych cytatów potrzebna byłaby osobna, zweryfikowana baza przekładów i jawny wybór fragmentu. Dodatkowe instrukcje nie należą do oficjalnie gwarantowanych sposobów sterowania TranslateGemma, dlatego ich działanie sprawdzamy lokalnie: [karta modelu Google](https://huggingface.co/google/translategemma-4b-it), [obsługa initial_prompt w MLX Whisper](https://github.com/ml-explore/mlx-examples/blob/main/whisper/mlx_whisper/transcribe.py).

Na ośmiu krótkich, autorskich zdaniach testowych końcowy profil poprawił m.in. Hioba, usprawiedliwienie/uświęcenie, przymierze i przebłaganie. To próbka tekstowa, nie ocena całego kazania ani rozpoznawania audio. Powtórzenie porównania przez lokalną Ollama (wyniki w `test-results/sermon-production-benchmark.json`):

```sh
.venv/bin/python scripts/benchmark_sermon.py
```

Przed użyciem publicznym najlepiej sprawdzić kilkanaście minut rzeczywistego kazania, szczególnie nazwy, przeczenia i odnośniki do wersetów. Do próby zalecamy czysty sygnał z mikrofonu kazalnicy/miksera; nagranie powinno reprezentować warunki, w których system będzie pracował.

Tekst roboczy może się poprawiać wraz z kontekstem. Po pauzie (0,8 s) lub po maksymalnie 12 s ciągłej wypowiedzi fragment zostaje zatwierdzony. Nowe wypowiedzi pojawiają się w kolejnych akapitach. Wszystkie wcześniejsze fragmenty pozostają w pamięci karty do ręcznego wyczyszczenia lub odświeżenia strony. Nie zapisuje audio ani transkrypcji na dysku. Odświeżenie strony usuwa napisy. Preferencje wyglądu zapisujemy lokalnie w przeglądarce.

## Ekrany i projekcja

Ikona ekranu (cast) obok pełnego ekranu otwiera menu **Ekrany i projekcja**. Dla bieżącego okna wybierzesz: oryginał, tłumaczenie albo oba teksty. Przycisk pełnego ekranu pokazuje wybraną treść.

W sekcji dodatkowego okna wybierz jego treść i kliknij **Otwórz okno projekcji**. Na przykład:

1. W bieżącym oknie ustaw „Tylko oryginał”.
2. W dodatkowym oknie ustaw „Tylko tłumaczenie”.
3. Przenieś okno projekcji na drugi monitor i włącz w nim „Pełny ekran”.

Możesz otworzyć kilka projekcji o różnych treściach. Lista w menu pozwala przejść do otwartego okna lub je zamknąć. W oknie projekcji wybór treści i pełny ekran są dostępne po ruchu myszy; pasek narzędzi chowa się po chwili. Przewijanie można wstrzymać osobno dla każdego okna.

**Wykryj monitory** korzysta z Window Management API, jeżeli przeglądarka je udostępnia. Przeglądarka pyta o zgodę na dostęp do podłączonych ekranów. Po zgodzie można wybrać konkretny monitor; jego pozycja i dostępny rozmiar zostaną użyte przy otwieraniu okna. Bez obsługi API albo bez zgody nadal działa ręczne przeniesienie okna. Blokadę wyskakujących okien trzeba wyłączyć dla tej lokalnej strony, jeśli przeglądarka ją zgłosi. Wejście w pełny ekran może wymagać osobnego kliknięcia w oknie projekcji.

Okna pokazują ten sam strumień i istniejącą historię oraz dostają aktualizacje czcionek. Same projekcje nie uruchamiają mikrofonu, nie łączą się z ASR i nie ładują dodatkowych modeli. Synchronizacja działa lokalnie między oknami tej samej przeglądarki i profilu, przez BroadcastChannel oraz postMessage jako transport zapasowy. Stan jest wysyłany także wtedy, gdy panel sterowania jest w karcie w tle; nie zależy od rysowania jego interfejsu.

Zamknięcie projekcji nie przerywa nasłuchu. Zamknięcie lub odświeżenie panelu sterowania kończy bieżące połączenie z projekcjami; zachowują ostatni tekst i pokazują rozłączenie. Po odświeżeniu panelu otwórz projekcje ponownie. Każdy panel ma osobny identyfikator sesji, żeby okna różnych sesji nie mieszały napisów.

Obsługiwane są monitory/rzutniki podłączone do tego samego komputera. To funkcja wielu okien; nie dodaje protokołów Chromecast ani AirPlay. Nie testowano automatycznego rozmieszczania na dwóch fizycznych monitorach w tej sesji. Przetestowano synchronizację między oknami, istniejącą historię, wybór treści i obsługę rozłączenia.

Źródła API: [Window Management w Chrome](https://developer.chrome.com/docs/capabilities/web-apis/window-management), [BroadcastChannel (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API).

## Przetwarzanie i ograniczenia prototypu

Whisper nie jest natywnie modelem strumieniowym. Co około sekundę dekodujemy rosnące okno bieżącej wypowiedzi; oczekujące wersje robocze zastępujemy najnowszą, żeby nie budować narastającej kolejki. Zatwierdzonych fragmentów nie gubimy. Przepełnienie ograniczonej kolejki kończy sesję z komunikatem. Jeden backend obsługuje jeden aktywny mikrofon.

Detekcja pauz to lekka bramka RMS z krótkim buforem dźwięku sprzed początku mowy, nie neuronowy VAD. Próg może wymagać dostosowania do mikrofonu i hałasu. Wentylator, muzyka czy głośne otoczenie mogą go otwierać. Whisper może błędnie rozpoznawać mowę; w tym prototypie nie ma jeszcze Silero VAD, rozdzielania mówców, eksportu ani projekcji na innych komputerach przez sieć.

W lokalnym teście z polskim nagraniem wygenerowanym systemowym głosem (8,39 s) pierwsza robocza transkrypcja przyszła po **1,72 s**, a średni czas pojedynczego rozpoznawania wyniósł **857 ms**. Ostatni fragment został zapisany po stopie. To pomiar jednego krótkiego nagrania na tym komputerze, nie gwarantowane opóźnienie ani test godzinnej sesji / rzeczywistego mikrofonu. Wybór MLX jest dopasowany do Apple Silicon; nie porównywano go tutaj z whisper.cpp ani WhisperKit.

Serwer domyślnie nasłuchuje tylko na `127.0.0.1`. Przeglądarkowy mikrofon działa na localhost lub przez HTTPS. Do projekcji na drugim monitorze przenieś na niego okno i użyj pełnego ekranu. Samo otwarcie adresu IP w LAN przez zwykłe HTTP nie zapewni dostępu do mikrofonu.

Opcjonalne zmienne środowiskowe:

```sh
PORT=8888 ./start.sh
WHISPER_MODEL_PATH=/absolutna/sciezka/do/modelu ./start.sh
```

Nie uruchamiaj wielu workerów Uvicorn — każdy załadowałby własną kopię wag.

## Sprawdzenie

```sh
.venv/bin/python -m unittest discover -v
npm test
```

Testy obejmują segmentację mowy i ciszy, domknięcie wypowiedzi, ograniczoną kolejkę, protokół WebSocket, zachowanie wszystkich zakończonych tłumaczeń, rewizje napisów, spóźnione wyniki przypisane do odpowiedniego akapitu, podział zdań i resampling z 16 / 44,1 / 48 kHz. Nie wymagają GPU ani pobierania modelu. Node.js służy tylko do tych testów, nie jest potrzebny do działania aplikacji.

Pełny test z rzeczywistym modelem i własnym nagraniem:

```sh
# Format wejścia: WAV, PCM16, mono, 16 kHz
.venv/bin/python scripts/smoke_transcription.py /sciezka/do/nagrania.wav
```

Skrypt przesyła nagranie w czasie rzeczywistym do już działającego backendu na localhost, pokazuje wersje robocze, czas rozpoznawania i końcowy tekst. Do konwersji innych formatów można użyć ffmpeg; ffmpeg nie jest wymagany przez aplikację do obsługi mikrofonu.

## Pliki

- `web/` — interfejs, przechwytywanie audio w AudioWorklet, renderowanie i ustawienia.
- `web/projection.js` — synchronizacja lokalnych okien projekcji, historia i status połączenia.
- `server/audio.py` — segmentacja i kolejka, która scala oczekujące wersje robocze.
- `server/engine.py` — natywne rozpoznawanie MLX i rozgrzanie modelu.
- `server/app.py` — HTTP i WebSocket.
- `server/translation.py` — lokalna Ollama, kolejka wszystkich fragmentów i aktualizacje tłumaczeń.
- `server/sermon.py` — profil terminologii, krótkie podpowiedzi nazw i słownik PL/EN.
- `scripts/download_model.py` — jednorazowe pobieranie wag Whisper.
- `setup-translation.sh` — jednorazowe pobieranie TranslateGemma przez Ollama.

Dokumentacja bazowa: [Whisper w MLX](https://github.com/ml-explore/mlx-examples/tree/main/whisper) oraz [wagi Whisper large-v3-turbo w MLX](https://huggingface.co/mlx-community/whisper-large-v3-turbo).

Tłumacz: [TranslateGemma w Ollama](https://ollama.com/library/translategemma). Domyślny adres lokalnego API: `http://127.0.0.1:11434` (`OLLAMA_URL` może wskazywać inny port localhost).
