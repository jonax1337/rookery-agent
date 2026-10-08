import { useState } from 'react';
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { ToolCall } from './tool-call';
import { ToolFallback, humanizeToolName } from './tool-fallback.aui';

/** Tool output is usually JSON text; anything that is not stays the plain text it is. */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const isTextBlocks = (value: unknown): value is { type: 'text'; text: string }[] =>
  Array.isArray(value) && value.length > 0 && value.every((part) => part?.type === 'text' && typeof part.text === 'string');

/** CLI results can contain JSON-encoded MCP text blocks. Show their readable content. */
export function formatToolValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  const parsed = typeof value === 'string' ? parseJsonText(value) : value;
  if (isTextBlocks(parsed)) return parsed.map((part) => part.text).join('\n\n');
  return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
}

export const CompactToolCall: ToolCallMessagePartComponent = (props) => {
  const [open, setOpen] = useState(false);
  if (props.status.type === 'requires-action') return <ToolFallback {...props} />;
  const name = humanizeToolName(props.toolName);
  const failed = props.isError || props.status.type === 'incomplete';
  return <ToolCall label={name} activeLabel={name} query=""
    request={formatToolValue(props.argsText)} result={formatToolValue(props.result)}
    running={props.status.type === 'running'} failed={failed}
    open={open} onOpenChange={setOpen} className="max-w-none" />;
};
