import { getStore } from "@netlify/blobs";
import type { Context } from "@netlify/functions";

// Nessuna autenticazione qui (a differenza di upload-report): i dati non sono sensibili per
// valutazione esplicita del rischio, e deve restare raggiungibile da un semplice fetch/curl.
export default async (req: Request, context: Context) => {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !/^\d{6}$/.test(id)) {
    return new Response(JSON.stringify({ error: "ID non valido" }), { status: 400 });
  }

  const store = getStore("reports");
  const entry = await store.getWithMetadata(id);
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
