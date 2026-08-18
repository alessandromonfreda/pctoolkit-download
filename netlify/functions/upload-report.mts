import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

// Filtro contro spam/scansioni automatiche, non un vero segreto (visibile a chi decompila l'exe) -
// i report non contengono dati sensibili (niente password, niente contenuti di file personali).
const EXPECTED_HEADER = "x-pctoolkit-client";
const EXPECTED_VALUE = "compulandia-pctoolkit-v1";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 giorni, scelta esplicita dell'utente
const MAX_ID_ATTEMPTS = 5;

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Metodo non consentito" }), { status: 405 });
  }

  if (req.headers.get(EXPECTED_HEADER) !== EXPECTED_VALUE) {
    return new Response(JSON.stringify({ error: "Richiesta non riconosciuta" }), { status: 403 });
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

  // Spazio di 900.000 combinazioni (100000-999999): collisione praticamente impossibile ai volumi
  // reali, ma verificata comunque prima di salvare - "meglio nessun ID che uno duplicato".
  let id: number | null = null;
  for (let i = 0; i < MAX_ID_ATTEMPTS && id === null; i++) {
    const candidate = Math.floor(100000 + Math.random() * 900000);
    const existing = await store.get(String(candidate));
    if (existing === null) {
      id = candidate;
    }
  }

  if (id === null) {
    return new Response(JSON.stringify({ error: "Riprova: ID temporaneamente non disponibile" }), { status: 503 });
  }

  // Nessun TTL nativo in Netlify Blobs: la scadenza è un timestamp nei metadata, controllato in
  // lettura da get-report.mts (che cancella e ritorna 404 se scaduto).
  await store.set(String(id), bodyText, {
    metadata: { expiresAt: Date.now() + EXPIRY_MS, createdAt: Date.now() }
  });

  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
