"use client";

import type { Transition } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface ChevronsUpDownIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ChevronsUpDownIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const DEFAULT_TRANSITION: Transition = {
  type: "spring",
  stiffness: 250,
  damping: 25,
};

const ChevronsUpDownIcon = forwardRef<
  ChevronsUpDownIconHandle,
  ChevronsUpDownIconProps
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
      <svg
        ref={hostRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
          fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        className={cn(className)}
        {...props}
      >
        <motion.path
          animate={controls}
          d="m7 15 5 5 5-5"
          initial="normal"
          transition={DEFAULT_TRANSITION}
          variants={{
            normal: { translateY: "0%" },
            animate: { translateY: "2px" },
          }}
        />
        <motion.path
          animate={controls}
          d="m7 9 5-5 5 5"
          initial="normal"
          transition={DEFAULT_TRANSITION}
          variants={{
            normal: { translateY: "0%" },
            animate: { translateY: "-2px" },
          }}
        />
      </svg>
);
});

ChevronsUpDownIcon.displayName = "ChevronsUpDownIcon";

export { ChevronsUpDownIcon };
