// server.js — FortiFit backend (Express + Gemini, ESM)
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";

/* ========== helpers ========== */
const fmt = (v, fb = "brak") =>
  v === undefined || v === null || String(v).trim() === "" ? fb : String(v).trim();

const fmtArr = (v, fb = "brak") => {
  if (Array.isArray(v)) return v.length ? v.join(", ") : fb;
  if (typeof v === "string") return v.trim() ? v : fb;
  return fb;
};

function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // południe UTC dla stabilności
  return isNaN(dt.getTime()) ? null : dt;
}

function diffFromNow(toDate) {
  const now = new Date();
  const ms = toDate.getTime() - now.getTime();
  const days = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
  const weeks = Math.floor(days / 7);
  const months =
    (toDate.getUTCFullYear() - now.getUTCFullYear()) * 12 +
    (toDate.getUTCMonth() - now.getUTCMonth());
  return {
    days,
    weeks: Math.max(0, weeks),
    months: Math.max(0, months),
  };
}

/* ========== prompt builder (draft) ========== */
function buildDietPrompt(form = {}, ctx = {}) {
  const {
    // Podstawowe
    name, age, sex, weight, height, level,
    // Cel
    goal, goalOther, eventInfo, eventDate, targetWeight,
    // Trening – dni i pory
    trainingDaysCount, trainingDays, trainingSchedule,
    // (legacy) pojedyncze miejsce – pozostawione tylko dla kompatybilności, NIE używamy:
    location,
    // NOWE: Źródło prawdy dot. miejsc
    locationsMulti,        // ["Siłownia","Dom","Plener","Basen","Inne"]
    dayLocationMap,        // { "Poniedziałek": "Siłownia", ... }
    locationOtherText,     // opis dla "Inne" (np. "hala sportowa / lodowisko")
    // Sprzęt i reszta
    equipmentList, trainingTypes, focusAreas, extraGoals,
    workoutLength,
    activity, sleepHours, injuries,
    budget, dietChoice, dietType, foodPrefsAllergies,
    cookingTime, somatotype, portionSize,
    supplementsMode, supplementsText,
  } = form;

  // --- Meal prep (gotowanie na kilka dni) ---
  const isMealPrep = /meal[-_\s]?prep/i.test(String(cookingTime || ""));
  const mealPrepRule = isMealPrep
    ? `
**MEAL PREP – wymagania (stosuj ściśle):**
- Użytkownik gotuje maksymalnie **2–3 razy w tygodniu**.
- Proponuj **dania „hurtowe”** (gulasz/chili/curry, pieczone mięso + kasza/ryż, sałatki z bazą węglowodanową, nocne owsianki w słoikach).
- Przy gotowaniu podawaj: **„Przygotuj X porcji – wystarczy na dni: …”** oraz instrukcję porcjowania i przechowywania (lodówka 2–3 dni / zamrażarka dłużej).
- W planie zaznaczaj wyraźnie **które dni są dniami gotowania**, a które **korzystają z przygotowanych wcześniej porcji** (np. „porcja z poniedziałku”).
- Unikaj układania 7 różnych przepisów gotowanych od zera – **powtarzalność jest pożądana**.
1) **Pierwsze wystąpienie potrawy (dzień, w którym gotujemy cały batch)**  
   - Podaj **pełny przepis dla całego batcha**:
     - **Nazwa potrawy (BATCH, np. „Curry z kurczakiem — batch na 6 porcji”)**
     - **Składniki (gramatura łącznie dla całego batcha)**
     - **Przygotowanie krok po kroku (dla całego batcha i dla jednej porcji)**
     - **Makro, kcal, waga (waga dla całego batcha i dla jednej porcji batcha) — dla CAŁEGO batcha** *oraz* **dla 1 porcji** (osobno)
    
     - **Orientacyjny koszt (PLN)** — **dla batcha** *i* **dla 1 porcji**
     - **Porcje i przechowywanie**: liczba porcji, gdzie trafią (lodówka/zamrażarka), maks. czas, sposób odgrzania
   - W tym dniu w sekcji posiłków wpisz przy odpowiednim posiłku jasny dopisek:
     - „**porcja 1/6 z poniedziałkowego batcha: Curry z kurczakiem**”

2) **Każde kolejne wystąpienie tej samej potrawy w innych dniach (wyjadamy porcje)**  
   - **NIE powtarzaj całego przepisu**.  
   - Wypisz **tylko informacje o porcji**:
     - **Nazwa posiłku** z dopiskiem „**porcja z [dzień gotowania, nazwa potrawy]**”
     - **Składniki na 1 porcję** (gramatura porcji)
  
     - **Makro, waga i kcal — dla 1 porcji**
     - **Orientacyjny koszt (PLN) — dla 1 porcji**
     - **Krótka uwaga**: jak odgrzać (mikrofala/patelnia/piekarnik), ewentualne szybkie dodatki (np. świeże zioła)
   - **Zakaz** powtarzania pełnego przepisu batcha w kolejnych dniach.

3) **Spójność liczby porcji**  
   - Liczba porcji przygotowanych w dniu batch-cook **musi się zgadzać** z liczbą ich użyć w kolejnych dniach (np. batch 6 porcji → dokładnie 6 użyć).
   - Jeśli porcja jest dzielona na 2 mniejsze posiłki, **przelicz makro/kcal/koszt** adekwatnie i zaznacz „1/2 porcji”.

4) **Format oznaczeń**  
   - **W dniu gotowania**: w sekcji posiłków użyj formatu:  
     „**[POSIŁEK] — porcja 1/6 z batcha: [Nazwa potrawy] (gotowany dziś)**”  
   - **W dniach kolejnych**:  
     „**[POSIŁEK] — porcja X/6 z batcha: [Nazwa potrawy] (z [dzień])**”
   - Dla klarowności całego planu dodaj na **końcu każdego dnia** krótką linijkę „**Porcje z batchy wykorzystane dziś:** …”.

5) **Twarde wymagania dot. danych liczbowych przy meal-prep**  
   - **Zawsze** podawaj **makro (B/W/T) i kcal**:  
     - **dla CAŁEGO batcha** (tylko w dniu gotowania)  
     - **dla 1 porcji** (w dniu gotowania i w dniach kolejnych)  
   - **Zawsze** podawaj **koszt (PLN)**:  
     - **dla CAŁEGO batcha** (tylko w dniu gotowania)  
     - **dla 1 porcji** (w dniu gotowania i w dniach kolejnych)

6) **Równoległość z nagłówkiem dnia**  
   - SUMA kcal/makro/koszt w nagłówku dnia **musi uwzględniać tylko porcje zjedzone w danym dniu**, a nie cały batch.
`
    : "";

  const mealPrepException =
    isMealPrep
      ? `(**Wyjątek tylko dla MEAL PREP**): możesz używać wcześniej przygotowanych porcji
— wpisuj przy posiłku dopisek wprost, np. „porcja z poniedziałkowego batch cookingu (curry z kurczakiem)”.
**Nie używaj** sformułowań typu „jak wyżej”, „analogicznie”, „patrz dzień X”.
Każdy dzień nadal musi zawierać pełny wykaz posiłków i makro; przy posiłku z porcji wystarczy krótka adnotacja o pochodzeniu.
`
      : ``;

  // Dieta – wybór i intencja
  const chosenDiet = (dietChoice || "").toLowerCase().includes("sam")
    ? fmt(dietType, "brak")
    : "FortiFit dobiera";

  const dietIntentNote =
    /na[_\s-]?redukcj/i.test(String(dietType || "")) || goal === "redukcja"
      ? "Dieta ukierunkowana na redukcję: deficyt kcal, wysokie białko."
      : /na[_\s-]?mas/i.test(String(dietType || "")) || goal === "masa"
      ? "Dieta ukierunkowana na budowę masy: kontrolowana nadwyżka kcal, wysokie białko."
      : "";

  const showTargetWeight = !!targetWeight && (goal === "redukcja" || goal === "masa");

  // Dni → pory
  const scheduleLines = trainingDays?.length
    ? trainingDays
        .map((d) => {
          const arr =
            trainingSchedule && Array.isArray(trainingSchedule[d]) && trainingSchedule[d].length
              ? trainingSchedule[d].join(", ")
              : "—";
          return `  - ${d}: ${arr}`;
        })
        .join("\n")
    : "  - —";

  // === LOKALIZACJE: PRIORYTET = locationsMulti & dayLocationMap ===
  const hasLocationsMulti = Array.isArray(locationsMulti) && locationsMulti.length > 0;
  const allowedPlaces = hasLocationsMulti ? locationsMulti : []; // jedyne dozwolone miejsca
  const locationsMultiLine = hasLocationsMulti ? fmtArr(allowedPlaces) : "—";
  const dayLocationLines = trainingDays?.length
    ? trainingDays
        .map((d) => `  - ${d}: ${dayLocationMap?.[d] ? String(dayLocationMap[d]) : "— (dobierz z listy multi)"}`)
        .join("\n")
    : "  - —";
  const locationOtherLine =
    hasLocationsMulti && allowedPlaces.includes("Inne")
      ? fmt(locationOtherText, "—")
      : "—";

  // Czy potrzebny sprzęt (poza siłownią)
  const OUT_OF_GYM_PLACES = ["Dom", "Plener", "Basen", "Inne"];
  const anyOutOfGymFromMap = dayLocationMap && Object.values(dayLocationMap).some((p) => OUT_OF_GYM_PLACES.includes(p));
  const anyOutOfGymFromMulti = allowedPlaces.some((p) => OUT_OF_GYM_PLACES.includes(p));
  const placeNeedsEquipment = anyOutOfGymFromMap || anyOutOfGymFromMulti;

  const when = ctx?.now || {};
  const event = ctx?.event || {};

  // Suplementy
  const supplementsRule =
    (supplementsMode === "Tak" || supplementsMode === "Wybrane")
      ? `**WYMAGANA sekcja „Suplementacja”**:
   - Lista pozycji z DAWKOWANIEM (mg/g/IU), porą przyjmowania (przed/po treningu, z posiłkiem, rano/wieczór), czasem trwania.
   - Uwagi bezpieczeństwa (np. interakcje, przeciwwskazania), ewentualne alternatywy.
   - Szacunkowy budżet miesięczny (PLN).
   ${supplementsMode === "Wybrane" && supplementsText ? `- Wybrane przez użytkownika: ${fmt(supplementsText)}.` : ""}`
      : `Jeżeli użytkownik wybrał „Nie” dla suplementów — dodaj krótką notę „bez suplementacji” i uzasadnij (np. wystarczająca dieta/priorytet podstaw).`;
const proteinPriorityRule = `
**BIAŁKO (WPC/WPI/roślinne) — ZASADA PRIORYTETU I LOGIKA DECYZJI (WYMAGANA):**

Cel nadrzędny: zapewnij dzienne białko w widełkach **1.6–2.2 g/kg mc** (redukcja/rekompozycja bliżej **1.8–2.2**, masa **1.6–2.0**). Najpierw oceniaj podaż z potraw dziennych; dopiero potem decyduj o suplemencie.

1) **Kiedy DODAĆ białko jako suplement (wpisz konkretny produkt i dawkowanie):**
   - Jeżeli suma z jedzenia w danym dniu < **dolnej granicy** celu (np. redukcja 1.8 g/kg, masa 1.6 g/kg) → **DODAJ** taką liczbę porcji, by osiągnąć cel (zaokrąglaj sensownie do 20–40 g porcji).
   - Jeżeli suma z jedzenia jest tylko **minimalnie powyżej minimum** (np. +0.0–0.2 g/kg) i rozkład posiłków ma długie okna bez białka → **DODAJ 1 porcję** jako praktyczne uzupełnienie (po treningu lub jako szybki posiłek).
   - Jeżeli użytkownik **deklaruje trudność** z „dojadaniem białka” (preferencje/alergie/czas) → **DODAJ 1 porcję** jako wsparcie nawet przy progu minimalnym.

2) **Kiedy NIE dodawać białka (pomijaj suplement):**
   - Gdy z potraw dziennych stabilnie mieści się w celu (np. ≥ docelowej wartości i rozkład jest równomierny).
   - Gdy budżet jest **bardzo niski** i cel można realnie osiągnąć samą dietą — **priorytetyzuj jedzenie** i tylko wtedy dodaj białko, gdy bez niego nie dojdziesz do celu.

3) **Dobór rodzaju białka do ograniczeń:**
   - **Laktoza/nietolerancje nabiału** → **WPI (izolat bezlaktozowy)** lub **białka roślinne**.
   - **Wegańska/bezmleczna** → izolat **sojowy** lub **mieszanka groch + ryż** (uzupełnianie profilu aminokwasów).
   - **Budżet niski** → WPC lub tania mieszanka roślinna; podaj **koszt 1 porcji (PLN)**.
   - **Smak/rozpuszczalność** → krótko sugeruj wodę/mleko/napoje roślinne i czas przyjmowania.

4) **Dawkowanie i umiejscowienie w planie:**
   - Porcja **20–40 g** (wg masy ciała i braków w danym dniu).
   - **Po treningu** lub jako **szybki posiłek** tam, gdzie dzień ma deficyt białka.
   - Podawaj **makro i kcal porcji**, a także **koszt porcji (PLN)**.
   - Jeżeli w danym dniu dodałeś białko, **uwzględnij je** w nagłówku dnia (SUMA kcal/makro/koszt).

5) **Spójność z celem:**
   - **Masa** → nie bój się 1–2 porcji/tydzień więcej, jeśli realnie pomaga domknąć białko w dni cięższych jednostek.
   - **Redukcja/Rekompozycja** → preferuj białko jako „wysycacz” w posiłkach o niskim czasie przygotowania, pilnuj kcal.
   - **Kondycja/mobilność/utrzymanie** → dodawaj tylko, gdy faktycznie brakuje do dolnej granicy celu.

6) **Bezpieczeństwo i alergie:**
   - Sprawdź alergie i preferencje — jeśli są przeciwwskazania dla nabiału/soi/grochu/ryżu, **wybierz alternatywę** i zaznacz to jawnie.
   - Nie dawaj „stacków” bez potrzeby: jeśli białko + kreatyna + witaminy są w planie, **krótko uzasadnij** każde i podaj koszt miesięczny.
`;

const loadPrescriptionRule = `
**DOBÓR OBCIĄŻENIA (WYMAGANE, GDY ĆWICZENIE WYMAGA SPRZĘTU):**

Dla każdego ćwiczenia ze sztangą, hantlami, odważnikami lub na maszynie:
- Podaj **konkretną sugestię obciążenia** w **kg** albo **widełki kg** (np. „hantle 8–12 kg każda”, „sztanga ~40–55 kg”), opierając się na danych z planu:
  - poziom (początkujący/średnio/zaaw.), 
  - liczba powtórzeń/serii,
  - RPE/RIR, 
  - dostępny sprzęt (jeśli brak dokładnej skali, podaj **widełki** i **progresję**).
- Zawsze dołącz jedną krótką linijkę **„Jak dobrać ciężar w praktyce”** (patrz niżej).

**Jak wyliczać i komunikować obciążenie:**
- Jeśli zakres powtórzeń to **3–6** → sugeruj **70–85% 1RM** (siła).
- **6–12** → **60–75% 1RM** (hipertrofia).
- **12–20** → **50–65% 1RM** (objętość/wytrzymałość mięśniowa).
- Gdy **1RM nieznane** → dobieraj z **RPE 7–9** (lub **RIR 1–3**); zapisz to w ćwiczeniu.
- Hantle/ketle: zawsze pisz **masę jednej sztuki** (np. „2×10 kg”), przy braku pewności podaj **widełki** i **próbę startową** (np. „zacznij od 2×8 kg, zwiększ jeśli ostatnie 2–3 powt. są zbyt lekkie”).

**Notka dla użytkownika (dodawaj przed dniem pierwszym oraz skrótowo przy ćwiczeniach):**
> **Dobór ciężaru jest indywidualny.** Potraktuj podane kg jako **punkt startowy**. Idealny ciężar to taki, przy którym:
> - Zostaje Ci **1–3 powtórzenia w rezerwie (RIR 1–3)** na końcu serii (czujesz wysoki wysiłek, ale technika się nie sypie).
> - **Ostatnie powtórzenia są wolniejsze**, ale **czyste technicznie** (bez bujania/skrótów ruchu).
> - Przy planowanym RPE (np. 8/10) **mógłbyś zrobić 1–2 powt. więcej**, ale świadomie kończysz serię.
> Jeśli w ostatniej serii czujesz, że mógłbyś dołożyć **≥3 powt.**, zwiększ obciążenie w następnym tygodniu (5–10% dla sztangi, 1–2 kg na hantel).
> Jeśli **łamie się technika** albo czujesz **ból w stawach** (nie „pieczenie mięśni”), **natychmiast zmniejsz ciężar** i/lub zamień wariant na bezpieczniejszy.

**Progresja tygodniowa (podawaj skrót przy planie):**
- Metoda **double progression**: utrzymaj zakres powtórzeń (np. 8–12). Gdy wykonasz **2 treningi z rzędu** na górnej granicy zakresu przy danym ciężarze, **zwiększ obciążenie** (np. +2.5–5 kg na sztangę, +1–2 kg na hantel).
- Dni „gorszego samopoczucia” → trzymaj **dolną granicę RPE** i zostaw większą rezerwę.

**Serie rozgrzewkowe (skrót):**
- Zanim wejdziesz na serie robocze, zrób **2–3 krótkie serie wstępne**: ~40%, ~60–70% ciężaru roboczego, po 3–5 powtórzeń, aby sprawdzić ruch i wstępny dobór kg.

**Format w ćwiczeniu (przykład):**
- „Wyciskanie hantli na ławce – **4×8–10**, **RPE 8**, **sugestia: 2×18–22 kg**.  
  *Dobór ciężaru*: ostatnie 1–2 powt. trudne, technika czysta; jeśli zapas ≥3 powt., zwiększ. Przed seriami roboczymi: 2 serie rozgrzewkowe (40% i 65%).”
`;


  // Event
  const eventRule = event?.has
    ? `Użytkownik podał wydarzenie: **${fmt(eventInfo)}** w dniu **${fmt(eventDate)}**.
**Dziś (serwer)**: ${fmt(when.localDate)} (strefa ${fmt(when.tz)}), ${fmt(when.utcDate)} UTC.  
**Do wydarzenia pozostało (wyliczone na serwerze):** około **${event.months} mies. / ${event.weeks} tyg. / ${event.days} dni**.
- Używaj powyższych liczb (nie przeliczaj od zera).  
- W planie treningowym uwzględnij **periodyzację pod szczyt formy** z delikatnym **taperingiem** w ostatnim tygodniu.
- Zasugeruj kamienie milowe (np. co 4–6 tyg.) i krótkie testy kontrolne.
`
    : `Jeśli pojawi się wydarzenie z datą — użyj liczb różnicy dni/tyg./mies. dostarczonych przez serwer i zaplanuj periodyzację ze szczytem formy.`;

  return `
Przygotuj **kompletny 7-dniowy plan** (trening + dieta) w **Markdown** zgodnie z poniższymi danymi i zasadami.
Nie używaj zwrotów typu „korekta”, „przepraszam”, „poprawka” — **oddaj od razu finalny, spójny plan**.

## DZIŚ (do wyliczeń)
- Lokalnie (PL): ${fmt(when.localDate)}  | UTC: ${fmt(when.utcDate)}  | Strefa: ${fmt(when.tz)}

## DANE UŻYTKOWNIKA
- Imię: ${fmt(name, "anonim")}
- Wiek: ${fmt(age, "?")}
- Płeć: ${fmt(sex, "?")}
- Waga: ${fmt(weight, "?")} kg
- Wzrost: ${fmt(height, "?")} cm
- Poziom: ${fmt(level, "?")}

## CEL
- Główny cel: ${fmt(goal, "?")} ${goal === "inne" ? `(opis: ${fmt(goalOther)})` : ""}
- Wydarzenie/szczyt formy: ${fmt(eventInfo)} | data: ${fmt(eventDate, "—")}
${showTargetWeight ? `- Docelowa waga: ${fmt(targetWeight)} kg (oszacuj czas dojścia w sekcji końcowej)` : ""}

${eventRule}

## TRENING
- Dni/tydz.: ${fmt(trainingDaysCount, "?")}
- Dni → pory:
${scheduleLines}
- **Miejsca (multi) – jedyna dozwolona pula**: ${locationsMultiLine}
- **Opis „Inne” (jeśli wybrano)**: ${locationOtherLine}
- **Mapa dzień → miejsce (jeśli puste, DOBIERZ z puli powyżej)**:
${dayLocationLines}
- Sprzęt (dla Dom/Plener/Basen/Inne): ${placeNeedsEquipment ? fmt(equipmentList, "brak – dobierz ćwiczenia bez sprzętu") : "nie dotyczy (siłownia w jedynej puli)"}
- Rodzaje: ${fmtArr(trainingTypes)}
- Partie priorytetowe (bez dysproporcji): ${fmtArr(focusAreas)}
- Dodatkowe cele: ${fmtArr(extraGoals)}
- Czas jednostki: ${fmt(workoutLength, "wg FortiFit")}

## DIETA
- Wybór: ${fmt(dietChoice, "FortiFit")}
- Typ: ${chosenDiet} ${dietIntentNote ? "(" + dietIntentNote + ")" : ""}
- Preferencje/alergie: ${fmt(foodPrefsAllergies)}
- Budżet (PLN/dzień): ${fmt(budget, "wg FortiFit")}
- Gotowanie: ${fmt(cookingTime, "wg FortiFit")}
- Somatotyp: ${fmt(somatotype, "—")}
- Porcje: ${fmt(portionSize, "wg preferencji")}


## ZASADY GENEROWANIA
KAŻDY DZIEŃ MA MIEĆ UKŁAD NAJPIERW TRENING PÓŹNIEJ DIETA 
Przed dniem pierwszym ZAWSZE dodawaj notatkę: 

W nagłówkach dni podane są wartości kalorii i makroskładników, które stanowią **idealny cel dzienny**.  
Rozpisane posiłki mogą różnić się od tych wartości w niewielkim stopniu (kilka procent), co jest naturalne w praktycznym planowaniu diety.  
Takie różnice nie mają znaczenia dla efektów – plan został przygotowany tak, aby prowadził do celu zgodnie z założeniami.  

Warto też pamiętać, że niektóre produkty mogą być opisane z lekkim zaokrągleniem (np. sery, nabiał).  
To normalne w codziennej diecie i nie wpływa na spójność ani skuteczność całego planu.

Na poczatku planu nigdy nie pisz w sposób Jasne, oto kompletny 7-dniowy plan treningowo-dietetyczny dla Kuby, przygotowany zgodnie z podanymi wytycznymi.



[FORMAT POSIŁKÓW – JEDNO ŹRÓDŁO PRAWDY, BEZ HTML]
- Nie używaj HTML (zakaz: <details>, <summary>, <table> w HTML). Używaj wyłącznie czystego Markdown.
- Dla każdego posiłku stosuj dokładnie JEDEN format danych: TABELA składników w Markdown.
- Tabela musi mieć kolumny: | Składnik | Gramatura (g) | kcal/100 g | Kcal | B (g) | W (g) | T (g) |
- Ostatni wiersz tabeli to **Suma** (zlicz Kcal, B, W, T).
- Po tabeli dodaj JEDNĄ linię „Podsumowanie posiłku (z tabeli): **X kcal; B Y g; W Z g; T T g; Koszt ~K PLN**”.
- NIE dodawaj żadnych dodatkowych linii typu „Makro: …”, „Kcal: …”, „Waga posiłku: …” itp. – jedynym źródłem prawdy jest tabela + jedno zdanie podsumowania.

[SPÓJNOŚĆ LICZB – POSIŁKI, DZIEŃ, NAGŁÓWKI]
- Nagłówek posiłku i nagłówek dnia (SUMA KALORII / B/W/T / Koszt) wyliczaj WYŁĄCZNIE na podstawie sum z tabel posiłków.
- Po wygenerowaniu posiłków **sprawdź spójność**: jeżeli rozbieżność między nagłówkiem dnia a sumą z tabel > 1%, POPRAW nagłówek dnia (nie modyfikuj tabel).
- Jeżeli już podałeś wartości w nagłówkach, ale po zsumowaniu tabel wychodzi inna liczba, **nadpisz nagłówki** wartościami z tabel (tabela ma zawsze pierwszeństwo).

[UNIKAJ DUBLI]
- Gdy używasz tabeli, nie pisz równolegle wypunktowania ze składnikami/kaloriami ani drugiej listy makro – ma być tylko tabela + jednozdaniowe podsumowanie.
Nie używaj znaczników <details>, <summary> ani innych elementów HTML.
Wszystko podawaj w czystym Markdown.
**PEŁNE ROZPISANIE KAŻDEGO DNIA (WYMAGANE):**
- Każdy dzień musi być opisany w pełni, bez skrótów i odwołań.
- Zabronione są zwroty: „jak w dniu 1”, „powtórz z dnia X”, „analogicznie do…”, „tak samo jak wcześniej”.
- Każdy dzień zawiera kompletną sekcję **Rozgrzewka**, **Trening główny**, **Cool down**, wszystkie ćwiczenia, serie, powtórzenia, przerwy, RPE i notki bezpieczeństwa.
- Każdy posiłek musi być rozpisany pełny: składniki, gramatura, przygotowanie, makro, kcal i koszt. Nigdy nie odwołuj się do wcześniejszych dni czy przepisów.
- Wszystkie opisy muszą być samodzielne, tak aby użytkownik mógł wydrukować tylko jeden dzień i wszystko miał jasno rozpisane.

[FORMAT LICZB I ZAOKRĄGLENIA — WYMAGANE]
- Gramatury składników: liczby całkowite (g/ml). Dopuszczalne 5 g/5 ml kroki przy płynach/tłuszczach.
- Makroskładniki: podawaj w 1 g dokładności (zaokrąglaj matematycznie).
- Kalorie posiłków: zaokrąglaj do najbliższych 5 kcal.
- Kalorie dnia (nagłówek): zaokrąglaj do najbliższych 5 kcal i MUSZĄ równać się sumie posiłków (po korektach).
- Czas przygotowania: zakresy 5–10 min, 10–15 min itd.
- Ceny: podawaj w PLN do 0.10 zł; koszt dnia = suma kosztów posiłków danego dnia.

[OBJĘTOŚĆ I BEZPIECZEŃSTWO — WYMAGANE]
- Dla dni siłowych: 4–8 ćwiczeń/dzień; 10–22 serii łącznie (poziomem steruj dolną/górną granicą).
- Nie łącz w jednym dniu skrajnie obciążających wzorców bez uzasadnienia.
- Każdy trening: rozgrzewka 5–10 min; cooldown 5–10 min.
- Kontuzje/ograniczenia: zamień ryzykowne ćwiczenia na bezpieczne warianty i to uzasadnij 1 zdaniem.
- Dla Dom/Plener/Basen: uwzględnij realny dostępny sprzęt i warunki.

[BUDŻET — WYMAGANE]
- Trzymaj koszt dnia w granicach budżetu użytkownika (±10%).
- Pokaż w nagłówku dnia: „Koszt dnia: xx.xx PLN”.
- Na końcu planu dodaj „Suma tygodniowa kosztów: xxx.xx PLN” oraz „Średnia/dzień: xx.xx PLN”.
- Gdy przekraczasz budżet: zastosuj tańsze zamienniki i przeskaluj porcje tłuszczów/węgli; ZAKAZ obniżania białka poniżej celu.

[SPÓJNOŚĆ MIEJSC — TWARDY ZAKAZ]
- Możesz używać wyłącznie lokalizacji z puli „Miejsca (multi)”.
- Jeśli „Mapa dzień → miejsce” jest pusta dla dnia, DOBIERZ wyłącznie z puli multi.
- Każdy blok „Trening” dnia zaczynaj linijką: „Miejsce: [Siłownia/Dom/Plener/Basen/Inne]”.
- Jeżeli miejsce ≠ „Siłownia” i brakuje sprzętu — podaj bezpieczne alternatywy niewymagające sprzętu.

[DOZWOLONE TABELE — OGRANICZ]
- Tabele są dozwolone TYLKO w:
  (a) KOŃCU POSIŁKU — krótka tabela „Składniki i kcal”,
  (b) KOŃCU DNIA — tabela kontroli „Suma kcal, makro, 4/4/9, różnica % i korekta”,
  (c) „## Lista zakupów”.
- W pozostałych sekcjach używaj list i akapitów. ZAKAZ dodatkowych tabel (np. na trening).

[WALIDATOR PRZED ZWROTEM — WYMAGANE]
Przed zwróceniem odpowiedzi:
1) Dla każdego dnia przelicz:
   - suma kcal = suma z posiłków (po korektach) — musi się równać nagłówkowi,
   - suma makro i 4/4/9 — różnica ≤ 5%; w razie przekroczenia popraw wartości,
   - koszt dnia = suma kosztów posiłków; sprawdź limit budżetu (±10%).
2) Dla treningu dnia:
   - Policz liczbę ćwiczeń (N) i serii (S) i upewnij się, że nagłówek zawiera właściwe N i S.
3) Globalnie:
   - Dokładnie 7 dni; po Dniu 7 MUSI następować „## Lista zakupów” i sekcje końcowe.
4) Jeśli którykolwiek test nie przejdzie — popraw wartości i zwróć tylko wersję finalną (bez procesu korekty).

[NAWODNIENIE I BŁONNIK — WYMAGANE]
- Każdego dnia dodaj linijkę: „Nawodnienie: ≥ 30 ml/kg m.c. (dopasuj do aktywności)”.
- Kontroluj błonnik 25–35 g/d; jeśli dzień < 20 g, dodaj szybkie źródło (warzywa/pełne ziarna/owoce/otręby).

[TON I ZAKAZY SFORMUŁOWAŃ]
- Nie używaj 1. os. lp. („zrobiłem”, „przygotowałem”); mów „my” jako FortiFit.
- ZAKAZ słów: „przepraszam”, „korekta”, „poprawka”, „jak wyżej”, „analogicznie”.
- ZAKAZ jednostek „szklanki/łyżki” — zawsze g/ml (łyżka oleju = 10–12 g, określ, ile przyjąłeś).

[FORMAT NAGŁÓWKA DNIA — METADANE]
- Nagłówek: „## Dzień X — SUMA KALORII: XXXX kcal (B: xx g, W: xx g, T: xx g), Koszt dnia: xx.xx PLN, Ćwiczenia: N, Serie: S, Miejsce: [nazwa]”.
- Jeśli dzień bez treningu: „Ćwiczenia: 0, Serie: 0, Miejsce: —”, a w treści dnia dodaj „Dzień regeneracyjny”.

[AUDYT WEWNĘTRZNY — SAMOKOREKTA]
Przed zwrotem odpowiedzi wykonaj audyt kontrolny (kcal, makro, koszty, N/S, lokalizacje, liczba dni = 7).
Jeśli znajdziesz niespójność — popraw liczby i pokaż tylko wersję finalną po poprawkach (bez opisywania procesu).

1. **Wygeneruj dokładnie 7 pełnych dni.** Tytuł dnia ma być nagłówkiem H2 (Markdown \`##\`) i wyglądać tak:
   \`## Dzień X — SUMA KALORII: XXXX kcal (B: xx g, W: xx g, T: xx g), Koszt dnia: xx PLN, Ćwiczenia: N, Serie: S\`
   - \`XXXX\` = **łączna liczba kalorii** z POSIŁKÓW w danym dniu (podaj konkretną liczbę).
   - \`N\` = łączna liczba **różnych ćwiczeń** w tym dniu.
   - \`S\` = łączna liczba **serii** wszystkich ćwiczeń w tym dniu.
   - Nagłówek ma być wyraźny i czytelny (H2).

  ## DODATKOWE WYMAGANIA
KAŻDY DZIEŃ MA MIEĆ UKŁAD NAJPIERW TRENING PÓŹNIEJ DIETA 
1. Plan ma być przygotowany jako **pierwszy etap większej strategii**, która prowadzi do osiągnięcia celu użytkownika (np. redukcja, masa, poprawa kondycji).
2. Aktualny plan obowiązuje na **okres około 1 miesiąca (4 tygodni)**. 
3. Na początku planu dodaj jasną notkę: 
   *„Ten plan obejmuje miesiąc pracy. Po tym okresie należy zaktualizować dane w FortiFit, aby otrzymać kolejny, spersonalizowany plan uwzględniający progres”*
4. W treści planu uwzględnij, że **zmiany w ciele i wydolności będą stopniowe**, a po miesiącu należy spodziewać się pierwszych efektów (np. spadek/wzrost masy ciała, poprawa kondycji, techniki ćwiczeń).
5. Dodaj sekcję „Periodyzacja Treningowa i Kamienie Milowe” i opisz w niej najbliższy miesiąc oraz kolejne etapy (np. adaptacja, budowanie siły, szczyt formy).
6. Wspomnij o **testach kontrolnych** (np. na początku wdrożeniea planu: zdjęcia, pomiary aby obserwować i porównywać późniejsze zmiany sylwewtki i mieć jakieś odniesienie, ważenie się codziennie lub co dwa dni, co tydzień/dwa tygodnie pomiary sylwetki, co 4 tygodnie: zdjęcia sylwetki, co 6–8 tygodni testy sprawnościowe), aby użytkownik wiedział jak monitorować progres. 
8. Nie wspominaj że ty generujesz ten plan. Unikaj zdań typu np. "a ja przygotuję dla Ciebie" - nie ty, tylko FortiFit.
9. Na początku pisz też ile kalorii mniej wiecej użytkownik ma zjadać dziennie odwołując się do wygenerowanego planu.
10. NIGDY nie zwracaj się w pierwszej osbobie liczby pojedynczej, że TY coś zrobiłeś - to jest błąd. Zwracaj się w liczbie mnogiej w pierwszej osobie MY jako FortiFit. Zrobiliśmy, przygotowaliśmy, gratulujemy, życzymy itd.
${mealPrepRule}
${supplementsRule}
${proteinPriorityRule}
${loadPrescriptionRule }

2. W **każdym dniu** wypisz posiłki (np. śniadanie, II śniadanie, obiad, podwieczorek, kolacja — dopasuj do danych).
   Dla każdego posiłku podaj:
   - Nazwa
   - **Składniki z gramaturą**
   - **Przygotowanie krok po kroku**
   - **Makro, kcal i szacukowa waga całego posiłku**
   - **Orientacyjny koszt (PLN)**

3. **Zakaz** używania sformułowań typu: „analogicznie”, „jak wyżej”, „podobnie jak wcześniej”. Dni muszą być **niezależne i kompletne** ${mealPrepException}

4. **Trening**:
Ćwiczenia tylko i wyłącznie dla dni wybranych w generatorze przez uzytkownika - jesli wybral konkretne, jesli nie to dopasuj samodzielnie
   - KAŻDE ĆWICZENIE MA ZAWIERAć:
     -Serie i powtórzenia
     -Przerwa
     -RPE
     -Sugestia obciążenia
     -Wskazówki jak wykonywać
        I NIC WIĘCEJ ANI MNIEJ
   - **Bezwzględnie trzymaj się puli „Miejsca (multi)”**. **Nie wolno** używać lokalizacji spoza tej listy.
   - Jeśli dla dnia nie wskazano miejsca w mapie — **DOBIERZ je wyłącznie z puli multi**, sensownie względem celu/rozkładu tygodnia.
   - Zasady dla miejsc:
     - **Siłownia** — maszyny/wolne ciężary (zgodnie z poziomem).
     - **Dom** — masa ciała / prosty sprzęt; jeśli brak sprzętu, podaj pełne alternatywy bez sprzętu.
     - **Plener** — biegi/sprinty, schody, street-workout, kalistenika; dodaj krótką uwagę dot. warunków pogodowych.
     - **Basen** — jednostka pływacka (style, odcinki, RPE, czasy odpoczynku) + krótka mobilność/rdzeń poza wodą.
     - **Inne** — zastosuj opis: ${locationOtherLine}.
   - Dopasuj ćwiczenia do **miejsca dnia** i dostępnego sprzętu (${placeNeedsEquipment ? "sprzęt podany wyżej" : "jeśli wymagany"}).
   - Przy ćwiczeniach podawaj **serie × powtórzenia, tempo (gdy relewantne), przerwy** oraz orientacyjny **RPE**.
   - Jeśli dzień bez treningu — jawnie napisz **„Dzień odpoczynku – regeneracja”**.
   - Jeśli są kontuzje/ograniczenia — **unikaj** ryzykownych ćwiczeń, podaj **modyfikacje/alternatywy** i krótkie uwagi bezpieczeństwa.
   - Każdy dzień z treningiem zaczynaj **rozgrzewką 5–10 min**, kończ **cooldown 5–10 min**.
   **ZASADY WEDŁUG POZIOMU ZAAWANSOWANIA**

- Początkujący (0–6 mies.)  
  - Główny cel: opanowanie techniki i podstawowych wzorców ruchowych (przysiad, martwy ciąg, wyciskanie, podciąganie, plank).  
  - Schematy treningowe proste i czytelne: FBW, góra/dół lub podstawowy push–pull–legs.  
  - Niska do umiarkowanej objętość, umiarkowana intensywność.  
  - Powtórzenia w średnim zakresie (8–12), bez nadmiernego obciążania układu nerwowego.  
  - Wskazówki edukacyjne i notki techniczne są szczególnie ważne.  
  - Wspomnij o nagrywaniu podczas wykonywania ćwiczeń aby monitorować technikę 


- Średniozaawansowany (6–24 mies.)  
  - Zakładamy, że użytkownik zna podstawy i ćwiczy regularnie.  
  - Można stosować bardziej rozbudowane schematy (push–pull–legs, góra/dół, split 4–5 dniowy).  
  - Większa objętość treningowa i progresja obciążeń.  
  - Różnorodność ćwiczeń i akcentowanie priorytetowych partii mięśniowych.  
  - Intensywność dostosowana do osoby, która już ma doświadczenie i wytrzymałość.  

- Zaawansowany (24+ mies.)  
  - Użytkownik trenuje regularnie od ponad 2 lat i zna swoje ciało.  
  - Plan powinien uwzględniać wysoką objętość, periodyzację, manipulację intensywnością i specjalistyczne metody (superserie, drop sety, RPE, tempo).  
  - Wysoka indywidualizacja pod kątem celu (redukcja, masa, rekompozycja).  
  - Trening ma być wymagający, ale logicznie ułożony i spójny z regeneracją.  

   

5. **Dieta**:
   - Jeśli dieta to **„na redukcję” / „na masę”** — prowadź kaloryczność/makro **spójnie z celem** (deficyt / nadwyżka).
   - **Różnicuj kaloryczność i makro**: dni treningowe ↑ kcal/WW (lub białko), dni wolne ↓. Zaznacz to w nagłówkach dni.
   - Ceny orientacyjne w **PLN** i dostępne w polskich marketach; unikaj niszowych, bardzo drogich produktów przy niskim budżecie.
   - Dla droższych/składników „trudnych” podaj **2–3 zamienniki** (tanie/dostępne/roślinne).
   - **Bezwzględnie wyklucz** alergeny; stosuj bezpieczne zamienniki.
   - Szacuj **czas przygotowania** każdego posiłku (np. 10–15 min). Przy „≤15 min” łącz kanapki/owsianki/koktajle/1-garnkowe.
   - Jednostki: **g/ml**; makro do **1 g**, kcal do **5–10**.
   - Cel: **białko 1.6–2.2 g/kg mc**, **błonnik 25–35 g/d**, **nawodnienie min. 30 ml/kg/d** (dopasuj do aktywności).
   - Agreguj ilości **z 7 dni/batchy**; wskaż, na ile dni wystarczą bazowe produkty.
   - Jeśli widzisz, że w diecie brakuje białka lub jego podaż jest minimalnie powyżej minimum, rozważ białko serwatkowe jako suplement pierwszego wyboru. Kreatyna, witaminy, omega-3 i inne wchodzą dodatkowo, zgodnie z potrzebami.
[REGUŁY KALORII – WYMAGANE]
1) Każdy posiłek podawaj z ROZPISKĄ SKŁADNIKÓW:
   - nazwa składnika
   - gramatura w g (liczba)
   - kcal na 100 g (liczba)
   - kcal składnika = (gramatura/100) * (kcal_100g)
2) Po składnikach podaj PODSUMOWANIE POSIŁKU:
   - kcal (suma z pozycji powyżej)
   - białko, węgle, tłuszcze (g) oraz przeliczenie kontrolne kcal = 4*B + 4*W + 9*T
   - jeśli różnica między „suma kcal ze składników” a „4/4/9” > 5%, skoryguj liczby i pokaż poprawione.
3) Dzienny cel kcal trzymaj w granicach ±3%, posiłki ±15% od średniej posiłku (chyba że użytkownik wymaga inaczej).
4) Unikaj przeszacowań:
   - chleb pszenny/bułka ~240–280 kcal/100 g
   - ryż/biały makaron suchy ~340–370 kcal/100 g; po ugotowaniu ~110–150 kcal/100 g
   - pierś z kurczaka surowa ~110–130 kcal/100 g
   - oleje/orzechy ~600–900 kcal/100 g
   - twaróg półtłusty ~120–160 kcal/100 g, jogurt naturalny 2% ~60–70 kcal/100 g
   - warzywa liściaste 10–30 kcal/100 g
5) Jeśli jakaś pozycja przekracza sensowną gęstość energetyczną (np. owsianka 70 g płatków + mleko = ~350–500 kcal, NIE 900 kcal), ZMNIEJSZ gramatury wysokokalorycznych składników zamiast zawyżać.
6) NA KOŃCU DNIA: pokaż tabelę kontroli:
   - suma kcal z posiłków
   - suma makro i przeliczenie 4/4/9
   - różnica do celu (kcal i %). Jeśli różnica > 3%, przeskaluj porcje (preferuj skalowanie węgli/tłuszczu), pokaż współczynnik skalowania i wynik po korekcie.
7) Nie używaj „szklanek/łyżek” jako jednostek docelowych – zawsze zamień na gramy/ml. Łyżkę przyjmuj jako 10–12 g oleju (określ, ile przyjąłeś).
8) Jeśli brakujesz wartości kcal/100 g – przyjmij konserwatywny typowy zakres, podaj źródłowe założenie (np. „przyjąłem 150 kcal/100 g dla ugotowanego ryżu”).
**KOREKTA / UZUPEŁNIENIE (WYMAGANE):**

Po podsumowaniu dnia sprawdź różnicę między „SUMA dnia” a „CELEM”.  
Uwzględnij zarówno **niedobór**, jak i **nadmiar** kcal/makro.

1. **Jeśli niedobór (np. -30 kcal, -10 g białka, -15 g węglowodanów, -5 g tłuszczu):**
   - Zaproponuj **1 małą przekąskę lub produkt** możliwy do szybkiego dodania (np. owoc, kilka orzechów, kostka gorzkiej czekolady, jogurt naturalny, wafle ryżowe).
   - Dobierz tak, aby uzupełniało głównie brakujące makroskładniki (np. brak białka → serek wiejski, brak tłuszczu → kilka orzechów).
   - Podaj **gramaturę, kcal i makro** tego dodatku.

2. **Jeśli nadmiar (np. +50 kcal, +15 g tłuszczu):**
   - Zasugeruj **zmniejszenie lub pominięcie małego składnika** (np. mniej orzechów, mniej oleju, kawałek pieczywa mniej).
   - Pokaż dokładnie: *„odejmij 10 g orzechów → -60 kcal (-2 g B, -2 g W, -5 g T)”*.

3. **Zasady ogólne:**
   - Nie próbuj bilansować co do 1 kcal — wystarczy sprowadzić wynik **bliżej celu** (±0–2%).
   - Zawsze podaj konkretną propozycję w formacie:  
     „➕ Dodaj: …” albo „➖ Odejmij: …”.
   - Dopisek umieszczaj **na końcu podsumowania dnia**, w osobnej linii:  
     Dopasowanie: ...  

Przykład:
- Dopasowanie: ➕ Dodaj 100 g jogurtu naturalnego (60 kcal, 6 g białka, 4 g węgli, 2 g tłuszczu)  
-Dopasowanie: ➖ Odejmij 10 g orzechów włoskich (65 kcal, 1 g białka, 1 g węgli, 6 g tłuszczu)

6. **Suplementacja**: ${supplementsRule}
   - Suplementacje zawsze dodawaj przed dniem pierwszym. 
   - Zawsze podaj przy batchu **liczbę porcji**, **sposób przechowywania** (lodówka/zamrażarka, ile dni), **instrukcję odgrzania**.
   - W dniach korzystających z porcji wpisz dopisek: „porcja z [dzień, potrawa]”.

7. **Lokalizacje – spójność planu**:
   - Stosuj wyłącznie miejsca z puli **Miejsca (multi)**: ${locationsMultiLine}.
   - Jeśli mapa nie określa dnia — dobierz **tylko z tej puli**, logicznie do celu (np. siła na siłowni, technika w domu, wydolność w plenerze/basenie).
   - Dla **Basen** planuj konkretne odcinki i style; dla **Inne** – użyj: ${locationOtherLine}.

8. Szacuj **koszty posiłków** w realiach **polskiego rynku** (PLN).

9. Na końcu dodaj:
   - \`## Lista zakupów\` — ma się znajdować zawsze od razu po 7 dniu, Tabela/wykaz: **Produkt | Ilość | Cena (PLN) | Szacunkowo wystarczy na** (np. 3 dni / 6 porcji).
     Oszacuj sumę kosztów listy oraz wskaż, na ile dni planu wystarczy większość bazowych produktów. Lista ma zawierać produkty użyte w diecie.
   - ${
     showTargetWeight
       ? `Użytkownik podał **docelową wagę**. Dodaj sekcję:
   \`## Szacowany czas do osiągnięcia wagi\`
   - Podaj realistyczny przedział czasu (tygodnie/miesiące), zakładając zdrowe tempo zmian
     (orientacyjnie 0.25–1.0% masy ciała tygodniowo; uwzględnij kierunek: redukcja/masa).
   - Krótko wyjaśnij czynniki wpływające (aktywność, bilans energetyczny, regeneracja).`
      : `Jeśli użytkownik poda docelową wagę, dodaj sekcję o szacowanym czasie dojścia.`
   }

