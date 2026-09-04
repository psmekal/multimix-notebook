# MultiMix – přenosný notebook

Záložní réžie a světelný panel na Windows **bez cloudu**.

## První instalace

1. Vytvoř prázdnou složku, např. `C:\\MultiMix`.
2. Stáhni jen **[install.cmd](https://github.com/psmekal/multimix-notebook/releases/latest/download/install.cmd)** a ulož ho do té složky.
3. Dvojklik na `install.cmd` — stáhne kompletní balíček (včetně Node).
4. Spusť `start-local.cmd`. Přihlášení: `admin` / `admin`.

## Aktualizace

Zavři server a dvojklik na **`sync.cmd`**.
Stáhne jen změněné soubory. Složka `data` (zápasy, týmy, hesla) zůstane.

## Vývojové PC

Po změně v MultiMix:

```
node tools/sync-notebook-repo.mjs
node tools/pack-portable.mjs --publish
```
