# MultiMix – přenosný notebook

Záložní réžie a světelný panel na Windows PC **bez cloudu**. V ZIPu je jen to, co je potřeba ke spuštění (včetně přenosného Node.js). Nejsou tam instalátory hal, OBS ani produkční databáze.

## Stáhnout

Otevři **Releases** vpravo nahoře a stáhni `multimix-portable.zip` (vždy poslední verze).

1. Rozbal ZIP.
2. Dvojklik na `start-local.cmd`.
3. Réžie: http://localhost:3000/admin/ (prázdná DB = `admin` / `admin`).
4. Světelný panel: http://localhost:3000/panel/?hall=1

## Aktualizace

Na notebooku zavři server a spusť `aktualizovat.cmd`, nebo stáhni nový ZIP a rozbal ho přes starou složku. Složka `data` (zápasy, týmy, hesla) se nesmí mazat.

Nový ZIP se na vývojovém PC skládá příkazem `pack-portable.cmd` v hlavním MultiMix repu a nahraje se sem do Releases.
