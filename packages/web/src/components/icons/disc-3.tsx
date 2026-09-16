"use client";

import { motion, useAnimation } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface Disc3IconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface Disc3IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const Disc3Icon = forwardRef<Disc3IconHandle, Disc3IconProps>(
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
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="2" />

          <motion.g
            animate={controls}
            style={{ transformOrigin: "12px 12px" }}
            transition={{ duration: 0.4, ease: "easeInOut" }}
            variants={{
              normal: { rotate: 0 },
              animate: { rotate: 90 },
            }}
          >
            <path d="M6 12c0-1.7.7-3.2 1.8-4.2" />
            <path d="M18 12c0 1.7-.7 3.2-1.8 4.2" />
          </motion.g>
        </svg>
  );
  }
);

Disc3Icon.displayName = "Disc3Icon";

export { Disc3Icon };