10. Na końcu planu przypomnij dodając notkę: 
*„Ten plan obejmuje miesiąc pracy. Po tym okresie należy zaktualizować dane w FortiFit, aby otrzymać kolejny, spersonalizowany plan uwzględniający progres”*
Podsumuj ładnie cały plan.

11. Zwróć wynik w **Markdown**, z czytelnymi nagłówkami i listami, gotowy do renderu. Styl: zwięźle, klarownie.



# ZAKAZ SKRÓTÓW — REGUŁA KOŃCOWA (NAJWAŻNIEJSZE)

- Każdy dzień planu musi być **rozpisany w całości i samodzielnie**.  
- **Zakaz** stosowania jakichkolwiek skrótów, odwołań czy uproszczeń.  
- **NIE WOLNO** używać sformułowań: „jak w dniu 1”, „powtórz z dnia X”, „analogicznie”, „tak samo jak wcześniej”.  
- Każdy posiłek musi mieć pełną listę składników, gramatury, przygotowanie krok po kroku, tabelę makro i koszt — nawet jeśli powtarza się w kolejnych dniach.  
- Każdy trening musi być opisany pełny (rozgrzewka, ćwiczenia z seriami/powtórzeniami/przerwami/RPE, cooldown) — również wtedy, gdy wygląda identycznie jak w innym dniu.  
- **Wszystko musi być napisane tak, jakby użytkownik miał wydrukować tylko jeden wybrany dzień i mieć w nim wszystko kompletne i zrozumiałe.**  
`;
}


/* ========== AUDYT prompt (nowy) ========== */
function buildAuditPrompt(draftPlan, form = {}, ctx = {}) {
  return `
