"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Toast } from "@/ui/toast";

type NotificationContext = { notify: (message: string) => void };
const Context = createContext<NotificationContext | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const notify = useCallback((next: string) => setMessage(next), []);
  const closeToast = useCallback(() => setMessage(""), []);
  const value = useMemo(() => ({ notify }), [notify]);

  return <Context.Provider value={value}>{children}{message && <Toast message={message} onClose={closeToast} />}</Context.Provider>;
}

export function useNotifications() {
  const context = useContext(Context);
  if (!context) throw new Error("useNotifications must be used within NotificationProvider");
  return context;
}
