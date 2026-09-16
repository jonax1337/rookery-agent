"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import type { SVGProps } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";
import { useHostHover } from "./use-host-hover";

export interface MailboxIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface MailboxIconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const FLAG_VARIANTS: Variants = {
  normal: {
    rotate: 0,
    transition: {
      type: "spring",
      stiffness: 300,
      damping: 18,
    },
  },
  animate: {
    rotate: -90,
    transition: {
      type: "spring",
      stiffness: 280,
      damping: 12,
      mass: 1,
    },
  },
};

const MailboxIcon = forwardRef<MailboxIconHandle, MailboxIconProps>(
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
          className={cn(className, "overflow-visible")}
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
          {...props}
        >
          <path d="M22 17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5C2 7 4 5 6.5 5H18c2.2 0 4 1.8 4 4v8Z" />
          <motion.path
            animate={controls}
            d="M18 11V9H15"
            initial="normal"
            style={{ transformOrigin: "18px 11px" }}
            variants={FLAG_VARIANTS}
          />
          <path d="M6.5 5C9 5 11 7 11 9.5V17a2 2 0 0 1-2 2" />
          <line x1="6" x2="7" y1="10" y2="10" />
        </svg>
  );
  }
);

MailboxIcon.displayName = "MailboxIcon";

export { MailboxIcon };
