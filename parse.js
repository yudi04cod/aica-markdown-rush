// A fast Markdown renderer that produces, for every input string, exactly the
// HTML that marked 18.1.3 produces with its default options (GFM on, breaks
// off, pedantic off). Written from scratch as a line-oriented block parser
// with a single-pass inline scanner; the reference renderer's observable
// behaviour (including its departures from the CommonMark and GFM specs) is
// the specification this code is held to.
//
// No dependencies. `parse(markdown)` is the only export.

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape &, <, >, " and ' (marked's full escape, used for code and hrefs of autolinks). */
function escapeAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

const UNENCODED_AMP = /&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

/** Escape like marked's escape with encode off: & is kept when it begins an entity-like run. */
function escapeText(s) {
  if (!/[<>"']/.test(s) && !UNENCODED_AMP.test(s)) return s;
  return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (ch) => ESCAPE_MAP[ch]);
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

/**
 * Decode numeric character references the way marked does before escaping
 * text: an out-of-range or surrogate reference becomes U+FFFD, &#38; becomes
 * the literal string "&amp;", and a bare & that is not part of a reference is
 * rewritten to "&amp;" here so the later escape step leaves it alone.
 */
function decodeNumericRefs(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const v = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return '\uFFFD';
    if (v === 38) return '&amp;';
    return String.fromCodePoint(v);
  });
}

/** marked's cleanUrl: encodeURI, undoing the %25 doubling; null when it throws. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Remove a trailing run of `ch` (marked's trimEnd helper with no escape flag). */
function trimEndRun(s, ch) {
  let n = s.length;
  let count = 0;
  while (count < n && s.charAt(n - count - 1) === ch) count++;
  return s.slice(0, n - count);
}

