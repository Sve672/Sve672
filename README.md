# Memo – il tuo assistente personale che ricorda

App per il telefono (Android e iPhone) che fa da assistente virtuale: ci parli scrivendo o a voce,
e **impara e ricorda** quello che gli racconti di te, conversazione dopo conversazione.
Il "cervello" è Claude di Anthropic.

## Cosa sa fare

- **Memoria a lungo termine** – durante la chat l'assistente salva da solo i fatti importanti
  (chi sei, gusti, persone care, lavoro, obiettivi, abitudini, eventi) e li aggiorna o li dimentica
  quando cambiano. Ogni volta che impara qualcosa compare una nota "🧠 Ho imparato: …".
- **Impara il tuo stile** – se lo correggi su come ti risponde, se lo ricorda.
- **Pannello 🧠** – vedi tutto quello che ricorda di te, puoi cercarlo, correggerlo toccando il testo,
  cancellarlo o aggiungere ricordi a mano.
- **Voce** – 🎤 per dettare (italiano) e, nelle impostazioni, lettura ad alta voce delle risposte.
- **Privacy** – ricordi, conversazioni e chiave API restano **solo sul tuo telefono**
  (memoria del browser). Nessun server intermedio: il telefono parla direttamente con l'API di Anthropic.
- **Backup** – esporta/importa un file JSON con tutti i ricordi (utile se cambi telefono).
- Funziona come una vera app: si installa sulla schermata home e si apre a schermo intero.

## Cosa ti serve

Una **chiave API di Anthropic**: crea un account su <https://console.anthropic.com>,
aggiungi un metodo di pagamento e vai su *API Keys → Create Key*. L'uso si paga a consumo
(una chiacchierata normale costa pochi centesimi; con *Claude Haiku 5.5* nelle impostazioni costa molto meno).

## Come metterla sul telefono

L'app deve essere online su un indirizzo `https://`. Il modo più semplice e gratuito è GitHub Pages:

1. Il workflow pubblica dal ramo `main` (o dal ramo `claude/virtual-assistant-memory-ole6z1`, se è quello principale).
2. Su GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Dopo un minuto l'app sarà su `https://<tuo-utente>.github.io/<nome-repo>/`
   (il link compare anche in *Actions* e in *Settings → Pages*).
4. Apri il link sul telefono:
   - **Android (Chrome)**: menu ⋮ → *Installa app* / *Aggiungi a schermata Home*.
   - **iPhone (Safari)**: tasto Condividi → *Aggiungi alla schermata Home*.
5. Apri l'app, inserisci la chiave API e il tuo nome nelle impostazioni ⚙︎, e inizia a parlare.

> ⚠️ La chiave API è salvata nel telefono: chi ha accesso al telefono sbloccato può usarla.
> Puoi impostare un limite di spesa mensile nella console di Anthropic, e revocare la chiave in qualsiasi momento.

## Provarla sul computer

```bash
cd app && python3 -m http.server 8080
# poi apri http://localhost:8080
```

## Come funziona la memoria (per i curiosi)

- I ricordi sono una lista di frasi brevi con categoria e data, salvate nel `localStorage`.
- All'inizio di ogni conversazione vengono passati a Claude nel prompt di sistema.
- Claude ha tre strumenti: `ricorda`, `aggiorna_ricordo`, `dimentica`, che l'app esegue sul telefono.
- Le conversazioni lunghe ripartono automaticamente (o con ✚): i ricordi restano, quindi
  l'assistente continua a conoscerti.

## Struttura

```
app/
  index.html            interfaccia
  style.css             stile (chiaro/scuro automatico)
  app.js                logica: chat, memoria, voce, impostazioni
  sw.js                 service worker (installazione e apertura offline)
  manifest.webmanifest  dati dell'app installabile
  vendor/anthropic.js   SDK ufficiale Anthropic (generato con `npm run build`)
```

Per aggiornare l'SDK: cambia la versione in `package.json`, poi `npm install && npm run build`.
