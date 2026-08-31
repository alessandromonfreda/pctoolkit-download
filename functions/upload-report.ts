interface Env {
  REPORTS_DB: D1Database;
}

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

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toUpperCase().includes("UNIQUE");
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get(EXPECTED_HEADER) !== EXPECTED_VALUE) {
    return new Response(JSON.stringify({ error: "Richiesta non riconosciuta" }), { status: 403 });
  }

  const requestedId = (request.headers.get(REQUESTED_ID_HEADER) ?? "").toLowerCase();
  if (!REQUESTED_ID_PATTERN.test(requestedId)) {
    return new Response(JSON.stringify({ error: "Identificativo richiesto mancante o non valido" }), { status: 400 });
  }

  const bodyText = await request.text();
  if (!bodyText || bodyText.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Payload mancante o troppo grande" }), { status: 400 });
  }

  try {
    JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "JSON non valido" }), { status: 400 });
  }

  // Deterministico, non casuale: un nome scelto dal tecnico deve restare prevedibile. Primo
  // tentativo: lo slug esatto. Se già occupato (stesso Cliente rivisto in un'altra data, o Cliente
  // omonimo), si aggiunge un suffisso data (MMDD). Se anche quello è occupato (stesso Cliente due
  // volte nello stesso giorno), si aggiunge un contatore progressivo fino a MAX_ID_ATTEMPTS tentativi.
  //
  // A differenza della versione Netlify Blobs (onlyIfNew), qui la chiave primaria della tabella
  // SQLite rende l'INSERT atomico by design: se la chiave esiste già, D1 rifiuta la scrittura con
  // un vincolo UNIQUE, senza bisogno di un get() preventivo (mai affidabile sotto concorrenza).
  const now = new Date();
  const dateSuffix = `${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
  const createdAt = Date.now();
  const expiresAt = createdAt + EXPIRY_MS;

  let finalId: string | null = null;
  for (let i = 0; i < MAX_ID_ATTEMPTS && finalId === null; i++) {
    const candidate =
      i === 0 ? requestedId
      : i === 1 ? `${requestedId}-${dateSuffix}`
      : `${requestedId}-${dateSuffix}-${i}`;

    try {
      await env.REPORTS_DB.prepare(
        "INSERT INTO reports (id, data, createdAt, expiresAt) VALUES (?, ?, ?, ?)"
      ).bind(candidate, bodyText, createdAt, expiresAt).run();
      finalId = candidate;
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      // ID già occupato: prova il prossimo candidato.
    }
  }

  if (finalId === null) {
    return new Response(JSON.stringify({ error: "Riprova con un nome diverso: troppi report già salvati con questo nome oggi" }), { status: 503 });
  }

  return new Response(JSON.stringify({ id: finalId }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
