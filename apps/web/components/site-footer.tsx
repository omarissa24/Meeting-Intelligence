import { REPO_URL } from "@/lib/releases";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t">
      <div className="text-caption mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">Meeting Intelligence</span>
          <span aria-hidden>·</span>
          <span>© {year}</span>
        </div>
        <nav className="flex items-center gap-5">
          <a href="#features" className="transition-fast hover:text-foreground">
            Features
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="transition-fast hover:text-foreground"
          >
            GitHub
          </a>
          <a
            href={`${REPO_URL}/releases`}
            target="_blank"
            rel="noreferrer"
            className="transition-fast hover:text-foreground"
          >
            Releases
          </a>
        </nav>
      </div>
    </footer>
  );
}
