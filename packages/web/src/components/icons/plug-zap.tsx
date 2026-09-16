"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface PlugZapIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface PlugZapIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const ZAP_VARIANT: Variants = {
  normal: { opacity: 1 },
  animate: {
    opacity: [1, 0.4, 1],
    transition: {
      duration: 1,
      repeat: Number.POSITIVE_INFINITY,
      ease: "easeInOut",
    },
  },
};

const PlugZapIcon = forwardRef<PlugZapIconHandle, PlugZapIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 24, ...props }, ref) => {
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
          <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
          <path d="m2 22 3-3" />
          <path d="M7.5 13.5 10 11" />
          <path d="M10.5 16.5 13 14" />
          <motion.path
            animate={controls}
            d="m18 3-4 4h6l-4 4"
            initial="normal"
            variants={ZAP_VARIANT}
          />
        </svg>
  );
  }
);

PlugZapIcon.displayName = "PlugZapIcon";

export { PlugZapIcon };
