"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface ConnectIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ConnectIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const PLUG_VARIANTS: Variants = {
  normal: {
    x: 0,
    y: 0,
  },
  animate: {
    x: -3,
    y: 3,
  },
};

const SOCKET_VARIANTS: Variants = {
  normal: {
    x: 0,
    y: 0,
  },
  animate: {
    x: 3,
    y: -3,
  },
};

const PATH_VARIANTS = {
  normal: (custom: { x: number; y: number }) => ({
    d: `M${custom.x} ${custom.y} l2.5 -2.5`,
  }),
  animate: (custom: { x: number; y: number }) => ({
    d: `M${custom.x + 2.93} ${custom.y - 2.93} l0.10 -0.10`,
  }),
};

const ConnectIcon = forwardRef<ConnectIconHandle, ConnectIconProps>(
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
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          {...props}
        >
          <motion.path
            animate={controls}
            d="M19 5l3 -3"
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            variants={{
              normal: {
                d: "M19 5l3 -3",
              },
              animate: {
                d: "M17 7l5 -5",
              },
            }}
          />
          <motion.path
            animate={controls}
            d="m2 22 3-3"
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            variants={{
              normal: {
                d: "m2 22 3-3",
              },
              animate: {
                d: "m2 22 6-6",
              },
            }}
          />
          <motion.path
            animate={controls}
            d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            variants={SOCKET_VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={{ x: 7.5, y: 13.5 }}
            initial="normal"
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            variants={PATH_VARIANTS}
          />
          <motion.path
            animate={controls}
            custom={{ x: 10.5, y: 16.5 }}
            initial="normal"
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            variants={PATH_VARIANTS}
          />
          <motion.path
            animate={controls}
            d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            variants={PLUG_VARIANTS}
          />
        </svg>
    );
  }
);

ConnectIcon.displayName = "ConnectIcon";

export { ConnectIcon };
