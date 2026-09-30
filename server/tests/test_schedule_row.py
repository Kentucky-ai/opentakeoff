"""The /ai/parse-schedule row contract mirrors the client's.

The scan adapter's rows land in the same approval dialog as the vector
reader's, so the category vocabulary and its tick defaults must match the
client's mirror in web/src/lib/scheduleScan.ts (CATEGORIES / SUGGESTED):
- wall_protection and unassigned ("No section") are categories, both ticked;
- an unknown category still coerces to "other" (unticked);
- REMARKS rides through as `remarks`, empty when the adapter sends none.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import ScheduleRow, _CATEGORIES, _SUGGESTED_DEFAULT  # noqa: E402

SCAN_TS = Path(__file__).resolve().parents[2] / "web" / "src" / "lib" / "scheduleScan.ts"


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


def test_vocabulary_and_defaults_match_the_client_mirror():
    src = SCAN_TS.read_text()
    cats = re.search(r"const CATEGORIES[^=]*=\s*\[([^\]]*)\]", src).group(1)
    assert set(re.findall(r'"(\w+)"', cats)) == _CATEGORIES
    body = re.search(r"const SUGGESTED[^=]*=\s*\{([^}]*)\}", src).group(1)
    client = {k: v == "true" for k, v in re.findall(r"(\w+):\s*(true|false)", body)}
    assert client == _SUGGESTED_DEFAULT
