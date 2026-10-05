interface Env {
  REPORTS_DB: D1Database;
}

// Scelte del Cliente sulla pagina "programmi" ("Lo uso / Non lo uso / Non so", e "Voglio tenerlo" per i
// programmi che toglieremmo). POST le salva (il Cliente puo' cambiarle finche' la pagina non scade); GET le
// restituisce con i dati della pagina, per lo script del negozio e per TK (Sessione automatica -> "Importa
// scelte del Cliente"), che ne ricava i nomi esatti dei programmi da "nomiEsatti".
// Autosufficiente di proposito (niente import tra funzioni): su questo PC non si possono provare in locale.
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const MAX_BODY_BYTES = 64 * 1024;
const VALORI_DOMANDA = ["uso", "non-uso", "non-so"];
const VALORI_TOGLIERE = ["tieni", "togli"];

interface PageRow {
  kind: string;
  data: string;
  expiresAt: number;
  choices: string | null;
  choicesAt: number | null;
}

interface PageData {
  domande?: { gruppo: string }[];
  daTogliere?: { gruppo: string }[];
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
    if (row === null || Date.now() > row.expiresAt) {
      return null;
    }
    return row;
  } catch {
    return null;
  }
}

function codeFrom(request: Request): string {
  return (new URL(request.url).searchParams.get("c") ?? "").toUpperCase();
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const code = codeFrom(request);
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const code = codeFrom(request);
  if (!CODE_PATTERN.test(code)) {
    return json({ error: "Codice non valido" }, 400);
  }
  const row = await loadPage(env.REPORTS_DB, code);
  if (row === null) {
    return json({ error: "Pagina non trovata o scaduta" }, 404);
  }
  if (row.kind !== "programmi") {
    return json({ error: "Questa pagina non raccoglie scelte" }, 400);
  }

  const text = await request.text();
  if (!text || text.length > MAX_BODY_BYTES) {
    return json({ error: "Contenuto mancante o troppo grande" }, 413);
  }
  let body: { choices?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "JSON non valido" }, 400);
  }
  if (typeof body.choices !== "object" || body.choices === null || Array.isArray(body.choices)) {
    return json({ error: "Scelte non valide" }, 400);
  }

  // Solo gruppi della pagina e solo valori ammessi per quel tipo di voce: niente dati estranei in D1.
  const data = JSON.parse(row.data) as PageData;
  const domande = new Set((data.domande ?? []).map((d) => d.gruppo));
  const togliere = new Set((data.daTogliere ?? []).map((d) => d.gruppo));
  const pulite: Record<string, string> = {};
  for (const [gruppo, valore] of Object.entries(body.choices as Record<string, unknown>)) {
    if (typeof valore !== "string") {
      return json({ error: "Scelta non valida" }, 400);
    }
    if (domande.has(gruppo) && VALORI_DOMANDA.includes(valore)) {
      pulite[gruppo] = valore;
    } else if (togliere.has(gruppo) && VALORI_TOGLIERE.includes(valore)) {
      pulite[gruppo] = valore;
    } else {
      return json({ error: "Scelta non valida" }, 400);
    }
  }

  await env.REPORTS_DB.prepare("UPDATE customer_pages SET choices = ?, choicesAt = ? WHERE code = ?")
    .bind(JSON.stringify(pulite), Date.now(), code).run();
  return json({ ok: true }, 200);
};