/** Expand tabs to spaces with tab stops of 4, counting from column `col`. */
function expandTabs(s, col) {
  if (!s.includes('\t')) return s;
  let out = '';
  let t = col;
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

const BLANK_LINE = /^[ \t]*$/;

/** Drop trailing blank lines of a block, keeping the text when little remains (marked's helper). */
function trimBlankTail(a) {
  const lines = a.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  return lines.length - t <= 2 ? a : lines.slice(0, t + 1).join('\n');
}

/** Normalise a link reference label: collapse whitespace, fold case (marked's way). */
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/**
 * Scan `s` for a closing bracket of the pair `pair` ('()' or '[]'), honouring
 * backslash escapes. Returns the index of an unmatched closing bracket, -2
 * when an opener is left unclosed, and -1 when there is nothing to report
 * (no brackets at all, or a balanced run).
 */
function findClosing(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
    } else if (s[i] === pair[0]) {
      depth++;
    } else if (s[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

/** Split a table row on unescaped pipes, then pad or trim to `count` cells. */
function splitRow(row, count) {
  const replaced = row.replace(/\|/g, (m, offset, whole) => {
    let escaped = false;
    let p = offset;
    while (--p >= 0 && whole[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = replaced.split(' |');
  if (cells.length > 0 && !cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Shared patterns
// ---------------------------------------------------------------------------

const TAG_NAMES =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const PUNCT_SRC = '[\\p{P}\\p{S}]';
const PUNCT_SPACE_SRC = '[\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_SRC = '[^\\s\\p{P}\\p{S}]';

const ANY_PUNCT_ESCAPE = new RegExp(`\\\\(${PUNCT_SRC})`, 'gu');
const PUNCT_TEST = new RegExp(`^(?![*_])${PUNCT_SPACE_SRC}`, 'u');
const ALNUM_TEST = /[\p{L}\p{N}]/u;

/** Index of the end of the line starting at `i` (the \n position, or s.length). */
function lineEnd(s, i) {
  const nl = s.indexOf('\n', i);
  return nl === -1 ? s.length : nl;
}

// ---------------------------------------------------------------------------
// Block level
//
// Tokens are plain objects. A token that needs inline parsing carries a `job`
// ({ src, holder }) registered on the context; jobs run after the whole block
// phase, in the order they were made, mirroring the reference's deferred
// inline queue (so link definitions anywhere in the document resolve).
// ---------------------------------------------------------------------------

function makeJob(ctx, holder, src) {
  const job = { src, holder };
  holder.job = job;
  ctx.jobs.push(job);
  return job;
}

function dropJob(ctx, holder) {
  const idx = ctx.jobs.indexOf(holder.job);
  if (idx !== -1) ctx.jobs.splice(idx, 1);
  holder.job = null;
}

/** Blank lines: a run of lines holding only spaces and tabs. */
function spaceToken(src) {
  let i = 0;
  while (i < src.length) {
    const le = lineEnd(src, i);
    if (!BLANK_LINE.test(src.slice(i, le))) break;
    i = le === src.length ? le : le + 1;
    if (le === src.length) break;
  }
  return i > 0 ? { type: 'space', raw: src.slice(0, i) } : null;
}

function isCodeLine(line) {
  if (line.startsWith('    ')) return line.length > 4;
  const m = /^ {0,3}\t/.exec(line);
  return m !== null && line.length > m[0].length;
}

/** Indented code block: runs of lines indented by four spaces or a tab. */
function codeToken(src) {
  let pos = 0;
  let rawEnd = -1;
  while (pos < src.length) {
    const le = lineEnd(src, pos);
    if (!isCodeLine(src.slice(pos, le))) break;
    pos = le === src.length ? le : le + 1;
    // Blank lines may follow a code line inside the same block.
    while (pos < src.length) {
      const be = lineEnd(src, pos);
      if (!BLANK_LINE.test(src.slice(pos, be))) break;
      pos = be === src.length ? be : be + 1;
    }
    rawEnd = pos;
  }
  if (rawEnd === -1) return null;
  const raw = trimBlankTail(src.slice(0, rawEnd));
  const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { type: 'code', raw, text, codeBlockStyle: 'indented' };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,}) *$/;

/** Fenced code block (``` or ~~~), with the reference's indent compensation. */
function fenceToken(src) {
  const m = FENCE_OPEN.exec(src);
  if (!m) return null;
  const fence = m[1];
  const ch = fence[0];
  if (ch === '`' && m[2].includes('`')) return null;
  const openLen = m[0].length;
  let pos = openLen;
  let contentEnd = -1;
  let rawEnd = -1;
  while (pos < src.length) {
    const le = lineEnd(src, pos);
    const cm = FENCE_CLOSE.exec(src.slice(pos, le));
    if (cm && cm[1][0] === ch && cm[1].length >= fence.length) {
      contentEnd = pos;
      rawEnd = le;
      break;
    }
    if (le === src.length) break;
    pos = le + 1;
  }
  let raw;
  let text;
  if (contentEnd !== -1) {
    const seg = src.slice(openLen, contentEnd);
    text = seg.endsWith('\n') ? seg.slice(0, -1) : seg;
    raw = src.slice(0, rawEnd);
  } else {
    const seg = src.slice(openLen);
    text = seg.endsWith('\n') ? seg.slice(0, -1) : seg;
    raw = src;
  }
  // When the opening fence was itself indented, content lines give back up to
  // that much of their own leading space.
  const comp = /^(\s+)(?:```)/.exec(raw);
  if (comp !== null) {
    const width = comp[1].length;
    text = text
      .split('\n')
      .map((line) => {
        const lead = /^\s+/.exec(line);
        if (lead === null) return line;
        return line.slice(Math.min(lead[0].length, width));
      })
      .join('\n');
  }
  const info = m[2];
  const lang = info ? info.trim().replace(ANY_PUNCT_ESCAPE, '$1') : info;
  return { type: 'code', raw, lang, text };
}

const ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;

/** ATX heading, with the reference's closing-hash rule. */
function headingToken(ctx, src) {
  const m = ATX.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const stripped = trimEndRun(text, '#');
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  const tok = {
    type: 'heading',
    raw: trimEndRun(m[0], '\n'),
    depth: m[1].length,
    text,
    tokens: null,
  };
  makeJob(ctx, tok, text);
  return tok;
}

const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;

function hrToken(src) {
  const m = HR.exec(src);
  return m ? { type: 'hr', raw: trimEndRun(m[0], '\n') } : null;
}

const HTML_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const HTML_BLOCK = new RegExp(
  '^ {0,3}(?:' +
    '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
    '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(?:\\n+|$)' +
    '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
    '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
    '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
    `|</?(?:${TAG_NAMES})(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)` +
    `|<(?!((?:script|pre|style|textarea)(?![a-z0-9-])))([a-z][a-z0-9-]*)(?:${HTML_ATTR.source})*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)` +
    '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    ')',
  'i',
);

/** Raw HTML block, ending at the first blank line (or its closing tag). */
function htmlToken(src) {
  const m = HTML_BLOCK.exec(src);
  if (!m) return null;
  const text = trimBlankTail(m[0]);
  return {
    type: 'html',
    block: true,
    raw: text,
    pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
    text,
  };
}

const DEF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_TITLE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/;
const DEF = new RegExp(
  `^ {0,3}\\[(${DEF_LABEL.source})\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)` +
    `(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(${DEF_TITLE.source}))? *(?:\\n+|$)`,
);

/** Link reference definition. Registration happens in the block driver. */
function defToken(src) {
  const m = DEF.exec(src);
  if (!m) return null;
  if (!m[2].startsWith('<') && findClosing(m[2], '()') !== -1) return null;
  let href = m[2] ? m[2].replace(/^<(.*)>$/, '$1') : '';
  href = href.replace(ANY_PUNCT_ESCAPE, '$1');
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_ESCAPE, '$1') : undefined;
  return { type: 'def', tag: normLabel(m[1]), raw: trimEndRun(m[0], '\n'), href, title };
}

const TABLE_DELIM = /^ {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n|$)/;

function tableAlignOf(cell) {
  if (/^ *-+: *$/.test(cell)) return 'right';
  if (/^ *:-+: *$/.test(cell)) return 'center';
  if (/^ *:-+ *$/.test(cell)) return 'left';
  return null;
}

/** Does a table start at `pos` (header line plus delimiter line)? Cheap probe for paragraph/table. */
function tableStartsAt(src, pos) {
  const le = lineEnd(src, pos);
  if (le === src.length) return false;
  const dm = TABLE_DELIM.exec(src.slice(le + 1));
  return dm !== null && /[:|]/.test(dm[1]);
}

const HTML_INTERRUPT = new RegExp(
  `^ {0,3}(?:</?(?:${TAG_NAMES})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
  'i',
);
const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const FENCE_LINE = /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~{3,})[^\n]*(?:\n|$)/;

/** Lines that interrupt a paragraph or a table's row run. */
function isInterruptLine(src, pos, forTable) {
  const le = lineEnd(src, pos);
  const line = src.slice(pos, le);
  let a = 0;
  while (line[a] === ' ') a++;
  if (a > 3) return forTable && line.length > 4;
  const c = line[a];
  if (c === '\t') return forTable && line.length > a + 1;
  switch (c) {
    case '#':
      return HEADING_LINE.test(line + '\n');
    case '>':
      return true;
    case '`':
    case '~':
      return FENCE_LINE.test(line + '\n');
    case '<':
      return HTML_INTERRUPT.test(line + '\n');
    case '-':
    case '+':
    case '*':
    case '_': {
      if (HR.test(line + '\n')) return true;
      if (c === '_') return false;
      return forTable
        ? /^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)
        : /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(line);
    }
    default:
      if (c >= '0' && c <= '9') {
        return forTable
          ? /^ {0,3}(?:[*+-]|1[.)])[ \t]/.test(line)
          : /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(line);
      }
      return false;
  }
}

/** GFM table: header line, delimiter line, then row lines. */
function tableToken(ctx, src) {
  const firstEnd = lineEnd(src, 0);
  if (firstEnd === src.length) return null;
  const dm = TABLE_DELIM.exec(src.slice(firstEnd + 1));
  if (!dm || !/[:|]/.test(dm[1])) return null;
  const headerCells = splitRow(src.slice(0, firstEnd));
  const alignCells = dm[1].replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== alignCells.length) return null;
  const align = alignCells.map(tableAlignOf);
  let pos = firstEnd + 1 + dm[0].length;
  const rowLines = [];
  while (pos < src.length) {
    const le = lineEnd(src, pos);
    const line = src.slice(pos, le);
    if (/^ *$/.test(line) && le < src.length) break;
    if (isInterruptLine(src, pos, true)) break;
    rowLines.push(line);
    pos = le === src.length ? le : le + 1;
  }
  // The reference also swallows newlines directly after the last row.
  while (pos < src.length && src[pos] === '\n') pos++;
  const raw = trimEndRun(src.slice(0, pos), '\n');
  const tok = { type: 'table', raw, header: [], align, rows: [] };
  for (let i = 0; i < headerCells.length; i++) {
    const cell = { text: headerCells[i], tokens: null, header: true, align: align[i] };
    makeJob(ctx, cell, headerCells[i]);
    tok.header.push(cell);
  }
  for (const line of rowLines) {
    const cells = splitRow(line, headerCells.length);
    const row = cells.map((text, i) => {
      const cell = { text, tokens: null, header: false, align: align[i] };
      makeJob(ctx, cell, text);
      return cell;
    });
    tok.rows.push(row);
  }
  return tok;
}

const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/** Lines a setext heading's text may not start with (checked on the first line). */
function setextStartBlocked(src) {
  const le = lineEnd(src, 0);
  const line = src.slice(0, le);
  const withNl = line + '\n';
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(withNl)) return true;
  if (/^(?: {4}| {0,3}\t)/.test(line)) return true;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(withNl)) return true;
  if (/^ {0,3}<[^\n>]+>\n/.test(withNl)) return true;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*\n/.test(withNl)) return true;
  return false;
}

/** Lines that may not continue a setext heading's text. */
function setextContinueBlocked(src, pos) {
  const le = lineEnd(src, pos);
  const line = src.slice(pos, le);
  const withNl = line + '\n';
  if (BLANK_LINE.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(withNl)) return true;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(withNl)) return true;
  if (HR.test(withNl)) return true;
  if (/^ {0,3}<[^\n>]+>\n/.test(withNl)) return true;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*\n/.test(withNl)) return true;
  return false;
}

