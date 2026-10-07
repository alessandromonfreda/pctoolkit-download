interface Env {
  REPORTS_DB: D1Database;
  // Notifica WhatsApp ad Alessandro tramite CallMeBot (segreti del progetto su Cloudflare, mai nel repository).
  // Se mancano, nessuna notifica: le scelte si salvano comunque.
  CALLMEBOT_PHONE?: string;
  CALLMEBOT_APIKEY?: string;
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
const VALORI_SOSTITUZIONE = ["si", "no"];
const SUFFISSO_SOSTITUZIONE = "|sostituisci";

interface PageRow {
  kind: string;
  reportId: string;
  data: string;
  expiresAt: number;
  choices: string | null;
  choicesAt: number | null;
}

interface PageData {
  domande?: { gruppo: string; sostituzione?: unknown }[];
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
      "SELECT kind, reportId, data, expiresAt, choices, choicesAt FROM customer_pages WHERE code = ?"
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

// Nome e telefono del Cliente (customer_labels, scritta da publish-page.ts): solo per la notifica.
// Se manca o la lettura fallisce, la notifica usa solo lo slug del report.
async function etichetta(db: D1Database, code: string): Promise<string | null> {
  try {
    const r = await db.prepare("SELECT label FROM customer_labels WHERE code = ?").bind(code).first<{ label: string }>();
    return r?.label ?? null;
  } catch {
    return null;
  }
}

// Testo della notifica: il nome del Cliente va solo ad Alessandro, mai nelle risposte pubbliche.
export function testoNotifica(nome: string | null, reportId: string, code: string, scelte: Record<string, string>,
                              aggiornate: boolean, quando: number): string {
  const conta = (v: string) => Object.entries(scelte).filter(([g, x]) => !g.endsWith(SUFFISSO_SOSTITUZIONE) && x === v).length;
  const ora = new Date(quando).toLocaleString("it-IT", {
    timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  });
  const chi = nome ? `${nome} · report ${reportId}` : `report ${reportId}`;
  return `${aggiornate ? "Scelte AGGIORNATE" : "Questionario compilato"}: ${chi} (${ora})
` +
    `Usa ${conta("uso")}, non usa ${conta("non-uso")}, non sa ${conta("non-so")}; ` +
    `vuole tenere ${conta("tieni")} programmi da togliere.
Codice TK: ${code}`;
}

async function notifica(env: Env, testo: string): Promise<void> {
  if (!env.CALLMEBOT_PHONE || !env.CALLMEBOT_APIKEY) {
    return;
  }
  const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(env.CALLMEBOT_PHONE) +
    "&text=" + encodeURIComponent(testo) + "&apikey=" + encodeURIComponent(env.CALLMEBOT_APIKEY);
  try {
    await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch {
    // Servizio esterno non ufficiale: se non risponde si perde solo la notifica, mai le scelte del Cliente.
    // Rete di sicurezza: "cliente_tk.py elenco" mostra le scelte arrivate.
  }
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
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
  // Proposta facoltativa di sostituzione: ammessa solo per le domande che la prevedono.
  const conSostituzione = new Set((data.domande ?? []).filter((d) => d.sostituzione).map((d) => d.gruppo));
  const pulite: Record<string, string> = {};
  for (const [gruppo, valore] of Object.entries(body.choices as Record<string, unknown>)) {
    if (typeof valore !== "string") {
      return json({ error: "Scelta non valida" }, 400);
    }
    if (domande.has(gruppo) && VALORI_DOMANDA.includes(valore)) {
      pulite[gruppo] = valore;
    } else if (togliere.has(gruppo) && VALORI_TOGLIERE.includes(valore)) {
      pulite[gruppo] = valore;
    } else if (gruppo.endsWith(SUFFISSO_SOSTITUZIONE) &&
               conSostituzione.has(gruppo.slice(0, -SUFFISSO_SOSTITUZIONE.length)) &&
               VALORI_SOSTITUZIONE.includes(valore)) {
      pulite[gruppo] = valore;
    } else {
      return json({ error: "Scelta non valida" }, 400);
    }
  }

  const adesso = Date.now();
  await env.REPORTS_DB.prepare("UPDATE customer_pages SET choices = ?, choicesAt = ? WHERE code = ?")
    .bind(JSON.stringify(pulite), adesso, code).run();
  // In background a salvataggio fatto: il Cliente non aspetta CallMeBot e non vede mai i suoi errori.
  const invio = (async () => notifica(env, testoNotifica(await etichetta(env.REPORTS_DB, code), row.reportId, code, pulite,
                                                          row.choices !== null, adesso)))();
  if (waitUntil) {
    waitUntil(invio);
  } else {
    await invio;
  }
  return json({ ok: true }, 200);
};
