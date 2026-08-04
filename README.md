# Sardegna — web app

Dezelfde gesproken rijgids als de native versie, nu als website. Geïnstalleerd
op je beginscherm gedraagt hij zich als een app: eigen icoon, geen
Safari-balk, werkt offline voor alles behalve de kaarttegels en live
navigatie. Geen Apple Developer Program, geen Codemagic, geen vervaldatum.

---

## Waarom niet op het Tesla-scherm

Twee dingen die geen enkele technologie oplost:

1. **Tesla schakelt de eigen browser uit zodra de auto in Drive staat.**
   Sinds het NHTSA-onderzoek naar "Passenger Play" in 2021 is dit vaste
   Tesla-policy: de browser verdwijnt of laadt niets meer zodra je rijdt.
2. **De Tesla-browser geeft externe sites geen manier om locatietoestemming
   te vragen.** Zonder locatie geen highlights die afgaan op waar je bent.

Dit is dus een **telefoon-app**. Het geluid komt via Bluetooth op de
Tesla-speakers terecht, precies zoals nu al werkt — daar verandert niets aan.
Het Tesla-scherm kun je geparkeerd gebruiken om vooraf een route te bekijken,
als je wilt, maar niet als rijdend dashboard.

---

## Hosten — met je bestaande GitHub-account

Je hebt al een GitHub-account van de Codemagic-poging. Die kun je nu voor iets
veel simpelers gebruiken.

1. Ga naar `github.com` → **New repository** → naam bijvoorbeeld `sardegna-web`
   → **Public** (GitHub Pages op een gratis account vereist een publieke
   repository — de code is zichtbaar, maar dat maakt voor deze inhoud niets
   uit).
2. **uploading an existing file** → sleep de **inhoud** van de map
   `SardegnaWeb` erin: `index.html`, `manifest.json`, `sw.js`, en de mappen
   `css`, `js`, `data`, `icons`.
3. **Commit changes**.
4. **Settings** (bovenin de repository) → **Pages** (linkermenu) →
   bij **Source** kies **Deploy from a branch** → branch `main`, map `/ (root)`
   → **Save**.
5. Na een minuut of twee staat er een groen vinkje met de URL, iets als
   `https://jouwgebruikersnaam.github.io/sardegna-web/`.

Dat is de link. Open hem op je telefoon.

---

## Op je telefoon zetten

1. Open de link in **Safari** — niet Chrome; "Zet op beginscherm" werkt
   alleen in Safari.
2. Tik op het deelicoon (vierkant met pijl omhoog) → **Zet op beginscherm**.
3. Er verschijnt een icoon. Vanaf nu open je de app daar, niet via Safari.

Klaar. Geen account, geen wachttijd, geen vervaldatum.

---

## Voor je wegrijdt

1. Koppel je telefoon met de auto via Bluetooth, radio op Bluetooth.
2. Open de app, druk op **Test** op het startscherm.
3. iOS vraagt de eerste keer om locatietoestemming — kies **Bij gebruik van
   de app**. Zonder dat werkt geen enkele highlight.
4. Zet een betere stem: **Instellingen → Toegankelijkheid → Gesproken
   materiaal → Stemmen → Nederlands** → download een **Verbeterde** of
   **Premium** stem.
5. Zet je telefoon in een houder met het scherm zichtbaar. Dit is
   belangrijk — zie hieronder waarom.

---

## Wat anders is dan de native versie

**Het scherm moet aan blijven.** Een website mag op iOS niet doorpraten
zodra Safari naar de achtergrond gaat of het scherm vergrendelt — dat is een
harde grens van het platform, native apps krijgen die rechten wel via een
speciale achtergrondmodus, websites niet. Zet je telefoon dus in een houder
zoals je met Waze of Google Maps ook zou doen. Er zit een verzoek in de code
om het scherm actief te houden (`wakeLock`), maar dat werkt niet op elk
toestel — een houder is de betrouwbare oplossing.

**Muziek pauzeert soms in plaats van zachter te gaan.** Native apps kunnen
exact regelen dat Spotify zachter gaat tijdens een verhaal en daarna
terugkomt. Een website heeft die controle niet; standaardgedrag van iOS is
vaker pauzeren dan dimmen. Niet op te lossen vanuit de browser.

**Navigatie en kaarttegels hebben een verbinding nodig.** De verhalen en
weetjes zitten volledig in de app en werken zonder bereik. De écht
gesproken linksaf/rechtsaf-instructies en de kaartafbeelding zelf komen van
een gratis routeringsdienst (OSRM) en OpenStreetMap — die moeten opgehaald
worden. Eenmaal gereden wordt de routelijn + de afslagen lokaal bewaard, dus
de tweede keer werkt een route ook zonder bereik; de eerste keer heb je
signaal nodig bij vertrek.

