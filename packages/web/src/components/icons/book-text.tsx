"use client";

import { motion, useAnimation, type SVGMotionProps } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";

import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface BookTextIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface BookTextIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const BookTextIcon = forwardRef<BookTextIconHandle, BookTextIconProps>(
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
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          variants={{
            animate: {
              scale: [1, 1.04, 1],
              rotate: [0, -8, 8, -8, 0],
              y: [0, -2, 0],
              transition: {
                duration: 0.6,
                ease: "easeInOut",
                times: [0, 0.2, 0.5, 0.8, 1],
              },
            },
            normal: {
              scale: 1,
              rotate: 0,
              y: 0,
            },
          }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
          className={cn(className)}
          {...(props as SVGMotionProps<SVGSVGElement>)}
        >
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
          <path d="M8 11h8" />
          <path d="M8 7h6" />
        </motion.svg>
  );
  }
);

BookTextIcon.displayName = "BookTextIcon";

export { BookTextIcon };
