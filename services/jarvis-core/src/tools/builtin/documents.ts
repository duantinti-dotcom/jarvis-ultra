import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import mammoth from 'mammoth';
import type { Tool } from '../types.js';
import { backupFile } from './fs.js';
import { sha256 } from '../../util/ids.js';

const s = (v: unknown) => String(v);
type Cell = string | number | boolean | null;

function parseCsv(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? (text.split('\n')[0]!.split(';').length > text.split('\n')[0]!.split(',').length ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(rows: Cell[][], d = ','): string {
  return rows.map((r) => r.map((v) => {
    const t = v == null ? '' : String(v);
    return /[",\n\r;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }).join(d)).join('\r\n') + '\r\n';
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if ('result' in v) return (v.result as Cell) ?? null;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    return JSON.stringify(v);
  }
  return v as Cell;
}

export async function readWorkbook(file: string, maxRows = 500) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      if (rows.length < maxRows) rows.push((r.values as ExcelJS.CellValue[]).slice(1).map(cellValue));
    });
    return { name: ws.name, rowCount: ws.rowCount, columnCount: ws.columnCount, rows };
  });
}

async function readPdf(file: string) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await fsp.readFile(file)));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { pages: totalPages, text: Array.isArray(text) ? text.join('\n') : text };
}

/** Converte markdown simples (#, ##, -, **negrito**) em parágrafos do Word. */
function markdownToDocx(md: string): Paragraph[] {
  return md.split(/\r?\n/).map((line) => {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) return new Paragraph({ text: h[2], heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][h[1]!.length - 1] });
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const text = bullet ? bullet[1]! : line;
    const runs = text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => part.startsWith('**') ? new TextRun({ text: part.slice(2, -2), bold: true }) : new TextRun(part));
    return new Paragraph({ children: runs, ...(bullet ? { bullet: { level: 0 } } : {}) });
  });
}

