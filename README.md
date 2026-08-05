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

## Licht en donker

Onder Instellingen → Weergave staan drie standen: **Automatisch**, **Licht**
en **Donker**.

Op automatisch volgt de app de echte zon op jouw locatie: licht tussen
zonsopkomst en zonsondergang, donker daarbuiten. Zodra de app een GPS-fix
heeft, rekent hij zonsopkomst en -ondergang zelf uit. Heeft hij nog geen
locatie — bijvoorbeeld als je thuis zit te plannen — dan volgt hij de
weergave-instelling van je telefoon, en schakelt hij mee op het moment dat
iOS dat doet.

De zonsberekening negeert de tijdsvereffening, dus hij kan door het jaar heen
tot ongeveer een kwartier afwijken. Voor het dimmen van een scherm maakt dat
niets uit; voor sterrenkijken zou je iets nauwkeurigers willen.

---

## Routes toevoegen uit Komoot, Strava en andere apps

Onderaan het beginscherm staat **Route toevoegen uit GPX**.

**Waarom GPX en niet een Komoot-koppeling?** Omdat die niet bestaat. Komoot
zegt zelf dat ze geen publiek toegankelijke API aanbieden en alleen koppelen
met geselecteerde fabrikanten als Garmin, Bosch en Suunto. Er circuleren
omwegen via hun interne frontend-API, maar die vragen om je Komoot-wachtwoord
en breken zodra Komoot iets verandert — niets om je vakantie van af te laten
hangen.

GPX werkt daarentegen overal: Komoot, Strava, Wikiloc, RideWithGPS,
Outdooractive en Garmin exporteren het allemaal. In Komoot: open een route →
de drie puntjes → **Exporteer als GPX**.

**Wat de app er daarna zelf bij zoekt.** Na het inlezen loopt de app in
stappen van vier kilometer langs je track en vraagt bij elk punt aan
Wikipedia wat daar in de buurt ligt. Alles wat binnen 2,5 kilometer van de
route valt komt in de selectie, dubbele treffers gaan eruit, plekken die te
dicht op elkaar zitten ook, en wat overblijft wordt op volgorde van rijden
gezet. Van elke plek haalt hij vervolgens de samenvatting op en maakt daar
het verhaal van dat je onderweg hoort. Maximaal veertien per route.

Dat kost even: een lange route betekent veel beleefde verzoeken aan een
gratis dienst. Een voortgangsbalk laat zien waar hij is. Doe dit thuis op
wifi, niet bij vertrek.

**Twee dingen om te weten.** Een geïmporteerde route wordt in één taal
opgebouwd — de taal die op dat moment in de app staat — en de verhalen
blijven in die taal, ook als je later omschakelt. Machinaal vertalen zou het
subtiel fout doen, dus dat doen we niet. En de kwaliteit hangt af van wat
Wikipedia over een streek weet: rond Sardijnse dorpen is dat veel, in een
leeg stuk bergland weinig tot niets.

Geïmporteerde routes staan met het label **EIGEN** in de lijst en op de
overzichtskaart, en zijn op hun eigen detailpagina weer te verwijderen. Ze
worden in je browser opgeslagen, dus een app-update raakt ze niet — maar
"websitegegevens wissen" in Safari wel.

---

## Weer, gouden uur en foto's

Op elke routepagina staat nu het actuele weer op het startpunt, met
zonsopkomst en -ondergang, via **Open-Meteo** — gratis, geen sleutel, geen
account.

Daaronder staat een vertrektijd. De redenering: het mooiste licht op deze
wegen is het uur voor zonsondergang, en elke route eindigt ergens waar je
dat wilt meemaken. De app rekent terug vanaf zonsondergang, zet je twintig
minuten daarvoor op het eindpunt, en rekent anderhalf keer de kale rijtijd —
want in de praktijk stop je voor foto's, koffie en een kudde geiten. Is dat
moment vandaag al voorbij, dan zegt hij dat gewoon.

Bij de highlights staan foto's van Wikipedia, en op het rijscherm verschijnt
een klein plaatje van de plek waar de gids het over heeft. Beide zijn puur
extra: geen bereik of online extra's uitgezet betekent simpelweg geen foto's,
verder verandert er niets.

---

## Als er iets misgaat

Onderaan het scherm verschijnt nu een rood balkje zodra er een fout optreedt,
met de melding, het bestand en het regelnummer, plus een kopieerknop. Een
telefoon heeft geen console, dus zonder dat is een opstartfout niets meer dan
een leeg scherm. Loop je ergens tegenaan: tik op **Kopieer** en plak het.

Krijg je vlak na een update een vreemde fout, probeer dan eerst dit — dan
serveert de service worker waarschijnlijk oude en nieuwe bestanden door
elkaar:

1. Verwijder het app-icoon van je beginscherm
2. Safari → Instellingen → Geschiedenis en websitegegevens wissen
3. Open de link opnieuw en zet hem terug op je beginscherm

---

## Naar het startpunt navigeren

De knop **Open in kaarten-app** op elke routepagina kiest zelf het juiste
doel en zegt in het label waar hij je heen stuurt.