Oto szkic planu wygenerowany w pierwszym etapie:
---
${draftPlan}
---

## AUDYT I FINALIZACJA PLANU FORTIFIT

1. Sprawdź całość planu krok po kroku (dieta + trening).
2. Oceń zgodność ze wszystkimi regułami FortiFit:
   - kalorie i makro,
   - meal-prep i porcjowanie,
   - suplementy,
   - białko (1.6–2.2 g/kg mc),
   - obciążenia (dobór ciężaru),
   - miejsca i sprzęt,
   - periodyzacja pod wydarzenie.
3. Skoryguj błędy rachunkowe (kalorie, makro, koszty).
4. Upewnij się, że nagłówki dni zawierają poprawne SUMY.
5. Zweryfikuj, czy plan pasuje do celu: **${form.goal || "brak"}**.
6. Zwróć finalny plan w **Markdown** (dzień po dniu, format identyczny jak szkic).

Nigdy nie pisz, że poprawiasz czy przepraszasz. Oddaj od razu gotowy, poprawiony plan FortiFit.
`;
}

/* ========== Gemini call ========== */
async function callGemini(prompt, { retries = 1 } = {}) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    // generationConfig: { temperature: 0.7, maxOutputTokens: 36000 },
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ??
      data?.candidates?.[0]?.content?.parts?.[0]?.inline_data?.data;

    if (text) return { ok: true, text };

    const errMsg =
      data?.promptFeedback?.blockReason ||
      data?.error?.message ||
      `HTTP ${res.status}`;
    lastErr = { errMsg, raw: data };
    if (attempt <= retries) await new Promise((r) => setTimeout(r, 600));
  }
  return { ok: false, error: lastErr?.errMsg || "unknown", raw: lastErr?.raw };
}

/* ========== API ========== */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "fortifit-backend",
    port: PORT,
    model: GEMINI_MODEL,
  });
});

app.post("/api/plan", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ ok: false, error: "Brak GEMINI_API_KEY w .env" });
    }

    // Kontekst czasu (serwer -> do promptu)
    const now = new Date();
    const localDate = new Intl.DateTimeFormat("pl-PL", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(now);
    const utcDate = now.toISOString().replace("T", " ").replace(".000Z", "Z");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    // Kalendarz / event
    const eventDt = parseISODate(req.body?.eventDate);
    const eventDiff = eventDt
      ? diffFromNow(eventDt)
      : { days: 0, weeks: 0, months: 0 };

    // === ETAP 1: draft ===
    const draftPrompt = buildDietPrompt(req.body || {}, {
      now: { localDate, utcDate, tz },
      event: { has: !!eventDt, ...eventDiff },
    });
    const draftRes = await callGemini(draftPrompt, { retries: 1 });
    if (!draftRes.ok) {
      return res
        .status(500)
        .json({ ok: false, error: "Błąd w etapie 1: " + draftRes.error, raw: draftRes.raw });
    }

    // === ETAP 2: audyt ===
    const auditPrompt = buildAuditPrompt(draftRes.text, req.body || {}, {
      now: { localDate, utcDate, tz },
      event: { has: !!eventDt, ...eventDiff },
    });
    const finalRes = await callGemini(auditPrompt, { retries: 1 });
    if (!finalRes.ok) {
      return res
        .status(500)
        .json({ ok: false, error: "Błąd w etapie 2: " + finalRes.error, raw: finalRes.raw });
    }

    res.json({ ok: true, plan: finalRes.text });
  } catch (err) {
    console.error("❌ /api/plan error:", err);
    res.status(500).json({ ok: false, error: err.message || "Internal error" });
  }
});

/* ========== start ========== */
app.listen(PORT, () => {
  console.log(
    `[FortiFit] Backend działa na http://localhost:${PORT} (model: ${GEMINI_MODEL})`
  );
});