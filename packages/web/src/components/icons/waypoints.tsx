"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface WaypointsIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface WaypointsIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const VARIANTS: Variants = {
  normal: {
    pathLength: 1,
    opacity: 1,
  },
  animate: (custom: number) => ({
    pathLength: [0, 1],
    opacity: [0, 1],
    transition: {
      delay: 0.15 * custom,
      opacity: { delay: 0.1 * custom },
    },
  }),
};

const WaypointsIcon = forwardRef<WaypointsIconHandle, WaypointsIconProps>(
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
          <motion.circle
            animate={controls}
            custom={0}
            cx="12"
            cy="4.5"
            r="2.5"
            variants={VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={1}
            d="m10.2 6.3-3.9 3.9"
            variants={VARIANTS}
          />
          <motion.circle
            animate={controls}
            custom={0}
            cx="4.5"
            cy="12"
            r="2.5"
            variants={VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={2}
            d="M7 12h10"
            variants={VARIANTS}
          />
          <motion.circle
            animate={controls}
            custom={0}
            cx="19.5"
            cy="12"
            r="2.5"
            variants={VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={3}
            d="m13.8 17.7 3.9-3.9"
            variants={VARIANTS}
          />
          <motion.circle
            animate={controls}
            custom={0}
            cx="12"
            cy="19.5"
            r="2.5"
            variants={VARIANTS}
          />
        </svg>
  );
  }
);

WaypointsIcon.displayName = "WaypointsIcon";

export { WaypointsIcon };