/** Setext heading: text lines followed by an === or --- underline. */
function lheadingToken(ctx, src) {
  if (setextStartBlocked(src)) return null;
  let pos = 0;
  let textEnd = -1;
  let underline = null;
  let rawEnd = -1;
  for (;;) {
    const le = lineEnd(src, pos);
    const next = le === src.length ? le : le + 1;
    if (pos !== 0) {
      const um = SETEXT_UNDERLINE.exec(src.slice(pos, le));
      if (um) {
        underline = um[1];
        textEnd = pos - 1; // drop the \n before the underline
        rawEnd = next;
        break;
      }
      if (setextContinueBlocked(src, pos)) return null;
    }
    if (le === src.length) return null;
    pos = next;
  }
  if (underline === null) return null;
  const text = src.slice(0, textEnd).trim();
  const tok = {
    type: 'heading',
    raw: trimEndRun(src.slice(0, rawEnd), '\n'),
    depth: underline.charAt(0) === '=' ? 1 : 2,
    text,
    tokens: null,
  };
  makeJob(ctx, tok, text);
  return tok;
}

/** Paragraph: consecutive lines that start no other block. Only at the top level. */
function paragraphToken(ctx, src) {
  let pos = lineEnd(src, 0);
  let text = src.slice(0, pos);
  if (pos === src.length) {
    const tok = { type: 'paragraph', raw: text, text, tokens: null };
    makeJob(ctx, tok, text);
    return tok;
  }
  pos += 1;
  while (pos < src.length) {
    const le = lineEnd(src, pos);
    const line = src.slice(pos, le);
    if (BLANK_LINE.test(line) && le < src.length) break;
    if (isInterruptLine(src, pos, false)) break;
    if (tableStartsAt(src, pos)) break;
    text += '\n' + line;
    if (le === src.length) {
      pos = le;
      break;
    }
    pos = le + 1;
  }
  const tok = { type: 'paragraph', raw: text, text, tokens: null };
  makeJob(ctx, tok, text);
  return tok;
}

/** A single line of text (used inside block quotes and list items). */
function textToken(ctx, src) {
  const le = lineEnd(src, 0);
  const line = src.slice(0, le);
  const tok = { type: 'text', raw: line, text: line, tokens: null };
  makeJob(ctx, tok, line);
  return tok;
}

// ---------------------------------------------------------------------------
// Block quotes
// ---------------------------------------------------------------------------

const QUOTE_MARK = /^ {0,3}>/;

/** Lines that end a lazy paragraph continuation inside a quote (the reference's set). */
function quoteLazyBlocked(line) {
  const withNl = line + '\n';
  if (HR.test(withNl)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(withNl)) return true;
  if (QUOTE_MARK.test(line)) return true;
  if (/^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~{3,})[^\n]*(?:\n|$)/.test(withNl)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/.test(withNl)) return true;
  if (
    new RegExp(
      `^ {0,3}(?:</?(?:${TAG_NAMES})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ).test(withNl)
  ) {
    return true;
  }
  return false;
}

/** The raw extent of a block quote starting at src: marker lines plus lazy paragraph lines. */
function blockquoteExtent(src) {
  let pos = 0;
  let any = false;
  while (pos < src.length) {
    const le = lineEnd(src, pos);
    const line = src.slice(pos, le);
    const qm = /^ {0,3}> ?/.exec(line);
    if (!qm) break;
    any = true;
    const content = line.slice(qm[0].length);
    pos = le === src.length ? le : le + 1;
    if (BLANK_LINE.test(content)) continue;
    while (pos < src.length) {
      const le2 = lineEnd(src, pos);
      const lazy = src.slice(pos, le2);
      if (BLANK_LINE.test(lazy)) break;
      if (quoteLazyBlocked(lazy)) break;
      pos = le2 === src.length ? le2 : le2 + 1;
    }
  }
  return any ? src.slice(0, pos) : null;
}

/** Strip quote markers from a chunk, with the reference's tab and setext adjustments. */
function stripQuoteMarkers(h) {
  return h
    .replace(/^( {0,3}>)([ \t]+)/gm, (m, marker, ws) => marker + expandTabs(ws, marker.length))
    .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
    .replace(/^ {0,3}>[ \t]?/gm, '');
}

function blockquoteToken(ctx, src) {
  const extent = blockquoteExtent(src);
  if (extent === null) return null;
  let lines = trimEndRun(extent, '\n').split('\n');
  let rawAll = '';
  let textAll = '';
  const out = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (QUOTE_MARK.test(lines[p])) {
        chunk.push(lines[p]);
        seenMarker = true;
      } else if (!seenMarker) {
        chunk.push(lines[p]);
      } else {
        break;
      }
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = stripQuoteMarkers(h);
    rawAll = rawAll ? rawAll + '\n' + h : h;
    textAll = textAll ? textAll + '\n' + u : u;
    const savedTop = ctx.top;
    ctx.top = true;
    blockTokens(ctx, u, out, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = out[out.length - 1];
    if (
      last &&
      (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')
    ) {
      break;
    }
    if (last && last.type === 'blockquote') {
      const rest = lines.join('\n');
      const merged = last.raw + '\n' + rest.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = blockquoteToken(ctx, merged);
      out[out.length - 1] = f;
      const y = merged.substring(f.raw.length).replace(/^\n/, '');
      const r = y ? y.split('\n').length : 0;
      const a = r ? lines.slice(0, -r) : lines;
      if (a.length > 0) rawAll = rawAll + '\n' + a.join('\n');
      textAll = textAll.substring(0, textAll.length - last.text.length) + f.text;
      lines = lines.slice(a.length);
      if (lines.length > 0 && QUOTE_MARK.test(lines[0])) continue;
      break;
    }
    if (last && last.type === 'list') {
      const b = last.raw + '\n' + lines.join('\n');
      const f = listToken(ctx, b);
      out[out.length - 1] = f;
      let cnt = 0;
      if (f && f.raw.length > last.raw.length) {
        cnt = b.slice(last.raw.length + 1, f.raw.length).split('\n').length;
      }
      if (cnt > 0) {
        const y = lines.slice(0, cnt).join('\n');
        rawAll = rawAll + '\n' + y;
        textAll = textAll + '\n' + y;
      }
      lines = lines.slice(cnt);
      continue;
    }
  }
  return { type: 'blockquote', raw: rawAll, tokens: out, text: textAll };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const LIST_FIRST = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const TASK_TEST = /^\[[ xX]\][ \t]+\S/;
const TASK_STRIP = /^\[[ xX]\][ \t]+/;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const DOUBLE_BLANK_TAIL = /\n[ \t]*\n[ \t]*$/;

const beginCache = [null, null, null, null];
/** The "does a block start here" probes used inside list items, per indent level. */
function beginTests(indent) {
  const n = Math.max(0, Math.min(3, indent - 1));
  if (beginCache[n]) return beginCache[n];
  const tests = {
    bullet: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`),
    hr: new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`),
    fence: new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
    heading: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
    html: new RegExp(
      `^ {0,${n}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    ),
    quote: new RegExp(`^ {0,${n}}>`),
  };
  beginCache[n] = tests;
  return tests;
}

