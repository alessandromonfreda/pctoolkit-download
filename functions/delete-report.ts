interface Env {
  REPORTS_DB: D1Database;
}

// Nato il 10/11/2026: due report intestati per errore al Cliente sbagliato (2g-autoricambi-nb e
// 2g-auto-batteria, in realta' un notebook di Brin Credit) non si potevano togliere ne' rinominare, perche'
// il sito non aveva nessuna funzione di cancellazione (le righe scadute le toglie get-report al primo accesso).
// Stessa chiave di lettura e stessa impronta di get-report.ts / list-reports.ts: senza l'intestazione giusta
// la risposta e' 401 e non si cancella nulla. Cancella un report per volta, per ID esatto.
const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const READ_KEY_HEADER = "x-pctoolkit-read-key";
const READ_KEY_SHA256 = "c3d05a46e2e54253d057d1f15bd36459a03b96fde2c70693b1839572c8157c36";

async function hasReadKey(request: Request): Promise<boolean> {
  const key = request.headers.get(READ_KEY_HEADER);
  if (!key) {
    return false;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === READ_KEY_SHA256;
}

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  if (!(await hasReadKey(request))) {
    return new Response(JSON.stringify({ error: "Accesso riservato a Compulandia" }), { status: 401 });
  }

  const id = (new URL(request.url).searchParams.get("id") ?? "").toLowerCase();
  if (!ID_PATTERN.test(id)) {
    return new Response(JSON.stringify({ error: "ID non valido" }), { status: 400 });
  }

  const risultato = await env.REPORTS_DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run();
  const cancellati = risultato.meta?.changes ?? 0;

  // Esito del WhatsApp: tabella creata da upload-report.ts al primo uso, puo' non esistere.
  try {
    await env.REPORTS_DB.prepare("DELETE FROM report_notifications WHERE id = ?").bind(id).run();
  } catch {
    // niente da togliere
  }

  if (cancellati === 0) {
    return new Response(JSON.stringify({ error: "Report non trovato" }), { status: 404 });
  }
  return new Response(JSON.stringify({ deleted: id }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
