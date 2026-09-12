import { useState } from 'react';
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { ToolCall } from './tool-call';
import { ToolFallback } from './tool-fallback.aui';

/** CLI results can contain JSON-encoded MCP text blocks. Show their readable content. */
export function formatToolValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return value as string; }
  }
  if (Array.isArray(value) && value.length && value.every((part) => part?.type === 'text' && typeof part.text === 'string')) {
    return value.map((part) => part.text).join('\n\n');
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export const CompactToolCall: ToolCallMessagePartComponent = (props) => {
  const [open, setOpen] = useState(false);
  if (props.status.type === 'requires-action') return <ToolFallback {...props} />;
  const name = props.toolName.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  const failed = props.isError || props.status.type === 'incomplete';
  return <ToolCall label={name} activeLabel={name} query=""
    request={formatToolValue(props.argsText)} result={formatToolValue(props.result)}
    running={props.status.type === 'running'} failed={failed}
    open={open} onOpenChange={setOpen} className="max-w-none" />;
};
