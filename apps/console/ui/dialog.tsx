"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon";

type DialogProps = { open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void; dismissible?: boolean };

export function Dialog({ open, title, description, children, onClose, dismissible = true }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousOverflow = useRef<string | null>(null);
  const lastContent = useRef({ title, description, children });
  const [keepContent, setKeepContent] = useState(open);

  const finishClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    ref.current?.close();
    // Remove form fields and sensitive account material after the exit motion.
    lastContent.current = { ...lastContent.current, children: null };
    setKeepContent(false);
    if (ref.current) delete ref.current.dataset.closing;
    if (previousOverflow.current !== null) {
      document.body.style.overflow = previousOverflow.current;
      previousOverflow.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);

    if (open) {
      setKeepContent(true);
      delete dialog.dataset.closing;
      if (!dialog.open) {
        previousOverflow.current = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        dialog.showModal();
      }
    } else if (dialog.open) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        finishClose();
      } else {
        // Keep the native modal and backdrop present until their exit completes.
        dialog.dataset.closing = "true";
        closeTimer.current = setTimeout(finishClose, 220);
      }
    }
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, [open, finishClose]);

  useLayoutEffect(() => {
    if (open) lastContent.current = { title, description, children };
  }, [open, title, description, children]);

  useEffect(() => () => finishClose(), [finishClose]);

  // Freeze the last open content so labels and form values do not change mid-exit.
  const content = open ? { title, description, children } : lastContent.current;

  return <dialog className="dialog" ref={ref} onCancel={event => { event.preventDefault(); if (open && dismissible) onClose(); }} onClick={event => { if (open && dismissible && event.target === ref.current) onClose(); }} onAnimationEnd={event => { if (event.target === ref.current && event.animationName === "dialog-out" && ref.current?.dataset.closing === "true") finishClose(); }} aria-labelledby={titleId} aria-describedby={content.description ? descriptionId : undefined}>
    {(open || keepContent) && <div className="dialog-content" inert={!open}>
      <button type="button" className="icon-button dialog-close" disabled={!dismissible} onClick={() => { if (open && dismissible) onClose(); }} aria-label="Close dialog"><Icon name="close" size={15.75} /></button>
      <h2 id={titleId}>{content.title}</h2>
      {content.description && <p className="dialog-description" id={descriptionId}>{content.description}</p>}
      <div className="dialog-body">{content.children}</div>
    </div>}
  </dialog>;
}
