import {
  type DragEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface UseSftpDropUploadOptions<T extends HTMLElement> {
  enabled: boolean;
  onUploadPaths: (localPaths: string[]) => void | Promise<void>;
  targetRef: RefObject<T | null>;
}

export function useSftpDropUpload<T extends HTMLElement>({
  enabled,
  onUploadPaths,
  targetRef,
}: UseSftpDropUploadOptions<T>) {
  const [dropActive, setDropActive] = useState(false);
  const onUploadPathsRef = useRef(onUploadPaths);

  useEffect(() => {
    onUploadPathsRef.current = onUploadPaths;
  }, [onUploadPaths]);

  useEffect(() => {
    if (!enabled) {
      setDropActive(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const pointInsideTarget = (position: { x: number; y: number }) => {
      const targetElement = targetRef.current;

      if (!targetElement) {
        return false;
      }

      const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
      const target = document.elementFromPoint(position.x / pixelRatio, position.y / pixelRatio);
      return Boolean(target && targetElement.contains(target));
    };

    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;

          if (payload.type === "leave") {
            setDropActive(false);
            return;
          }

          if (payload.type === "enter" || payload.type === "over") {
            setDropActive(pointInsideTarget(payload.position));
            return;
          }

          if (payload.type === "drop") {
            const isTargetDrop = pointInsideTarget(payload.position);
            setDropActive(false);

            if (isTargetDrop && payload.paths.length > 0) {
              void onUploadPathsRef.current(uniquePaths(payload.paths));
            }
          }
        }),
      )
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }

        unlisten = nextUnlisten;
      })
      .catch(() => {
        // Browser preview uses the HTML5 drag handlers below.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, targetRef]);

  const dropZoneProps = useMemo(
    () => ({
      onDragEnter: (event: DragEvent<T>) => {
        if (!enabled) {
          return;
        }

        event.preventDefault();
        setDropActive(true);
      },
      onDragLeave: (event: DragEvent<T>) => {
        if (!enabled) {
          return;
        }

        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropActive(false);
        }
      },
      onDragOver: (event: DragEvent<T>) => {
        if (!enabled) {
          return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      },
      onDrop: (event: DragEvent<T>) => {
        if (!enabled) {
          return;
        }

        event.preventDefault();
        setDropActive(false);
        const paths = extractLocalFilePaths(event);

        if (paths.length > 0) {
          void onUploadPathsRef.current(paths);
        }
      },
    }),
    [enabled],
  );

  return { dropActive, dropZoneProps };
}

function extractLocalFilePaths(event: DragEvent<HTMLElement>) {
  const paths: string[] = [];

  for (const file of Array.from(event.dataTransfer.files)) {
    const path = (file as File & { path?: string }).path;

    if (path) {
      paths.push(path);
    }
  }

  for (const item of Array.from(event.dataTransfer.items)) {
    const file = item.kind === "file" ? item.getAsFile() : null;
    const path = (file as (File & { path?: string }) | null)?.path;

    if (path) {
      paths.push(path);
    }
  }

  return uniquePaths(paths);
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}
