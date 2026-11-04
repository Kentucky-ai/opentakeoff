// Renders lib/chatMarkdown's block tree. Every string goes through React as a
// text child, so whatever a model writes is escaped — no HTML pass-through.
import { useMemo } from "react";
import { parseMarkdown } from "../lib/chatMarkdown.js";

function Inline({ spans }) {
  return spans.map((s, i) =>
    s.t === "b" ? <strong key={i}>{s.v}</strong>
      : s.t === "i" ? <em key={i}>{s.v}</em>
        : s.t === "code" ? <code key={i} className="ac-md-code">{s.v}</code>
          : s.v);
}

export default function ChatMarkdown({ text, className = "" }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={`ac-md${className ? ` ${className}` : ""}`}>
      {blocks.map((b, i) => {
        if (b.type === "p") return <p key={i}><Inline spans={b.inline} /></p>;
        if (b.type === "h") { const H = `h${Math.min(6, b.level + 2)}`; return <H key={i}><Inline spans={b.inline} /></H>; }
        if (b.type === "code") return <pre key={i} className="ac-md-pre"><code>{b.text}</code></pre>;
        const L = b.type === "ol" ? "ol" : "ul";
        return <L key={i} start={b.start}>{b.items.map((it, j) => <li key={j}><Inline spans={it} /></li>)}</L>;
      })}
    </div>
  );
}