const ITEM_RE_CACHE = new Map();

function listToken(ctx, src) {
  const first = LIST_FIRST.exec(src);
  if (!first) return null;
  const bullet = first[1].trim();
  const ordered = bullet.length > 1;
  const start = ordered ? parseInt(bullet.slice(0, -1), 10) : '';
  const lastChar = bullet[bullet.length - 1];
  const cacheKey = (ordered ? 'o' : 'u') + lastChar;
  let itemRe = ITEM_RE_CACHE.get(cacheKey);
  if (!itemRe) {
    const itemPattern = ordered ? `\\d{1,9}\\${lastChar}` : `\\${lastChar}`;
    itemRe = new RegExp(`^( {0,3}${itemPattern})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
    ITEM_RE_CACHE.set(cacheKey, itemRe);
  }
  const list = { type: 'list', raw: '', ordered, start, loose: false, items: [] };
  let rest = src;
  let consumed = 0;
  let endWithBlank = false;
  while (rest) {
    if (HR.test(rest)) break;
    const t = itemRe.exec(rest);
    if (!t) break;
    const itemStart = consumed;
    rest = rest.substring(t[0].length);
    consumed += t[0].length;
    const t2 = t[2];
    const t2nl = t2.indexOf('\n');
    const firstContent = t2nl === -1 ? t2 : t2.slice(0, t2nl);
    const bulletLen = t[1].length;
    const fc0 = firstContent.charCodeAt(0);
    const expandedFirst =
      fc0 === 32 || fc0 === 9
        ? firstContent.replace(/^[ \t]+/, (v) => expandTabs(v, bulletLen))
        : firstContent;
    const blankFirst = !expandedFirst.trim();
    let indent;
    let itemText = '';
    let earlyEnd = false;
    if (blankFirst) {
      indent = bulletLen + 1;
    } else {
      const r = expandedFirst.search(/[^ ]/);
      const capped = r > 4 ? 1 : r;
      itemText = expandedFirst.slice(capped);
      indent = capped + bulletLen;
    }
    if (blankFirst) {
      const nl = rest.indexOf('\n');
      const nextLine = nl === -1 ? rest : rest.slice(0, nl);
      if (BLANK_LINE.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        consumed += nextLine.length + 1;
        earlyEnd = true;
      }
    }
    if (!earlyEnd) {
      const begins = beginTests(indent);
      let prevBlank = blankFirst;
      let prevContent = expandedFirst;
      while (rest) {
        const le = lineEnd(rest, 0);
        const line = rest.slice(0, le);
        if (
          begins.fence.test(line) ||
          begins.heading.test(line) ||
          begins.html.test(line) ||
          begins.quote.test(line) ||
          begins.bullet.test(line) ||
          begins.hr.test(line)
        ) {
          break;
        }
        const lc0 = line.charCodeAt(0);
        const expanded =
          lc0 === 32 || lc0 === 9 ? line.replace(/^[ \t]+/, (v) => expandTabs(v, 0)) : line;
        let idx = 0;
        while (expanded[idx] === ' ') idx++;
        if (idx === expanded.length) idx = -1;
        const lineBlank = idx === -1 && !expanded.includes('\t');
        if ((idx !== -1 && idx >= indent) || lineBlank) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          const prevIdx = prevContent.replace(/\t/g, '    ').search(/[^ ]/);
          if (
            prevBlank ||
            prevIdx >= 4 ||
            begins.fence.test(prevContent) ||
            begins.heading.test(prevContent) ||
            begins.html.test(prevContent) ||
            begins.hr.test(prevContent)
          ) {
            break;
          }
          let lazy = line;
          if (
            /^ {0,3}(?:=+|-+) *$/.test(line) &&
            lheadingProbe(ctx, prevContent + '\n' + line)
          ) {
            lazy = '    ' + expanded.replace(/^ {0,3}/, '');
          }
          itemText += '\n' + lazy;
        }
        prevBlank = lineBlank;
        prevContent = expanded.slice(indent);
        rest = rest.substring(le + 1);
        consumed += le + 1;
      }
    }
    const itemRaw = src.slice(itemStart, consumed);
    if (!list.loose) {
      if (endWithBlank) list.loose = true;
      else if (DOUBLE_BLANK_TAIL.test(itemRaw)) endWithBlank = true;
    }
    list.items.push({
      type: 'list_item',
      raw: itemRaw,
      task: TASK_TEST.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(0, consumed).trimEnd();
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(ctx, item.text, [], false);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.type === 'space');
      if (spaces.length > 0 && spaces.some((tok) => /\n.*\n/.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && firstTok && (firstTok.type === 'text' || firstTok.type === 'paragraph')) {
      item.text = item.text.replace(TASK_STRIP, '');
      firstTok.raw = firstTok.raw.replace(TASK_STRIP, '');
      firstTok.text = firstTok.text.replace(TASK_STRIP, '');
      // The reference rewrites the last queued inline job whose source still
      // looks like a task line — usually this item's first job.
      for (let g = ctx.jobs.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK.test(ctx.jobs[g].src)) {
          ctx.jobs[g].src = ctx.jobs[g].src.replace(TASK_STRIP, '');
          break;
        }
      }
      const cm = /\[[ xX]\]/.exec(item.raw);
      if (cm) {
        const checkbox = { type: 'checkbox', raw: cm[0] + ' ', checked: cm[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          firstTok.raw = checkbox.raw + firstTok.raw;
          firstTok.text = checkbox.raw + firstTok.text;
          // The inline tokens are filled in later; put the checkbox first via a marker.
          firstTok.prependCheckbox = checkbox;
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) {
        if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
  }
  return list;
}

/** A cheap stand-in for the setext probe the list code makes on a lazy underline line. */
function lheadingProbe(ctx, src) {
  return lheadingToken({ jobs: [], links: ctx.links, top: true }, src) !== null;
}

// ---------------------------------------------------------------------------
// Block driver: tries each block rule in the reference's order and applies
// its token-merge rules (indented code and definitions fold into a preceding
// paragraph or text token; consecutive text lines coalesce).
// ---------------------------------------------------------------------------

function blockTokens(ctx, src, tokens, fromQuote) {
  let guard = Infinity;
  let canMergePara = fromQuote;
  while (src) {
    if (src.length >= guard) break;
    guard = src.length;
    let tok;
    if ((tok = spaceToken(src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((tok = codeToken(src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        if (prev.job) prev.job.src = prev.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = fenceToken(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = headingToken(ctx, src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = hrToken(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = blockquoteToken(ctx, src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = listToken(ctx, src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = htmlToken(src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = defToken(src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        if (prev.job) prev.job.src = prev.text;
      } else {
        if (!Object.hasOwn(ctx.links, tok.tag)) {
          ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        }
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tableToken(ctx, src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = lheadingToken(ctx, src))) {
      src = src.slice(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (ctx.top && (tok = paragraphToken(ctx, src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (canMergePara && prev && prev.type === 'paragraph') {
        dropJob(ctx, tok);
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        if (prev.job) prev.job.src = prev.text;
      } else {
        tokens.push(tok);
      }
      canMergePara = false;
      continue;
    }
    if ((tok = textToken(ctx, src))) {
      src = src.slice(tok.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        dropJob(ctx, tok);
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        if (prev.job) prev.job.src = prev.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    break;
  }
  ctx.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline level
//
// Inline parsing is deferred until the block phase is done, then runs once
// per block text, in order. Emphasis and strikethrough are found by scanning
// a masked copy of the text (links, code spans and escapes neutralised), the
// same strategy the reference uses, reimplemented here.
// ---------------------------------------------------------------------------

const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/;
const TAG_RE =
  /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const INLINE_CODE_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

const LINK_LABEL_SRC =
  '(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const LINK_TITLE_SRC =
  '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const LINK_RE = new RegExp(
  `^!?\\[(${LINK_LABEL_SRC})\\]\\([ \\t\\n]*(<(?:\\\\.|[^\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(${LINK_TITLE_SRC}))?[ \\t\\n]*\\)`,
);
const REF_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const REFLINK_RE = new RegExp(`^!?\\[(${LINK_LABEL_SRC})\\]\\[(${REF_SRC})\\]`);
const NOLINK_RE = new RegExp(`^!?\\[(${REF_SRC})\\](?:\\[\\])?`);

const AUTOLINK_RE =
  /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;

const EMAIL_IT_SRC = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const URL_RE = new RegExp(
  `^(?:mailto:${EMAIL_IT_SRC}|xmpp:${EMAIL_IT_SRC}(?:\\/[A-Za-z0-9@.]+)?)` +
    `|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*` +
    `|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])`,
);
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

const LDELIM_RE = new RegExp(
  `^(?:\\*+(?:((?!\\*)(?!~)${PUNCT_SRC})|([^\\s*]))?)|^_+(?:((?!_)(?!~)${PUNCT_SRC})|([^\\s_]))?`,
  'u',
);
const NOT_PUNCT_SPACE_T_SRC = '(?:[^\\s\\p{P}\\p{S}]|~)';
const RDELIM_AST_RE = new RegExp(
  `^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])` +
    `|(?!\\*)(?!~)${PUNCT_SRC}(\\*+)(?=[\\s]|$)` +
    `|${NOT_PUNCT_SPACE_T_SRC}(\\*+)(?!\\*)(?=(?!~)${PUNCT_SPACE_SRC}|$)` +
    `|(?!\\*)(?!~)${PUNCT_SPACE_SRC}(\\*+)(?=${NOT_PUNCT_SPACE_T_SRC})` +
    `|[\\s](\\*+)(?!\\*)(?=(?!~)${PUNCT_SRC})` +
    `|(?!\\*)(?!~)${PUNCT_SRC}(\\*+)(?!\\*)(?=(?!~)${PUNCT_SRC})` +
    `|${NOT_PUNCT_SPACE_T_SRC}(\\*+)(?=${NOT_PUNCT_SPACE_T_SRC})`,
  'gu',
);
const RDELIM_UND_RE = new RegExp(
  `^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])` +
    `|(?!_)${PUNCT_SRC}(_+)(?=[\\s]|$)` +
    `|${NOT_PUNCT_SPACE_SRC}(_+)(?!_)(?=${PUNCT_SPACE_SRC}|$)` +
    `|(?!_)${PUNCT_SPACE_SRC}(_+)(?=${NOT_PUNCT_SPACE_SRC})` +
    `|[\\s](_+)(?!_)(?=${PUNCT_SRC})` +
    `|(?!_)${PUNCT_SRC}(_+)(?!_)(?=${PUNCT_SRC})`,
  'gu',
);
const DEL_LDELIM_RE = new RegExp(`^(~~?)(?:((?!~)${PUNCT_SRC})|[^\\s~])`, 'u');
const DEL_RDELIM_RE = new RegExp(
  `[^~]+(?=[^~])` +
    `|(?!~)${PUNCT_SRC}(~~?)(?=[\\s]|$)` +
    `|${NOT_PUNCT_SPACE_SRC}(~~?)(?!~)(?=${PUNCT_SPACE_SRC}|$)` +
    `|(?!~)${PUNCT_SPACE_SRC}(~~?)(?=${NOT_PUNCT_SPACE_SRC})` +
    `|[\\s](~~?)(?!~)(?=${PUNCT_SRC})` +
    `|(?!~)${PUNCT_SRC}(~~?)(?!~)(?=${PUNCT_SRC})` +
    `|${NOT_PUNCT_SPACE_SRC}(~~?)(?=${NOT_PUNCT_SPACE_SRC})`,
  'gu',
);

const SEARCH_LABEL_SRC =
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const SEARCH_REF_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const REFLINK_SEARCH_RE = new RegExp(
  `!?\\[(${SEARCH_LABEL_SRC})\\]\\[(${SEARCH_REF_SRC})\\]|!?\\[(${SEARCH_REF_SRC})\\](?:\\[\\])?(?!\\()`,
  'g',
);
const BLOCK_SKIP_RE =
  /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(`+)[^`]+\3(?!`)|<(?! )[^<>]*?>/g;
