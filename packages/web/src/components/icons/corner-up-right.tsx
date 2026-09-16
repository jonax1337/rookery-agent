"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation, type SVGMotionProps } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

const STRETCH_VARIANTS: Variants = {
  normal: { scaleX: 1, x: 0, opacity: 1 },
  animate: {
    scaleX: [1, 1.15, 1],
    x: [0, 2, 0],
    transition: {
      duration: 0.45,
      ease: "easeInOut",
    },
  },
};

export interface CornerUpRightIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface CornerUpRightIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const CornerUpRightIcon = forwardRef<
  CornerUpRightIconHandle,
  CornerUpRightIconProps
>(({ onMouseEnter, onMouseLeave, className, size = 24, ...props }, ref) => {
  const controls = useAnimation();
  const isControlledRef = useRef(false);
    const hostRef = useHostHover(
      isControlledRef,
      () => void controls.start("animate"),
      () => void controls.start("normal")
    );

  useImperativeHandle(ref, () => {
    isControlledRef.current = true;
    return {
      startAnimation: () => controls.start("animate"),
      stopAnimation: () => controls.start("normal"),
    };
  });

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (isControlledRef.current) {
        onMouseEnter?.(e);
      } else {
        controls.start("animate");
      }
    },
    [controls, onMouseEnter]
  );

  const handleMouseLeave = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (isControlledRef.current) {
        onMouseLeave?.(e);
      } else {
        controls.start("normal");
      }
    },
    [controls, onMouseLeave]
  );

  return (
      <motion.svg
        ref={hostRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
          animate={controls}
        fill="none"
        height={size}
        initial="normal"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        variants={STRETCH_VARIANTS}
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        className={cn(className)}
        {...(props as SVGMotionProps<SVGSVGElement>)}
      >
        <path d="m15 14 5-5-5-5" />
        <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
      </motion.svg>
);
});

CornerUpRightIcon.displayName = "CornerUpRightIcon";

export { CornerUpRightIcon };
