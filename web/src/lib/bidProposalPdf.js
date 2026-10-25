// Bid proposal → PDF (letter, pdf-lib, lazy-loaded like the marked set).
// Lays out what lib/bidProposal.js decided — letterhead, prepared-for, scope,
// base bid, inclusions / exclusions / terms, acceptance — and stamps the
// OpenTakeoff watermark on every page (lib/pdfWatermark.js). Reader-first: the
// price sits on page one, right under the scope.

import { winAnsiSafe } from "./markedset.js";
import { stampWatermark } from "./pdfWatermark.js";

const PAGE = [612, 792];
const M = 54;                       // margin
const RIGHT = PAGE[0] - M;
const BOTTOM = M + 24;              // above the watermark footer
const money = (v) => `$${(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (v) => (Number(v) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

// Greedy word wrap at a width; a single word longer than the line is hard-split.
// Splits on the text's own line breaks FIRST, then makes each line WinAnsi-safe
// (sanitizing first would turn every newline into "?").
export function wrapText(text, font, size, width) {
  const out = [];
  for (const para of String(text || "").split(/\r?\n/)) {
    let line = "";
    for (const word of winAnsiSafe(para).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) out.push(line);
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
        let n = w.length - 1;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

const dataUrlBytes = (url) => {
  const b64 = String(url).split(",")[1] || "";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** @param {ReturnType<typeof import("./bidProposal.js").buildBidProposal>} model */
export async function buildBidProposalPdf(model) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsiSafe(`Proposal${model.project ? ` — ${model.project}` : ""}`));
  doc.setCreator("OpenTakeoff");
  doc.setProducer("OpenTakeoff");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.11, 0.12), muted = rgb(0.42, 0.44, 0.47), rule = rgb(0.8, 0.82, 0.84);

  let page = doc.addPage(PAGE);
  let y = PAGE[1] - M;
  const newPage = () => { page = doc.addPage(PAGE); y = PAGE[1] - M; };
  const ensure = (h) => { if (y - h < BOTTOM) newPage(); };
  const text = (t, x, size = 10, f = font, color = ink) => page.drawText(winAnsiSafe(t), { x, y, size, font: f, color });
  const textRight = (t, x, size = 10, f = font, color = ink) => {
    const s = winAnsiSafe(t);
    page.drawText(s, { x: x - f.widthOfTextAtSize(s, size), y, size, font: f, color });
  };
  const para = (t, x, width, size = 10, f = font, color = ink, lead = 1.35) => {
    for (const line of wrapText(t, f, size, width)) { ensure(size * lead); text(line, x, size, f, color); y -= size * lead; }
  };
  const hr = (gap = 10) => { y -= gap / 2; page.drawLine({ start: { x: M, y }, end: { x: RIGHT, y }, thickness: 0.6, color: rule }); y -= gap / 2 + 4; };
  const heading = (t) => { ensure(28); y -= 6; text(t.toUpperCase(), M, 8.5, bold, muted); y -= 14; };

  // ── letterhead ────────────────────────────────────────────────────────────
  const c = model.company;
  let logoH = 0;
  if (c.logo) {
    try {
      const img = /^data:image\/jpe?g/i.test(c.logo) ? await doc.embedJpg(dataUrlBytes(c.logo)) : await doc.embedPng(dataUrlBytes(c.logo));
      const s = Math.min(150 / img.width, 56 / img.height, 1);
      logoH = img.height * s;
      page.drawImage(img, { x: M, y: y - logoH, width: img.width * s, height: logoH });
    } catch { logoH = 0; }   // an unreadable logo never blocks the proposal
  }
  const top = y;
  if (logoH) y -= logoH + 8;
  if (c.name) { y -= 14; text(c.name, M, 15, bold); y -= 6; }
  for (const line of [...wrapText(c.address, font, 9.5, 260), [c.phone, c.email].filter(Boolean).join(" · "), c.license ? `License ${c.license}` : ""].filter(Boolean)) {
    y -= 12; text(line, M, 9.5, font, muted);
  }
  const leftBottom = y;
  y = top - 18;
  textRight("PROPOSAL", RIGHT, 20, bold);
  y -= 18; textRight(model.date, RIGHT, 10, font, muted);
  y -= 13; textRight(`Valid until ${model.valid_until}`, RIGHT, 10, font, muted);
  y = Math.min(leftBottom, y) - 10;
  hr(14);

  // ── prepared for / project ───────────────────────────────────────────────
  const colW = (RIGHT - M - 24) / 2;
  const blockTop = y;
  text("PREPARED FOR", M, 8.5, bold, muted); y -= 14;
  if (model.client.name) { text(model.client.name, M, 11, bold); y -= 13; }
  for (const line of wrapText(model.client.address, font, 10, colW)) { text(line, M, 10); y -= 12.5; }
  if (model.client.reference) { text(`Ref. ${model.client.reference}`, M, 10, font, muted); y -= 12.5; }
  if (!model.client.name && !model.client.address) { text("—", M, 10, font, muted); y -= 12.5; }
  const left2 = y;
  y = blockTop;
  const px = M + colW + 24;
  text("PROJECT", px, 8.5, bold, muted); y -= 14;
  for (const line of wrapText(model.project || "—", bold, 11, colW)) { text(line, px, 11, bold); y -= 13; }
  y = Math.min(left2, y) - 6;
  hr(14);

  // ── scope ─────────────────────────────────────────────────────────────────
  heading("Scope of work");
  const col = { item: M, desc: M + 70, qty: model.itemized ? RIGHT - 170 : RIGHT - 60, unit: model.itemized ? RIGHT - 160 : RIGHT - 50, price: RIGHT };
  const descW = col.qty - col.desc - 60;
  text("ITEM", col.item, 8, bold, muted); text("DESCRIPTION", col.desc, 8, bold, muted);
  textRight("QUANTITY", col.qty, 8, bold, muted); text("UNIT", col.unit, 8, bold, muted);
  if (model.itemized) textRight("PRICE", col.price, 8, bold, muted);
  y -= 6; hr(6); y -= 8;
  for (const s of model.scope) {
    const lines = wrapText(s.description || "", font, 9.5, descW);
    ensure(14 + Math.max(0, lines.length - 1) * 12);
    text(s.tag, col.item, 10, bold);
    textRight(qty(s.qty), col.qty, 10);
    text(s.unit, col.unit, 10, font, muted);
    if (model.itemized) textRight(money(s.price), col.price, 10);
    lines.forEach((l, i) => { if (i) y -= 12; text(l, col.desc, 9.5); });
    y -= 16;
  }
  if (model.scope_note) { y -= 2; para(model.scope_note, M, RIGHT - M, 9.5, font, muted); }

  // ── base bid ──────────────────────────────────────────────────────────────
  ensure(46);
  y -= 6;
  page.drawRectangle({ x: M, y: y - 30, width: RIGHT - M, height: 38, borderColor: ink, borderWidth: 1 });
  y -= 16;
  text("BASE BID", M + 12, 11, bold);
  textRight(money(model.base_bid), RIGHT - 12, 16, bold);
  y -= 32;

  // ── inclusions / exclusions / terms ──────────────────────────────────────
  const bullets = (title, items) => {
    if (!items.length) return;
    heading(title);
    for (const it of items) {
      const lines = wrapText(it, font, 10, RIGHT - M - 14);
      ensure(lines.length * 13.5);
      text("•", M + 2, 10);
      for (const l of lines) { text(l, M + 14, 10); y -= 13.5; }
    }
  };
  bullets("Inclusions", model.inclusions);
  bullets("Exclusions", model.exclusions);
  if (model.terms) { heading("Terms"); para(model.terms, M, RIGHT - M, 10); }

  // ── acceptance ────────────────────────────────────────────────────────────
  ensure(130);
  heading("Acceptance");
  para("The prices, scope and terms above are accepted. The contractor is authorized to do the work as specified.", M, RIGHT - M, 9.5, font, muted);
  y -= 22;
  const sigW = (RIGHT - M - 36) / 2;
  const sigRow = (label) => {
    for (const x of [M, M + sigW + 36]) {
      page.drawLine({ start: { x, y }, end: { x: x + sigW, y }, thickness: 0.6, color: ink });
      page.drawText(label, { x, y: y - 11, size: 8, font, color: muted });
    }
    y -= 34;
  };
  page.drawText(winAnsiSafe(c.name || "Contractor"), { x: M, y: y + 12, size: 9, font: bold, color: ink });
  page.drawText(winAnsiSafe(model.client.name || "Customer"), { x: M + sigW + 36, y: y + 12, size: 9, font: bold, color: ink });
  y -= 6;
  sigRow("Signature");
  sigRow("Name and title");
  sigRow("Date");

  // ── every page: page n of N + the OpenTakeoff watermark ──────────────────
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    if (pages.length > 1) pg.drawText(`Page ${i + 1} of ${pages.length}`, { x: M, y: 18, size: 7.5, font, color: muted });
    stampWatermark(pg, { font, rgb, degrees });
  });
  return { bytes: await doc.save(), pages: pages.length };
}
