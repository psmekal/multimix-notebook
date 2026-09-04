# MultiMix – přenosný notebook

Záložní réžie a světelný panel na Windows **bez cloudu**.

## První instalace

Stáhni [multimix-portable.zip](https://github.com/psmekal/multimix-notebook/releases/latest/download/multimix-portable.zip)
(jednou — obsahuje Node). Rozbal a spusť `start-local.cmd`.
Přihlášení: `admin` / `admin`.

## Aktualizace (jen změněné soubory)

Zavři server a dvojklik na `aktualizovat.cmd`.
Stáhne z tohoto repa jen soubory, které se změnily. Složka `data`, Node i `node_modules` zůstanou.

## Vývojové PC

Po změně v MultiMix:

```
node tools/sync-notebook-repo.mjs
```
