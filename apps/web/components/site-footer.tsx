import Image from "next/image";

import { REPO_URL } from "@/lib/releases";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t">
      <div className="text-caption mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <Image
            src="/marens-wordmark.png"
            alt="marens"
            width={1589}
            height={223}
            className="h-5 w-auto dark:hidden"
          />
          <Image
            src="/marens-wordmark-dark.png"
            alt="marens"
            width={1589}
            height={223}
            className="hidden h-5 w-auto dark:block"
          />
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
