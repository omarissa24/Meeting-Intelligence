"""Auth implementations: WorkOS provider, dev token issuer, FastAPI deps.

Routes never import the WorkOS SDK directly — they go through
`AuthProvider` (defined in `meeting_intelligence.interfaces.auth`) so
the dev-token path and the real AuthKit path use the same verifier
contract.
"""
