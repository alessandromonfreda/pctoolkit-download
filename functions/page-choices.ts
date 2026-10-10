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

// L'esito della notifica (page_notifications) lo legge solo lo script del negozio, con la chiave di lettura.
// Stessa impronta di get-report.ts, list-reports.ts e publish-page.ts (test_impronte_allineate in test_sito.py).
const READ_KEY_HEADER = "x-pctoolkit-read-key";
const READ_KEY_SHA256 = "c3d05a46e2e54253d057d1f15bd36459a03b96fde2c70693b1839572c8157c36";
const MAX_ESITO = 200;

async function hasReadKey(request: Request): Promise<boolean> {
  const key = request.headers.get(READ_KEY_HEADER);
  if (!key) {
    return false;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === READ_KEY_SHA256;
}

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

export interface EsitoNotifica {
  ok: boolean;
  esito: string;
}

// CallMeBot risponde 200 anche quando non consegna (codice non valido, limite giornaliero, numero sospeso): prima
// del 10/10/2026 l'esito si scartava, e il primo questionario vero (Cilla-AIO) e' rimasto senza WhatsApp senza
// lasciare traccia. Ora si salva il testo della risposta (senza codice di accesso ne' numero) e lo script del negozio
// lo mostra con "cliente_tk.py scelte". "ok" solo se CallMeBot dice di averlo messo in coda ("Message queued").
// CallMeBot ripete prima il messaggio ("Message to: ... Text to send: ...") e scrive l'esito solo in fondo: la prova
// dal vivo del 10/10/2026 (HTTP 208) teneva i primi 200 caratteri e l'esito restava tagliato fuori. Si toglie la
// ripetizione fino alla fine del nostro testo (che termina sempre con il codice della pagina) e, se resta troppo
// lungo, si tiene la coda.
export function esitoCallMeBot(status: number, corpo: string, segreti: string[], fineMessaggio = ""): EsitoNotifica {
  let testo = corpo.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  for (const s of segreti.filter((x) => x.length >= 4)) {
    testo = testo.split(s).join("***").split(encodeURIComponent(s)).join("***");
  }
  const fine = fineMessaggio ? testo.lastIndexOf(fineMessaggio) : -1;
  if (fine >= 0) {
    testo = "[messaggio ripetuto] " + testo.slice(fine + fineMessaggio.length).trim();
  }
  const ok = status >= 200 && status < 300 && /queued/i.test(testo);
  const intero = `HTTP ${status}: ${testo}`;
  const taglio = `HTTP ${status}: …`;
  return { ok, esito: intero.length <= MAX_ESITO ? intero : taglio + testo.slice(-(MAX_ESITO - taglio.length)) };
}

async function notifica(env: Env, testo: string, code: string): Promise<EsitoNotifica> {
  if (!env.CALLMEBOT_PHONE || !env.CALLMEBOT_APIKEY) {
    return { ok: false, esito: "non inviata: segreti CALLMEBOT_PHONE/CALLMEBOT_APIKEY mancanti sul progetto Cloudflare" };
  }
  const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(env.CALLMEBOT_PHONE) +
    "&text=" + encodeURIComponent(testo) + "&apikey=" + encodeURIComponent(env.CALLMEBOT_APIKEY);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return esitoCallMeBot(res.status, await res.text(), [env.CALLMEBOT_APIKEY, env.CALLMEBOT_PHONE], code);
  } catch (err) {
    // Servizio esterno non ufficiale: se non risponde si perde solo la notifica, mai le scelte del Cliente.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, esito: `errore di rete: ${msg}`.slice(0, MAX_ESITO) };
  }
}

// Mai bloccante: se il salvataggio dell'esito fallisce, le scelte del Cliente restano comunque salvate.
async function salvaEsito(db: D1Database, code: string, quando: number, e: EsitoNotifica): Promise<void> {
  try {
    await db.prepare(
      "CREATE TABLE IF NOT EXISTS page_notifications (code TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, esito TEXT NOT NULL)"
    ).run();
    await db.prepare("INSERT OR REPLACE INTO page_notifications (code, at, ok, esito) VALUES (?, ?, ?, ?)")
      .bind(code, quando, e.ok ? 1 : 0, e.esito).run();
  } catch {
    // niente
  }
}

async function leggiEsito(db: D1Database, code: string): Promise<{ at: string; ok: boolean; esito: string } | null> {
  try {
    const r = await db.prepare("SELECT at, ok, esito FROM page_notifications WHERE code = ?").bind(code)
      .first<{ at: number; ok: number; esito: string }>();
    return r ? { at: new Date(r.at).toISOString(), ok: r.ok === 1, esito: r.esito } : null;
  } catch {
    return null; // tabella non ancora creata: nessuna notifica tentata dopo il 10/10/2026
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
  const risposta: Record<string, unknown> = {
    kind: row.kind,
    data: JSON.parse(row.data),
    choices: row.choices ? JSON.parse(row.choices) : null,
    choicesAt: row.choicesAt ? new Date(row.choicesAt).toISOString() : null
  };
  if (await hasReadKey(request)) {
    risposta.notifica = await leggiEsito(env.REPORTS_DB, code);
  }
  return json(risposta, 200);
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
  const invio = (async () => {
    const esito = await notifica(env, testoNotifica(await etichetta(env.REPORTS_DB, code), row.reportId, code, pulite,
                                                    row.choices !== null, adesso), code);
    await salvaEsito(env.REPORTS_DB, code, adesso, esito);
  })();
  if (waitUntil) {
    waitUntil(invio);
  } else {
    await invio;
  }
  return json({ ok: true }, 200);
};
