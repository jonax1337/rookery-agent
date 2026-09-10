/**
 * One dim line of side-channel activity: a memory recall, a routing decision,
 * a board entry, an error. Provider tool calls do not come through here - they
 * are grouped and rendered by `ToolGroup`.
 *
 * Always exactly one line, wrapped rather than truncated, so a burst of them
 * cannot push the conversation off the screen but a long one is still legible.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ui } from '../theme.js';

export interface ActivityLineProps {
  icon: string;
  text: string;
  color?: string;
}

export function ActivityLine({ icon, text, color }: ActivityLineProps): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Text color={color ?? ui.faint}>{icon + ' '}</Text>
      <Box flexGrow={1}>
        <Text color={color ?? ui.faint} wrap="wrap">
          {text}
        </Text>
      </Box>
    </Box>
  );
}
