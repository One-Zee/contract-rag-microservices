/** RFC 4180: quoted fields may hold commas, quotes (doubled) and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') {
        i++;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  return rows
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) =>
      Object.fromEntries(header.map((name, i) => [name, row[i] ?? ''])),
    );
}

function quote(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(records: readonly Record<string, unknown>[]): string {
  if (records.length === 0) {
    return '';
  }
  const header = Object.keys(records[0]);
  const lines = [
    header.map(quote).join(','),
    ...records.map((record) =>
      header.map((key) => quote(record[key])).join(','),
    ),
  ];
  return `${lines.join('\n')}\n`;
}
