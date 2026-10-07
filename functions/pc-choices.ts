interface Env {
  REPORTS_DB: D1Database;
}

// Scelte del Cliente ritrovate dal PC, senza codice (07/10/2026): TK (Sessione automatica) manda le chiavi del PC su
// cui gira e riceve la pagina "programmi" nata da un report di quello stesso PC. Chiavi, in ordine di forza:
//   pc = impronta del MachineGuid di Windows (metadata.pcId, nei report da TK 07/10/2026 in poi; c'e' sempre);
//   sn = seriale del PC (hardware.bios.serialNumber o hardware.systemProduct.identifyingNumber);
//   mb = seriale della scheda madre (hardware.motherboard.serialNumber).
// I seriali finti ("0123456789ABCDEF", "Default string"...) li scarta TK prima di chiedere (Helpers/PcIdentity.cs).
// Risposta come GET /page-choices, piu' il codice della pagina e lo slug del report, che TK mostra al tecnico per
// riconoscere il Cliente. Filtro come upload-report: l'intestazione di TK (non un segreto, ferma solo le scansioni).
// Autosufficiente di proposito (niente import tra funzioni), come le altre.
const EXPECTED_HEADER = "x-pctoolkit-client";
const EXPECTED_VALUE = "compulandia-pctoolkit-v1";
const PC_ID_PATTERN = /^[0-9a-f]{32}$/;
const SERIAL_PATTERN = /^[\x21-\x7e][\x20-\x7e]{3,62}[\x21-\x7e]$/;

interface Row {
  code: string;
  reportId: string;
  kind: string;
  data: string;
  createdAt: number;
  choices: string | null;
  choicesAt: number | null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" }
  });
}

function param(url: URL, name: string, pattern: RegExp): string | null | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") {
    return null;
  }
  return pattern.test(v) ? v : undefined;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get(EXPECTED_HEADER) !== EXPECTED_VALUE) {
    return json({ error: "Richiesta non riconosciuta" }, 403);
  }

  const url = new URL(request.url);
  const pc = param(url, "pc", PC_ID_PATTERN);
  const sn = param(url, "sn", SERIAL_PATTERN);
  const mb = param(url, "mb", SERIAL_PATTERN);
  if (pc === undefined || sn === undefined || mb === undefined) {
    return json({ error: "Chiavi del PC non valide" }, 400);
  }
  if (pc === null && sn === null && mb === null) {
    return json({ error: "Nessuna chiave del PC" }, 400);
  }

  // Si parte dalle pagine "programmi" non scadute (poche) e si legge solo il report di ciascuna. Vince la pagina con
  // le scelte piu' recenti (il Cliente risponde solo alle pagine che gli abbiamo mandato); se nessuna ha scelte, la
  // pagina piu' recente, cosi' TK puo' dire "il Cliente non ha ancora risposto".
  let row: Row | null;
  try {
    row = await env.REPORTS_DB.prepare(
      "SELECT p.code, p.reportId, p.kind, p.data, p.createdAt, p.choices, p.choicesAt " +
      "FROM customer_pages p JOIN reports r ON r.id = p.reportId " +
      "WHERE p.kind = 'programmi' AND p.expiresAt > ?1 AND (" +
      "(?2 IS NOT NULL AND json_extract(r.data, '$.metadata.pcId') = ?2) OR " +
      "(?3 IS NOT NULL AND (json_extract(r.data, '$.hardware.bios.serialNumber') = ?3 OR " +
      "json_extract(r.data, '$.hardware.systemProduct.identifyingNumber') = ?3)) OR " +
      "(?4 IS NOT NULL AND json_extract(r.data, '$.hardware.motherboard.serialNumber') = ?4)) " +
      "ORDER BY p.choicesAt IS NULL, p.choicesAt DESC, p.createdAt DESC LIMIT 1"
    ).bind(Date.now(), pc, sn, mb).first<Row>();
  } catch (err) {
    // Nessuna pagina mai pubblicata (tabella assente) = "non trovata"; qualunque altro errore TK lo deve vedere come
    // tale, non come "il Cliente non ha una pagina".
    const message = err instanceof Error ? err.message : String(err);
    if (!message.toLowerCase().includes("no such table")) {
      return json({ error: "Ricerca non riuscita" }, 500);
    }
    row = null;
  }

  if (row === null) {
    return json({ error: "Nessuna pagina dei programmi per questo PC" }, 404);
  }
  return json({
    code: row.code,
    reportId: row.reportId,
    kind: row.kind,
    data: JSON.parse(row.data),
    createdAt: new Date(row.createdAt).toISOString(),
    choices: row.choices ? JSON.parse(row.choices) : null,
    choicesAt: row.choicesAt ? new Date(row.choicesAt).toISOString() : null
  }, 200);
};
