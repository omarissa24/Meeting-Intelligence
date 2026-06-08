"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

const WORDS = ["captured", "transcribed", "summarised", "searchable", "understood"];

export function AnimatedHeadline() {
  const [index, setIndex] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const id = setTimeout(() => setIndex((i) => (i + 1) % WORDS.length), 2200);
    return () => clearTimeout(id);
  }, [index]);

  return (
    <h1 className="animate-rise-in mt-5 max-w-3xl font-display text-4xl leading-[1.05] font-normal tracking-tight sm:text-5xl md:text-6xl">
      <span className="block">Every meeting,</span>
      <span className="relative flex w-full justify-center overflow-hidden pt-1 pb-3">
        &nbsp;
        {WORDS.map((word, i) => (
          <motion.span
            key={word}
            className="absolute font-medium text-accent"
            initial={{ opacity: 0, y: reduceMotion ? 0 : -120 }}
            transition={{ type: "spring", stiffness: 50, damping: 14 }}
            animate={
              index === i
                ? { y: 0, opacity: 1 }
                : { y: reduceMotion ? 0 : index > i ? -150 : 150, opacity: 0 }
            }
          >
            {word}
          </motion.span>
        ))}
      </span>
    </h1>
  );
}
