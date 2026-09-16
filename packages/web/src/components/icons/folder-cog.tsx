"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface FolderCogIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface FolderCogIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const G_VARIANTS: Variants = {
  normal: { rotate: 0 },
  animate: { rotate: 180 },
};

const FolderCogIcon = forwardRef<FolderCogIconHandle, FolderCogIconProps>(
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
          <path d="M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.98a2 2 0 0 1 1.69.9l.66 1.2A2 2 0 0 0 12 6h8a2 2 0 0 1 2 2v3.3" />
          <motion.g
            animate={controls}
            transition={{ type: "spring", stiffness: 50, damping: 10 }}
            variants={G_VARIANTS}
          >
            <path d="m14.305 19.53.923-.382" />
            <path d="m15.228 16.852-.923-.383" />
            <path d="m16.852 15.228-.383-.923" />
            <path d="m16.852 20.772-.383.924" />
            <path d="m19.148 15.228.383-.923" />
            <path d="m19.53 21.696-.382-.924" />
            <path d="m20.772 16.852.924-.383" />
            <path d="m20.772 19.148.924.383" />
            <circle cx="18" cy="18" r="3" />
          </motion.g>
        </svg>
  );
  }
);

FolderCogIcon.displayName = "FolderCogIcon";

export { FolderCogIcon };
