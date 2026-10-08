"use client";

import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
  copiedDuration?: number;
};

export const useCopyToClipboard = ({
  copiedDuration = 3000,
}: UseCopyToClipboardOptions = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A pending reset must never outlive the component that owns the state.
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copyToClipboard = (value: string) => {
    if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    navigator.clipboard.writeText(value).then(
      () => {
        setIsCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setIsCopied(false), copiedDuration);
      },
      () => {
        // Permission denied: the button just does not flip to "copied".
      },
    );
  };

  return { isCopied, copyToClipboard };
};
