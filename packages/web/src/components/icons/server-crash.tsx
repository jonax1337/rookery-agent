"use client";

import { motion, useAnimation, type SVGMotionProps, type Variants } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface ServerCrashIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface ServerCrashIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const PATH_VARIANTS: Variants = {
  normal: { pathLength: 1 },
  animate: {
    pathLength: [0, 1],
    transition: { duration: 0.4, ease: "linear" },
  },
};

const ServerCrashIcon = forwardRef<ServerCrashIconHandle, ServerCrashIconProps>(
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
          animate={controls}
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
          className={cn(className)}
          {...(props as SVGMotionProps<SVGSVGElement>)}
        >
          <path d="M6 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
          <path d="M6 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-2" />
          <path d="M6 6h.01" />
          <path d="M6 18h.01" />
          <motion.path
            animate={controls}
            d="m13 6-4 6h6l-4 6"
            initial="normal"
            variants={PATH_VARIANTS}
          />
        </motion.svg>
  );
  }
);

ServerCrashIcon.displayName = "ServerCrashIcon";

export { ServerCrashIcon };
