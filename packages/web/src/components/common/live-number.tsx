import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';

/**
 * A headline number: it rolls in from zero once its data arrives and keeps
 * rolling whenever a refetch moves it.
 *
 * `thousandSeparator` keeps `formatNumber`'s en-GB comma in the resting pose -
 * `CountingNumber` has no separator support and would quietly drop it above a
 * thousand.
 */
export function LiveNumber({ value }: { value: number }) {
  return <SlidingNumber number={value} fromNumber={0} thousandSeparator="," />;
}
