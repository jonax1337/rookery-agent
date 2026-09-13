import { cn } from '@/lib/utils';

/**
 * The assistant's face: the voice orb, at avatar size.
 *
 * `VoiceOrb` itself is a WebGL shader with a permanent `requestAnimationFrame`
 * loop. Mounting that in the sidebar footer would hold a GPU context and
 * repaint forever on every screen of the app, for thirty-two pixels of
 * decoration - and at this size none of the shader's detail is visible anyway.
 * So this is the orb's language rather than its implementation: the same two
 * colour pairs `VoiceOrb` uses for `idle` and `thinking`, in a plain CSS
 * gradient that costs nothing.
 *
 * It breathes only while a turn is running, and it switches to the violet the
 * real orb wears while it thinks - so the avatar says the same thing the
 * fullscreen orb would, in the same colours.
 */

/** Straight from `VoiceOrb`'s COLORS, converted to hex. */
const IDLE = 'radial-gradient(circle at 32% 26%, #26D9FF 0%, #1A59F2 38%, #0A1E4D 74%, #050A1A 100%)';
const THINKING =
  'radial-gradient(circle at 32% 26%, #F273FF 0%, #7340FF 40%, #2A1060 76%, #0B0518 100%)';

interface AssistantAvatarProps {
  /** A turn is running: the orb thinks, and shows it. */
  busy?: boolean;
  /** Read out in place of the picture. */
  label: string;
  className?: string;
}

export function AssistantAvatar({ busy = false, label, className }: AssistantAvatarProps) {
  return (
    <span
      role="img"
      aria-label={busy ? label + ', thinking' : label}
      className={cn(
        'relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg',
        // A hairline of the surrounding surface so the dark orb does not sit
        // on the sidebar like a hole punched in it.
        'ring-1 ring-black/10 dark:ring-white/10',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 transition-[background-image] duration-500"
        style={{ backgroundImage: busy ? THINKING : IDLE }}
      />
      {/* The glint the shader puts on the upper left of the sphere. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_30%_22%,rgba(255,255,255,0.45)_0%,transparent_38%)]"
      />
      {busy && (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-lg bg-white/15 motion-reduce:animate-none"
        />
      )}
    </span>
  );
}
