"""The /ai/parse-schedule row contract.

The web app no longer calls this route; its rows keep the client's row shape,
so the category vocabulary must match the `Category` union in
web/src/lib/scheduleRows.ts. The tick defaults are pinned here:
- wall_protection and unassigned ("No section") are categories, both ticked;
- an unknown category still coerces to "other" (unticked);
- REMARKS rides through as `remarks`, empty when the adapter sends none.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import ScheduleRow, _CATEGORIES  # noqa: E402

ROWS_TS = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "scheduleRows.ts"


def test_wall_protection_and_unassigned_are_categories_and_start_ticked():
    for cat in ("wall_protection", "unassigned"):
        row = ScheduleRow(finish_tag="X-1", category=cat)
        assert row.category == cat
        assert row.suggested is True


def test_unknown_category_still_falls_back_to_other():
    row = ScheduleRow(finish_tag="X-1", category="roofing")
    assert row.category == "other"
    assert row.suggested is False


def test_remarks_ride_through_and_default_empty():
    assert ScheduleRow(finish_tag="LVT-1", remarks="ADHESIVE: VENDOR-K").remarks == "ADHESIVE: VENDOR-K"
    assert ScheduleRow(finish_tag="LVT-1").remarks == ""


def test_vocabulary_matches_the_client_category_union():
    src = ROWS_TS.read_text()
    union = re.search(r"export type Category\s*=([^;]*);", src).group(1)
    assert set(re.findall(r'"(\w+)"', union)) == _CATEGORIES
