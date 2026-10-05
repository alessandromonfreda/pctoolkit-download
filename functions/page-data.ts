interface Env {
  REPORTS_DB: D1Database;
}

// Dati di una pagina per il Cliente (diagnosi.html / programmi.html), letti con il codice casuale ricevuto
// su WhatsApp. Nessuna chiave: chi ha il codice e' il Cliente (60 bit casuali, non indovinabili). Non
// restituisce mai reportId, che contiene il nome del Cliente. Vedi publish-page.ts.
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

interface PageRow {
  kind: string;
  data: string;
  expiresAt: number;
  choices: string | null;
  choicesAt: number | null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" }
  });
}

async function loadPage(db: D1Database, code: string): Promise<PageRow | null> {
  try {
    const row = await db.prepare(
      "SELECT kind, data, expiresAt, choices, choicesAt FROM customer_pages WHERE code = ?"
    ).bind(code).first<PageRow>();
    if (row === null) {
      return null;
    }
    if (Date.now() > row.expiresAt) {
      await db.prepare("DELETE FROM customer_pages WHERE code = ?").bind(code).run();
      return null;
    }
    return row;
  } catch {
    // Tabella non ancora creata (nessuna pagina mai pubblicata): equivale a "non trovata".
    return null;
  }
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const code = (new URL(request.url).searchParams.get("c") ?? "").toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    return json({ error: "Codice non valido" }, 400);
  }
  const row = await loadPage(env.REPORTS_DB, code);
  if (row === null) {
    return json({ error: "Pagina non trovata o scaduta" }, 404);
  }
  return json({
    kind: row.kind,
    data: JSON.parse(row.data),
    choices: row.choices ? JSON.parse(row.choices) : null,
    choicesAt: row.choicesAt ? new Date(row.choicesAt).toISOString() : null
  }, 200);
};
