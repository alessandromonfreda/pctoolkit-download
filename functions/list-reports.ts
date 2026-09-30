interface Env {
  REPORTS_DB: D1Database;
}

interface ReportListRow {
  id: string;
  createdAt: number;
  expiresAt: number;
}

// Dal 30/09/2026 l'elenco si legge solo con la chiave di lettura: gli identificativi dei report sono i
// nomi dei Clienti. Stessa impronta e stessa spiegazione di get-report.ts.
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

// Nato il 31/08/2026: prima di questa funzione bisognava sapere a memoria l'esatto ID/slug di un
// report per recuperarlo - inaffidabile a comando (l'ID dipende dal nome digitato dal tecnico e da
// eventuali suffissi di collisione data/contatore, mai indovinabile con certezza). Questa funzione
// permette di elencare i report esistenti (più recenti prima) invece di doverli indovinare.
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!(await hasReadKey(request))) {
    return new Response(JSON.stringify({ error: "Accesso riservato a Compulandia" }), { status: 401 });
  }

  const { results } = await env.REPORTS_DB.prepare(
    "SELECT id, createdAt, expiresAt FROM reports WHERE expiresAt > ? ORDER BY createdAt DESC"
  ).bind(Date.now()).all<ReportListRow>();

  return new Response(JSON.stringify({ reports: results }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
