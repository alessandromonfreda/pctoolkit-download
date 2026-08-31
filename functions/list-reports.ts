interface Env {
  REPORTS_DB: D1Database;
}

interface ReportListRow {
  id: string;
  createdAt: number;
  expiresAt: number;
}

// Stessa scelta di rischio già presa per get-report: nessuna autenticazione, elenca solo
// id/date, mai il contenuto dei report.
// Nato il 31/08/2026: prima di questa funzione bisognava sapere a memoria l'esatto ID/slug di un
// report per recuperarlo - inaffidabile a comando (l'ID dipende dal nome digitato dal tecnico e da
// eventuali suffissi di collisione data/contatore, mai indovinabile con certezza). Questa funzione
// permette di elencare i report esistenti (più recenti prima) invece di doverli indovinare.
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const { results } = await env.REPORTS_DB.prepare(
    "SELECT id, createdAt, expiresAt FROM reports WHERE expiresAt > ? ORDER BY createdAt DESC"
  ).bind(Date.now()).all<ReportListRow>();

  return new Response(JSON.stringify({ reports: results }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
