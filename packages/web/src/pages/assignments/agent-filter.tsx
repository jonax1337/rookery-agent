import { OptionCombobox, type Option } from './option-combobox';

/**
 * The agent filter.
 *
 * It sets the server's `agentId`, not a client predicate, for the same reason
 * the status tabs do: filtering inside the newest 500 rows would hide an
 * agent's older work entirely.
 */
export function AgentFilter({
  options,
  value,
  onChange,
}: {
  options: Option[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <OptionCombobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder="All Agents"
      emptyText="No agent found"
      aria-label="Filter by agent"
      className="h-8 w-full sm:w-48"
    />
  );
}
