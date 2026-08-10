import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

type Tone = "default" | "primary" | "danger" | "muted";
type Size = "sm" | "md" | "lg";

function cx(...classes: Array<false | null | undefined | string>) {
  return classes.filter(Boolean).join(" ");
}

const portalThemeVariables = [
  "--accent",
  "--accent-bg",
  "--app-bg",
  "--border-faint",
  "--border-panel",
  "--border-subtle",
  "--button-bg",
  "--button-muted-base-bg",
  "--button-muted-bg",
  "--control-radius",
  "--danger",
  "--danger-bg",
  "--field-bg",
  "--panel-bg",
  "--panel-solid-base-bg",
  "--panel-solid-bg",
  "--surface-radius",
  "--tag-radius",
  "--text-main",
  "--text-muted",
  "--text-strong",
];

function getPortalThemeStyle(): CSSProperties {
  if (typeof document === "undefined") {
    return {};
  }

  const source = document.querySelector<HTMLElement>(".app-shell") ?? document.documentElement;
  const computed = window.getComputedStyle(source);
  const style: CSSProperties & Record<string, string> = {};

  portalThemeVariables.forEach((name) => {
    const value = computed.getPropertyValue(name);
    if (value) {
      style[name] = value;
    }
  });

  return style;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  fullWidth?: boolean;
  icon?: IconName;
  size?: Size;
  tone?: Tone;
}

