"""Provider interfaces.

Every external service (STT, LLM, object storage, auth) sits behind an
abstract interface here. Feature code imports from this package — never from
a vendor SDK directly. See CLAUDE.md "Architectural invariants" #1.
"""

from meeting_intelligence.interfaces.auth import AuthProvider
from meeting_intelligence.interfaces.llm import LLMProvider
from meeting_intelligence.interfaces.storage import ObjectStorageProvider
from meeting_intelligence.interfaces.stt import STTProvider

__all__ = [
    "AuthProvider",
    "LLMProvider",
    "ObjectStorageProvider",
    "STTProvider",
]
