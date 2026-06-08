import { Features } from "@/components/features";
import { Hero } from "@/components/hero";
import { ScrollPreview } from "@/components/scroll-preview";
import { SiteFooter } from "@/components/site-footer";
import { getLatestRelease } from "@/lib/releases";

export default async function Home() {
  const release = await getLatestRelease();

  return (
    <main className="flex min-h-dvh flex-col">
      <Hero release={release} />
      <ScrollPreview />
      <Features />
      <div className="mt-auto">
        <SiteFooter />
      </div>
    </main>
  );
}
