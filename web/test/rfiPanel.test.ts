// RfiPanel render — the agent-raised half (#364). An RFI minted over MCP
// arrives with origin {actor: "agent", reviewed: false}; the panel must show
// it as the agent's, badge it pending, and offer the one Accept path that
// turns it to ink. A tombstone (deleted: true) never lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RfiPanel from "../src/components/RfiPanel.jsx";

const base = { number: "RFI-001", subject: "Room 102 finish conflict", question: "CPT-1 or VCT-1?", status: "open", to: "", priority: "normal", cost_impact: false, schedule_impact: false, date: "2026-09-01", response: "", response_date: "", sheet_id: "A-101" };
const render = (rfis: any[]) => renderToStaticMarkup(
  React.createElement(RfiPanel as any, { docked: true, rfis, markups: [], onUpdateRfi: () => {}, onDeleteRfi: () => {}, onFlyTo: () => {}, sheetLabel: (s: string) => s }),
);

test("RfiPanel: an agent-raised pending RFI is badged and offers Accept; a panel-raised one is not", () => {
  const agent = render([{ ...base, id: "rfi-a", origin: { actor: "agent", reviewed: false } }]);
  assert.match(agent, /RFI-001/);
  assert.match(agent, /agent · pending/);
  assert.match(agent, />Accept</);
  const panel = render([{ ...base, id: "rfi-p" }]);
  assert.match(panel, /RFI-001/);
  assert.doesNotMatch(panel, /agent/);
  assert.doesNotMatch(panel, />Accept</);
});

test("RfiPanel: an accepted agent RFI keeps the agent badge and loses the Accept button", () => {
  const html = render([{ ...base, id: "rfi-a", origin: { actor: "agent", reviewed: true } }]);
  assert.match(html, />agent</);
  assert.doesNotMatch(html, /pending/);
  assert.doesNotMatch(html, />Accept</);
});

test("RfiPanel: a withdrawn RFI (tombstone) never lists, and the counts skip it", () => {
  const html = render([{ ...base, id: "rfi-a" }, { ...base, id: "rfi-b", number: "RFI-002", status: "void", deleted: true }]);
  assert.match(html, /All 1</);
  assert.match(html, /RFI-001/);
  assert.doesNotMatch(html, /RFI-002/);
});