const ANY_PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

/** Does `txt` contain a working link (used by the masking pass)? */
function linkInText(ctx, txt) {
  if (!txt.includes('[')) return false;
  for (const m of txt.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_RE.test(m[0]) && txt.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of txt.matchAll(REFLINK_SEARCH_RE)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(ctx, s.slice(1, r - 1)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The masked copy of an inline string: reference links that resolve are
 * hidden, escapes outside code spans become '+', and link destinations, code
 * spans and tags collapse to bracketed filler of the same length, so emphasis
 * scanning sees the same shape the reference sees.
 */
function maskSrc(ctx, src) {
  let t = src;
  if (src.includes('[')) {
    const cb = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(ctx, inner)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, cb) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, cb);
  }
  if (t.includes('\\') || t.includes('`')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (n, s, r) =>
      r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n,
    );
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}

/** For each delimiter character, the last run start in `masked` that follows a non-space. */
function lastDelimIndices(masked) {
  const em = { '*': -1, _: -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  em['~'] = del;
  return em;
}

function tagToken(ctx, src) {
  const m = TAG_RE.exec(src);
  if (!m) return null;
  const raw = m[0];
  const st = ctx.state;
  if (!st.inLink && /^<a /i.test(raw)) st.inLink = true;
  else if (st.inLink && /^<\/a>/i.test(raw)) st.inLink = false;
  if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(raw)) st.inRawBlock = true;
  else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(raw)) st.inRawBlock = false;
  return { type: 'html', raw, text: raw };
}

