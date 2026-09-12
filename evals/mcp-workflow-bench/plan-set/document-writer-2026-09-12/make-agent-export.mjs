// Produce an agent takeoff with THIS build's server: the St. Cloud v2 reference rings, one condition per finish.
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "../../../../mcp/src/session.ts";
const [plan, refPath, out] = process.argv.slice(2);
const ref = JSON.parse(readFileSync(refPath, "utf8"));
const s = new Session();
const r = await s.loadPlan(plan);
const key = "sample-finish-plan.pdf";
s.setScale(key, { use_detected: true });
for (const room of ref.rooms) s.measurePolygon(key, room.verts_px, { condition: room.finish, role: "floor_area" });
const p = s.exportPayload();
writeFileSync(out, JSON.stringify(p, null, 2));
console.log("sheet", key, "conditions", p.conditions.length, "shapes", p.shapes.length, "keys", Object.keys(p).join(","), "created_at", p.conditions[0].created_at);
