// Link corto temporaneo per il collaudo della build Windows 7 (09/09/2026), da rimuovere
// una volta finito il test - punta a un asset "pre-release" su GitHub (non alla "latest",
// che resta la build Windows 10/11 usata dai clienti tramite il bottone della pagina).
export const onRequestGet: PagesFunction = async () => {
  return Response.redirect(
    "https://github.com/alessandromonfreda/pctoolkit-download/releases/download/v2026.09.09-win7-test/PCToolkit-Win7-Test.zip",
    302
  );
};
