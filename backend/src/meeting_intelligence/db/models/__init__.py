"""ORM model re-exports.

Importing this module is what populates `Base.metadata` with the full
table set. Alembic's `env.py` imports it for autogen; tests import it
to drive `Base.metadata.create_all` against the ephemeral DB.
"""

from meeting_intelligence.db.models.action_item import ActionItem
from meeting_intelligence.db.models.meeting import Meeting
from meeting_intelligence.db.models.meeting_summary import MeetingSummary
from meeting_intelligence.db.models.transcript_segment import TranscriptSegment
from meeting_intelligence.db.models.user import User

__all__ = [
    "ActionItem",
    "Meeting",
    "MeetingSummary",
    "TranscriptSegment",
    "User",
]
