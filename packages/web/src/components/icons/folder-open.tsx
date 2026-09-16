"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation, type SVGMotionProps } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface FolderOpenIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface FolderOpenIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: {
    rotate: [0, -8, 6, -4, 0],
    transition: {
      ease: "easeInOut",
      rotate: {
        duration: 0.6,
      },
    },
  },
};

const FolderOpenIcon = forwardRef<FolderOpenIconHandle, FolderOpenIconProps>(
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
        <motion.svg
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
          {...(props as SVGMotionProps<SVGSVGElement>)}
        >
          <motion.path
            animate={controls}
            d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
            initial="normal"
            style={{ transformOrigin: "12px 12px" }}
            variants={VARIANTS}
          />
        </motion.svg>
  );
  }
);

FolderOpenIcon.displayName = "FolderOpenIcon";

export { FolderOpenIcon };