/** True when a tag or autolink starting inside the label would run past it. */
function labelHasWideTag(ctx, src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = INLINE_CODE_RE.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const o = TAG_RE.exec(rest) || AUTOLINK_RE.exec(rest);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

function outputLink(ctx, match, def, raw) {
  const href = def.href;
  const title = def.title || null;
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const image = match[0].charAt(0) === '!';
  const st = ctx.state;
  const prevInLink = st.inLink;
  const prevEmitted = st.linkEmitted;
  const prevRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const tokens = inlineTokens(ctx, text);
  const emitted = st.linkEmitted;
  st.linkEmitted = prevEmitted;
  st.inLink = prevInLink;
  if (!image) {
    if (emitted) {
      st.inRawBlock = prevRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  return { type: image ? 'image' : 'link', raw, href, title, text, tokens };
}

function linkToken(ctx, src) {
  if (!ctx.state.linkParenPossible) return null;
  const t = LINK_RE.exec(src);
  if (!t) return null;
  const offset = t[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasWideTag(ctx, src, t[1], offset)) return null;
  const hrefPart = t[2].trim();
  if (hrefPart.startsWith('<')) {
    if (!hrefPart.endsWith('>')) return null;
    const inner = trimEndRun(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - inner.length) % 2 === 0) return null;
  } else {
    const idx = findClosing(t[2], '()');
    if (idx === -2) return null;
    if (idx > -1) {
      const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + idx;
      t[2] = t[2].substring(0, idx);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const endStrip = trimEndRun(t[0].slice(0, -1), '\\');
  if ((t[0].length - endStrip.length) % 2 === 0) return null;
  let href = t[2];
  let title = t[3] ? t[3].slice(1, -1) : '';
  href = href.trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  return outputLink(
    ctx,
    t,
    {
      href: href ? href.replace(ANY_PUNCT_ESCAPE, '$1') : href,
      title: title ? title.replace(ANY_PUNCT_ESCAPE, '$1') : title,
    },
    t[0],
  );
}

function reflinkToken(ctx, src) {
  const t = REFLINK_RE.exec(src) || NOLINK_RE.exec(src);
  if (!t) return null;
  const offset = t[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasWideTag(ctx, src, t[1], offset)) return null;
  const def = ctx.links[normLabel(t[2] || t[1])];
  if (!def) {
    const c = t[0].charAt(0);
    return { type: 'text', raw: c, text: c };
  }
  return outputLink(ctx, t, def, t[0]);
}

function emStrongToken(ctx, e, masked, prev, idx) {
  const s = LDELIM_RE.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const wasMid = prev === r;
  const i = masked.length - e.length;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || PUNCT_TEST.test(p);
  let n = prev;
  if (l < i) n = p;
  const u = l < i ? h : PUNCT_TEST.test(n);
  if (s[4] && ALNUM_TEST.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    const A = r === '*' ? RDELIM_AST_RE : RDELIM_UND_RE;
    const v = idx[r];
    const Q = masked.length - e.length + k;
    if (v < Q) return null;
    const tt = masked.slice(masked.length - e.length + k);
    const ee = v - Q;
    A.lastIndex = 0;
    let s2;
    while ((s2 = A.exec(tt)) !== null && !(s2.index > ee)) {
      const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
      if (!g) continue;
      let b = [...g].length;
      if (s2[3] || s2[4]) {
        m += b;
        continue;
      }
      if (s2[5] || s2[6] || R) {
        if (wasMid && (s2[5] || s2[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...s2[0]][0].length;
      const raw = e.slice(0, k + s2.index + te + b);
      if (Math.min(k, b) % 2) {
        const content = raw.slice(1, -1);
        return { type: 'em', raw, text: content, tokens: inlineTokens(ctx, content) };
      }
      const content = raw.slice(2, -2);
      return { type: 'strong', raw, text: content, tokens: inlineTokens(ctx, content) };
    }
  }
  return null;
}

function delToken(ctx, e, masked, prev, idx) {
  let s = DEL_LDELIM_RE.exec(e);
  if (!s) return null;
  if (prev && !PUNCT_TEST.test(prev)) return null;
  const o = [...s[0]].length - 1;
  let p = o;
  const v = idx['~'];
  const d0 = masked.length - e.length + o;
  if (v < d0) return null;
  const tt = masked.slice(masked.length - e.length + o);
  const ee = v - d0;
  DEL_RDELIM_RE.lastIndex = 0;
  while ((s = DEL_RDELIM_RE.exec(tt)) !== null && !(s.index > ee)) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    let l = [...g].length;
    if (l !== o) continue;
    if (s[3] || s[4]) {
      p += l;
      continue;
    }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const firstLen = [...s[0]][0].length;
    const raw = e.slice(0, o + s.index + firstLen + l);
    const content = raw.slice(o, raw.length - o);
    return { type: 'del', raw, text: content, tokens: inlineTokens(ctx, content) };
  }
  return null;
}

function urlToken(src) {
  const t = URL_RE.exec(src);
  if (!t) return null;
  let text;
  let href;
  if (t[2] === '@') {
    text = t[0];
    href = 'mailto:' + t[0];
  } else {
    let cur;
    let m = t[0];
    do {
      cur = m;
      m = BACKPEDAL_RE.exec(m)?.[0] ?? '';
    } while (cur !== m);
    text = m;
    href = t[1] === 'www.' ? 'http://' + m : m;
    t[0] = m;
  }
  return { type: 'link', raw: t[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

const EMAIL_CHAR = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?_`{|}~-") {
  EMAIL_CHAR[ch.charCodeAt(0)] = 1;
}
const TEXT_STOP = new Uint8Array(128);
for (const ch of '\\<![`*~_') TEXT_STOP[ch.charCodeAt(0)] = 1;

/** Length of the plain-text run the reference's text rule would take from `src`. */
function scanTextEnd(src) {
  const n = src.length;
  const c0code = src.charCodeAt(0);
  if (
    !(c0code >= 48 && c0code <= 57) && !(c0code >= 65 && c0code <= 90) && !(c0code >= 97 && c0code <= 122) &&
    /^[^a-zA-Z0-9](?=(?:mailto|xmpp):)/i.test(src)
  ) {
    return 1;
  }
  let i;
  const c0 = src[0];
  if (c0 === '`' || c0 === '~') {
    i = 1;
    while (i < n && src[i] === c0) i++;
  } else {
    i = 1;
  }
  for (let j = i; j < n; j++) {
    const code = src.charCodeAt(j);
    if (code < 128 && TEXT_STOP[code]) return j;
    const c = src[j];
    if (c === ' ') {
      if (src[j - 1] !== ' ') {
        let k = j;
        while (k < n && src[k] === ' ') k++;
        if (k - j >= 2 && src[k] === '\n') return j;
        j = k - 1;
      }
      continue;
    }
    if (code < 128 && EMAIL_CHAR[code]) {
      // A run of email characters stops the text at its start when the run
      // ends at '@'. A run with no character that could start another
      // terminator can be skipped wholesale; anything else falls through to
      // the per-character checks below.
      let k = j + 1;
      let plain = 'whfmxWHFMX`_~'.indexOf(c) === -1;
      while (k < n) {
        const kc = src.charCodeAt(k);
        if (kc >= 128 || !EMAIL_CHAR[kc]) break;
        if (plain && kc < 128 && (TEXT_STOP[kc] || kc === 119 || kc === 104 || kc === 102 || kc === 109 || kc === 120 || kc === 87 || kc === 72 || kc === 70 || kc === 77 || kc === 88)) plain = false;
        k++;
      }
      if (src[k] === '@') return j;
      if (plain) {
        j = k - 1;
        continue;
      }
    }
    if (
      (c === 'h' || c === 'H' || c === 'f' || c === 'F') &&
      /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.test(src.slice(j))
    ) {
      return j;
    }
    if (
      c === 'w' &&
      src.startsWith('www.', j) &&
      (j === 0 || /[\s*_~(]/.test(src[j - 1]))
    ) {
      return j;
    }
    if (
      (c === 'm' || c === 'M' || c === 'x' || c === 'X') &&
      /^(?:mailto|xmpp):/i.test(src.slice(j)) &&
      !/[a-zA-Z0-9]/.test(src[j - 1] ?? '')
    ) {
      return j;
    }
  }
  return n;
}

const TEXT_RE =
  /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|\}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|\}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|\}~-]+@))))/;

function textTokenInline(ctx, src) {
  const m = TEXT_RE.exec(src);
  const raw = m ? m[0] : src.slice(0, scanTextEnd(src));
  const inRaw = ctx.state.inRawBlock;
  return { type: 'text', raw, text: inRaw ? raw : decodeNumericRefs(raw), escaped: inRaw };
}

function mergeInlineText(tokens, tok) {
  const prev = tokens[tokens.length - 1];
  if (prev && prev.type === 'text') {
    prev.raw += tok.raw;
    prev.text += tok.text;
  } else {
    tokens.push(tok);
  }
}

function inlineTokens(ctx, src) {
  const saved = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = saved && src.includes(')');
  try {
    return inlineLoop(ctx, src);
  } finally {
    ctx.state.linkParenPossible = saved;
  }
}

function inlineLoop(ctx, src) {
  const tokens = [];
  let rest = src;
  let prevChar = '';
  let prevWasText = false;
  let masked = null;
  let delimIdx = null;
  const getMasked = () => {
    if (masked === null) {
      masked = src.includes('*') || src.includes('_') || src.includes('~') ? maskSrc(ctx, src) : src;
      delimIdx = lastDelimIndices(masked);
    }
    return masked;
  };
  let guard = Infinity;
  while (rest) {
    if (rest.length >= guard) break;
    guard = rest.length;
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    const c0 = rest[0];
    let tok = null;
    if (c0 === '\\') {
      const m = ESCAPE_RE.exec(rest);
      if (m) tok = { type: 'escape', raw: m[0], text: m[1] };
    }
    if (!tok && c0 === '<') tok = tagToken(ctx, rest);
    if (!tok && (c0 === '[' || c0 === '!')) tok = linkToken(ctx, rest);
    if (!tok && (c0 === '[' || c0 === '!')) {
      tok = reflinkToken(ctx, rest);
      if (tok && tok.type === 'text') {
        mergeInlineText(tokens, tok);
        rest = rest.slice(tok.raw.length);
        continue;
      }
    }
    if (!tok && (c0 === '*' || c0 === '_')) {
      getMasked();
      tok = emStrongToken(ctx, rest, masked, prevChar, delimIdx);
    }
    if (!tok && c0 === '`') {
      const m = INLINE_CODE_RE.exec(rest);
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.startsWith(' ') && text.endsWith(' ')) {
          text = text.substring(1, text.length - 1);
        }
        tok = { type: 'codespan', raw: m[0], text };
      }
    }
    if (!tok && (c0 === ' ' || c0 === '\\')) {
      const m = BR_RE.exec(rest);
      if (m) tok = { type: 'br', raw: m[0] };
    }
    if (!tok && c0 === '~') {
      getMasked();
      tok = delToken(ctx, rest, masked, prevChar, delimIdx);
    }
    if (!tok && c0 === '<') {
      const m = AUTOLINK_RE.exec(rest);
      if (m) {
        const text = m[1];
        const href = m[2] === '@' ? 'mailto:' + m[1] : m[1];
        tok = { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
      }
    }
    if (!tok && !ctx.state.inLink && /[A-Za-z0-9.+_-]/.test(c0) && URL_PRE.test(rest)) {
      tok = urlToken(rest);
    }
    if (!tok) {
      tok = textTokenInline(ctx, rest);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      prevWasText = true;
      mergeInlineText(tokens, tok);
      rest = rest.slice(tok.raw.length);
      continue;
    }
    tokens.push(tok);
    rest = rest.slice(tok.raw.length);
  }
  return tokens;
}

const URL_PRE = /^(?:www\.|[A-Za-z][A-Za-z0-9+.-]*:|[A-Za-z0-9._+-]+@)/;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function checkboxHtml(checked) {
  return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
}

function renderCodeBlock(tok) {
  const langWord = (tok.lang || '').match(/^\S*/)[0];
  const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
  const body = escapeAll(text);
  return langWord
    ? `<pre><code class="language-${escapeText(langWord)}">${body}</code></pre>\n`
    : `<pre><code>${body}</code></pre>\n`;
}

function renderList(list, ctx) {
  let body = '';
  for (const item of list.items) body += `<li>${renderTokens(item.tokens, ctx)}</li>\n`;
  const tag = list.ordered ? 'ol' : 'ul';
  const startAttr = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
  return `<${tag}${startAttr}>\n${body}</${tag}>\n`;
}

function tableCellHtml(cell, ctx) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return `${open}${renderInline(cell.tokens, ctx, false)}</${tag}>\n`;
}

