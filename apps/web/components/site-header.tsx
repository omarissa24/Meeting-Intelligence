"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

import { ThemeToggle } from "@/components/theme-toggle";
import { REPO_URL } from "@/lib/releases";

/**
 * Fixed top bar carrying the marens wordmark. Transparent over the hero, then
 * settles onto a blurred surface once the page scrolls — so the logo stays
 * legible over both the atmospheric hero and the content sections below.
 *
 * The logo ships as two PNGs (dark ink / light ink) toggled by the `dark`
 * class next-themes sets pre-paint, so the right one shows with no flash.
 */
export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-base ${
        scrolled ? "border-border bg-background/80 backdrop-blur-md" : "border-transparent"
      }`}
    >
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-3.5">
        <a
          href="#top"
          aria-label="marens — back to top"
          className="transition-fast inline-flex items-center hover:opacity-80"
        >
          <Image
            src="/marens-logo.png"
            alt="marens"
            width={1113}
            height={281}
            className="h-7 w-auto dark:hidden"
          />
          <Image
            src="/marens-logo-dark.png"
            alt="marens"
            width={1113}
            height={281}
            className="hidden h-7 w-auto dark:block"
          />
        </a>

        <nav className="flex items-center gap-1">
          <a
            href="#features"
            className="text-caption transition-fast hidden rounded-md px-3 py-2 hover:text-foreground sm:inline-flex"
          >
            Features
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="text-caption transition-fast hidden rounded-md px-3 py-2 hover:text-foreground sm:inline-flex"
          >
            GitHub
          </a>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
