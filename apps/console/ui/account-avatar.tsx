"use client";

import { useState, type CSSProperties } from "react";

export function AccountAvatar({ name, image, size = 25.2 }: { name: string; image?: string | null; size?: number }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "R";
  return <span className="account-avatar" style={{ width: size, height: size, fontSize: size * .32 } as CSSProperties} aria-hidden="true">
    {image?.startsWith("https://") && failedImage !== image ? <img src={image} alt="" referrerPolicy="no-referrer" onError={() => setFailedImage(image)} /> : initials}
  </span>;
}
