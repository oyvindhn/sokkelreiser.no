# Sokkelreise

Finn tilbake til hvor du har vært offshore. Last inn reiseloggen fra MinDaVinci, så viser kartet hvor du var på hver tur, også på flyttbare rigger som har flyttet seg mellom brønner.

**https://sokkelreise.no**

## Slik virker det

1. Brukeren eksporterer reisehistorikken fra MinDaVinci (Excel) eller lager en CSV med dato og installasjon.
2. Filen leses i nettleseren. Ingenting lastes opp.
3. Installasjonene i loggen kobles til innretninger hos [Sodir](https://factpages.sodir.no). Sikre navnetreff kobles automatisk.
4. For flyttbare rigger slår appen opp riggens brønner hos Sodir og finner hvilken brønn den boret på i oppholdsperioden. Hver posisjon får en sikkerhetsgrad: Sikker, Trolig, Usikker eller Ukjent.

I tillegg kan man slå opp en rigg uten egen logg og se hvor den har boret, eller hvor den lå på en bestemt dato.

### Prinsipper

- Ingen hardkodede navn, reiser, flyplasser eller rigger. Bare kystlinjer er bygd inn (Natural Earth, public domain).
- Ingen server, ingen database og ingen pålogging. Dataene ligger i brukerens nettleser (localStorage) til brukeren sletter dem, og kan lagres som en prosjektfil.
- Ingen JavaScript-biblioteker. Kartet tegnes med canvas, og .xlsx leses med nettleserens egen dekomprimering.

## Struktur

```
src/
  core.js      Ren logikk: import, kolonnegjenkjenning, opphold, Sodir-oppslag. Ingen DOM.
  ui.js        Tilstand, Sodir-klient, kartmotor og visninger
  style.css    Design (lyst og mørkt tema)
  body.html    HTML-skjelett
data/
  basemap.json Kystlinjer og grenser
static/        Kopieres rett til public/ (.htaccess, favicon, robots.txt)
tests/         Tester (node --test)
build.py       Setter alt sammen til public/index.html
```

## Utvikling

```bash
python3 build.py            # -> public/index.html
node --test tests/*.test.js # tester for core.js
python3 -m http.server -d public 8000
```

Åpne http://localhost:8000. Sodir-oppslag krever nett.

## Publisering til ProISP

Hver push til `main` testes, bygges og lastes opp til webhotellet med FTPS via GitHub Actions (`.github/workflows/deploy.yml`). Pull requests bygges og testes, men publiseres ikke.

Engangsoppsett i GitHub (*Settings → Secrets and variables → Actions*):

| Navn | Type | Verdi |
|---|---|---|
| `FTP_SERVER` | Secret | FTP-vertsnavnet fra ProISP-kontrollpanelet |
| `FTP_USERNAME` | Secret | FTP-brukeren |
| `FTP_PASSWORD` | Secret | FTP-passordet |
| `FTP_SERVER_DIR` | Variable (valgfri) | Mappen på serveren. Standard er `public_html/` |

Uten `FTP_SERVER` hopper workflowen over opplastingen, så bygget feiler ikke før oppsettet er på plass. Publisering kan også startes manuelt under *Actions → Bygg og publiser → Run workflow*.

Når SSL-sertifikatet er aktivt hos ProISP: fjern `#` foran HTTPS-omdirigeringen og `Strict-Transport-Security` i `static/.htaccess`.

## Datakilder

- Sodir FactMaps REST: `factmaps.sodir.no/api/rest/services/DataService/Data/FeatureServer`
  - lag 6000 `facility`: innretninger og posisjon for faste innretninger
  - lag 5000 `wellbore`: brønner med boreinnretning, start- og sluttdato og posisjon
  - Svar caches i nettleseren i 14 dager.
- Hvis API-et ikke svarer, kan Sodirs tabeller lastes ned som CSV og slippes inn i appen. De gjenkjennes på kolonnene `wlbWellboreName` og `fclName`.

## Kjente begrensninger

- Sodir dekker bare norsk sokkel. Rigger på britisk eller dansk side må plasseres manuelt.
- Sluttdatoen hos Sodir er når boringen ble avsluttet. Riggen kan ha ligget lenger (komplettering, plugging), derfor regnes treff innen 21 dager som «Trolig».
- Boligrigger og fartøy borer ikke og finnes derfor ikke i brønndataene. De kan settes til å følge en annen installasjon.
