// Monoline icon set. 24x24 grid, 1.5px stroke.

function I({ children, size = 24, stroke = 1.5, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="square" strokeLinejoin="miter">
      {children}
    </svg>
  );
}

export const icons = {
  logo: (s) => <I size={s}><path d="M2 18 C 7 18, 7 6, 12 12 S 17 18, 22 6" /><circle cx="7" cy="14" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="17" cy="10" r="1" fill="currentColor" /></I>,
  spec: (s) => <I size={s}><path d="M5 3 H 16 L 19 6 V 21 H 5 Z" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></I>,
  document: (s) => <I size={s}><path d="M6 3 H 16 L 19 6 V 21 H 6 Z" /><path d="M16 3 V 6 H 19" /><line x1="9" y1="12" x2="16" y2="12" /><line x1="9" y1="16" x2="16" y2="16" /></I>,
  product: (s) => <I size={s}><rect x="3" y="7" width="18" height="13" /><path d="M3 7 L 12 3 L 21 7" /><line x1="12" y1="3" x2="12" y2="20" /></I>,
  takeoff: (s) => <I size={s}><rect x="3" y="3" width="18" height="18" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="3" x2="9" y2="21" /><circle cx="15" cy="15" r="1.2" fill="currentColor" /></I>,
  plus: (s) => <I size={s}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></I>,

  // ── takeoff canvas set — drafting monoline, vertex-dot motif on measure tools ──
  pan: (s) => <I size={s}><path d="M12 2 V 22 M2 12 H 22" /><path d="M12 2 L 9.6 4.4 M12 2 L 14.4 4.4 M12 22 L 9.6 19.6 M12 22 L 14.4 19.6 M2 12 L 4.4 9.6 M2 12 L 4.4 14.4 M22 12 L 19.6 9.6 M22 12 L 19.6 14.4" /></I>,
  select: (s) => <I size={s}><path d="M7 3 L 7 17 L 11 13.5 L 13.5 19.2 L 16 18 L 13.5 12.5 L 18.5 12 Z" /></I>,
  calibrate: (s) => <I size={s}><circle cx="12" cy="4.6" r="1.4" /><path d="M11.2 5.9 L 7 19 M12.8 5.9 L 17 19" /><path d="M5.8 17.4 L 8.2 18.4 M18.2 17.4 L 15.8 18.4" /></I>,
  area: (s) => <I size={s}><path d="M12 4 L 20 10 L 17 19 L 7 19 L 4 10 Z" /><circle cx="12" cy="4" r="1.1" fill="currentColor" /><circle cx="20" cy="10" r="1.1" fill="currentColor" /><circle cx="17" cy="19" r="1.1" fill="currentColor" /><circle cx="7" cy="19" r="1.1" fill="currentColor" /><circle cx="4" cy="10" r="1.1" fill="currentColor" /></I>,
  rectTool: (s) => <I size={s}><rect x="4" y="6" width="16" height="12" /><circle cx="4" cy="6" r="1.1" fill="currentColor" /><circle cx="20" cy="6" r="1.1" fill="currentColor" /><circle cx="20" cy="18" r="1.1" fill="currentColor" /><circle cx="4" cy="18" r="1.1" fill="currentColor" /></I>,
  linear: (s) => <I size={s}><path d="M3 17 L 9 9 L 15 13 L 21 5" /><circle cx="3" cy="17" r="1.1" fill="currentColor" /><circle cx="9" cy="9" r="1.1" fill="currentColor" /><circle cx="15" cy="13" r="1.1" fill="currentColor" /><circle cx="21" cy="5" r="1.1" fill="currentColor" /></I>,
  surface: (s) => <I size={s}><line x1="3" y1="20" x2="21" y2="20" /><path d="M8 20 V 7 H 16 V 20" /><path d="M12 16.5 V 10 M12 10 L 10.2 11.8 M12 10 L 13.8 11.8" /></I>,
  count: (s) => <I size={s}><rect x="4" y="4" width="4.5" height="4.5" fill="currentColor" stroke="none" /><rect x="15" y="5.5" width="4.5" height="4.5" fill="currentColor" stroke="none" /><rect x="6.5" y="13.5" width="4.5" height="4.5" fill="currentColor" stroke="none" /><rect x="15" y="15" width="4.5" height="4.5" /></I>,
  deduct: (s) => <I size={s}><path d="M12 4 L 20 10 L 17 19 L 7 19 L 4 10 Z" /><line x1="9" y1="13" x2="15" y2="13" /></I>,
  deductRect: (s) => <I size={s}><rect x="4" y="6" width="16" height="12" /><line x1="9" y1="12" x2="15" y2="12" /></I>,
  snap: (s) => <I size={s}><path d="M7 4 V 12 a 5 5 0 0 0 10 0 V 4" /><path d="M7 4 H 10.5 M13.5 4 H 17" /><path d="M7 7.5 H 10.5 M13.5 7.5 H 17" /><circle cx="12" cy="20.6" r="0.9" fill="currentColor" /></I>,
  angle: (s) => <I size={s}><path d="M4 19 H 20" /><path d="M4 19 L 17 6" /><path d="M12 19 a 8 8 0 0 0 -2.3 -5.7" /></I>,
  cloud: (s) => <I size={s}><path d="M6 9 a2.3 2.3 0 0 1 4 -1.4 a2.3 2.3 0 0 1 4 0 a2.3 2.3 0 0 1 4 1.4 a2.3 2.3 0 0 1 0.4 3 a2.3 2.3 0 0 1 -0.4 3 a2.3 2.3 0 0 1 -4 1.4 a2.3 2.3 0 0 1 -4 0 a2.3 2.3 0 0 1 -4 -1.4 a2.3 2.3 0 0 1 -0.4 -3 a2.3 2.3 0 0 1 0.4 -3 Z" /></I>,
  callout: (s) => <I size={s}><circle cx="6" cy="17" r="1.1" fill="currentColor" /><line x1="6.8" y1="16.2" x2="13" y2="10" /><rect x="13" y="5.5" width="8" height="6" /></I>,
  textNote: (s) => <I size={s}><path d="M5 5 H 19 M5 5 V 7.5 M19 5 V 7.5 M12 5 V 19 M9.5 19 H 14.5" /></I>,
  copy: (s) => <I size={s}><rect x="8" y="8" width="12" height="12" /><path d="M16 8 V 4 H 4 V 16 H 8" /></I>,
  paste: (s) => <I size={s}><rect x="5" y="5" width="14" height="16" /><rect x="9" y="3" width="6" height="4" /><line x1="9" y1="12" x2="15" y2="12" /><line x1="9" y1="16" x2="15" y2="16" /></I>,
  duplicate: (s) => <I size={s}><rect x="8" y="8" width="12" height="12" /><path d="M16 8 V 4 H 4 V 16 H 8" /><path d="M12 14 H 16 M14 12 V 16" /></I>,
  undo: (s) => <I size={s}><path d="M9 5 L 5 9 L 9 13" /><path d="M5 9 H 14.5 a 4.8 4.8 0 0 1 0 9.6 H 8" /></I>,
  check: (s) => <I size={s}><path d="M5 13 L 10 18 L 19 7" /></I>,
  sheets: (s) => <I size={s}><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></I>,
  sideBySide: (s) => <I size={s}><rect x="4" y="5" width="7" height="14" /><rect x="13" y="5" width="7" height="14" /></I>,
  close: (s) => <I size={s}><path d="M6 6 L 18 18 M18 6 L 6 18" /></I>,
  chevronDown: (s) => <I size={s}><path d="M6 9 L 12 15 L 18 9" /></I>,
  chevronLeft: (s) => <I size={s}><path d="M15 6 L 9 12 L 15 18" /></I>,
  chevronRight: (s) => <I size={s}><path d="M9 6 L 15 12 L 9 18" /></I>,
  markup: (s) => <I size={s}><path d="M12 3 L 17 10 L 12 21 L 7 10 Z" /><line x1="12" y1="3" x2="12" y2="12.5" /><circle cx="12" cy="13" r="1" fill="currentColor" /></I>,
  takeoffs: (s) => <I size={s}><rect x="4" y="5" width="3" height="3" fill="currentColor" stroke="none" /><line x1="10" y1="6.5" x2="20" y2="6.5" /><rect x="4" y="10.5" width="3" height="3" fill="currentColor" stroke="none" /><line x1="10" y1="12" x2="20" y2="12" /><rect x="4" y="16" width="3" height="3" fill="currentColor" stroke="none" /><line x1="10" y1="17.5" x2="20" y2="17.5" /></I>,
  revisions: (s) => <I size={s}><circle cx="12" cy="12" r="8" /><path d="M12 7.5 V 12 L 15.4 14" /><circle cx="12" cy="12" r="0.9" fill="currentColor" /></I>,
  zone: (s) => <I size={s}><path d="M4 4 H 8 M11 4 H 15 M18 4 H 20 V 6 M20 9 H 20 V 13 M20 16 V 20 H 17 M14 20 H 10 M7 20 H 4 V 16 M4 13 V 9 M4 6 V 4" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /></I>,
  highlighter: (s) => <I size={s}><path d="M5 21 L8.5 17.5 M8.5 17.5 L6.8 14 L14 6.8 L17.2 10 L10 17.2 Z M14 6.8 L15.8 5 L19 8.2 L17.2 10" /></I>,
  target: (s) => <I size={s}><circle cx="12" cy="12" r="6" /><path d="M12 3 V 7 M12 17 V 21 M3 12 H 7 M17 12 H 21" /><circle cx="12" cy="12" r="1" fill="currentColor" /></I>,
  height: (s) => <I size={s}><line x1="6" y1="4" x2="18" y2="4" /><line x1="6" y1="20" x2="18" y2="20" /><path d="M12 6.5 V 17.5 M12 6.5 L 9.8 8.7 M12 6.5 L 14.2 8.7 M12 17.5 L 9.8 15.3 M12 17.5 L 14.2 15.3" /></I>,
  thickness: (s) => <I size={s}><line x1="5" y1="5" x2="5" y2="19" /><line x1="19" y1="5" x2="19" y2="19" /><path d="M7.5 12 H 16.5 M7.5 12 L 9.7 9.8 M7.5 12 L 9.7 14.2 M16.5 12 L 14.3 9.8 M16.5 12 L 14.3 14.2" /></I>,
  oneClick: (s) => <I size={s}><path d="M9 3 H 3 V 9" /><path d="M15 3 H 21 V 9" /><path d="M3 15 V 21 H 9" /><path d="M21 15 V 21 H 15" /><path d="M12 7.4 L 13.2 10.8 L 16.6 12 L 13.2 13.2 L 12 16.6 L 10.8 13.2 L 7.4 12 L 10.8 10.8 Z" /></I>,
  hiRes: (s) => <I size={s}><rect x="3" y="5" width="18" height="14" /><path d="M7 15 V 9 M7 12 H 10.5 M10.5 9 V 15" /><path d="M14 9 V 15 M14 9 H 15.6 A 3 3 0 0 1 15.6 15 H 14" /></I>,
};

export function Icon({ name, size = 18 }) {
  const fn = icons[name] || icons.spec;
  return fn(size);
}
