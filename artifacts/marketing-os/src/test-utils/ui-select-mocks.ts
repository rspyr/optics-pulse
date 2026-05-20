import React from "react";

type SelectModule = typeof import("@/components/ui/select");

/**
 * Replace `@/components/ui/select` with a tiny native-<select> shim. The
 * shipped component is Radix's portal-driven popover, which jsdom can't
 * model — userEvent.selectOptions / fireEvent.change just hang. Tests that
 * drive the dropdown (filter selection, mapping target choice, etc.) want a
 * real HTMLSelectElement they can change.
 *
 * Because the return type is pinned to `SelectModule`, dropping or renaming
 * an export on the real `ui/select` module surfaces a compile error here
 * instead of a silent `undefined` on the importing test.
 *
 * Usage:
 *
 *     vi.mock("@/components/ui/select", async () => {
 *       const { mockUiSelectAsNative } = await import(
 *         "@/test-utils/ui-select-mocks",
 *       );
 *       return mockUiSelectAsNative();
 *     });
 */
export function mockUiSelectAsNative(
  overrides: Partial<SelectModule> = {},
): SelectModule {
  const Select: SelectModule["Select"] = (({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  }) =>
    React.createElement(
      "select",
      {
        "data-testid": "ui-select",
        value: value ?? "",
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
          onValueChange?.(e.target.value),
      },
      children,
    )) as unknown as SelectModule["Select"];

  const SelectTrigger: SelectModule["SelectTrigger"] = (() =>
    null) as unknown as SelectModule["SelectTrigger"];
  const SelectValue: SelectModule["SelectValue"] = (() =>
    null) as unknown as SelectModule["SelectValue"];
  const SelectContent: SelectModule["SelectContent"] = (({
    children,
  }: {
    children?: React.ReactNode;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      children,
    )) as unknown as SelectModule["SelectContent"];
  const SelectItem: SelectModule["SelectItem"] = (({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) =>
    React.createElement(
      "option",
      { value },
      children,
    )) as unknown as SelectModule["SelectItem"];
  const SelectGroup: SelectModule["SelectGroup"] = (({
    children,
  }: {
    children?: React.ReactNode;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      children,
    )) as unknown as SelectModule["SelectGroup"];
  const SelectLabel: SelectModule["SelectLabel"] = (({
    children,
  }: {
    children?: React.ReactNode;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      children,
    )) as unknown as SelectModule["SelectLabel"];
  const SelectSeparator: SelectModule["SelectSeparator"] = (() =>
    null) as unknown as SelectModule["SelectSeparator"];
  const SelectScrollUpButton: SelectModule["SelectScrollUpButton"] = (() =>
    null) as unknown as SelectModule["SelectScrollUpButton"];
  const SelectScrollDownButton: SelectModule["SelectScrollDownButton"] = (() =>
    null) as unknown as SelectModule["SelectScrollDownButton"];

  const defaults: SelectModule = {
    Select,
    SelectGroup,
    SelectValue,
    SelectTrigger,
    SelectContent,
    SelectLabel,
    SelectItem,
    SelectSeparator,
    SelectScrollUpButton,
    SelectScrollDownButton,
  };
  return { ...defaults, ...overrides };
}

/**
 * Replace `@/components/ui/select` with a div-passthrough shim. Use when
 * the test only needs the children to render (e.g. snapshot / presence
 * assertions) and never actually drives the selection.
 */
export function mockUiSelectAsPassthrough(
  overrides: Partial<SelectModule> = {},
): SelectModule {
  const div = (label: string) =>
    (({ children }: { children?: React.ReactNode }) =>
      React.createElement(
        "div",
        { "data-testid": `ui-select-${label}` },
        children,
      )) as unknown as SelectModule[keyof SelectModule];

  const defaults: SelectModule = {
    Select: div("root") as SelectModule["Select"],
    SelectGroup: div("group") as SelectModule["SelectGroup"],
    SelectValue: div("value") as SelectModule["SelectValue"],
    SelectTrigger: div("trigger") as SelectModule["SelectTrigger"],
    SelectContent: div("content") as SelectModule["SelectContent"],
    SelectLabel: div("label") as SelectModule["SelectLabel"],
    SelectItem: div("item") as SelectModule["SelectItem"],
    SelectSeparator: div("separator") as SelectModule["SelectSeparator"],
    SelectScrollUpButton: div(
      "scroll-up",
    ) as SelectModule["SelectScrollUpButton"],
    SelectScrollDownButton: div(
      "scroll-down",
    ) as SelectModule["SelectScrollDownButton"],
  };
  return { ...defaults, ...overrides };
}
