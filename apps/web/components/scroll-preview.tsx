import { AppPreview } from "@/components/app-preview";
import { ContainerScroll } from "@/components/ui/container-scroll-animation";

export function ScrollPreview() {
  return (
    <section className="mx-auto w-full max-w-5xl px-6">
      <ContainerScroll
        titleComponent={
          <>
            <span className="text-eyebrow">See it live</span>
            <h2 className="mt-4 font-display text-3xl font-normal tracking-tight sm:text-4xl">
              Watch the conversation become intelligence
            </h2>
          </>
        }
      >
        <AppPreview />
      </ContainerScroll>
    </section>
  );
}
