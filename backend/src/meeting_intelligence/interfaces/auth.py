"""Auth provider interface.

Implementation: WorkOS (email/password, Google OAuth, enterprise SSO/SAML).
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AuthenticatedUser:
    user_id: str
    # WorkOS AuthKit access tokens do NOT carry `email` — they only
    # have `sub` (the workos_user_id). We capture the email at
    # `/auth/callback` time (where the SDK gives us the User record)
    # and provision the local users row there. Per-request bearers
    # land here with email=None and resolve via `workos_user_id`.
    email: str | None
    organization_id: str | None


class AuthProvider(ABC):
    """Authenticate sessions and authorise organization access."""

    @abstractmethod
    async def verify_token(self, token: str) -> AuthenticatedUser:
        """Validate a bearer token; raise on invalid / expired."""
        raise NotImplementedError

    @abstractmethod
    async def start_sso(self, organization_id: str, redirect_uri: str) -> str:
        """Return the provider's authorization URL for an SSO/SAML flow."""
        raise NotImplementedError
