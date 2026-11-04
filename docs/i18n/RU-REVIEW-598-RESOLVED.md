# Russian wording review for PR #598

All 665 rows were reviewed. The accompanying CSV preserves the original columns and adds `decision` and `final_ru`. Every `done` cell is `yes`. There are 635 accepted suggestions, 29 revised translations and one retained translation.

The editable `ru.json` and runtime `ru.js` contain the reviewed wording. Numbered interpolation slots are preserved. The margin warning includes both the formula and its restriction.

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

## Whole sentences for engineering integration

`ru-sentences-598.json` supplies 84 complete Russian texts against all 84 locations in the review, including control groups that only need consistent labels. Locations refer to the original reviewed head. Slots receive formatted display values. Units must agree with the actual measurement system. Preserve links, input controls and their accessibility labels while replacing the surrounding text.

For the question summary, use «Вопросов: {0}. На все даны ответы.» when no questions remain open. For the seed checkbox without a tag, use «Учесть образец». For empty sheet selection, omit the parenthesized count from the three open/stitch actions. For roll summaries, slot 4 is either empty or a complete sentence such as «Рулонов: {0}, длина каждого: {1}.». Do not interpolate English plural suffixes into the new templates.

The report explanation corrects the source fragment's formula too. Quantity including allowance equals measured quantity × (1 + allowance / 100), matching the calculation. The sheet-approval message refers to an approval stamp, not sealing a doorway. The long schedule-reader tool description is kept in English to preserve the full schema contract.

Engineering integration of these sentences, project currency, technical-key removal, rebasing and layout work remains assigned to the maintainers as requested in their review. This commit delivers the reviewed translations and templates for that integration.

## Verification

- Full web check passed on 2026-11-04. Run npm run check in web/. It includes typecheck, lint, ORT dependency validation, tests, benchmarks, production build and OCR distribution validation.
- Tests reported 3614 passed, 4 skipped, 0 failed (3618 total). The final wording refinements also passed all 12 localization and Russian-unit tests.
- check:tool-count and check:wiki in mcp/, check in protocol/, and node scripts/check-doc-links.mjs passed.
- The 665 review records are all marked done. All 84 source compositions have a handoff record. Runtime and JSON catalogs match, with all numbered placeholder occurrences preserved.
- Existing expectations for the reviewed Unpriced label and the Russian Excel-compatible CSV dialect were updated. CSV numeric values keep their value with a decimal comma and semicolon delimiter.