---

## Hoe de turn-by-turn werkt

Bij het openen van een route wordt eenmalig de grove lijn uit het
routebestand naar **OSRM** gestuurd (`router.project-osrm.org`, gratis,
geen key). Die stuurt een lijn terug die daadwerkelijk over de weg loopt,
plus een lijst afslagen met type, richting en straatnaam. Daar bouwt de app
zinnen van: "Over 300 meter, sla linksaf" op 400/150/35 meter voor de afslag.

Rijd je meer dan 70 meter van de lijn af en blijft dat 12 seconden zo, dan
herberekent de app vanaf je huidige positie naar het einde van de route —
net als een gewone navigatie-app.

Navigatie-instructies onderbreken een verhaal direct; een verhaal
onderbreekt nooit een navigatie-instructie. Dat is bewust zo: een afslag is
tijdkritisch, een verhaal over een kerktoren niet. Wil je alleen de
verhalen en geen gesproken afslagen — bijvoorbeeld omdat je Apple Maps
ernaast open hebt staan — zet dan **Navigatie-instructies** uit bij
Instellingen.

OSRM's publieke server is bedoeld voor licht, persoonlijk gebruik — precies
dit. Is hij een keer overbelast, dan valt de app terug op de grove lijn
zonder gesproken afslagen; de highlights en weetjes blijven gewoon werken.

---

## Overzichtskaart & eten onderweg

Twee dingen die er sinds kort bij zitten.

**Overzichtskaart.** Bovenaan het beginscherm staat nu een kaart met alle acht
routes tegelijk, elk in een eigen kleur, met een klikbare legenda eronder. Zo
zie je in één oogopslag waar een route ligt voor je 'm openklikt — handig als
je aan het plannen bent welke dag welke kant van het eiland past. Tikken op
een lijn of op de legenda opent die route direct.

**Eten onderweg.** Onder de highlights van elke route staat een klein
gecureerd lijstje met ontbijt, lunch en diner — geen sterrenlijst, maar een
paar adressen die opduiken als je locals vraagt waar zij eten. Welke van de
drie bij het huidige tijdstip past, springt eruit met een gouden rand; de
andere twee blijven zichtbaar maar gedimd, zodat je ook voor later op de dag
kunt plannen.

Deze adressen zijn niet verzonnen: ze komen uit onderzoek naar wat er
herhaaldelijk als lokale favoriet naar voren komt (Gambero Rosso-vermeldingen,
terugkerende Google-reviews, culinaire tv-programma's als 4 Ristoranti). Op de
meest afgelegen route, Costa Verde, staat dat er eerlijk bij vermeld — daar is
simpelweg geen sterk onderbouwde aanrader gevonden, en dan verzinnen we er
liever geen.

**Een update pushen:** dezelfde route als altijd — bestand aanpassen op
GitHub, commit, klaar binnen een minuut. Voeg je zelf een eetadres toe, zet
het in de `dining`-array van het bijbehorende routebestand met dezelfde
velden als de bestaande entries (`meal`, `town`, `lat`/`lon`, `name`, `tip`,
`specialty`, `price`).

## Een route toevoegen

Zelfde als bij de native versie: kopieer een bestand in `data/`, hernoem het
naar `route-<iets>.json`, en zet de bestandsnaam ook in
`data/routes-manifest.json`. Commit naar GitHub, klaar — GitHub Pages
publiceert automatisch bij elke commit, meestal binnen een minuut.

---

## Bestandenoverzicht

```
index.html          de hele app in één pagina
manifest.json        Add-to-Home-Screen instellingen
sw.js                 service worker: cachet de app voor offline gebruik
css/style.css         dezelfde kleuren en typografie als de native versie
js/
  app.js               bindt alles samen, tekent de drie schermen
  data.js              laadt routes/weetjes, afstandsberekeningen
  speech.js            Web Speech API, wachtrij, chunking, ducking-vervanger
  geo.js               locatie
  navEngine.js         turn-by-turn via OSRM
  tourEngine.js        highlights + weetjes, zelfde logica als native
  enrichment.js        Wikipedia-extra's
  map.js                Leaflet-kaart (routedetail & rijscherm)
  overviewMap.js         alle acht routes op één kaart, beginscherm
  storage.js            instellingen + routecache in localStorage
  i18n.js                NL/EN teksten voor de interface
data/                  dezelfde acht routes + weetjes als de native versie
icons/                  app-icoon, gegenereerd, geen externe dependency
```
