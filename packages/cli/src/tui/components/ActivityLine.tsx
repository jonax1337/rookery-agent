/**
 * One dim line of side-channel activity: a provider tool, a memory recall, a
 * routing decision. Always exactly one line so a burst of them cannot push the
 * conversation off the screen.
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
      <Text color={color ?? ui.muted} dimColor={!color}>
        {icon} {text}
      </Text>
    </Box>
  );
}
