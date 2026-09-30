interface Env {
  REPORTS_DB: D1Database;
}

// Fino a 48 caratteri per coprire uno slug di 20 più il più lungo suffisso di collisione possibile
// ("-MMDD-N"). Le cifre sono un sottoinsieme di [a-z0-9-], quindi i vecchi ID numerici a 6 cifre
// (dal periodo Netlify) restano validi qui senza bisogno di nessuna logica di compatibilità separata
// - anche se i dati storici non sono stati migrati, il formato ID resta coerente.
const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;

// Dal 30/09/2026 i report si leggono solo con la chiave di lettura: con la versione per il Cliente
// (Compulandia Report PC) gli identificativi sono i nomi dei Clienti e i report contengono i loro dati.
// Qui c'è solo l'impronta SHA-256 della chiave, un valore casuale di 256 bit custodito nel Gestore
// credenziali di Windows del PC di Compulandia: questo repository è pubblico, e da quest'impronta non
// si risale alla chiave. Stessa costante in list-reports.ts: per cambiarla vedi
// tools/ChiaveReport/chiave_report.py nel repository PCToolkit.
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

interface ReportRow {
  data: string;
  expiresAt: number;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!(await hasReadKey(request))) {
    return new Response(JSON.stringify({ error: "Accesso riservato a Compulandia" }), { status: 401 });
  }

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
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