function renderTable(tok, ctx) {
  let head = '';
  for (const cell of tok.header) head += tableCellHtml(cell, ctx);
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += tableCellHtml(cell, ctx);
    body += `<tr>\n${cells}</tr>\n`;
  }
  const tbody = body ? `<tbody>${body}</tbody>` : '';
  return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${tbody}</table>\n`;
}

function renderTokens(tokens, ctx) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok.tokens, ctx, false)}</h${tok.depth}>\n`;
        break;
      case 'code':
        out += renderCodeBlock(tok);
        break;
      case 'table':
        out += renderTable(tok, ctx);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderTokens(tok.tokens, ctx)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(tok, ctx);
        break;
      case 'checkbox':
        out += checkboxHtml(tok.checked);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph':
        out += `<p>${renderInline(tok.tokens, ctx, false)}</p>\n`;
        break;
      case 'text':
        out += renderInline(tok.tokens, ctx, false);
        break;
    }
  }
  return out;
}

function renderLink(tok, ctx) {
  const inner = tok.autolink ? escapeAll(tok.text) : renderInline(tok.tokens, ctx, false);
  const href = cleanUrl(tok.href);
  if (href === null) return inner;
  const e = tok.autolink ? escapeAll(href) : escapeText(href);
  let out = `<a href="${e}"`;
  if (tok.title) out += ` title="${escapeText(tok.title)}"`;
  return `${out}>${inner}</a>`;
}

