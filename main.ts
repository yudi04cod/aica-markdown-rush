// Entry point for the markdown-render-speed-02 harness.
//
// The harness mounts the case set at /input/cases.json (an array of
// { id, markdown } objects) and expects /output/html.json to hold one HTML
// string per case, in the same order. Each case is rendered on its own by
// parse() from ./parse.js — no state is shared between cases.
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override the mount points when
// running outside the harness (e.g. against the kit's practice set).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as Case[];

  const html = cases.map((entry) => parse(entry.markdown));

  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
