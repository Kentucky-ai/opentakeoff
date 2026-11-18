// A deliberately small markdown reader for the agent chat's answers — the
// basics a model actually writes in a takeoff conversation: paragraphs,
// headings, bullet and numbered lists, fenced code, and inline **bold**,
// *italic* and `code`. Pure: text in, a block tree out; the component
// (components/ChatMarkdown.jsx) renders the tree through React, so model text
// is always escaped — there is no HTML pass-through and no link rendering.
//
// Block: { type: "p", inline } | { type: "h", level: 1..4, inline }
//      | { type: "ul" | "ol", items: Inline[], start? } | { type: "code", lang, text }
// Inline: [{ t: "text" | "b" | "i" | "code", v }]

/** Inline markdown → spans. Unclosed markers stay literal text. */
export function parseInline(src) {
  const s = String(src ?? "");
  const out = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "code", v: s.slice(i + 1, end) }); i = end + 1; continue; }
    } else if ((c === "*" || c === "_") && s[i + 1] === c) {
      const end = s.indexOf(c + c, i + 2);
      if (end > i + 2) { flush(); out.push({ t: "b", v: s.slice(i + 2, end) }); i = end + 2; continue; }
    } else if (c === "*" || (c === "_" && !/\w/.test(s[i - 1] || ""))) {
      const end = s.indexOf(c, i + 1);
      const inner = end > i + 1 ? s.slice(i + 1, end) : "";
      // "*" followed by a space is a literal (e.g. "2 * 3"), not emphasis
      if (inner && !/^\s|\s$/.test(inner) && (c === "*" || !/\w/.test(s[end + 1] || ""))) {
        flush(); out.push({ t: "i", v: inner }); i = end + 1; continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const HEAD = /^(#{1,4})\s+(.*?)\s*#*\s*$/;
// an opening fence may carry any info string ("csv title=x.csv", "c#"); its
// first word is the language. Only a bare ``` closes the block.
const FENCE = /^\s*```\s*([^`\s]*)[^`]*$/;
const FENCE_END = /^\s*```\s*$/;

/** Markdown text → blocks.
 *  @returns {any[]} */
export function parseMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let list = null;
  const endPara = () => { if (para.length) { blocks.push({ type: "p", inline: parseInline(para.join(" ")) }); para = []; } };
  const endList = () => { if (list) { blocks.push(list); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      endPara(); endList();
      const body = [];
      i++;
      while (i < lines.length && !FENCE_END.test(lines[i])) { body.push(lines[i]); i++; }
      blocks.push({ type: "code", lang: fence[1] || "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) { endPara(); endList(); continue; }
    const h = HEAD.exec(line);
    if (h) { endPara(); endList(); blocks.push({ type: "h", level: h[1].length, inline: parseInline(h[2]) }); continue; }
    const ul = UL.exec(line);
    const ol = ul ? null : OL.exec(line);
    if (ul || ol) {
      endPara();
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) {
        endList();
        list = { type, items: [] };
        if (ol && +ol[1] !== 1) list.start = +ol[1];
      }
      list.items.push(parseInline(ul ? ul[1] : ol[2]));
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // an indented continuation line belongs to the list item above it
      const items = list.items;
      items[items.length - 1] = parseInline(`${inlineText(items[items.length - 1])} ${line.trim()}`);
      continue;
    }
    endList();
    para.push(line.trim());
  }
  endPara(); endList();
  return blocks;
}

// re-serialize spans to source so a continuation can be re-parsed as one item
function inlineText(spans) {
  return spans.map((s) => (s.t === "b" ? `**${s.v}**` : s.t === "i" ? `*${s.v}*` : s.t === "code" ? `\`${s.v}\`` : s.v)).join("");
}