function renderImage(tok, ctx) {
  const alt = renderInline(tok.tokens, ctx, true);
  const href = cleanUrl(tok.href);
  if (href === null) return escapeText(alt);
  let out = `<img src="${escapeText(href)}" alt="${escapeText(alt)}"`;
  if (tok.title) out += ` title="${escapeText(tok.title)}"`;
  return out + '>';
}

function renderInline(tokens, ctx, textOnly) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += textOnly ? tok.text : escapeText(tok.text);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
        out += textOnly ? renderInline(tok.tokens, ctx, true) : renderLink(tok, ctx);
        break;
      case 'image':
        out += textOnly ? renderInline(tok.tokens, ctx, true) : renderImage(tok, ctx);
        break;
      case 'checkbox':
        out += textOnly ? tok.raw : checkboxHtml(tok.checked);
        break;
      case 'strong':
        out += textOnly ? renderInline(tok.tokens, ctx, true) : `<strong>${renderInline(tok.tokens, ctx, false)}</strong>`;
        break;
      case 'em':
        out += textOnly ? renderInline(tok.tokens, ctx, true) : `<em>${renderInline(tok.tokens, ctx, false)}</em>`;
        break;
      case 'del':
        out += textOnly ? renderInline(tok.tokens, ctx, true) : `<del>${renderInline(tok.tokens, ctx, false)}</del>`;
        break;
      case 'codespan':
        out += textOnly ? tok.text : `<code>${escapeAll(tok.text)}</code>`;
        break;
      case 'br':
        out += textOnly ? '' : '<br>';
        break;
      case 'text':
        out += textOnly ? tok.text : tok.escaped ? tok.text : escapeText(tok.text);
        break;
    }
  }
  return out;
}

/**
 * Render a Markdown document to HTML, byte-for-byte matching the reference
 * renderer's default output for the same input.
 */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const ctx = {
    links: Object.create(null),
    jobs: [],
    top: true,
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true },
  };
  const tokens = blockTokens(ctx, src, [], false);
  for (const job of ctx.jobs) {
    ctx.state.inRawBlock = false;
    const holder = job.holder;
    const inline = inlineTokens(ctx, job.src);
    holder.tokens = holder.prependCheckbox ? [holder.prependCheckbox, ...inline] : inline;
  }
  return renderTokens(tokens, ctx);
}
