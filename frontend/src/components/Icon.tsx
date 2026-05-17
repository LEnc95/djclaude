import type { JSX } from "preact";

// Material Symbols Outlined icon. `fill` toggles the variable axis.
export function Icon(props: {
  name: string;
  fill?: boolean;
  class?: string;
  style?: JSX.CSSProperties | string;
}) {
  const cls = `material-symbols-outlined${props.fill ? " icon-fill" : ""}${props.class ? " " + props.class : ""}`;
  return (
    <span class={cls} style={props.style} aria-hidden="true">
      {props.name}
    </span>
  );
}
