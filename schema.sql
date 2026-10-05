CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_expiresAt ON reports(expiresAt);

-- Pagine per il Cliente (05/10/2026): diagnosi e scelta dei programmi. Creata anche da publish-page.ts al primo
-- uso (CREATE TABLE IF NOT EXISTS), perche' su questo PC non c'e' wrangler per applicare lo schema a mano.
CREATE TABLE IF NOT EXISTS customer_pages (code TEXT PRIMARY KEY, kind TEXT NOT NULL, reportId TEXT NOT NULL, data TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, choices TEXT, choicesAt INTEGER);