export const documentTools: Tool[] = [
  {
    manifest: {
      name: 'documents.read', version: '1.0.0', category: 'documents', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Lê documentos de uma pasta autorizada: Excel (.xlsx), CSV, Word (.docx), PDF, texto e Markdown. Retorna o texto ou as linhas das planilhas.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, maxRows: { type: 'integer', default: 200 }, maxChars: { type: 'integer', default: 40000 } }, required: ['path'] },
      returns: 'Conteúdo estruturado do documento',
    },
    async run(a, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      const ext = path.extname(file).toLowerCase();
      const maxChars = Number(a.maxChars ?? 40000);
      const clip = (t: string) => ({ text: t.slice(0, maxChars), truncated: t.length > maxChars, chars: t.length });
      switch (ext) {
        case '.xlsx':
        case '.xlsm':
          return { ok: true, data: { path: file, type: 'xlsx', sheets: await readWorkbook(file, Number(a.maxRows ?? 200)) } };
        case '.csv': {
          const rows = parseCsv(await fsp.readFile(file, 'utf8'));
          return { ok: true, data: { path: file, type: 'csv', rowCount: rows.length, rows: rows.slice(0, Number(a.maxRows ?? 200)) } };
        }
        case '.docx': {
          const r = await mammoth.extractRawText({ path: file });
          return { ok: true, data: { path: file, type: 'docx', ...clip(r.value) } };
        }
        case '.pdf': {
          const r = await readPdf(file);
          return { ok: true, data: { path: file, type: 'pdf', pages: r.pages, ...clip(r.text) } };
        }
        case '.doc':
        case '.xls':
          return { ok: false, error: `Formato legado ${ext} não suportado. Salve como ${ext}x no Office.` };
        default:
          return { ok: true, data: { path: file, type: 'text', ...clip(await fsp.readFile(file, 'utf8')) } };
      }
    },
  },
  {
    manifest: {
      name: 'documents.create_spreadsheet', version: '1.0.0', category: 'documents', permissions: ['fs.write'], risk: 'medium', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Cria uma planilha Excel (.xlsx) ou CSV com cabeçalho e linhas. Ex.: planilha de tarefas com colunas Tarefa, Prazo, Status.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Caminho terminado em .xlsx ou .csv' },
          sheet: { type: 'string', default: 'Planilha1' },
          headers: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array' }, description: 'Lista de linhas; cada linha é uma lista de valores' },
          overwrite: { type: 'boolean', default: false },
        },
        required: ['path', 'headers'],
      },
      returns: 'Arquivo criado com número de linhas',
    },
    async run(a, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'write', ctx.origin);
      if (fs.existsSync(file) && !a.overwrite) return { ok: false, error: `Já existe: ${file}` };
      const backup = fs.existsSync(file) ? await backupFile(ctx, file) : null;
      const headers = (a.headers as unknown[]).map(String);
      const rows = ((a.rows as Cell[][] | undefined) ?? []).map((r) => (Array.isArray(r) ? r : [r]));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (file.toLowerCase().endsWith('.csv')) {
        await fsp.writeFile(file, '﻿' + toCsv([headers, ...rows]), 'utf8');
      } else {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'JARVIS ULTRA';
        const ws = wb.addWorksheet(s(a.sheet ?? 'Planilha1'));
        ws.addRow(headers).font = { bold: true };
        rows.forEach((r) => ws.addRow(r));
        ws.columns.forEach((c, i) => { c.width = Math.min(60, Math.max(12, headers[i]?.length ?? 10, ...rows.map((r) => String(r[i] ?? '').length + 2))); });
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        await wb.xlsx.writeFile(file);
      }
      return { ok: true, data: { path: file, rows: rows.length, columns: headers.length, backup }, evidence: { expectedRows: rows.length + 1 }, undo: { tool: 'fs.delete', args: { path: file } } };
    },
    async verify(a, out, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      const expected = (out.evidence as { expectedRows: number }).expectedRows;
      if (file.toLowerCase().endsWith('.csv')) {
        const n = parseCsv((await fsp.readFile(file, 'utf8')).replace(/^﻿/, '')).length;
        return n === expected ? { ok: true, detail: `CSV reaberto com ${n} linhas` } : { ok: false, detail: `esperado ${expected} linhas, encontrado ${n}` };
      }
      const sheets = await readWorkbook(file, 100_000);
      const n = sheets[0]?.rows.length ?? 0;
      return n === expected ? { ok: true, detail: `planilha reaberta com ${n} linhas` } : { ok: false, detail: `esperado ${expected} linhas, encontrado ${n}` };
    },
  },
  {
    manifest: {
      name: 'documents.update_spreadsheet', version: '1.0.0', category: 'documents', permissions: ['fs.write'], risk: 'medium', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Modifica uma planilha .xlsx existente preservando formatação: define células (ex.: {"B2": 10}) e/ou acrescenta linhas no fim. Faz backup antes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }, sheet: { type: 'string', description: 'Nome da aba; padrão: primeira' },
          set: { type: 'object', description: 'Mapa endereço→valor, ex.: {"A1":"Total","B1":42}' },
          appendRows: { type: 'array', items: { type: 'array' } },
        },
        required: ['path'],
      },
      returns: 'Células alteradas e linhas acrescentadas',
    },
    async run(a, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'write', ctx.origin);
      if (!/\.xlsx$/i.test(file)) return { ok: false, error: 'Somente arquivos .xlsx.' };
      const backup = await backupFile(ctx, file);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      const ws = a.sheet ? wb.getWorksheet(s(a.sheet)) : wb.worksheets[0];
      if (!ws) return { ok: false, error: `Aba não encontrada: ${a.sheet}` };
      const set = (a.set as Record<string, Cell> | undefined) ?? {};
      for (const [addr, v] of Object.entries(set)) {
        if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/i.test(addr)) return { ok: false, error: `Endereço inválido: ${addr}` };
        ws.getCell(addr.toUpperCase()).value = typeof v === 'string' && v.startsWith('=') ? { formula: v.slice(1) } : v;
      }
      const append = (a.appendRows as Cell[][] | undefined) ?? [];
      append.forEach((r) => ws.addRow(r));
      await wb.xlsx.writeFile(file);
      return { ok: true, data: { path: file, sheet: ws.name, cellsSet: Object.keys(set).length, rowsAppended: append.length, backup }, undo: { tool: 'fs.restore', args: { backup, path: file } } };
    },
    async verify(a, out, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      const ws = wb.getWorksheet((out.data as { sheet: string }).sheet);
      if (!ws) return { ok: false, detail: 'aba sumiu' };
      for (const [addr, v] of Object.entries((a.set as Record<string, Cell>) ?? {})) {
        if (typeof v === 'string' && v.startsWith('=')) continue;
        const got = cellValue(ws.getCell(addr.toUpperCase()).value);
        if (String(got) !== String(v)) return { ok: false, detail: `${addr}: esperado ${v}, encontrado ${got}` };
      }
      return { ok: true, detail: 'valores conferidos após reabrir o arquivo' };
    },
  },
  {
    manifest: {
      name: 'documents.create_word', version: '1.0.0', category: 'documents', permissions: ['fs.write'], risk: 'medium', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Cria um documento Word (.docx) a partir de texto em Markdown simples (# títulos, - listas, **negrito**).',
      parameters: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, markdown: { type: 'string' }, overwrite: { type: 'boolean', default: false } }, required: ['path', 'markdown'] },
      returns: 'Arquivo .docx criado',
    },
    async run(a, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'write', ctx.origin);
      if (!/\.docx$/i.test(file)) return { ok: false, error: 'O caminho deve terminar em .docx' };
      if (fs.existsSync(file) && !a.overwrite) return { ok: false, error: `Já existe: ${file}` };
      const backup = fs.existsSync(file) ? await backupFile(ctx, file) : null;
      const doc = new Document({ creator: 'JARVIS ULTRA', title: a.title ? s(a.title) : path.basename(file), sections: [{ children: markdownToDocx(s(a.markdown)) }] });
      const buf = await Packer.toBuffer(doc);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, buf);
      return { ok: true, data: { path: file, bytes: buf.length, backup }, evidence: { sha256: sha256(buf) }, undo: { tool: 'fs.delete', args: { path: file } } };
    },
    async verify(a, _o, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      const r = await mammoth.extractRawText({ path: file });
      const firstWords = s(a.markdown).replace(/[#*\-]/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
      const ok = firstWords.every((w) => r.value.includes(w));
      return ok ? { ok: true, detail: 'documento reaberto e conteúdo encontrado' } : { ok: false, detail: 'conteúdo não encontrado ao reabrir' };
    },
  },
];

export { parseCsv, toCsv };
