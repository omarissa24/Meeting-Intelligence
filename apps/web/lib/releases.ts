/**
 * Resolves the latest published desktop installer from GitHub Releases.
 *
 * The desktop CI (`.github/workflows/desktop-release.yml`) builds `.dmg` (macOS)
 * and `.msi` (Windows) artifacts on `v*` tags and attaches them to a GitHub
 * Release. `/releases/latest` only returns *published* (non-draft) releases, so
 * until a maintainer publishes the first one this returns `available: false`
 * and the UI shows a "Coming soon" state.
 *
 * Server-only: keeps the (rate-limited, unauthenticated) GitHub API call off the
 * client. Cached via ISR (`revalidate`), so new releases surface within an hour.
 */

const GITHUB_REPO = process.env.GITHUB_REPO ?? "omarissa24/Meeting-Intelligence";
const REVALIDATE_SECONDS = 3600;

/** Public repository URL — used for footer links and the "Coming soon" fallback. */
export const REPO_URL = `https://github.com/${GITHUB_REPO}`;

export interface ReleaseInfo {
  available: boolean;
  version: string | null;
  macUrl: string | null;
  winUrl: string | null;
  releasesUrl: string;
  publishedAt: string | null;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string | null;
  assets: GitHubAsset[];
}

function emptyRelease(): ReleaseInfo {
  return {
    available: false,
    version: null,
    macUrl: null,
    winUrl: null,
    releasesUrl: `${REPO_URL}/releases`,
    publishedAt: null,
  };
}

function findAsset(assets: GitHubAsset[], ...extensions: string[]): string | null {
  for (const ext of extensions) {
    const match = assets.find((a) => a.name.toLowerCase().endsWith(ext));
    if (match) return match.browser_download_url;
  }
  return null;
}

export async function getLatestRelease(): Promise<ReleaseInfo> {
  const fallback = emptyRelease();
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      next: { revalidate: REVALIDATE_SECONDS },
    });

    if (!res.ok) return fallback;

    const release = (await res.json()) as GitHubRelease;
    const assets = release.assets ?? [];
    const macUrl = findAsset(assets, ".dmg");
    const winUrl = findAsset(assets, ".msi", ".exe");

    return {
      available: Boolean(macUrl || winUrl),
      version: release.tag_name ?? null,
      macUrl,
      winUrl,
      releasesUrl: fallback.releasesUrl,
      publishedAt: release.published_at,
    };
  } catch {
    return fallback;
  }
}
