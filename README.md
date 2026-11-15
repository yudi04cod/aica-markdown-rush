# Aica Markdown Rush

A from-scratch Markdown renderer in a single dependency-free ES module
(`parse.js`), built to produce byte-for-byte the same HTML as marked 18.1.3
with default options (GFM on, breaks off, pedantic off) — only faster. The
block phase is line-oriented with per-construct scanners, and the inline
phase is a single-pass scanner with a masked delimiter search for emphasis
and strikethrough, so pathological backtracking stays out of the hot path.

`main.ts` is the harness driver: it reads the case set from
`/input/cases.json`, renders every case independently with `parse()`, and
writes the resulting HTML strings to `/output/html.json`.

![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/yudi04cod/aica-markdown-rush/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/yudi04cod/aica-markdown-rush/reward.svg)

Competition: https://make.fun/competition/markdown-render-speed-02

Referral code: 38m33ybw

## Licence

MIT. The behavioural reference (marked 18.1.3) is MIT-licensed; this entry is
an independent implementation written against its observable output.