export function Button({
  active = false,
  children,
  className,
  fullWidth = false,
  icon,
  size = "md",
  tone = "default",
  type = "button",
  ...props
}: ButtonProps) {
  const content =
    icon && (typeof children === "string" || typeof children === "number") ? (
      <span className="ui-button-content">{children}</span>
    ) : (
      children
    );

  return (
    <button
      className={cx("ui-button", `ui-button-${tone}`, `ui-button-${size}`, active && "active", fullWidth && "ui-button-full", className)}
      type={type}
      {...props}
    >
      {icon ? <Icon name={icon} /> : null}
      {content}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon"> {
  icon: IconName;
}

export function IconButton({ className, icon, ...props }: IconButtonProps) {
  return (
    <Button className={cx("ui-icon-button", className)} icon={icon} {...props}>
      <span className="ui-sr-only">{props["aria-label"] ?? props.title}</span>
    </Button>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  fieldSize?: Size;
  leadingIcon?: IconName;
  mono?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { className, fieldSize = "md", leadingIcon, mono = false, ...props },
  ref,
) {
  const input = (
    <input className={cx("ui-field", `ui-field-${fieldSize}`, mono && "ui-field-mono", className)} ref={ref} {...props} />
  );

  if (!leadingIcon) {
    return input;
  }

  return (
    <span className="ui-field-shell">
      <Icon name={leadingIcon} />
      {input}
    </span>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  fieldSize?: Size;
  mono?: boolean;
}

export function TextArea({ className, fieldSize = "md", mono = false, ...props }: TextAreaProps) {
  return <textarea className={cx("ui-field", "ui-textarea", `ui-field-${fieldSize}`, mono && "ui-field-mono", className)} {...props} />;
}

export interface SelectOption<T extends string | number> {
  disabled?: boolean;
  label: ReactNode;
  value: T;
}

export interface SelectProps<T extends string | number> extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  disabled?: boolean;
  fieldSize?: Size;
  menuClassName?: string;
  menuWidth?: number;
  options: Array<SelectOption<T>>;
  placeholder?: ReactNode;
  value: T;
  onChange: (value: T) => void;
}

export function Select<T extends string | number>({
  className,
  disabled = false,
  fieldSize = "md",
  menuClassName,
  menuWidth,
  onChange,
  options,
  placeholder = "请选择",
  value,
  ...props
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const menuRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value);
  const canOpen = !disabled && options.some((option) => !option.disabled);

  useEffect(() => {
    if (!open) {
      return;
    }

    const updateMenuStyle = () => {
      const root = rootRef.current;

      if (!root) {
        return;
      }

      const rect = root.getBoundingClientRect();
      const rootStyle = window.getComputedStyle(root);
      const viewportGap = 8;
      const preferredMaxHeight = 220;
      const spaceBelow = window.innerHeight - rect.bottom - viewportGap;
      const spaceAbove = rect.top - viewportGap;
      const opensUp = spaceBelow < 120 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(96, Math.min(preferredMaxHeight, opensUp ? spaceAbove - 4 : spaceBelow - 4));
      const themeVars = [
        "--accent",
        "--app-bg",
        "--border-subtle",
        "--button-muted-base-bg",
        "--button-muted-bg",
        "--panel-solid-base-bg",
        "--panel-solid-bg",
        "--text-main",
        "--text-muted",
        "--text-strong",
      ].reduce<Record<string, string>>((vars, name) => {
        vars[name] = rootStyle.getPropertyValue(name);
        return vars;
      }, {});

      setMenuStyle({
        ...themeVars,
        left: rect.left,
        maxHeight,
        minWidth: menuWidth ?? rect.width,
        top: opensUp ? Math.max(viewportGap, rect.top - maxHeight - 4) : rect.bottom + 4,
        width: menuWidth ?? rect.width,
      });
    };

    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    updateMenuStyle();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updateMenuStyle);
    window.addEventListener("scroll", updateMenuStyle, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updateMenuStyle);
      window.removeEventListener("scroll", updateMenuStyle, true);
    };
  }, [menuWidth, open]);

  const menu = open ? (
    <div className={cx("ui-select-menu", "ui-select-menu-floating", menuClassName)} ref={menuRef} role="listbox" style={menuStyle}>
      {options.map((option) => (
        <button
          aria-selected={option.value === value}
          className={cx("ui-select-option", option.value === value && "active")}
          disabled={option.disabled}
          key={String(option.value)}
          onClick={() => {
            onChange(option.value);
            setOpen(false);
          }}
          role="option"
          type="button"
        >
          <span>{option.label}</span>
          {option.value === value ? <Icon name="check" /> : null}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div
      className={cx("ui-select-control", `ui-select-control-${fieldSize}`, open && "open", disabled && "disabled", className)}
      ref={rootRef}
      {...props}
    >
      <Button
        aria-label={props["aria-label"]}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cx("ui-select-trigger", !canOpen && "disabled")}
        disabled={!canOpen}
        onClick={() => setOpen((current) => !current)}
        tone="muted"
      >
        <span>{selectedOption?.label ?? placeholder}</span>
        <Icon name="chevron-right" className="ui-select-arrow" />
      </Button>
      {menu && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </div>
  );
}

export interface ConfirmDialogProps {
  actions?: ReactNode;
  cancelLabel?: ReactNode;
  confirmLabel?: ReactNode;
  description?: ReactNode;
  dismissible?: boolean;
  open: boolean;
  title: ReactNode;
  tone?: "default" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  actions,
  cancelLabel = "取消",
  confirmLabel = "确认",
  description,
  dismissible = true,
  open,
  title,
  tone = "default",
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open || !dismissible) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismissible, onCancel, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  const themeStyle = getPortalThemeStyle();

  return createPortal(
    <div
      className="modal-backdrop ui-confirm-backdrop"
      onPointerDown={dismissible ? onCancel : undefined}
      role="presentation"
      style={themeStyle}
    >
      <section
        aria-modal="true"
        className="ui-confirm-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="ui-confirm-content">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <div className="ui-confirm-actions">
          {actions ?? (
            <>
              <Button onClick={onCancel} tone="muted">
                {cancelLabel}
              </Button>
              <Button
                className={tone === "danger" ? "danger-action" : undefined}
                icon={tone === "danger" ? "trash" : undefined}
                onClick={onConfirm}
                tone={tone}
              >
                {confirmLabel}
              </Button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "article" | "aside" | "div" | "section";
  footer?: ReactNode;
  header?: ReactNode;
  tone?: "default" | "solid";
}

export function Card({ as: Element = "section", children, className, footer, header, tone = "default", ...props }: CardProps) {
  return (
    <Element className={cx("ui-card", `ui-card-${tone}`, className)} {...props}>
      {header ? <div className="ui-card-header">{header}</div> : null}
      <div className="ui-card-body">{children}</div>
      {footer ? <div className="ui-card-footer">{footer}</div> : null}
    </Element>
  );
}

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  icon?: IconName;
  tone?: "default" | "success" | "warning" | "danger" | "accent";
}

export function Tag({ children, className, icon, tone = "default", ...props }: TagProps) {
  return (
    <span className={cx("ui-tag", `ui-tag-${tone}`, className)} {...props}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  description?: ReactNode;
  label: ReactNode;
}

export function Toggle({ className, description, label, ...props }: ToggleProps) {
  return (
    <label className={cx("ui-toggle", "check-row", className)}>
      <input type="checkbox" {...props} />
      <span className="check-row-label">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}

export interface SegmentedOption<T extends string> {
  ariaLabel?: string;
  count?: number;
  icon?: IconName;
  label: ReactNode;
  title?: string;
  value: T;
}

export interface SegmentedControlProps<T extends string> extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  itemLayout?: "compact" | "iconText";
  options: Array<SegmentedOption<T>>;
  orientation?: "horizontal" | "vertical";
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  className,
  itemLayout = "compact",
  onChange,
  options,
  orientation = "horizontal",
  value,
  ...props
}: SegmentedControlProps<T>) {
  return (
    <div className={cx("ui-segmented", `ui-segmented-${orientation}`, `ui-segmented-${itemLayout}`, className)} {...props}>
      {options.map((option) => (
        <Button
          active={option.value === value}
          aria-label={option.ariaLabel}
          aria-pressed={option.value === value}
          icon={option.icon}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          tone="muted"
        >
          <span>{option.label}</span>
          {typeof option.count === "number" ? <small>{option.count}</small> : null}
        </Button>
      ))}
    </div>
  );
}

export interface VirtualListProps<T> extends HTMLAttributes<HTMLDivElement> {
  empty?: ReactNode;
  estimateHeight?: number;
  items: readonly T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
}

export function VirtualList<T>({
  className,
  empty = null,
  estimateHeight = 36,
  items,
  keyExtractor,
  renderItem,
  ...props
}: VirtualListProps<T>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const totalHeight = items.length * estimateHeight;
  const overscan = estimateHeight * 6;
  const requestedStartIndex = Math.max(0, Math.floor(Math.max(0, scrollTop - overscan) / estimateHeight));
  const visibleCapacity = Math.max(1, Math.ceil((viewportHeight + overscan) / estimateHeight));
  const maximumStartIndex = Math.max(0, items.length - visibleCapacity);
  const startIndex = Math.min(requestedStartIndex, maximumStartIndex);
  const endIndex = Math.min(items.length, Math.ceil((scrollTop + viewportHeight + overscan) / estimateHeight));
  const visibleItems = useMemo(() => items.slice(startIndex, endIndex), [endIndex, items, startIndex]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const updateHeight = () => setViewportHeight(viewport.clientHeight);
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const maximumScrollTop = Math.max(0, totalHeight - viewport.clientHeight);
    if (viewport.scrollTop > maximumScrollTop) {
      viewport.scrollTop = maximumScrollTop;
      setScrollTop(maximumScrollTop);
    }
  }, [totalHeight]);

  if (!items.length) {
    return (
      <div
        className={cx("ui-virtual-list", "ui-virtual-list-empty", className)}
        ref={viewportRef}
        {...props}
      >
        {empty}
      </div>
    );
  }

  return (
    <div
      className={cx("ui-virtual-list", className)}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      ref={viewportRef}
      {...props}
    >
      <div className="ui-virtual-list-spacer" style={{ height: totalHeight }}>
        <div className="ui-virtual-list-window" style={{ transform: `translateY(${startIndex * estimateHeight}px)` }}>
          {visibleItems.map((item, offset) => {
            const index = startIndex + offset;
            return (
              <div className="ui-virtual-list-item" key={keyExtractor(item, index)} style={{ minHeight: estimateHeight }}>
                {renderItem(item, index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
