import type {
  ComponentType,
  ForwardRefExoticComponent,
} from "react";

/**
 * Props, die jede Icon-Variante (lucide-react, animated Icons aus diesem
 * Ordner, animate-ui-Icons) mindestens entgegennimmt.
 */
export interface IconBaseProps {
  className?: string;
  size?: number;
}

/**
 * Gemeinsamer Typ fuer Icon-Komponenten: nimmt lucide-react-Icons, die
 * animated Icons aus diesem Ordner und die animate-ui-Wrapper-Icons
 * (forwardRef ohne eigene Props) entgegen. Bewusst minimal (kein ref,
 * keine DOM-Event-Props), damit alle Varianten kontravariant hineinpassen.
 */
export type IconComponent =
  | ComponentType<IconBaseProps>
  | ForwardRefExoticComponent<any>;
