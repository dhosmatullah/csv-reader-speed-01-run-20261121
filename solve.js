// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// Returns exactly csv-reader's answer {columns, rows, errors} for every input
// {text, header}, following its broken-row policy word for word:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are the
//     records after it, padded (short_row) or cut (long_row) to the first
//     record's width; each error is {code, line, row} in the order met, line the
//     1-based line its record starts on, row its record's index in rows (null
//     for the header).
//
// How it is faster than the reference (which builds every field one character
// at a time and allocates a result object per field):
//
//   - Fields are cut out of the text with slice(), never concatenated per char.
//   - The next comma / LF / CR / quote is found with String.indexOf, whose scan
//     runs in native code. Each delimiter's next position is cached, and the
//     caches only move forward as the read advances, so over a whole file each
//     delimiter is scanned for once in total, not once per field.
//   - The segment-join path (an array of slices joined once) is taken only when
//     a field is actually broken or transformed: a stray CR in an unquoted
//     field, a doubled quote or a CR inside a quoted field, junk after a
//     closing quote, or an unterminated quote's re-read.
//   - No object is allocated per field; how a field ended is kept in one local.
//   - Line numbers inside quoted fields are counted with indexOf over each
//     content segment, again one native scan per segment.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next (every cache and counter is a local of run).

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Monotonic lookahead caches: the first index >= pos of each delimiter, n
  // when there is none, -2 when unknown. A cache is refreshed only once pos has
  // moved past it, so the native scans behind them cover the text once each.
  let iComma = -2;
  let iNL = -2;
  let iCR = -2;
  let iQ = -2;

  let fEnded = 2; // how the field just read ended

  // Adds the LFs in text[from, to) to the line count (they stay in the value).
  function countLines(from, to) {
    let i = text.indexOf('\n', from);
    while (i !== -1 && i < to) {
      line += 1;
      i = text.indexOf('\n', i + 1);
    }
  }

  // Reads an unquoted field from pos on top of `prefix` (null: nothing before
  // it; a string: that value already stands, junk after a closing quote or the
  // literal quote of an unterminated field). Sets fEnded.
  function readUnquoted(prefix) {
    let segs = prefix === null ? null : [prefix];
    let start = pos;
    for (;;) {
      if (iComma < pos) {
        iComma = text.indexOf(',', pos);
        if (iComma === -1) iComma = n;
      }
      if (iNL < pos) {
        iNL = text.indexOf('\n', pos);
        if (iNL === -1) iNL = n;
      }
      if (iCR < pos) {
        iCR = text.indexOf('\r', pos);
        if (iCR === -1) iCR = n;
      }
      let end = iComma;
      let kind = 0; // comma
      if (iNL < end) {
        end = iNL;
        kind = 1; // LF
      }
      if (iCR < end) {
        end = iCR;
        kind = 3; // CR
      }
      if (end >= n) {
        fEnded = 2;
        pos = n;
        if (segs !== null) {
          segs.push(text.slice(start, n));
          return segs.join('');
        }
        return text.slice(start, n);
      }
      if (kind === 3) {
        if (text.charCodeAt(end + 1) === 10) {
          // CRLF: the record ends. (Tested on the character itself, not the
          // LF cache: a CR as the text's last character has no LF after it.)
          fEnded = 1;
          pos = end + 2;
          line += 1;
          if (segs !== null) {
            segs.push(text.slice(start, end));
            return segs.join('');
          }
          return text.slice(start, end);
        }
        // A CR not followed by LF is dropped (stray_cr).
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (segs === null) segs = [];
        segs.push(text.slice(start, end));
        pos = end + 1;
        start = pos;
        continue;
      }
      if (kind === 0) {
        fEnded = 0;
        pos = end + 1;
      } else {
        fEnded = 1;
        pos = end + 1;
        line += 1;
      }
      if (segs !== null) {
        segs.push(text.slice(start, end));
        return segs.join('');
      }
      return text.slice(start, end);
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let start = pos;
    let segs = null;
    let value;
    for (;;) {
      if (iQ < pos) {
        iQ = text.indexOf('"', pos);
        if (iQ === -1) iQ = n;
      }
      if (iCR < pos) {
        iCR = text.indexOf('\r', pos);
        if (iCR === -1) iCR = n;
      }
      if (iCR < iQ) {
        // A CR inside quotes before the next quote: CRLF and a lone CR are
        // each read as one LF.
        countLines(start, iCR);
        if (segs === null) segs = [];
        segs.push(text.slice(start, iCR), '\n');
        line += 1;
        pos = iCR + (text.charCodeAt(iCR + 1) === 10 ? 2 : 1);
        start = pos;
        continue;
      }
      if (iQ >= n) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. The read rewinds, so the
        // lookahead caches are dropped.
        pos = open + 1;
        line = openLine;
        iComma = -2;
        iNL = -2;
        iCR = -2;
        iQ = -2;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      countLines(start, iQ);
      if (text.charCodeAt(iQ + 1) === 34) {
        // A doubled quote inside the field is one quote.
        if (segs === null) segs = [];
        segs.push(text.slice(start, iQ), '"');
        pos = iQ + 2;
        start = pos;
        continue;
      }
      // The closing quote.
      if (segs !== null) {
        segs.push(text.slice(start, iQ));
        value = segs.join('');
      } else {
        value = text.slice(start, iQ);
      }
      pos = iQ + 1;
      break;
    }
    if (pos >= n) {
      fEnded = 2;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = 0;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = 1;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = 1;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break (quote_junk, when anything was appended).
    const before = value.length;
    const joined = readUnquoted(value);
    if (joined.length > before) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return joined;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      lastQuoted = text.charCodeAt(pos) === 34;
      fields.push(lastQuoted ? readQuoted() : readUnquoted(null));
      if (fEnded !== 0) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
      fields.length = width;
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
