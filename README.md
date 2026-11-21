# csv-reader-speed-01-run-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/dhosmatullah/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/dhosmatullah/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A speed-tuned drop-in replacement for make.fun's csv-reader 1.0.0: `run(input)`
in `solve.js` returns exactly csv-reader's answer `{columns, rows, errors}` for
every input `{text, header}` — including its broken-row policy (stray CRs,
quoted fields, doubled quotes, junk after a closing quote, unterminated
quotes, short/long rows) — while `main.ts` (the house driver) answers a whole
case set from `/input/cases.json` to `/output/answers.json` in much less CPU
time than csv-reader itself.

## How it is faster

The reference builds every field one character at a time and allocates a
result object per field. This reader instead:

- cuts fields out of the text with `slice()`, never per-character concatenation;
- finds the next comma / LF / CR / quote with `String.indexOf` (native scan),
  caching each delimiter's next position so the caches only move forward —
  over a whole file each delimiter is scanned for once in total, not per field;
- takes a segment-join path (slices joined once) only for fields that are
  actually broken or transformed: a stray CR, a doubled quote or a CR inside
  quotes, junk after a closing quote, an unterminated quote's re-read;
- allocates no object per field, and counts line numbers inside quoted fields
  with `indexOf` over each content segment.

## Measured on the practice set (6 cases, 10.2M characters)

Local machine, Node 24, `--no-incremental-marking` as the house driver sets:

- `run()` alone, per set: **~155 ms vs csv-reader's ~880–930 ms (~5.7× faster)**
- Whole program (driver + JSON in/out), CPU per run: **~0.86 s vs ~1.84 s (~2.1×)**
- Output byte-identical to the house baseline's on the practice set; the kit
  scorer reports `passed: 1, cases_passed: 6/6`. Correctness was also checked
  against the reference implementation on ~180,000 fuzzed broken-CSV inputs
  and 12 large generator-shaped files, all identical.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=0trcj9y5&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
