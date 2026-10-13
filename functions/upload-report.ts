interface Env {
  REPORTS_DB: D1Database;
  // Notifica WhatsApp ad Alessandro tramite CallMeBot (segreti del progetto su Cloudflare, mai nel repository).
  // Se mancano, nessuna notifica: il report si salva comunque.
  CALLMEBOT_PHONE?: string;
  CALLMEBOT_APIKEY?: string;
}

// Filtro contro spam/scansioni automatiche, non un vero segreto (visibile a chi decompila l'exe) -
// i report non contengono dati sensibili (niente password, niente contenuti di file personali).
const EXPECTED_HEADER = "x-pctoolkit-client";
const EXPECTED_VALUE = "compulandia-pctoolkit-v1";
const REQUESTED_ID_HEADER = "x-pctoolkit-requested-id";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EXPIRY_MS = 90 * 24 * 60 * 60 * 1000; // 90 giorni, scelta esplicita dell'utente
const MAX_ID_ATTEMPTS = 5;

// Stesso limite di 20 caratteri del client (Helpers/ReportIdSlugGenerator.cs) - mai fidarsi solo
// della validazione lato client, un client futuro o una richiesta scritta a mano potrebbe non
// rispettarla. Un solo carattere alfanumerico è valido (caso limite ma legittimo).
const REQUESTED_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;

// Notifica WhatsApp per i report inviati dal programma per Clienti ("Compulandia Report PC", metadata.origin =
// "cliente"), come per il questionario dei programmi (page-choices.ts). Decisione di Alessandro (13/10/2026): SEMPRE,
// anche quando e' lui a usare il programma per Clienti in negozio. Dei report di TK Tecnico notifica solo il "dopo"
// della Sessione automatica (fine della sessione, vedi fineSessione).
// L'invio e' aperto a chiunque conosca l'intestazione sopra: al massimo MAX_NOTIFICHE_GIORNO notifiche nelle ultime
// 24 ore, perche' uno script che invia report a raffica non faccia sospendere il numero da CallMeBot. Oltre il limite
// il report si salva comunque.
const MAX_NOTIFICHE_GIORNO = 20;
const ESITO_LIMITE = "non inviata: limite giornaliero";
const MAX_ESITO = 200;

function twoDigits(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toUpperCase().includes("UNIQUE");
}

// Testo scritto dal Cliente nel programma: una riga, senza spazi doppi, al massimo `max` caratteri; null se vuoto.
function pulito(v: unknown, max: number): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) {
    return null;
  }
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

interface Elemento {
  name?: unknown;
  succeeded?: unknown;
}

interface ReportPerNotifica {
  metadata?: { origin?: unknown; customer?: { name?: unknown; phone?: unknown; problemDescription?: unknown } };
  hardware?: { systemProduct?: { manufacturer?: unknown; model?: unknown } };
  diagnosis?: { findings?: { severity?: unknown }[] };
  // Solo nel report "dopo" della Sessione automatica di TK (AutoSessionSummary in PCToolkit.Core).
  sessionSummary?: {
    clientName?: unknown; startedAt?: unknown; aborted?: unknown; rebootCount?: unknown; windowsUpdateCycles?: unknown;
    bytesFreed?: unknown; steps?: { displayName?: unknown; status?: unknown }[]; installedUpdates?: Elemento[];
    removedSoftware?: Elemento[]; removedStoreApps?: Elemento[]; installedApps?: Elemento[];
    avgActivationPending?: unknown; esetActivationPending?: unknown;
  } | null;
}

// Fine della Sessione automatica (Alessandro, 13/10/2026): TK carica il report "dopo" con sessionSummary come ultimo
// atto della sessione, quindi il suo arrivo vuol dire "sessione finita". Una sessione che non arriva in fondo (PC
// spento, upload fallito) non manda nulla: il report "dopo" che manca resta il segnale, come gia' scritto nella skill.
export function fineSessione(report: unknown): boolean {
  const s = (report as ReportPerNotifica | null)?.sessionSummary;
  return typeof s === "object" && s !== null;
}

export function daNotificare(report: unknown): boolean {
  return (report as ReportPerNotifica | null)?.metadata?.origin === "cliente" || fineSessione(report);
}

