import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

// Verificato empiricamente il 18/08/2026: la propagazione di una scrittura appena fatta su Netlify
// Blobs può richiedere più di 4-5s in alcuni casi - 6 tentativi da 2s (fino a 12s in più) coprono
// con margine quanto osservato, e riguardano SOLO il percorso "non trovato" (una lettura di un
// report generato anche solo qualche minuto prima lo trova sempre al primo tentativo, zero ritardo).
const NOT_FOUND_RETRY_ATTEMPTS = 6;
const NOT_FOUND_RETRY_DELAY_MS = 2000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Nessuna autenticazione qui (a differenza di upload-report): i dati non sono sensibili per
// valutazione esplicita del rischio, e deve restare raggiungibile da un semplice fetch/curl.
export default async (req: Request, context: Context) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^\d{6}$/.test(id)) {
    return new Response(JSON.stringify({ error: "ID non valido" }), { status: 400 });
  }

  const store = getStore("reports");

  // Verificato il 18/08/2026: una lettura fatta a ridosso di una scrittura appena avvenuta può
  // restituire "non trovato" per qualche secondo (propagazione, non un bug del nostro codice) -
  // pochi tentativi ravvicinati riducono di molto il rischio di un falso negativo per chi recupera
  // il report subito dopo averlo generato, senza rallentare il caso comune (trovato al primo colpo).
  let entry = await store.getWithMetadata(id);
  for (let attempt = 0; entry === null && attempt < NOT_FOUND_RETRY_ATTEMPTS; attempt++) {
    await delay(NOT_FOUND_RETRY_DELAY_MS);
    entry = await store.getWithMetadata(id);
  }

  if (entry === null) {
    return new Response(JSON.stringify({ error: "Report non trovato" }), { status: 404 });
  }

  const expiresAt = entry.metadata?.expiresAt as number | undefined;
  if (typeof expiresAt === "number" && Date.now() > expiresAt) {
    await store.delete(id);
    return new Response(JSON.stringify({ error: "Report scaduto" }), { status: 404 });
  }

  return new Response(entry.data, {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
