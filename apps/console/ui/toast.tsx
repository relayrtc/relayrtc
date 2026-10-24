"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icon";

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    function updateHost() {
      const dialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
      // A toast inside the active modal stays interactive while the page is inert.
      setHost(dialogs.item(dialogs.length - 1) ?? document.body);
    }
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const toast = ref.current;
    if (!toast) return;
    // Native popovers share the browser's top layer with modal dialogs.
    toast.showPopover();
    return () => toast.hidePopover();
  }, [host]);

  useEffect(() => { const timer = setTimeout(onClose, 3200); return () => clearTimeout(timer); }, [message, onClose]);

  if (!host) return null;
  return createPortal(<div ref={ref} popover="manual" className="toast" role="status"><span className="toast-check"><Icon name="check" size={13.3875} /></span>{message}<button type="button" className="icon-button" onClick={onClose} aria-label="Dismiss notification"><Icon name="close" size={12.6} /></button></div>, host);
}
