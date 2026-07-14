# EasyJam Spotify Party Queue

Node.js + React -sovellus, jossa isäntä kirjautuu Spotifyyn ja vieraat lisäävät kappaleita ilman kirjautumista selainkohtaisen UUID:n avulla. Backend pitää vieraiden jonot erillään ja muodostaa Spotifyhin synkronoitavan jonon round-robin-limityksellä.

## Käynnistys

1. Kopioi `.env.example` tiedostoksi `.env`.
2. Luo Spotify Developer Dashboardissa appi ja lisää Redirect URI: `http://localhost:5050/api/auth/callback`.
3. Täytä `.env` arvoilla `SPOTIFY_CLIENT_ID` ja `SPOTIFY_CLIENT_SECRET`.
4. Asenna riippuvuudet ja käynnistä:

```bash
npm install
npm run dev
```

Development frontend: `http://localhost:5173`
Backend/API: `http://localhost:5050`

After `npm run build`, the Express backend also serves the built frontend at:

```text
http://localhost:5050
```

Use this single-port URL when you just want to try the app locally without relying on the separate Vite dev server.

Paikallisessa kehityskäytössä Spotify-arvot voi myös tallentaa admin-paneelista, jos `.env` puuttuu:

```text
http://localhost:5050/admin
```

Lomake tallentaa arvot paikalliseen `.env`-tiedostoon ja on rajattu localhost-käyttöön.
Jos OAuth redirect pitää korjata myöhemmin, avaa `http://localhost:5050/admin?setup=spotify`.

Admin-paneelin suojaus:

- Vierasnäkymässä voidaan näyttää admin-linkki, mutta admin-paneeli pyytää admin-koodia, jos `ADMIN_ACCESS_KEY` on asetettu.
- Admin-paneeli pyytää admin-koodia, jos `ADMIN_ACCESS_KEY` on asetettu `.env`-tiedostoon.
- Paikallisessa kehityksessä admin voi avautua ilman koodia, jos `ADMIN_ACCESS_KEY` puuttuu ja pyyntö tulee localhostista.
- Julkisessa asennuksessa admin-koodi vaaditaan ennen Spotify OAuth -kirjautumisen tai Spotify-asetusten avaamista.

Pysyvä data:

- `DATABASE_PATH` määrittää SQLite-tietokannan sijainnin.
- SQLiteen tallennetaan kutsulinkki, PIN-hash, vieraiden kutsuoikeusasetus, aktiivinen toivejono, vieraat ja heidän järjestyksensä, manuaalinen jonojärjestys, estetyt vieras-ID:t, adminin kiinnitetyt soittolistat, vieraiden tallennetut Spotify-listat ja soitettujen kappaleiden loki. Soitettujen kappaleiden loki on palvelinpuolen append-only-loki, eikä sovellus tyhjennä sitä automaattisesti. Admin-paneelista voi viedä koko lokin tai valitun päivämäärävälin Excel-yhteensopivana CSV-tiedostona, joka sisältää toivojan nimen ja tyypin, jam-tunnisteen sekä UTC- ja palvelimen paikallisen ajan. `playback_observed` tarkoittaa, että EasyJam havaitsi kappaleen alkaneen; se ei takaa, että kappale soitettiin loppuun.
- Spotify OAuth -access tokenit ovat edelleen muistissa, joten backend-restartin jälkeen admin kirjautuu Spotifyyn uudelleen.

OAuth-asetuksista:

- `SPOTIFY_REDIRECT_URI` on pakollinen, koska Spotify palauttaa isännän kirjautumisen jälkeen tähän backend-reittiin.
- `FRONTEND_URL` on sisäinen fallback redirecteihin. Admin-lomake laskee sen automaattisesti nykyisestä osoitteesta, eikä käyttäjän tarvitse täyttää sitä.

## Toteutetut ominaisuudet

- Spotify Authorization Code Flow isännälle.
- Vieraiden localStorage-UUID ja kirjautumaton käyttö.
- Debouncattu Spotify-haku.
- Soittolistan linkitys, localStorage-muisti ja selaus.
- TuneMyMusic CSV/TXT -tuonti vierasnäkymässä: CSV:n Spotify ID:t käytetään suoraan ja TXT:n `Artist - Track` -rivit haetaan Spotify Searchilla.
- Kiinnitetyt soittolistat adminilta vieraiden etusivulle.
- Recommendations-endpointiin perustuvat ehdotukset oman jonon perusteella.
- Round-robin-jonon muodostus käyttäjäkohtaisista jonoista.
- Spotify-soittolistan täysi synkronointi jokaisen lisäyksen, poiston ja admin-järjestelyn jälkeen.
- Admin-paneelin drag-and-drop-manuaalijärjestys ja poistot.
- Admin-paneelin vieraslista, viimeisen 90 sekunnin aktiivisuustila sekä vieraskohtainen tai kaikkien vieraiden poistaminen. Poisto tyhjentää vieraan jonotoiveet eikä ole esto; vieras voi liittyä takaisin voimassa olevalla kutsulla. Erillisellä estotoiminnolla vieras voidaan estää, ja esto voidaan poistaa admin-paneelista.
- React i18n suomeksi ja englanniksi, kielivalinta localStoragessa.
- QR + PIN -kutsumalli: `/join/<token>` vaaditaan aina vieraskäyttöön; admin voi ottaa asetetun PIN-kyselyn käyttöön tai pois käytöstä.
- JAM Screenin QR-koodi näytetään vain kutsuvaltuutetussa näkymässä; avaa se vierasnäkymän JAM Screen -painikkeesta.
- SQLite-pysyvyys kutsuasetuksille, live-jonolle, vieraille ja estoille, tallennetuille soittolistoille sekä palvelimella säilyvälle soitettujen kappaleiden lokille.

## Homelab / Tailscale

Suositeltu suljettu julkaisutapa on ajaa EasyJam homelabin k3s-klusterissa ja julkaista se Tailscalen sisäiseen tailnetiin. Tällöin vieraat pääsevät sovellukseen vain, jos he ovat Tailscale-verkossa tai heille on jaettu Tailscale Serve/Funnel -pääsy.

Päivitetyn version viemiseen homelabiin on oma ohje: [docs/HOMELAB_UPDATE.md](docs/HOMELAB_UPDATE.md).

Tärkeät ympäristöarvot homelabissa:

```env
PORT=5050
DATABASE_PATH=/data/easyjam.sqlite
FRONTEND_URL=https://easyjam.example.com
SPOTIFY_REDIRECT_URI=https://easyjam.example.com/api/auth/callback
ADMIN_ACCESS_KEY=<pitka-admin-salasana>
```

Spotify Developer Dashboardiin pitää lisätä täsmälleen sama Redirect URI kuin `SPOTIFY_REDIRECT_URI`.

Jos päädomain on jo toisen palvelun käytössä, EasyJam kannattaa julkaista erillisessä Tailscale Serve HTTPS -portissa:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:30050
```

Tällöin EasyJamin osoite on:

```text
https://your-tailnet-host.ts.net:8443
```

## Spotify API -huomio

Spotify on merkinnyt Recommendations-endpointin deprekoiduksi. Toteutus kutsuu endpointia pyydetysti, mutta backend käyttää Search API -fallbackia, jos Spotify ei salli Recommendations-kutsua.

Julkisten soittolistojen selaus tapahtuu isännän OAuth-tokenilla. Jos Spotify rajoittaa tietyn soittolistan näkyvyyttä API:ssa, sovellus palauttaa Spotifyn virheen UI:hin.
