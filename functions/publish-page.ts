interface Env {
  REPORTS_DB: D1Database;
}

// Pagine per il Cliente (05/10/2026): "diagnosi" (problemi del PC spiegati in modo semplice) e "programmi"
// (il Cliente sceglie "Lo uso / Non lo uso"). Le pubblica solo lo script del negozio
// (.claude/skills/diagnosi-cliente-tk/scripts/cliente_tk.py), con la stessa chiave di lettura dei report.
// Il Cliente le apre con un codice casuale (mai il suo nome, che e' lo slug del report): vedi page-data.ts
// e page-choices.ts. Questo repository e' pubblico: i dati stanno solo in D1.
//
// Stessa impronta in get-report.ts, list-reports.ts e qui: il test test_impronte_allineate.py della skill
// diagnosi-cliente-tk fallisce se divergono (per cambiarla vedi tools/ChiaveReport/chiave_report.py).
const READ_KEY_HEADER = "x-pctoolkit-read-key";
const READ_KEY_SHA256 = "c3d05a46e2e54253d057d1f15bd36459a03b96fde2c70693b1839572c8157c36";

const KINDS = ["diagnosi", "programmi"];
const MAX_BODY_BYTES = 512 * 1024;
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // come i report
const REPORT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
// 32 simboli senza quelli che si confondono (0/O, 1/I): 12 caratteri = 60 bit, non indovinabile.
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_TENTATIVI = 5;
// Nome (ed eventuale telefono) del Cliente, solo per la notifica WhatsApp ad Alessandro (page-choices.ts):
// tabella a parte, mai restituita dalle pagine pubbliche, cancellata alla scadenza della pagina.
const MAX_ETICHETTA = 120;

async function hasReadKey(request: Request): Promise<boolean> {
  const key = request.headers.get(READ_KEY_HEADER);
  if (!key) {
    return false;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === READ_KEY_SHA256;
}

// Tabella creata qui al primo uso: su questo PC non c'e' wrangler per applicare schema.sql a mano.
async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS customer_pages (code TEXT PRIMARY KEY, kind TEXT NOT NULL, reportId TEXT NOT NULL, " +
    "data TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, choices TEXT, choicesAt INTEGER)"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS customer_labels (code TEXT PRIMARY KEY, label TEXT NOT NULL, expiresAt INTEGER NOT NULL)"
  ).run();
}

function nuovoCodice(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (let i = 0; i < 12; i++) {
    s += ALFABETO[bytes[i] % 32];
    if (i === 3 || i === 7) {
      s += "-";
    }
  }
  return s;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!(await hasReadKey(request))) {
    return json({ error: "Accesso riservato a Compulandia" }, 401);
  }

  const text = await request.text();
  if (!text || text.length > MAX_BODY_BYTES) {
    return json({ error: "Contenuto mancante o troppo grande" }, 413);
  }

  let body: { kind?: unknown; reportId?: unknown; data?: unknown; etichetta?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "JSON non valido" }, 400);
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  const reportId = typeof body.reportId === "string" ? body.reportId.toLowerCase() : "";
  if (!KINDS.includes(kind) || !REPORT_ID_PATTERN.test(reportId)) {
    return json({ error: "Tipo di pagina o report non validi" }, 400);
  }
  if (typeof body.data !== "object" || body.data === null || (body.data as { tipo?: unknown }).tipo !== kind) {
    return json({ error: "Dati della pagina non validi" }, 400);
  }

  if (body.etichetta !== undefined &&
      (typeof body.etichetta !== "string" || !body.etichetta.trim() || body.etichetta.length > MAX_ETICHETTA)) {
    return json({ error: "Etichetta del Cliente non valida" }, 400);
  }
  const etichetta = typeof body.etichetta === "string" ? body.etichetta.trim() : null;

  await ensureTable(env.REPORTS_DB);
  const now = Date.now();
  const data = JSON.stringify(body.data);
  for (let i = 0; i < MAX_TENTATIVI; i++) {
    const code = nuovoCodice();
    try {
      await env.REPORTS_DB.prepare(
        "INSERT INTO customer_pages (code, kind, reportId, data, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(code, kind, reportId, data, now, now + EXPIRY_MS).run();
      if (etichetta) {
        await env.REPORTS_DB.prepare("DELETE FROM customer_labels WHERE expiresAt < ?").bind(now).run();
        await env.REPORTS_DB.prepare("INSERT INTO customer_labels (code, label, expiresAt) VALUES (?, ?, ?)")
          .bind(code, etichetta, now + EXPIRY_MS).run();
      }
      const url = `${new URL(request.url).origin}/${kind}?c=${code}`;
      return json({ code, url }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toUpperCase().includes("UNIQUE")) {
        return json({ error: "Salvataggio non riuscito" }, 500);
      }
    }
  }
  return json({ error: "Codice non disponibile, riprovare" }, 503);
};