De test is niet "hoe ver ben ik van het startpunt", maar "zit ik op de
route". Dat verschil is belangrijk: sta je halverwege de rit, dan wil je naar
het eind, niet terug naar het begin.

- **Meer dan 1,5 km van de routelijn** — bijvoorbeeld in je hotel, bij de
  veerboot in Olbia of op het vliegveld — dan stuurt hij je naar het
  **startpunt**, met de afstand erbij.
- **Op of vlak bij de route** dan stuurt hij je naar het **eindpunt**.
- **Nog geen locatie bekend** dan het startpunt, want dat is wat je nodig
  hebt voor je vertrekt.

Onder de knop staat altijd een tekstlink naar de andere kant, dus de keuze
wordt je nooit uit handen genomen.

De app vraagt hiervoor geen extra toestemming. Pas nadat je één keer een rit
hebt gestart en locatie hebt toegestaan, haalt hij op de routepagina stilletjes
één positie op om de afstand te kunnen tonen. Wie alleen wat routes zit te
lezen, krijgt geen enkele pop-up.

---

## Muziek bedienen tijdens het rijden

Op het rijscherm staat een muziekbalk boven de drie gidsknoppen: titel,
artiest, hoesje, en knoppen voor vorige, pauze en volgende.

### Spotify

Werkt, maar er zijn voorwaarden — en die komen van Spotify, niet van deze app:

- **Je hebt Spotify Premium nodig.** De bedieningsendpoints zijn Premium-only.
- Sinds februari 2026 moet ook de *eigenaar* van de gekoppelde app Premium
  hebben, mag je één Client ID per account, en maximaal vijf gebruikers. Voor
  persoonlijk gebruik ruim voldoende.
- Bediening loopt via de servers van Spotify, dus het heeft internet nodig en
  reageert met een halve tot twee seconden vertraging. In de dode zones op de
  SS125 en in de Barbagia werkt het niet.

**Eenmalig instellen (5 minuten):**

1. Ga naar `developer.spotify.com/dashboard` → **Create app**
2. Naam: `Sardegna`. Redirect URI: **exact** het adres dat in de instellingen
   van de app onder het Client ID-veld staat — kopieer het daarvandaan, een
   afwijkende schuine streep is al genoeg om het te laten mislukken
3. Vink **Web API** aan → **Save**
4. Kopieer de **Client ID**. Het Client Secret heb je níét nodig: de app
   gebruikt PKCE, zodat er geen geheim in publieke code hoeft te staan
5. In het dashboard: **User Management** → voeg je eigen Spotify-mailadres toe
6. Plak de Client ID in de app onder Instellingen → Muziek → **Koppel Spotify**

Start daarna één nummer in de Spotify-app zelf. De Web API bestuurt een
*actief apparaat*; zonder iets dat speelt is er niets om te besturen.

### Radio

TuneIn kan niet bediend worden: hun Platform API is partner-gericht en zit
achter een evaluatieovereenkomst en certificering, bedoeld voor Sonos en
autofabrikanten.

In plaats daarvan speelt de radio in de app zelf. NPO Radio 1 tot en met 5
staan er standaard in, en via het zoekveld vind je elke andere zender —
Qmusic, 538, Sky, Veronica — in de open zenderdatabase van Radio Browser
(gratis, geen sleutel, geen login).

Eén technisch detail dat je kan opvallen: alleen zenders met een
HTTPS-stream verschijnen in de lijst. De app draait zelf op HTTPS en browsers
blokkeren onbeveiligde audio daarbinnen. Een aantal oudere zenders valt
daardoor af. Streamadressen verouderen ook; werkt een zender niet meer, zoek
hem dan opnieuw op.

### Automatisch dimmen

Aan, en instelbaar tussen 5% en 70%. Zodra de gids begint te praten gaat je
muziek zachter, daarna weer terug.

Voor de radio is dat exact en direct — een korte fade omlaag en omhoog,
omdat een harde volumesprong klinkt als een storing. Voor Spotify gaat het
via een volumeopdracht over het netwerk, dus daar zit ongeveer een seconde
vertraging in.

Dit is meteen de oplossing voor iets wat eerder niet kon: zonder deze
koppeling pauzeert iOS je muziek bij elk verhaal in plaats van hem te dimmen.

Stop je de rit, dan blijft de radio bewust doorspelen — je rit beëindigen
hoort je muziek niet af te kappen.

---

## Een route toevoegen aan de app zelf (voor ingebouwde routes)

Wil je een route meeleveren in plaats van importeren: kopieer een bestand in `data/`, hernoem het
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
  overviewMap.js         alle routes op één kaart, beginscherm
  theme.js               licht/donker + zonsopkomst-berekening
  gpxImport.js           GPX inlezen + highlights zoeken via Wikipedia
  weather.js             weer + gouden-uur vertrektijd (Open-Meteo)
  spotify.js             Spotify-koppeling (PKCE) en bediening
  radio.js               internetradio in de app + zender zoeken
  storage.js            instellingen + routecache in localStorage
  i18n.js                NL/EN teksten voor de interface
data/                  dezelfde acht routes + weetjes als de native versie
icons/                  app-icoon, gegenereerd, geen externe dependency
```
