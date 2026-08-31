interface Env {
  REPORTS_DB: D1Database;
}

// Fino a 48 caratteri per coprire uno slug di 20 più il più lungo suffisso di collisione possibile
// ("-MMDD-N"). Le cifre sono un sottoinsieme di [a-z0-9-], quindi i vecchi ID numerici a 6 cifre
// (dal periodo Netlify) restano validi qui senza bisogno di nessuna logica di compatibilità separata
// - anche se i dati storici non sono stati migrati, il formato ID resta coerente.
const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;

interface ReportRow {
  data: string;
  expiresAt: number;
}

// Nessuna autenticazione qui (a differenza di upload-report): i dati non sono sensibili per
// valutazione esplicita del rischio, e deve restare raggiungibile da un semplice fetch/curl.
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const idParam = new URL(request.url).searchParams.get("id");
  const id = idParam?.toLowerCase() ?? "";
  if (!ID_PATTERN.test(id)) {
    return new Response(JSON.stringify({ error: "ID non valido" }), { status: 400 });
  }

  // D1 ha coerenza immediata scrittura->lettura (niente propagazione ritardata come Netlify Blobs):
  // nessun retry-loop necessario qui, a differenza della versione precedente su Netlify.
  const row = await env.REPORTS_DB.prepare(
    "SELECT data, expiresAt FROM reports WHERE id = ?"
  ).bind(id).first<ReportRow>();

  if (row === null) {
    return new Response(JSON.stringify({ error: "Report non trovato" }), { status: 404 });
  }

  if (Date.now() > row.expiresAt) {
    await env.REPORTS_DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run();
    return new Response(JSON.stringify({ error: "Report scaduto" }), { status: 404 });
  }

  return new Response(row.data, {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
