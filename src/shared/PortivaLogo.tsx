import type { ImgHTMLAttributes } from "react";

export function PortivaLogo({ alt = "", className = "", ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={["portiva-logo", className].filter(Boolean).join(" ")}
      draggable={false}
      src="/portiva-logo.png"
      {...props}
    />
  );
}
