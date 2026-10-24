"use client";

import { Children, Fragment, isValidElement, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { Icon } from "./icon";
import { FieldLabelContext } from "./field-context";

type Option = { value: string; label: ReactNode; text: string; disabled: boolean };
function textContent(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : String(child)).join("");
}
function readOptions(children: ReactNode, disabled = false): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>(child)) return [];
    if (child.type === Fragment || child.type === "optgroup") return readOptions(child.props.children, disabled || Boolean(child.props.disabled));
    if (child.type !== "option") return [];
    const text = textContent(child.props.children);
    return [{ value: String(child.props.value ?? text), label: child.props.children, text, disabled: disabled || Boolean(child.props.disabled) }];
  });
}

// The hidden select preserves FormData, native validation and existing change
// handlers. The visible control and its top-layer options are built here.
export function Select({ children, className = "input", value, defaultValue, onChange, id, disabled, autoFocus, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const generatedId = useId();
  const fieldLabel = useContext(FieldLabelContext);
  const accessibleLabel = props["aria-label"] ?? fieldLabel ?? props.name;
  const listId = `${id ?? generatedId}-options`;
  const options = readOptions(children);
  const [localValue, setLocalValue] = useState(String(defaultValue ?? options[0]?.value ?? ""));
  const selectedValue = String(value ?? localValue);
  const selected = options.find(option => option.value === selectedValue);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [invalid, setInvalid] = useState(false);
  const native = useRef<HTMLSelectElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", time: 0 });
  const firstEnabled = options.findIndex(option => !option.disabled);
  function close() { setOpen(false); }
  function reveal() {
    if (disabled || trigger.current?.matches(":disabled")) return;
    const index = options.findIndex(option => option.value === selectedValue && !option.disabled);
    setActive(index >= 0 ? index : Math.max(0, firstEnabled)); setOpen(true);
  }
  function choose(index: number) {
    const option = options[index], element = native.current;
    if (!option || option.disabled || !element || disabled || trigger.current?.matches(":disabled")) return;
    setLocalValue(option.value); setInvalid(false);
    element.value = option.value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    close(); trigger.current?.focus();
  }
  useLayoutEffect(() => {
    const popup = list.current, button = trigger.current;
    if (!popup || !button || !open) return;
    const position = () => {
      const rect = button.getBoundingClientRect();
      popup.style.width = `${Math.min(Math.max(rect.width, 180), window.innerWidth - 24)}px`;
      const height = Math.min(280, popup.scrollHeight || 280, window.innerHeight - 24);
      const above = window.innerHeight - rect.bottom < height + 8 && rect.top > height + 8;
      popup.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 12))}px`;
      popup.style.top = `${above ? Math.max(12, rect.top - height - 6) : rect.bottom + 6}px`;
      popup.style.maxHeight = `${above ? Math.min(280, rect.top - 18) : Math.min(280, window.innerHeight - rect.bottom - 18)}px`;
    };
    popup.showPopover(); position();
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { if (popup.matches(":popover-open")) popup.hidePopover(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { const target = event.target as Node; if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    const popup = list.current, option = popup?.children[active] as HTMLElement | undefined;
    if (!open || !popup || !option) return;
    if (option.offsetTop < popup.scrollTop) popup.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = option.offsetTop + option.offsetHeight - popup.clientHeight;
  }, [active, open]);
  useLayoutEffect(() => {
    if (accessibleLabel || props["aria-labelledby"]) return;
    const label = trigger.current?.closest("label")?.querySelector(".field-label")?.textContent;
    if (label) trigger.current?.setAttribute("aria-label", label);
  }, [accessibleLabel, props["aria-labelledby"]]);
  useEffect(() => {
    const form = native.current?.form;
    const reset = () => { setLocalValue(String(defaultValue ?? options[0]?.value ?? "")); setInvalid(false); close(); };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [defaultValue, children]);
  return <span className="custom-select">
    <select {...props} ref={native} id={id ? `${id}-native` : undefined} className="select-native" tabIndex={-1} aria-hidden="true" disabled={disabled} value={selectedValue} onFocus={event => { props.onFocus?.(event); trigger.current?.focus(); }} onChange={event => { setLocalValue(event.target.value); setInvalid(false); onChange?.(event); }} onInvalid={event => { event.preventDefault(); setInvalid(true); trigger.current?.focus(); props.onInvalid?.(event); }}>{children}</select>
    <button ref={trigger} id={id} type="button" role="combobox" autoFocus={autoFocus} aria-label={accessibleLabel} aria-labelledby={props["aria-labelledby"]} aria-describedby={props["aria-describedby"]} aria-required={props.required} aria-invalid={invalid || props["aria-invalid"]} aria-expanded={open} aria-controls={listId} aria-haspopup="listbox" aria-activedescendant={open ? `${listId}-${active}` : undefined} disabled={disabled} className={`${className} custom-select-trigger`} onClick={() => open ? close() : reveal()} onKeyDown={event => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === "Tab") { close(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); if (!open) { reveal(); return; }
        const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
        let next = event.key === "Home" ? -1 : event.key === "End" ? options.length : active;
        for (let count = 0; count < options.length; count++) { next = (next + direction + options.length) % options.length; if (!options[next].disabled) { setActive(next); break; } }
      } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (open) choose(active); else reveal(); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now(); search.current = { text: (now - search.current.time < 700 ? search.current.text : "") + event.key.toLowerCase(), time: now };
        const next = options.findIndex(option => !option.disabled && option.text.toLowerCase().startsWith(search.current.text));
        if (next >= 0) { if (open) setActive(next); else choose(next); } event.preventDefault();
      }
    }}><span>{selected?.label ?? options[0]?.label ?? "Select an option"}</span><Icon name="chevronDown" size={14.175} /></button>
    {open && <div ref={list} id={listId} role="listbox" aria-label={accessibleLabel} popover="manual" className="select-options">{options.map((option, index) => <div id={`${listId}-${index}`} key={`${option.value}:${index}`} role="option" aria-selected={option.value === selectedValue} aria-disabled={option.disabled} className={`select-option ${active === index ? "select-option-active" : ""}`} onPointerMove={() => { if (!option.disabled) setActive(index); }} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}><span>{option.label}</span>{option.value === selectedValue && <Icon name="check" size={14.175} />}</div>)}</div>}
    {invalid && <span className="field-error" role="alert">Please choose an option.</span>}
  </span>;
}
