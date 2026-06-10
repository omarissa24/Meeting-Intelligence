"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";

/**
 * Scroll-driven 3D reveal. As the container moves through the viewport the card
 * rotates from a backward tilt to flat, scales in, and the header drifts up.
 *
 * Adapted from Aceternity's ContainerScroll to this project's design system:
 * the device bezel uses semantic tokens (no hardcoded hex), and the whole
 * effect collapses to a flat, static render when the OS prefers reduced motion.
 */
export function ContainerScroll({
  titleComponent,
  children,
}: {
  titleComponent: ReactNode;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: containerRef });
  const reduceMotion = useReducedMotion();

  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const rotate = useTransform(scrollYProgress, [0, 1], reduceMotion ? [0, 0] : [20, 0]);
  const scale = useTransform(
    scrollYProgress,
    [0, 1],
    reduceMotion ? [1, 1] : isMobile ? [0.8, 0.95] : [1.05, 1],
  );
  const translate = useTransform(scrollYProgress, [0, 1], reduceMotion ? [0, 0] : [0, -100]);

  return (
    <div
      ref={containerRef}
      className="relative flex h-[55rem] items-center justify-center p-2 md:h-[70rem] md:p-20"
    >
      <div className="relative w-full py-10 md:py-28" style={{ perspective: "1000px" }}>
        <Header translate={translate}>{titleComponent}</Header>
        <Card rotate={rotate} scale={scale}>
          {children}
        </Card>
      </div>
    </div>
  );
}

function Header({ translate, children }: { translate: MotionValue<number>; children: ReactNode }) {
  return (
    <motion.div style={{ translateY: translate }} className="mx-auto max-w-2xl text-center">
      {/* Wrapped in a plain element (mirrors Card below) so the app's ReactNode
          isn't passed straight into motion.div's children — sidesteps the
          duplicated @types/react skew in the workspace. */}
      <div>{children}</div>
    </motion.div>
  );
}

function Card({
  rotate,
  scale,
  children,
}: {
  rotate: MotionValue<number>;
  scale: MotionValue<number>;
  children: ReactNode;
}) {
  return (
    <motion.div
      style={{ rotateX: rotate, scale }}
      className="elevation-overlay mx-auto mt-10 w-full max-w-5xl rounded-2xl border bg-secondary p-2 md:mt-14 md:p-3"
    >
      <div className="overflow-hidden rounded-xl">{children}</div>
    </motion.div>
  );
}