function quandoIt(quando: number): string {
  return new Date(quando).toLocaleString("it-IT", {
    timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

function riusciti(elenco: Elemento[] | undefined): number {
  return (elenco ?? []).filter((x) => x?.succeeded === true).length;
}

// Prima i passi non riusciti (sono quelli da controllare a mano), poi i numeri della sessione.
export function testoNotificaSessione(report: unknown, id: string, quando: number): string {
  const s = (report as ReportPerNotifica).sessionSummary ?? {};
  const cliente = pulito(s.clientName, 80) ?? id;
  const righe = [`Sessione automatica ${s.aborted === true ? "INTERROTTA" : "finita"}: ${cliente} · ${quandoIt(quando)}`];
  const inizio = typeof s.startedAt === "string" ? Date.parse(s.startedAt) : NaN;
  if (!isNaN(inizio) && quando > inizio) {
    const min = Math.round((quando - inizio) / 60000);
    righe.push(`Durata: ${min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`}`);
  }
  const passi = s.steps ?? [];
  const conta = (st: string) => passi.filter((p) => p?.status === st).length;
  const falliti = passi.filter((p) => p?.status === "Failed").map((p) => pulito(p.displayName, 60) ?? "?");
  righe.push(`Passi: ${conta("Done")} fatti, ${conta("Skipped")} saltati, ` +
             (falliti.length ? `${falliti.length} NON RIUSCITI` : "nessuno non riuscito"));
  if (falliti.length) {
    righe.push(`Da controllare: ${falliti.slice(0, 4).join("; ")}${falliti.length > 4 ? "; …" : ""}`);
  }
  const gb = (Number(s.bytesFreed) || 0) / 1024 ** 3;
  const nonTolti = (s.removedSoftware ?? []).length - riusciti(s.removedSoftware);
  righe.push(`Tolti ${riusciti(s.removedSoftware)} programmi${nonTolti ? ` (${nonTolti} NON tolti)` : ""} e ` +
             `${riusciti(s.removedStoreApps)} app, ` +
             `installati o aggiornati ${riusciti(s.installedApps)} programmi, ` +
             `${riusciti(s.installedUpdates)} aggiornamenti di Windows`);
  righe.push(`Spazio liberato ${gb.toFixed(1).replace(".", ",")} GB, riavvii ${Number(s.rebootCount) || 0}`);
  const daFare = [s.avgActivationPending === true ? "attivare AVG" : "", s.esetActivationPending === true ? "attivare ESET" : ""]
    .filter((x) => x);
  if (daFare.length) {
    righe.push(`Da fare: ${daFare.join(", ")}`);
  }
  righe.push(`Report: ${id}`);
  return righe.join("\n");
}

// Il nome del Cliente va solo ad Alessandro. L'id del report sta in fondo: esitoCallMeBot lo usa per togliere dalla
// risposta di CallMeBot la ripetizione del messaggio.
export function testoNotificaReport(report: unknown, id: string, quando: number): string {
  const r = (report ?? {}) as ReportPerNotifica;
  const c = r.metadata?.customer ?? {};
  const nome = pulito(c.name, 80) ?? "nome non indicato";
  const tel = pulito(c.phone, 30);
  const problema = pulito(c.problemDescription, 300);
  const sp = r.hardware?.systemProduct ?? {};
  const pc = [pulito(sp.manufacturer, 60), pulito(sp.model, 60)].filter((x) => x).join(" ");
  const sev = (r.diagnosis?.findings ?? []).map((f) => Number(f?.severity) || 0);
  const problemi = sev.filter((s) => s >= 1).length;
  const gravi = sev.filter((s) => s >= 2).length;
  const righe = [`Report PC dal Cliente: ${nome}${tel ? ` (${tel})` : ""} · ${quandoIt(quando)}`];
  if (problema) {
    righe.push(`Problema: ${problema}`);
  }
  if (pc) {
    righe.push(`PC: ${pc}`);
  }
  if (r.diagnosis) {
    righe.push(`Diagnosi TK: ${problemi} ${problemi === 1 ? "problema" : "problemi"}` +
               (gravi ? `, di cui ${gravi} ${gravi === 1 ? "grave" : "gravi"}` : ""));
  }
  righe.push(`Report: ${id}`);
  return righe.join("\n");
}

export interface EsitoNotifica {
  ok: boolean;
  esito: string;
}

// Copia identica di page-choices.ts (le funzioni non si importano tra loro): test_sito.py controlla che non divergano.
// CallMeBot risponde 200 anche quando non consegna: "ok" solo se dice di aver messo in coda il messaggio.
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

const CREA_TABELLA_NOTIFICHE =
  "CREATE TABLE IF NOT EXISTS report_notifications (id TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, esito TEXT NOT NULL)";

// Notifiche davvero tentate nelle ultime 24 ore (quelle fermate dal limite non contano). Se la lettura fallisce si
// prova a inviare: meglio una notifica in piu' che un report Cliente senza avviso.
async function tentateUltimoGiorno(db: D1Database, adesso: number): Promise<number> {
  try {
    await db.prepare(CREA_TABELLA_NOTIFICHE).run();
    const r = await db.prepare("SELECT COUNT(*) AS n FROM report_notifications WHERE at > ? AND esito <> ?")
      .bind(adesso - 24 * 60 * 60 * 1000, ESITO_LIMITE).first<{ n: number }>();
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

// Mai bloccante: il report e' gia' salvato quando si arriva qui.
async function salvaEsito(db: D1Database, id: string, quando: number, e: EsitoNotifica): Promise<void> {
  try {
    await db.prepare(CREA_TABELLA_NOTIFICHE).run();
    await db.prepare("INSERT OR REPLACE INTO report_notifications (id, at, ok, esito) VALUES (?, ?, ?, ?)")
      .bind(id, quando, e.ok ? 1 : 0, e.esito).run();
  } catch {
    // niente
  }
}

async function notificaReport(env: Env, report: unknown, id: string, quando: number): Promise<void> {
  const esito = (await tentateUltimoGiorno(env.REPORTS_DB, quando)) >= MAX_NOTIFICHE_GIORNO
    ? { ok: false, esito: ESITO_LIMITE }
    : await notifica(env, fineSessione(report) ? testoNotificaSessione(report, id, quando)
                                               : testoNotificaReport(report, id, quando), id);
  await salvaEsito(env.REPORTS_DB, id, quando, esito);
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  if (request.headers.get(EXPECTED_HEADER) !== EXPECTED_VALUE) {
    return new Response(JSON.stringify({ error: "Richiesta non riconosciuta" }), { status: 403 });
  }

  const requestedId = (request.headers.get(REQUESTED_ID_HEADER) ?? "").toLowerCase();
  if (!REQUESTED_ID_PATTERN.test(requestedId)) {
    return new Response(JSON.stringify({ error: "Identificativo richiesto mancante o non valido" }), { status: 400 });
  }

  const bodyText = await request.text();
  if (!bodyText || bodyText.length > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Payload mancante o troppo grande" }), { status: 400 });
  }

  let report: unknown;
  try {
    report = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "JSON non valido" }), { status: 400 });
  }

  // Deterministico, non casuale: un nome scelto dal tecnico deve restare prevedibile. Primo
  // tentativo: lo slug esatto. Se già occupato (stesso Cliente rivisto in un'altra data, o Cliente
  // omonimo), si aggiunge un suffisso data (MMDD). Se anche quello è occupato (stesso Cliente due
  // volte nello stesso giorno), si aggiunge un contatore progressivo fino a MAX_ID_ATTEMPTS tentativi.
  //
  // A differenza della versione Netlify Blobs (onlyIfNew), qui la chiave primaria della tabella
  // SQLite rende l'INSERT atomico by design: se la chiave esiste già, D1 rifiuta la scrittura con
  // un vincolo UNIQUE, senza bisogno di un get() preventivo (mai affidabile sotto concorrenza).
  const now = new Date();
  const dateSuffix = `${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
  const createdAt = Date.now();
  const expiresAt = createdAt + EXPIRY_MS;

  let finalId: string | null = null;
  for (let i = 0; i < MAX_ID_ATTEMPTS && finalId === null; i++) {
    const candidate =
      i === 0 ? requestedId
      : i === 1 ? `${requestedId}-${dateSuffix}`
      : `${requestedId}-${dateSuffix}-${i}`;

    try {
      await env.REPORTS_DB.prepare(
        "INSERT INTO reports (id, data, createdAt, expiresAt) VALUES (?, ?, ?, ?)"
      ).bind(candidate, bodyText, createdAt, expiresAt).run();
      finalId = candidate;
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
      // ID già occupato: prova il prossimo candidato.
    }
  }

  if (finalId === null) {
    return new Response(JSON.stringify({ error: "Riprova con un nome diverso: troppi report già salvati con questo nome oggi" }), { status: 503 });
  }

  // In background a report salvato: il programma del Cliente non aspetta CallMeBot e non ne vede mai gli errori.
  if (daNotificare(report)) {
    const invio = notificaReport(env, report, finalId, createdAt);
    if (waitUntil) {
      waitUntil(invio);
    } else {
      await invio;
    }
  }

  return new Response(JSON.stringify({ id: finalId }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
