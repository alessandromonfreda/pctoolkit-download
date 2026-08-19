import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

// Filtro contro spam/scansioni automatiche, non un vero segreto (visibile a chi decompila l'exe) -
// i report non contengono dati sensibili (niente password, niente contenuti di file personali).
const EXPECTED_HEADER = "x-pctoolkit-client";
const EXPECTED_VALUE = "compulandia-pctoolkit-v1";
const REQUESTED_ID_HEADER = "x-pctoolkit-requested-id";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 giorni, scelta esplicita dell'utente
const MAX_ID_ATTEMPTS = 5;

// Stesso limite di 20 caratteri del client (Helpers/ReportIdSlugGenerator.cs) - mai fidarsi solo
// della validazione lato client, un client futuro o una richiesta scritta a mano potrebbe non
// rispettarla. Un solo carattere alfanumerico è valido (caso limite ma legittimo).
const REQUESTED_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;

function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Metodo non consentito" }), { status: 405 });
  }

  if (req.headers.get(EXPECTED_HEADER) !== EXPECTED_VALUE) {
    return new Response(JSON.stringify({ error: "Richiesta non riconosciuta" }), { status: 403 });
  }

  const requestedId = (req.headers.get(REQUESTED_ID_HEADER) ?? "").toLowerCase();
  if (!REQUESTED_ID_PATTERN.test(requestedId)) {
    return new Response(JSON.stringify({ error: "Identificativo richiesto mancante o non valido" }), { status: 400 });
  }

  const bodyText = await req.text();
  if (!bodyText || bodyText.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Payload mancante o troppo grande" }), { status: 400 });
  }

  try {
    JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "JSON non valido" }), { status: 400 });
  }

  const store = getStore("reports");

  // Deterministico, non casuale (a differenza del vecchio ID numerico): un nome scelto dal tecnico
  // deve restare prevedibile. Primo tentativo: lo slug esatto. Se già occupato (stesso Cliente
  // rivisto in un'altra data, o Cliente omonimo), si aggiunge un suffisso data (MMDD) - mai
  // sovrascrivere un report esistente. Se anche quello è occupato (stesso Cliente due volte nello
  // stesso giorno), si aggiunge un contatore progressivo fino a MAX_ID_ATTEMPTS tentativi totali.
  const now = new Date();
  const dateSuffix = `${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;

  let id: string | null = null;
  for (let i = 0; i < MAX_ID_ATTEMPTS && id === null; i++) {
    const candidate =
      i === 0 ? requestedId
      : i === 1 ? `${requestedId}-${dateSuffix}`
      : `${requestedId}-${dateSuffix}-${i}`;

    const existing = await store.get(candidate);
    if (existing === null) {
      id = candidate;
    }
  }

  if (id === null) {
    return new Response(JSON.stringify({ error: "Riprova con un nome diverso: troppi report già salvati con questo nome oggi" }), { status: 503 });
  }

  // Nessun TTL nativo in Netlify Blobs: la scadenza è un timestamp nei metadata, controllato in
  // lettura da get-report.mts (che cancella e ritorna 404 se scaduto).
  await store.set(id, bodyText, {
    metadata: { expiresAt: Date.now() + EXPIRY_MS, createdAt: Date.now() }
  });

  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
