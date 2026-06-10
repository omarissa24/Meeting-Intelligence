"""Release sources (desktop auto-update manifest).

The package exposes concrete implementations behind the `ReleaseSource`
ABC defined in `interfaces.releases`. Pick the implementation via
`Settings.updates_provider`; `api/deps.py` does the wiring.
"""

from meeting_intelligence.releases.fake import InMemoryFakeReleaseSource
from meeting_intelligence.releases.github import GitHubReleaseSource

__all__ = ["GitHubReleaseSource", "InMemoryFakeReleaseSource"]
