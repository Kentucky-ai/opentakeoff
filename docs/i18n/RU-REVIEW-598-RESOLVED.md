# Russian wording review for PR #598

This supersedes the first handoff in cc6f889. The follow-up review found real context errors in that handoff, including an incorrect dimensional formula, controls merged with tooltips, an unscaled opacity value presented as a percentage, and a filtered-result count described as the number actually displayed. Those records have been replaced.

## Review files

- [Reviewed CSV](ru-fixes-598-reviewed.csv) preserves all 665 original rows and adds the final wording, decision, source locations, handoff IDs, integration status and context notes. Decisions are 502 accept, 157 revise and 6 keep. Every done cell means translation reviewed, not UI integration complete.
- [Russian reading copy](ru-sentences-598.md) shows each context, ready-to-read examples and its source values.
- [Engineering handoff](ru-sentences-598.json) contains 84 source locations and 136 independent messages. Each message distinguishes text, label, tooltip, accessible name, option, placeholder or readout. It includes a proposed whole English key, Russian text, condition, bindings and a rendered example. The source excerpts refer to cc6f889.

Source occurrence indexing found 649 of the 665 review keys in the current web/src. The other 16 are explicitly marked usage unconfirmed in the CSV. They are retained as compatibility keys, not claimed as verified visible UI. Source locations are search evidence; styles and internal identifiers can also occur in that index. The rect{i} vertex key, for example, is preserved as an identifier.

## Corrections from the context pass

| Actual context | Corrected wording or treatment |
| --- | --- |
| Reference wall area | Perimeter × height, not area × height. The formatted area and its tooltip are separate messages. |
| Filtered measurement count | Измерений по фильтру: 75 из 100. The list can render only its first 50 rows, so Показано was inaccurate. |
| Marker opacity | A separate Непрозрачность label. The original slider stores 0.1–0.75 and does not render a percentage. |
| Sheet-number warning | unread is a file count, not a list of filenames. |
| Annotation properties | Labels, accessible names and point-size options are distinct messages. |
| Actual pixels | Пиксель в пиксель, a 100% raster view, not the physical printed page size. |
| Labor Type | Способ укладки. The actual input examples are Glue-down, Float and Nail-down. |
| Border area | Полосы, calculated as measured length × width. |
| Roll diagram breaks | Границы рулонов on the diagram, not installed material joints. |
| Acceptance / sealing | An approval seal is an отметка утверждения. Bridging an open doorway is an algorithmic closure, not human approval. |
| Excel warning | The reference to the unpriced sheet uses its current localized sheet name. |

## Grammar slots and interpolation

The context pass changes 152 catalog entries. Thirty catalog keys contain 39 slots that are exclusively English suffixes or pronouns, such as count === 1 ? "" : "s" or "its" : "their". The Russian strings omit these grammar slots. catalog_grammar_slots in the JSON records the exact expressions and source locations. All content slots remain, including counts, labels, units, filenames and the margin formula parameter. Tests allow only these evidenced grammar omissions, rather than weakening placeholder checks globally.

Adjacent source slots such as an optional proposal label immediately followed by a count keep their original order in the catalog. The legacy regex interpolator cannot reliably split arbitrary adjacent fields. New handoff messages use unambiguous content slots. Rich links remain link elements, user-entered organization names remain data, and point/length units are not inserted twice.

## Context decisions

| Concepts | Reviewed wording and integration notes |
| --- | --- |
| Work / Approval | Работа и проверка / Утвердить. The approval tool face is updated too. |
| Reference / Subfloor | Ссылка / Основание. Use a contextual key for the proposal's order reference. |
| Theme / Surface / Appearance | Тема / Фон рабочей области / Оформление. `Surface` in WorkspaceLayout is a background selector. For the measuring tool use Площадь стен. |
| Light chrome / Studio light | Светлая панель / Студийная светлая. |
| Draft / Draw | Построение / Рисование. `Draft` in the toolbar opens drawing controls. For an unfinished proposal use a separate key translating to Черновик. |
| Text / READ / Text tools | Текст / Чтение текста / Инструменты текста. |
| Look / Show | Осмотреть / Показать. |
| From / Prepared by / Contractor | От кого / Подготовил / Исполнитель. The proposal header has a whole-sentence template with Исполнитель. |
| Project info / Project / Workspace | Сведения о проекте / Проект / Рабочая область. |
| Shapes / Measurements | Фигуры / Измерения. |
| Templates / Library | Шаблоны / Библиотека. |
| left / remaining | слева / осталось. |
| Cuts / Deduction tools | Раскрой / Вычеты. Use Вырезать for an action and Вычет for a measurement deduction. |
| Detach / Unlink | Отвязать от вида работ / Отвязать от RFI. |
| Coverage / preset | Норма расхода / Типовая норма… |
| rule ids | Technical identifiers remain engineering-owned and must not be translated. |
| Accept / Keep | Принять / Оставить, including their all variants. |
| Open action / Open status | Keep the shared `Open` key as Открыть. Existing `rfiStatusLabel` supplies Открыт for RFI status. Do not replace button text with a status adjective. |
| SF w/Waste / Total SF w/Waste | Площадь с запасом, кв. фут / Итого с запасом, кв. фут. |
| Spec / schedule import | Спецификация / Импорт из ведомости. `find_schedule` is an identifier. |
| pricing markup / annotation markup | наценка / пометка. No markups becomes Пометок нет. |
| Finish field / Finish action | Поле отделки / Готово. |


## Integration status

The catalog changes apply to existing individual keys. The 84 composition sites still require the maintainer to wire whole messages in the JSX after rebasing. Sixty-seven CSV rows refer to fragments covered by that handoff. Each conditional branch has its own message; optional roll text is a separate message rather than a nested sentence argument. A control group may need several short labels, not one sentence combining the entire row.

The long schedule-reader tool contract remains in English to preserve every field and enum name. Technical-key removal, project currency, the language menu, rebasing and layout remain assigned to the maintainers as agreed in the original review. This handoff does not claim those engineering changes are finished.

## Verification

The subsequent [delivery audit](DELIVERY-AUDIT-598.md) fixes data-versus-label collisions in exports and editable fields, uses explicit interpolation in selected receipts, and records the actual browser/export checks. It supersedes the test count below: the final web check passed with **3620 passed, 4 skipped, 0 failed and 0 cancelled**. The 84-location document remains a historical engineering handoff, not a claim that every composition has been wired.

The localization checks exercise counts 1, 2, 5 and 21, optional proposal labels, approval wording, the full margin warning, all content placeholders, the 84-location handoff and all rendered examples. They also check that Excel names the same unpriced sheet that its warning references.

Run npm run check in web/. Run npm run check:tool-count and npm run check:wiki in mcp/, npm run check in protocol/, and node scripts/check-doc-links.mjs from the repository root. The final full web check passed on 2026-11-04: 3616 tests passed, 4 skipped and 0 failed (3620 total). Typecheck, lint, ORT validation, benchmarks, production build and OCR distribution validation passed. MCP tool-count, wiki, protocol and documentation-link checks passed. All 84 source excerpts were separately verified against their recorded source lines. Automated checks protect interpolation and export behavior; the contextual wording decisions are documented above.
